-- Phase A: 7-day corpus maturity (CORPUS_ACTIVATION_DELAY_DAYS = 7). Purely
-- additive — two range indexes, no new column, no backfill, no data mutation,
-- no down migration.
--
-- Every TurnitPlus corpus backing waits 7 full days before it can contribute
-- plagiarism evidence. Backing-level maturity T0 is:
--   submission-reference backing  -> corpus_submission_references.created_at
--   admission-promotion backing   -> corpus_admission_decisions.created_at
--                                     WHERE decisions.id = promotions.decision_id
-- (the promotion's OWN decision — immutable, one row per evaluation — not the
-- canonical-SHA-unique corpus_admission_accepted_representations.created_at,
-- which is frozen to the first-accepted sample and would let a later backing
-- inherit an older age; not corpus_document_representations.first_seen_at; not
-- the mutable corpus_admission_promotions.updated_at.)
--
-- lib/user-submission-corpus.ts's admissionEligibilitySql() adds
-- `<T0> <= :maturityCutoff` (== asOf - 7 days) to each backing arm and
-- `r.first_seen_at <= :maturityCutoff` to the legacy fallback. That predicate
-- is a per-representation EXISTS already served by the existing
-- idx_corpus_submission_references_representation_id /
-- idx_corpus_admission_promotions_representation_id + primary-key indexes, so
-- these two indexes are NOT for that path.
--
-- They exist for lib/report-historical-match.ts's time-based snapshot
-- invalidation (corpusBackingMaturedInWindow): a conservative corpus-wide
-- EXISTS over `T0 IN (snapshot.computed_at - 7 days, asOf - 7 days]` that runs
-- on every cached-snapshot reuse decision (no corpus_match_generation write
-- happens when a backing simply reaches 7 days old). Without a created_at
-- index that check is a full SCAN of both tables on every score read; with it,
-- an indexed range SEARCH.
CREATE INDEX IF NOT EXISTS idx_corpus_submission_references_created_at
  ON corpus_submission_references(created_at);

CREATE INDEX IF NOT EXISTS idx_corpus_admission_decisions_created_at
  ON corpus_admission_decisions(created_at);
