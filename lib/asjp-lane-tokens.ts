import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { tokensForScoringNormalization, type ScoringNormalizationVersion } from "./similarity-core";
import { normalizationProbeSha256 } from "./corpus-engine/versions";

/**
 * Prepared lane tokens (asjp-lane-tokens-v2): every indexed article's text as the ASJP lane tokenizes it
 * (tokensForScoringNormalization, the lane's normalization), stored once so the verbatim-rescue bound can test a
 * candidate without fetching and re-tokenizing its text. Keyed by docId, which is derived from the article's normalized
 * content, so one docId always names the same text in every generation that holds it.
 *
 *   identity.json  format, normalization version, two probe sha256s (this module's probe and the Corpus Engine's
 *                  multilingual normalization probe): a store built under another tokenization is refused at open
 *   index.json     { docId: [byteOffset, byteLength, tokenCount, sha256 prefix of the entry bytes] }, checked per read
 *   tokens.bin     each article's tokens joined by "\n" (a token never holds a newline), UTF-8
 *
 * The lane uses an entry to REJECT a rescue candidate without fetching its text, so exactness rests on the entry being
 * the lane's own tokens of that docId's text: docIds are content-derived (one docId, one text), the tokenization is
 * pinned by the two probes, and each entry's bytes by its checksum. A missing entry falls back to the full path.
 */
export const ASJP_LANE_TOKENS_FORMAT = "asjp-lane-tokens-v2";
const PROBE = "Probe: Article 11(2) of the Law No. 15-12 — « citation » “quoted” 1,234.56 Ünïcödé naïve café l’état e-mail 3G/4G; Ibid., pp. 7–9.\nسطر عربي — fin.";
const digestOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

export type LaneTokensIdentity = { format: string; normalization: ScoringNormalizationVersion; probeSha256: string; engineProbeSha256: string };
export function laneTokensIdentity(normalization: ScoringNormalizationVersion): LaneTokensIdentity {
  return {
    format: ASJP_LANE_TOKENS_FORMAT, normalization,
    probeSha256: createHash("sha256").update(tokensForScoringNormalization(PROBE, normalization).join("\n")).digest("hex"),
    engineProbeSha256: normalizationProbeSha256(normalization),
  };
}

/** Writes a store for (docId, text) pairs; returns counts. */
export async function buildLaneTokens(dir: string, normalization: ScoringNormalizationVersion, documents: AsyncIterable<{ docId: string; text: string }>) {
  mkdirSync(dir, { recursive: true });
  const fd = openSync(path.join(dir, "tokens.bin"), "w");
  const index: Record<string, [number, number, number, string]> = {};
  let offset = 0, docs = 0, tokens = 0;
  try {
    for await (const { docId, text } of documents) {
      if (index[docId]) continue;
      const words = tokensForScoringNormalization(text, normalization);
      const bytes = Buffer.from(words.join("\n"), "utf8");
      writeSync(fd, bytes);
      index[docId] = [offset, bytes.length, words.length, digestOf(bytes)];
      offset += bytes.length; docs += 1; tokens += words.length;
    }
  } finally { closeSync(fd); }
  writeFileSync(path.join(dir, "index.json"), JSON.stringify(index));
  writeFileSync(path.join(dir, "identity.json"), JSON.stringify(laneTokensIdentity(normalization), null, 1));
  return { docs, tokens, bytes: offset };
}

export class LaneTokenStore {
  private constructor(private readonly fd: number, private readonly index: Record<string, [number, number, number, string]>, readonly identity: LaneTokensIdentity) {}
  reads = 0;
  misses = 0;
  /** Opens a store; refuses one whose tokenization identity differs from the running code's. */
  static open(dir: string, normalization: ScoringNormalizationVersion): LaneTokenStore {
    const identity = JSON.parse(readFileSync(path.join(dir, "identity.json"), "utf8")) as LaneTokensIdentity;
    const expected = laneTokensIdentity(normalization);
    if (identity.format !== expected.format || identity.normalization !== expected.normalization || identity.probeSha256 !== expected.probeSha256 || identity.engineProbeSha256 !== expected.engineProbeSha256) {
      throw new Error(`lane-token store ${dir} was built under another tokenization (${String(identity.probeSha256).slice(0, 12)} vs ${expected.probeSha256.slice(0, 12)})`);
    }
    if (!existsSync(path.join(dir, "tokens.bin"))) throw new Error(`lane-token store ${dir} has no tokens.bin`);
    return new LaneTokenStore(openSync(path.join(dir, "tokens.bin"), "r"), JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8")), identity);
  }
  /** The article's lane tokens, or null when the store does not hold it (the caller then takes the full path). */
  read(docId: string): string[] | null {
    const entry = this.index[docId];
    if (!entry) { this.misses += 1; return null; }
    const [offset, length, count, digest] = entry;
    const buffer = Buffer.allocUnsafe(length);
    readSync(this.fd, buffer, 0, length, offset);
    if (digestOf(buffer) !== digest) throw new Error(`lane-token store entry ${docId} fails its checksum`);
    this.reads += 1;
    const words = length === 0 ? [] : buffer.toString("utf8").split("\n");
    if (words.length !== count) throw new Error(`lane-token store entry ${docId} is corrupt`);
    return words;
  }
  close() { closeSync(this.fd); }
}
