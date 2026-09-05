import fs from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { canonicalizeText } from "./canonical-text";
import { canonicalSha256 } from "./document-identity";
import { tokens, grams, gramHash } from "./similarity-core";
import {
  createReusableDocumentRepresentation,
  findReusableRepresentationByCanonicalHash,
  CORPUS_SHINGLE_WRITE_BATCH_ROWS,
} from "./user-submission-corpus";

/**
 * 100k-scale architecture, slice 1 (server-side archive parity foundation).
 *
 * Seeds the built-in archive (currently app/similarity-worker.ts's static
 * public/data/document-index.* index, 321 documents) into
 * corpus_document_representations / corpus_document_shingles, using the same
 * write primitives the live corpus uses (createReusableDocumentRepresentation,
 * the same batched-INSERT-OR-IGNORE shape as recordCorpusShingles), so the
 * archive can eventually be matched by the same scalable, indexed machinery
 * (findCandidateCorpusRepresentations) instead of a client-side static index.
 *
 * SOURCE OF TRUTH, VERIFIED FROM CODE (not assumed):
 *   - public/data/document-index.{meta.json,hashes,offsets,postings}.<ver>.bin
 *     carry ONLY shingle-hash postings and per-article metadata (id/title/
 *     wordCount/uniqueShingleCount) — hashes are one-way (FNV-1a+djb2), so
 *     no original text is recoverable from the static index alone.
 *   - The recoverable source is corpus/manifest.json (gitignored, restored
 *     locally from the archive's own build tree) filtered to
 *     roles.includes("index-source") — exactly 321 entries, matching
 *     document-index.meta.json's documentCount — plus the raw text files
 *     each entry's textPath points to under corpus/similarity/text/. Cross-
 *     checked: matching id, title, and turnitinScore<->originalSimilarity
 *     for a sampled entry; word count within ~1% of meta.json's own count
 *     (the residual gap is normalize()'s tokenization, not a different
 *     document).
 *
 * WHY THIS DOES NOT REUSE corpusShingleHashes/recordCorpusShingles UNCHANGED:
 * grep-verified that scripts/build-document-corpus.py's own informative()
 * filter (its line 64) is DEAD CODE — never called anywhere in that script.
 * The browser archive's true posting universe is therefore "every 5-gram of
 * the document, capped only by document frequency" — NOT "informative
 * 5-grams only," which is what lib/user-submission-corpus.ts's
 * corpusShingleHashes (and therefore recordCorpusShingles) computes for the
 * live corpus. Reusing that function here would silently produce a smaller,
 * differently-shaped shingle set and break parity with the browser engine's
 * own self-exclusion (containment >= 0.75) and per-document uniqueShingleCount
 * — both computed over ALL grams there, not just informative ones. See
 * archiveShingleHashes below.
 *
 * ISOLATION FROM THE LIVE HISTORICAL-MATCH PATH: every write here uses
 * ARCHIVE_FINGERPRINT_VERSION, never CORPUS_FINGERPRINT_VERSION — so
 * lib/user-submission-matching.ts's matchAgainstUserSubmissionCorpus (which
 * always queries CORPUS_FINGERPRINT_VERSION) cannot see these rows at all,
 * and the user-visible similarity result is unchanged by seeding alone. No
 * corpus_submission_references or corpus_admission_promotions row is ever
 * created for a seeded representation, so it is structurally never
 * account-owned and never eligible for the SELF/PRIOR_SUBMISSION/
 * TURNITPLUS_CORPUS_SOURCE relationship classification that function applies
 * — see lib/archive-corpus-matching.ts for the separate, purpose-built
 * adapter that actually matches against these rows.
 */

export const ARCHIVE_FINGERPRINT_VERSION = "archive-shingle-v1";
export const ARCHIVE_SHINGLE_SIZE = 5;
export const ARCHIVE_EXTRACTOR_VERSION = "archive-corpus-seed-v1";

export type ArchiveManifestEntry = {
  id: string;
  roles: string[];
  textPath: string;
  title: string;
  turnitinScore: number | null;
};

export type ArchiveSeedSourceEntry = {
  archiveArticleId: string;
  title: string;
  originalSimilarity: number | null;
  text: string;
  /**
   * This article's index in public/data/document-index.meta.json's own
   * articles[] array — see archive_document_representations.archive_order's
   * own migration comment (drizzle/0048) for why this matters: it is what
   * lets a server-side adapter reproduce the browser's fixed, query-
   * independent winner-take-all tie-break instead of an arbitrary one.
   * Undefined when the true build-time position isn't known (stored as
   * NULL) — sorts after every explicitly-ordered row.
   */
  archiveOrder?: number;
};

/**
 * Reads corpus/manifest.json + corpus/similarity/text/*.txt. Offline/local
 * only — corpus/ is gitignored and is never expected to exist on a deployed
 * server; this is an import step run by hand (or a one-off job) against a
 * chosen database, never called from a live request path.
 *
 * `packedIndexMetaPath`, when given, should point at the SAME public/data/
 * document-index.meta.json the browser engine actually loads — its
 * articles[] array order is where archiveOrder (see
 * ArchiveSeedSourceEntry.archiveOrder) comes from. manifest.json's own
 * entry order is unrelated (roughly alphabetical by title, an artifact of
 * how it was compiled) and must never be used as a stand-in for it.
 */
export function loadArchiveSourceEntries(corpusRoot: string, packedIndexMetaPath?: string): ArchiveSeedSourceEntry[] {
  const manifestPath = path.join(corpusRoot, "manifest.json");
  const manifest: ArchiveManifestEntry[] = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const archiveOrderById = new Map<string, number>();
  if (packedIndexMetaPath) {
    const meta: { articles: { id: string }[] } = JSON.parse(fs.readFileSync(packedIndexMetaPath, "utf8"));
    meta.articles.forEach((article, index) => archiveOrderById.set(article.id, index));
  }
  return manifest
    .filter((entry) => entry.roles.includes("index-source"))
    .map((entry) => ({
      archiveArticleId: entry.id,
      title: entry.title,
      originalSimilarity: entry.turnitinScore ?? null,
      text: fs.readFileSync(path.join(corpusRoot, entry.textPath), "utf8"),
      archiveOrder: archiveOrderById.get(entry.id),
    }));
}

/**
 * EVERY 5-gram hash of canonicalText — deliberately unfiltered by
 * informativeGram. See this module's own header for why.
 */
export function archiveShingleHashes(canonicalText: string, shingleSize: number = ARCHIVE_SHINGLE_SIZE): Set<string> {
  const words = tokens(canonicalText);
  const hashes = new Set<string>();
  for (const gram of grams(words, shingleSize)) hashes.add(gramHash(gram));
  return hashes;
}

/**
 * Same batched-write shape as lib/user-submission-corpus.ts's
 * recordCorpusShingles (bounded at CORPUS_SHINGLE_WRITE_BATCH_ROWS rows per
 * batch() call, INSERT OR IGNORE against the same
 * ux_corpus_document_shingles_representation_version_hash unique index, so
 * idempotent on retry) — a deliberately SEPARATE function rather than a
 * shared call, because the hash-selection semantics differ (see
 * archiveShingleHashes). This mirrors the codebase's own existing
 * convention of one shingle-writer per distinct semantic purpose
 * (document_identity_shingles vs corpus_document_shingles are already two
 * independent writers for exactly this reason).
 */
export async function recordArchiveDocumentShingles(
  client: Client,
  representationId: string,
  canonicalText: string,
  fingerprintVersion: string = ARCHIVE_FINGERPRINT_VERSION,
  shingleSize: number = ARCHIVE_SHINGLE_SIZE,
): Promise<{ shingleCount: number }> {
  const hashes = archiveShingleHashes(canonicalText, shingleSize);
  const hashList = [...hashes];
  for (let offset = 0; offset < hashList.length; offset += CORPUS_SHINGLE_WRITE_BATCH_ROWS) {
    const chunk = hashList.slice(offset, offset + CORPUS_SHINGLE_WRITE_BATCH_ROWS);
    const statements = chunk.map((hash) => ({
      sql: "INSERT OR IGNORE INTO corpus_document_shingles (representation_id, shingle_hash, fingerprint_version, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)",
      args: [representationId, hash, fingerprintVersion],
    }));
    await client.batch(statements, "write");
  }
  return { shingleCount: hashes.size };
}

export type SeedArchiveDocumentOptions = {
  corpusVersion: string;
  /**
   * Honest first_seen_at for this archive snapshot — see
   * lib/user-submission-corpus.ts's createReusableDocumentRepresentation's
   * own firstSeenAt doc comment. Must be a real fact (e.g. the archive
   * build's own generation timestamp, public/data/risk-calibration.json's
   * generatedAt or the index file's own mtime), never fabricated, and never
   * "now" — that would just re-impose the 7-day wait this exists to avoid
   * for genuinely pre-existing content.
   */
  firstSeenAt: string;
  fingerprintVersion?: string;
};

export type SeedArchiveDocumentResult =
  | { status: "SEEDED"; archiveArticleId: string; representationId: string; shingleCount: number }
  | { status: "ALREADY_SEEDED"; archiveArticleId: string; representationId: string };

/** Idempotent — safe to re-run; a second run for the same archiveArticleId no-ops via the archive_document_representations lookup. */
export async function seedArchiveDocument(
  client: Client,
  entry: ArchiveSeedSourceEntry,
  options: SeedArchiveDocumentOptions,
): Promise<SeedArchiveDocumentResult> {
  const fingerprintVersion = options.fingerprintVersion ?? ARCHIVE_FINGERPRINT_VERSION;
  const existing = await client.execute({
    sql: "SELECT representation_id FROM archive_document_representations WHERE archive_article_id = ?",
    args: [entry.archiveArticleId],
  });
  const existingRow = existing.rows[0] as unknown as { representation_id: string } | undefined;
  if (existingRow) {
    return { status: "ALREADY_SEEDED", archiveArticleId: entry.archiveArticleId, representationId: existingRow.representation_id };
  }

  const canonicalText = canonicalizeText(entry.text);
  const canonicalHash = canonicalSha256(canonicalText);
  const existingRepresentation = await findReusableRepresentationByCanonicalHash(client, canonicalHash);
  const representation = existingRepresentation ?? await createReusableDocumentRepresentation(client, {
    canonicalText,
    extractorVersion: ARCHIVE_EXTRACTOR_VERSION,
    firstSeenAt: options.firstSeenAt,
  });
  const { shingleCount } = await recordArchiveDocumentShingles(client, representation.id, canonicalText, fingerprintVersion);

  await client.execute({
    sql: `INSERT INTO archive_document_representations
          (archive_article_id, representation_id, title, source_type, original_similarity, archive_order, corpus_version, fingerprint_version, created_at)
          VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [entry.archiveArticleId, representation.id, entry.title, "Publication", entry.originalSimilarity, entry.archiveOrder ?? null, options.corpusVersion, fingerprintVersion],
  });

  return { status: "SEEDED", archiveArticleId: entry.archiveArticleId, representationId: representation.id, shingleCount };
}

export async function seedArchiveCorpus(
  client: Client,
  entries: ArchiveSeedSourceEntry[],
  options: SeedArchiveDocumentOptions,
): Promise<SeedArchiveDocumentResult[]> {
  const results: SeedArchiveDocumentResult[] = [];
  for (const entry of entries) {
    results.push(await seedArchiveDocument(client, entry, options));
  }
  return results;
}
