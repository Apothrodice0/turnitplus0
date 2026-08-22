-- Controlled live-report integration for the corpus-admission gate: a
-- durable job/status record per report, so a failed admission attempt is
-- visible (queryable) and retryable rather than only ever surfacing as a
-- console.error line. One row per report, ever (unique on source_ref) —
-- see lib/corpus-admission-report-integration.ts's own header comment.
--
-- source_ref here is intentionally NOT a bare document_identity_id: it is
-- built from (account_id, device_key, report_id) directly, so cleanup for
-- one report can never be ambiguous with, or reach, another report's row —
-- independent of whatever document_identities' own lifecycle/uniqueness
-- guarantees happen to be. account_id/device_key/report_id are also stored
-- as their own columns (not just folded into source_ref) so a report/
-- account deletion, or a consent-revocation cleanup, never needs to parse
-- source_ref back apart.
--
-- The row is created SYNCHRONOUSLY, in the same request that inserts the
-- report — never only inside runAfterResponse's deferred callback — so a
-- process that crashes (or is recycled) after sending the response but
-- before that deferred work ever starts still leaves a durable 'pending'
-- row for a later retry sweep to find. Creation itself never changes an
-- existing row's status/decision_id/attempt_count (ON CONFLICT DO NOTHING)
-- — only actual processing (lib/corpus-admission-report-integration.ts's
-- processReportAdmissionJob) ever advances those.
CREATE TABLE IF NOT EXISTS corpus_admission_report_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  source_ref TEXT NOT NULL,
  account_id TEXT NOT NULL,
  device_key TEXT NOT NULL,
  report_id TEXT NOT NULL,
  -- 'pending'   — created, not yet (successfully) processed.
  -- 'succeeded' — the gate produced a decision (ACCEPT, REVIEW, or REJECT
  --               are all a successful EVALUATION; a REJECT is not a
  --               failure). decision_id is set.
  -- 'failed'    — the gate call itself threw (an operational error) —
  --               retry-eligible.
  -- 'cancelled' — was pending/failed when the account's consent was
  --               revoked; will never be retried automatically. A
  --               'succeeded' job is NEVER touched by consent revocation —
  --               accepted corpus content is durable (see
  --               lib/corpus-admission-report-integration.ts's own header
  --               comment) — so this status never applies to accepted work.
  status TEXT NOT NULL,
  -- Deliberately ON DELETE SET NULL, not CASCADE: the job row's own
  -- lifecycle (visibility/retryability) is independent of whether its
  -- decision row still exists. Report/account deletion removes both rows
  -- explicitly and together (source_ref-scoped) rather than relying on this
  -- FK action to do it.
  decision_id TEXT REFERENCES corpus_admission_decisions(id) ON DELETE SET NULL,
  -- Set (not NULL) only while a worker (the deferred callback, a manual
  -- retry, or a sweep) is actively working this job — the atomic-claim
  -- marker a concurrent sweep checks so the SAME job is never processed
  -- twice at once. Always cleared back to NULL once processing concludes
  -- (succeeded or failed), and reclaimable by a later sweep once stale
  -- (see runReportAdmissionRetrySweep's own comment) in case the process
  -- that claimed it died mid-attempt.
  claimed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_corpus_admission_report_jobs_source_ref ON corpus_admission_report_jobs(source_ref);
CREATE INDEX IF NOT EXISTS idx_corpus_admission_report_jobs_account_id ON corpus_admission_report_jobs(account_id);
-- Covers the sweep's own claim query (status IN ('pending','failed') AND
-- (claimed_at IS NULL OR claimed_at < ?)) directly.
CREATE INDEX IF NOT EXISTS idx_corpus_admission_report_jobs_sweep_candidates ON corpus_admission_report_jobs(status, claimed_at);
