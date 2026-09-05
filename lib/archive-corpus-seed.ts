import fs from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { canonicalizeText } from "./canonical-text";
import { canonicalSha256 } from "./document-identity";
import {
  createReusableDocumentRepresentation,
  findReusableRepresentationByCanonicalHash,
} from "./user-submission-corpus";
import {
  recordArchiveDocumentFingerprints,
  recordArchiveDocumentPhraseEntry,
  rebuildArchiveDfBands,
} from "./archive-index-build";
import { optimizePhraseIndex } from "./archive-phrase-index";
// archiveShingleHashes / ARCHIVE_SHINGLE_SIZE now live in the leaf module
// lib/archive-fingerprint.ts (breaking the seed -> index-build -> df-bands ->
// seed import cycle); re-exported here so existing importers are unaffected.
export { archiveShingleHashes, ARCHIVE_SHINGLE_SIZE } from "./archive-fingerprint";

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

/**
 * The OLD full-shingle namespace (corpus_document_shingles.fingerprint_version
 * for archive rows) — retained ONLY because archive_document_representations
 * .fingerprint_version still records it as a historical fact. As of the
 * scalable-index slice (drizzle/0049) the seed path no longer writes
 * corpus_document_shingles rows under this namespace at all; candidate
 * discovery reads archive_document_fingerprints (ARCHIVE_COMPACT_FINGERPRINT_
 * VERSION) instead. See lib/archive-fingerprint.ts / lib/archive-corpus-matching.ts.
 */
export const ARCHIVE_FINGERPRINT_VERSION = "archive-shingle-v1";
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
  /** Compact-fingerprint generation. Defaults to ARCHIVE_COMPACT_FINGERPRINT_VERSION. */
  fingerprintVersion?: string;
};

export type SeedArchiveDocumentResult =
  | { status: "SEEDED"; archiveArticleId: string; representationId: string; fingerprintCount: number }
  | { status: "ALREADY_SEEDED"; archiveArticleId: string; representationId: string };

/**
 * Idempotent — a re-run for the same archiveArticleId no-ops via the
 * archive_document_representations lookup. On the SEEDED path it produces
 * exactly: canonical representation, archive metadata row, compact
 * fingerprints (archive_document_fingerprints), and a phrase-index entry
 * (archive_phrase_fts + archive_phrase_fts_map). It NO LONGER writes any
 * corpus_document_shingles rows — the ~5,500-rows-per-doc full-shingle write
 * is gone. The archive-global DF-band table is built once per corpus by
 * seedArchiveCorpus() / lib/archive-index-build.ts after all documents are in.
 *
 * SHARED-REPRESENTATION SAFETY: if findReusableRepresentationByCanonicalHash
 * returns a representation that a genuine user submission already created,
 * that row's own corpus_document_shingles (written under CORPUS_FINGERPRINT_
 * VERSION by the historical-corpus path) are NEVER touched here — this
 * function only ever adds archive-namespaced fingerprint/phrase rows keyed by
 * representation_id, and never deletes anything.
 */
export async function seedArchiveDocument(
  client: Client,
  entry: ArchiveSeedSourceEntry,
  options: SeedArchiveDocumentOptions,
): Promise<SeedArchiveDocumentResult> {
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

  const { fingerprintCount } = await recordArchiveDocumentFingerprints(
    client,
    representation.id,
    canonicalText,
    options.fingerprintVersion,
  );

  await client.execute({
    sql: `INSERT INTO archive_document_representations
          (archive_article_id, representation_id, title, source_type, original_similarity, archive_order, corpus_version, fingerprint_version, created_at)
          VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      entry.archiveArticleId,
      representation.id,
      entry.title,
      "Publication",
      entry.originalSimilarity,
      entry.archiveOrder ?? null,
      options.corpusVersion,
      // archive_document_representations.fingerprint_version keeps recording
      // the historical full-shingle namespace for continuity with drizzle/0048.
      ARCHIVE_FINGERPRINT_VERSION,
    ],
  });

  await recordArchiveDocumentPhraseEntry(client, representation.id, canonicalText);

  return { status: "SEEDED", archiveArticleId: entry.archiveArticleId, representationId: representation.id, fingerprintCount };
}

/**
 * Seeds every entry, then finalises the corpus-global structures: rebuilds
 * the compact DF-band table (which needs every document present to tally true
 * archive-wide DF) and merges the FTS b-tree segments. Idempotent.
 */
export async function seedArchiveCorpus(
  client: Client,
  entries: ArchiveSeedSourceEntry[],
  options: SeedArchiveDocumentOptions,
): Promise<SeedArchiveDocumentResult[]> {
  const results: SeedArchiveDocumentResult[] = [];
  for (const entry of entries) {
    results.push(await seedArchiveDocument(client, entry, options));
  }
  await rebuildArchiveDfBands(client);
  await optimizePhraseIndex(client);
  return results;
}
