-- Phase E5: the controlled provenance verification decision workflow.
-- Purely additive — no existing table is touched, including
-- provenance_sources/provenance_events (Phase E1) and provenance_evidence
-- (Phase E4).
--
-- Append-only. There is no "verified = true" flag anywhere in this table or
-- elsewhere in the schema — provenance_sources.provenance_state remains the
-- single, current, authoritative answer; this table is the audit trail of
-- the explicit decisions that moved it there (or explicitly declined to).
-- requested_state = previous_state only for a REAFFIRMED decision (reviewed
-- new evidence, an already-VERIFIED_SOURCE stays verified) — the one
-- decision kind with no corresponding provenance_events row, since
-- same-state transitions are never valid. See
-- lib/provenance-verification-workflow.ts for how each decision kind is
-- produced, and lib/provenance-registry.ts's transitionProvenanceState
-- (extended in this phase with an optional extraStatements parameter) for
-- how a decision row and its state transition are written atomically.
CREATE TABLE IF NOT EXISTS provenance_verification_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  source_id TEXT NOT NULL REFERENCES provenance_sources(id) ON DELETE CASCADE,
  previous_state TEXT NOT NULL,
  requested_state TEXT NOT NULL,
  decision TEXT NOT NULL,
  evaluation_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  reason TEXT,
  method TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_provenance_verification_decisions_source_id ON provenance_verification_decisions(source_id);
