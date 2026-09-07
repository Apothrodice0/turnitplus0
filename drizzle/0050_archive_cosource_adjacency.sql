-- Archive co-source adjacency (100k-scale architecture, slice 2D.4). Purely
-- additive: one new ordinary table plus its indexes and one guard trigger, no
-- existing table altered, no backfill, no down migration, no destructive
-- statement. Every row holds DERIVED, rebuildable data — reconstructible from
-- corpus_document_representations.canonical_text by lib/archive-cosource.ts's
-- buildCosourceAdjacencyTable (invoked from lib/archive-index-build.ts). None
-- of it is read by admissionEligibilitySql or any historical-corpus / SELF /
-- relationship predicate; lib/archive-corpus-matching.ts is the sole reader,
-- and only when process.env.ARCHIVE_COSOURCE_EXPANSION_ENABLED === "true".
--
-- WHY: the bounded compact+phrase archive discovery pipeline (slices 2A/2B)
-- collapses to zero recovered similarity when compact discovery returns ONLY
-- self-excluding candidates — e.g. a near-duplicate pair where both twins are
-- self-excluded (containment >= 0.75), so the real co-source is never scored.
-- Slices 2D.1-2D.3 validated a fix: a directed archive-document adjacency
-- ("co-source") graph, consulted ONLY when the primary result genuinely
-- collapsed (the frozen "G1s" gate — see lib/archive-corpus-matching.ts), whose
-- self-excluded anchors' neighbours are unioned with the primary candidates and
-- handed to the UNCHANGED scoreAgainstArchive. Locked parameters (Slice 2D.3
-- M2/K24): MIN_SHARED = 2, MAX_NEIGHBORS = 24.
--
-- archive_document_cosources: one row per DIRECTED edge
-- (representation_id -> co_representation_id) for a given policy generation.
-- shared_gram_count is the number of archive-informative, non-stop 5-grams the
-- two documents share (owner-capped at the archive maximumDocumentFrequency).
-- policy_version (ARCHIVE_COSOURCE_POLICY_VERSION) namespaces the build
-- semantics so a re-tune adds a new generation beside the old rows, exactly
-- like archive_hash_df_bands.policy_version. Same synthetic-id + composite-
-- unique-index shape as archive_document_fingerprints (drizzle/0049).
-- representation_id / co_representation_id -> corpus_document_representations(id)
-- ON DELETE CASCADE: derived data cannot outlive either endpoint.
--
-- Invariants:
--   * representation_id <> co_representation_id  (CHECK — no self edge)
--   * shared_gram_count >= 2                     (CHECK — MIN_SHARED floor)
--   * one edge per (policy_version, representation_id, co_representation_id)
--     (ux_archive_document_cosources_edge)
--   * at most 24 outgoing neighbours per (representation_id, policy_version)
--     for v1 (trg_archive_document_cosources_max_neighbors — BEFORE INSERT
--     RAISE(ABORT); no DELETE / DROP / ALTER, so no destructive-statement
--     allowlist entry is required in lib/e8-tables-migration-runner.ts)
--
-- idx_archive_document_cosources_lookup covers the request-time lookup
-- (lib/archive-cosource.ts loadCosources):
--   WHERE representation_id IN (...) AND policy_version = ?
CREATE TABLE IF NOT EXISTS archive_document_cosources (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  representation_id     TEXT NOT NULL REFERENCES corpus_document_representations(id) ON DELETE CASCADE,
  co_representation_id  TEXT NOT NULL REFERENCES corpus_document_representations(id) ON DELETE CASCADE,
  shared_gram_count     INTEGER NOT NULL,
  policy_version        TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (representation_id <> co_representation_id),
  CHECK (shared_gram_count >= 2)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_archive_document_cosources_edge
  ON archive_document_cosources(policy_version, representation_id, co_representation_id);
CREATE INDEX IF NOT EXISTS idx_archive_document_cosources_lookup
  ON archive_document_cosources(representation_id, policy_version);
CREATE TRIGGER IF NOT EXISTS trg_archive_document_cosources_max_neighbors
  BEFORE INSERT ON archive_document_cosources
  FOR EACH ROW
  WHEN (
    SELECT COUNT(*) FROM archive_document_cosources
     WHERE representation_id = NEW.representation_id AND policy_version = NEW.policy_version
  ) >= 24
  BEGIN
    SELECT RAISE(ABORT, 'archive_document_cosources v1 allows at most 24 outgoing co-source neighbours per representation per policy version');
  END;
