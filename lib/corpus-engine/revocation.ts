import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, nodeBytes, sha256Hex, type Bytes } from "./bytes";
import { docIdFromDecimal, docIdToDecimal } from "./ids";
import { CorpusStorageError, type CorpusObjectStore } from "./storage";
import { REVOCATION_CONTRACT_VERSION } from "./versions";

/**
 * Corpus Engine v1 — revocation-v1: the served-generation-independent
 * exclusion layer.
 *
 * A tombstone inside a generation is not enough for an urgent removal: an
 * older generation still holds the document, and a rollback would bring it
 * back. So revocations live OUTSIDE every generation, in one append-only list
 * at the corpus root, and every reader applies that list to whatever
 * generation it is pinned to:
 *
 *   - a revoked document is never returned by candidate retrieval;
 *   - its text is never fetched from a text pack;
 *   - rolling back to an older generation does not restore it;
 *   - re-ingesting the same normalized content is refused by the builder.
 *
 * Physical removal from packs and segments is left to a later compaction.
 *
 * FAIL CLOSED: the list file must exist (it is created with a header line
 * when a corpus root is initialized). A missing, unreadable or broken list is
 * an error — never "nothing is revoked".
 *
 * INTEGRITY: each entry carries the sha256 of the line before it AND a hash of
 * its own content chained to that, so an edited, reordered, inserted or
 * removed-from-the-middle entry is detected — the last entry included. What a
 * self-contained file cannot detect is its own TAIL being cut off, or a
 * wholesale rewrite by someone who recomputes every hash. For that a reader
 * is given an ANCHOR held outside the list (the activation pointer records
 * one): "entry N must exist and its line must hash to H". A list that is
 * shorter than the anchor, or whose history differs at it, is refused.
 */

export const REVOCATION_LIST_KEY = "revocations/revocations.jsonl";

export type RevocationEntry = {
  sequence: number;
  /** Decimal document id. */
  docId: string;
  /** When known, also blocks the same normalized content from being re-ingested. */
  normalizedContentSha256: string | null;
  reason: string;
  revokedAt: string;
  revokedBy: string | null;
  /** sha256 of the previous line's bytes (the header line for the first entry). */
  previousLineSha256: string;
  /** sha256(previousLineSha256 + "\n" + canonical JSON of this entry without this field). */
  entrySha256: string;
};

/** "The list must reach sequence N, and the line there must hash to H." Sequence 0 is the header line. */
export type RevocationAnchor = { sequence: number; lineSha256: string };

function entryHash(entry: Omit<RevocationEntry, "entrySha256">): string {
  return sha256Hex(`${entry.previousLineSha256}\n${canonicalJson(entry)}`);
}

export class CorpusRevocationError extends Error {
  readonly code: "REVOCATION_LIST_MISSING" | "REVOCATION_LIST_UNREADABLE" | "REVOCATION_LIST_CORRUPT" | "REVOCATION_LIST_STALE";
  constructor(code: CorpusRevocationError["code"], message: string) {
    super(message);
    this.name = "CorpusRevocationError";
    this.code = code;
  }
}

function headerLine(): string {
  return canonicalJson({ kind: "turnitplus-corpus-revocation-list", contract: REVOCATION_CONTRACT_VERSION });
}

export class RevocationList {
  private readonly ids = new Set<bigint>();
  private readonly contents = new Set<string>();

  private constructor(readonly entries: readonly RevocationEntry[], readonly epoch: string, private readonly lineHashes: readonly string[]) {
    for (const entry of entries) {
      this.ids.add(docIdFromDecimal(entry.docId));
      if (entry.normalizedContentSha256) this.contents.add(entry.normalizedContentSha256);
    }
  }

  get size() {
    return this.ids.size;
  }

  get lastSequence() {
    return this.entries.length === 0 ? 0 : this.entries[this.entries.length - 1].sequence;
  }

  /** The anchor for the list as it stands — recorded at activation and required by later readers. */
  anchor(): RevocationAnchor {
    return { sequence: this.lastSequence, lineSha256: this.lineHashes[this.lastSequence] };
  }

  has(docId: bigint): boolean {
    return this.ids.has(docId);
  }

  hasContent(normalizedContentSha256: string): boolean {
    return this.contents.has(normalizedContentSha256);
  }

  docIds(): bigint[] {
    return [...this.ids];
  }

  /** Parses and verifies the list bytes. `anchor` rejects a list that has lost its tail or had its history rewritten. */
  static parse(bytes: Bytes, anchor: RevocationAnchor | null = null): RevocationList {
    const text = bytes.toString("utf8");
    if (!text.endsWith("\n")) throw new CorpusRevocationError("REVOCATION_LIST_CORRUPT", "revocation list does not end with a complete line");
    const lines = text.slice(0, -1).split("\n");
    if (lines[0] !== headerLine()) throw new CorpusRevocationError("REVOCATION_LIST_CORRUPT", "revocation list header is missing or names another contract");
    const entries: RevocationEntry[] = [];
    const lineHashes: string[] = [sha256Hex(lines[0])];
    let previous = lines[0];
    for (let index = 1; index < lines.length; index += 1) {
      let entry: RevocationEntry;
      try {
        entry = JSON.parse(lines[index]) as RevocationEntry;
        docIdFromDecimal(entry.docId);
      } catch {
        throw new CorpusRevocationError("REVOCATION_LIST_CORRUPT", `revocation list line ${index + 1} is not a valid entry`);
      }
      const { entrySha256, ...content } = entry;
      if (
        entry.sequence !== index || entry.previousLineSha256 !== sha256Hex(previous)
        || entrySha256 !== entryHash(content) || canonicalJson(entry) !== lines[index]
      ) {
        throw new CorpusRevocationError("REVOCATION_LIST_CORRUPT", `revocation list line ${index + 1} breaks the sequence or hash chain`);
      }
      entries.push(entry);
      previous = lines[index];
      lineHashes.push(sha256Hex(previous));
    }
    if (anchor) {
      if (!Number.isInteger(anchor.sequence) || anchor.sequence < 0) throw new CorpusRevocationError("REVOCATION_LIST_STALE", "revocation anchor is malformed");
      if (entries.length < anchor.sequence) {
        throw new CorpusRevocationError("REVOCATION_LIST_STALE", `revocation list ends at sequence ${entries.length}; the anchor requires ${anchor.sequence}`);
      }
      if (lineHashes[anchor.sequence] !== anchor.lineSha256) {
        throw new CorpusRevocationError("REVOCATION_LIST_STALE", `revocation list history differs from the anchor at sequence ${anchor.sequence}`);
      }
    }
    return new RevocationList(entries, `revocations:${entries.length}:${lineHashes[entries.length].slice(0, 16)}`, lineHashes);
  }

  static async load(store: CorpusObjectStore, anchor: RevocationAnchor | null = null): Promise<RevocationList> {
    let bytes: Bytes;
    try {
      bytes = await store.readAll(REVOCATION_LIST_KEY);
    } catch (error) {
      if (error instanceof CorpusStorageError && error.code === "NOT_FOUND") {
        throw new CorpusRevocationError("REVOCATION_LIST_MISSING", "the corpus revocation list is missing; refusing to treat that as 'nothing revoked'");
      }
      throw new CorpusRevocationError("REVOCATION_LIST_UNREADABLE", `the corpus revocation list is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return RevocationList.parse(bytes, anchor);
  }
}

/** Creates the (empty) revocation list of a new corpus root. Never overwrites an existing one. */
export function initializeRevocationList(corpusRoot: string) {
  const file = path.join(corpusRoot, ...REVOCATION_LIST_KEY.split("/"));
  if (existsSync(file)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${headerLine()}\n`, { flag: "wx" });
}

/** Appends one revocation (fsync'd). Idempotent per document id: revoking twice returns the first entry. */
export function appendRevocation(
  corpusRoot: string,
  revocation: { docId: bigint; normalizedContentSha256?: string | null; reason: string; revokedBy?: string | null; revokedAt?: string },
): RevocationEntry {
  const file = path.join(corpusRoot, ...REVOCATION_LIST_KEY.split("/"));
  if (!existsSync(file)) throw new CorpusRevocationError("REVOCATION_LIST_MISSING", "the corpus revocation list is missing");
  const bytes = nodeBytes(readFileSync(file));
  const current = RevocationList.parse(bytes);
  const decimal = docIdToDecimal(revocation.docId);
  const existing = current.entries.find((entry) => entry.docId === decimal);
  if (existing) return existing;
  const lines = bytes.toString("utf8").slice(0, -1).split("\n");
  const content: Omit<RevocationEntry, "entrySha256"> = {
    sequence: current.entries.length + 1,
    docId: decimal,
    normalizedContentSha256: revocation.normalizedContentSha256 ?? null,
    reason: revocation.reason,
    revokedAt: revocation.revokedAt ?? new Date().toISOString(),
    revokedBy: revocation.revokedBy ?? null,
    previousLineSha256: sha256Hex(lines[lines.length - 1]),
  };
  const entry: RevocationEntry = { ...content, entrySha256: entryHash(content) };
  appendFileSync(file, `${canonicalJson(entry)}\n`);
  const descriptor = openSync(file, "r+");
  fsyncSync(descriptor);
  closeSync(descriptor);
  return entry;
}
