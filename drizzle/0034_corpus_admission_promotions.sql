-- Durable job/status record for promoting an ACCEPTed corpus-admission
-- decision's retained text into the shared plagiarism-matching index
-- (corpus_document_representations / corpus_document_shingles — see
-- lib/user-submission-corpus.ts's own header comment). One row per
-- decision, ever (unique on decision_id) — the same "atomic-claim,
-- fresh-connection-per-retry sweep" shape as corpus_admission_report_jobs,
-- see lib/corpus-admission-promotion.ts's own header comment.
--
-- Deliberately carries NO account/report-shaped column: decision_id and
-- accepted_representation_id both resolve only through the admin-only
-- corpus_admission_* tables, never through document_identities. This is
-- what keeps a promoted representation's matching-index presence free of
-- any account/report identity — see lib/corpus-admission-promotion.ts's own
-- header comment for the full argument.
CREATE TABLE IF NOT EXISTS corpus_admission_promotions (
  id TEXT PRIMARY KEY NOT NULL,
  decision_id TEXT NOT NULL REFERENCES corpus_admission_decisions(id),
  accepted_representation_id TEXT NOT NULL REFERENCES corpus_admission_accepted_representations(id),
  -- Set only once status='indexed'. May be shared with other decisions (a
  -- canonical-hash dedup onto a representation another decision, or a real
  -- user submission, already created) or with no one else at all.
  representation_id TEXT REFERENCES corpus_document_representations(id),
  -- 'NEW_CONTENT_REPRESENTATION' | 'EXACT_CANONICAL_DUPLICATE' — reuses
  -- lib/user-submission-corpus.ts's own LinkType vocabulary deliberately.
  -- Set only once status='indexed'. Records whether THIS promotion created
  -- the representation row or reused one that already existed — see
  -- lib/user-submission-corpus.ts's findCandidateCorpusRepresentations for
  -- why eligibility can never be decided from this column alone (a
  -- representation can be backed by several sources at once).
  link_type TEXT,
  -- Which corpus_document_shingles generation this promotion wrote under —
  -- always lib/user-submission-corpus.ts's own CORPUS_FINGERPRINT_VERSION,
  -- deliberately NOT corpus_admission_accepted_shingles' separate
  -- fingerprint scheme (see that table's own schema comment for why the two
  -- are different systems). Set only once status='indexed'.
  fingerprint_version TEXT,
  -- 'staged'  — discovered (an ACCEPT decision with no promotion row yet),
  --             not yet attempted.
  -- 'indexed' — representation + shingles are durably written;
  --             representation_id/link_type/fingerprint_version are set.
  -- 'failed'  — the last attempt threw (an operational error) — retry-
  --             eligible, same as corpus_admission_report_jobs' own
  --             'failed'.
  -- 'skipped' — permanently inapplicable (no retained text exists for this
  --             decision — see corpus_admission_content_store) — NEVER
  --             retried, unlike 'failed'.
  status TEXT NOT NULL DEFAULT 'staged',
  -- Same atomic-claim marker as corpus_admission_report_jobs.claimed_at —
  -- set only while a sweep attempt is actively working this row, cleared
  -- back to NULL once it concludes (indexed/failed/skipped), reclaimable
  -- once stale.
  claimed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_corpus_admission_promotions_decision_id ON corpus_admission_promotions(decision_id);
-- Covers the sweep's own claim query (status IN ('staged','failed') AND
-- (claimed_at IS NULL OR claimed_at < ?)) directly — mirrors
-- idx_corpus_admission_report_jobs_sweep_candidates.
CREATE INDEX IF NOT EXISTS idx_corpus_admission_promotions_sweep_candidates ON corpus_admission_promotions(status, claimed_at);
-- Covers both the matching-eligibility join (lib/user-submission-corpus.ts's
-- findCandidateCorpusRepresentations) and the admin detail lookup.
CREATE INDEX IF NOT EXISTS idx_corpus_admission_promotions_representation_id ON corpus_admission_promotions(representation_id);
