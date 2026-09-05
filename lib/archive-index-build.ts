import type { Client, InStatement } from "@libsql/client";
import { canonicalizeText } from "./canonical-text";
import { computeArchiveFingerprint, ARCHIVE_COMPACT_FINGERPRINT_VERSION } from "./archive-fingerprint";
import {
  phraseIndexInsertStatements,
  clearPhraseIndex,
  optimizePhraseIndex,
  ARCHIVE_PHRASE_INDEX_VERSION,
} from "./archive-phrase-index";
import {
  buildDfBandTable,
  ARCHIVE_DF_BAND_POLICY_VERSION,
  MIN_PERSISTED_DF,
  type DfBandBuildResult,
} from "./archive-df-bands";

/**
 * 100k-scale architecture — the deterministic build / rebuild path for the
 * scalable built-in-archive index (drizzle/0049). Reconstructs everything
 * from corpus_document_representations.canonical_text; never reads the old
 * per-archive-document corpus_document_shingles rows and never writes them.
 *
 * Offline / import-time only (tools/seed-archive-corpus.ts, one-off jobs) —
 * never a live request path. Idempotent: re-running rebuilds the same rows.
 *
 * Ordinary user-submission / historical-corpus behaviour is untouched:
 * nothing here reads or writes corpus_document_shingles, corpus_submission_
 * references, corpus_admission_*, or any relationship/eligibility state.
 */

const FINGERPRINT_WRITE_BATCH_ROWS = 4_000;

type ArchiveRepresentationRow = { representation_id: string; canonical_text: string };

/** Every representation backing a built-in archive document, with its canonical text. */
export async function loadArchiveRepresentations(client: Client): Promise<ArchiveRepresentationRow[]> {
  const rows = await client.execute(
    `SELECT a.representation_id AS representation_id, c.canonical_text AS canonical_text
       FROM archive_document_representations a
       JOIN corpus_document_representations c ON c.id = a.representation_id`,
  );
  return rows.rows.map((r) => {
    const row = r as unknown as ArchiveRepresentationRow;
    return { representation_id: String(row.representation_id), canonical_text: String(row.canonical_text) };
  });
}

/**
 * Write ONE archive document's compact fingerprint set (per-doc seed path).
 * Same bounded-batch, idempotent-on-retry INSERT OR IGNORE shape
 * lib/archive-corpus-seed.ts's recordArchiveDocumentShingles used for the old
 * full-shingle table (against ux_archive_document_fingerprints_repr_version_
 * hash). ~120 rows, never thousands.
 */
export async function recordArchiveDocumentFingerprints(
  client: Client,
  representationId: string,
  canonicalText: string,
  fingerprintVersion: string = ARCHIVE_COMPACT_FINGERPRINT_VERSION,
): Promise<{ fingerprintCount: number; trimmedByHardCap: boolean }> {
  const { fingerprints, trimmedByHardCap } = computeArchiveFingerprint(canonicalText);
  const statements = fingerprints.map<InStatement>((f) => ({
    sql: `INSERT OR IGNORE INTO archive_document_fingerprints
          (representation_id, fingerprint_hash, optional_position, fingerprint_version, created_at)
          VALUES (?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [representationId, f.hash, f.position, fingerprintVersion],
  }));
  for (let offset = 0; offset < statements.length; offset += FINGERPRINT_WRITE_BATCH_ROWS) {
    await client.batch(statements.slice(offset, offset + FINGERPRINT_WRITE_BATCH_ROWS), "write");
  }
  return { fingerprintCount: fingerprints.length, trimmedByHardCap };
}

/** Add ONE archive document to the phrase index (used by the per-doc seed path). */
export async function recordArchiveDocumentPhraseEntry(
  client: Client,
  representationId: string,
  canonicalText: string,
): Promise<void> {
  await client.batch(phraseIndexInsertStatements(representationId, canonicalText), "write");
}

// ── full rebuilds ───────────────────────────────────────────────────────────

export async function rebuildArchiveCompactFingerprints(
  client: Client,
  options: { fingerprintVersion?: string } = {},
): Promise<{ documents: number; fingerprintRows: number; hardCapHits: number }> {
  const fingerprintVersion = options.fingerprintVersion ?? ARCHIVE_COMPACT_FINGERPRINT_VERSION;
  const reps = await loadArchiveRepresentations(client);
  await client.execute({
    sql: `DELETE FROM archive_document_fingerprints WHERE fingerprint_version = ?`,
    args: [fingerprintVersion],
  });
  let fingerprintRows = 0;
  let hardCapHits = 0;
  let batch: InStatement[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await client.batch(batch, "write");
    batch = [];
  };
  for (const rep of reps) {
    const { fingerprints, trimmedByHardCap } = computeArchiveFingerprint(rep.canonical_text);
    if (trimmedByHardCap) hardCapHits += 1;
    for (const f of fingerprints) {
      batch.push({
        sql: `INSERT OR IGNORE INTO archive_document_fingerprints
              (representation_id, fingerprint_hash, optional_position, fingerprint_version, created_at)
              VALUES (?,?,?,?,CURRENT_TIMESTAMP)`,
        args: [rep.representation_id, f.hash, f.position, fingerprintVersion],
      });
      fingerprintRows += 1;
      if (batch.length >= FINGERPRINT_WRITE_BATCH_ROWS) await flush();
    }
  }
  await flush();
  return { documents: reps.length, fingerprintRows, hardCapHits };
}

export async function rebuildArchivePhraseIndex(client: Client): Promise<{ documents: number }> {
  const reps = await loadArchiveRepresentations(client);
  await clearPhraseIndex(client);
  const BATCH_DOCS = 200;
  let batch: InStatement[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await client.batch(batch, "write");
    batch = [];
  };
  for (const rep of reps) {
    batch.push(...phraseIndexInsertStatements(rep.representation_id, rep.canonical_text));
    if (batch.length >= BATCH_DOCS * 2) await flush();
  }
  await flush();
  await optimizePhraseIndex(client);
  return { documents: reps.length };
}

export async function rebuildArchiveDfBands(
  client: Client,
  options: { policyVersion?: string; minPersistedDf?: number } = {},
): Promise<DfBandBuildResult> {
  const reps = await loadArchiveRepresentations(client);
  return buildDfBandTable(client, reps.map((r) => r.representation_id), {
    policyVersion: options.policyVersion ?? ARCHIVE_DF_BAND_POLICY_VERSION,
    minPersistedDf: options.minPersistedDf ?? MIN_PERSISTED_DF,
  });
}

export type ArchiveScalableIndexRebuildSummary = {
  versions: {
    compactFingerprint: string;
    dfBandPolicy: string;
    phraseIndex: string;
  };
  fingerprints: Awaited<ReturnType<typeof rebuildArchiveCompactFingerprints>>;
  phraseIndex: Awaited<ReturnType<typeof rebuildArchivePhraseIndex>>;
  dfBands: DfBandBuildResult;
};

/**
 * One-shot deterministic rebuild of all three structures, in dependency
 * order (fingerprints and the phrase index are independent; the df-band
 * build reconstructs the same 5-gram sets and must run last only for a tidy
 * end state, not correctness). `canonicalize` re-derives canonical_text for
 * every archive representation first — normally a no-op, but a safety net if
 * canonicalization changed.
 */
export async function rebuildArchiveScalableIndex(
  client: Client,
  options: {
    fingerprintVersion?: string;
    dfBandPolicyVersion?: string;
    dfBandMinPersistedDf?: number;
  } = {},
): Promise<ArchiveScalableIndexRebuildSummary> {
  const fingerprints = await rebuildArchiveCompactFingerprints(client, { fingerprintVersion: options.fingerprintVersion });
  const phraseIndex = await rebuildArchivePhraseIndex(client);
  const dfBands = await rebuildArchiveDfBands(client, {
    policyVersion: options.dfBandPolicyVersion,
    minPersistedDf: options.dfBandMinPersistedDf,
  });
  return {
    versions: {
      compactFingerprint: options.fingerprintVersion ?? ARCHIVE_COMPACT_FINGERPRINT_VERSION,
      dfBandPolicy: options.dfBandPolicyVersion ?? ARCHIVE_DF_BAND_POLICY_VERSION,
      phraseIndex: ARCHIVE_PHRASE_INDEX_VERSION,
    },
    fingerprints,
    phraseIndex,
    dfBands,
  };
}

/** Re-canonicalise every archive representation's stored canonical_text
 *  (idempotent — canonicalizeText is deterministic). Exposed for a rebuild
 *  that follows a canonicalization-version change; not called by the normal
 *  seed path. */
export async function recanonicaliseArchiveRepresentations(client: Client): Promise<{ updated: number }> {
  const reps = await client.execute(
    `SELECT a.representation_id AS id, c.canonical_text AS canonical_text
       FROM archive_document_representations a
       JOIN corpus_document_representations c ON c.id = a.representation_id`,
  );
  let updated = 0;
  for (const r of reps.rows) {
    const row = r as unknown as { id: string; canonical_text: string };
    const recanonicalised = canonicalizeText(String(row.canonical_text));
    if (recanonicalised !== String(row.canonical_text)) {
      await client.execute({
        sql: `UPDATE corpus_document_representations SET canonical_text = ? WHERE id = ?`,
        args: [recanonicalised, String(row.id)],
      });
      updated += 1;
    }
  }
  return { updated };
}
