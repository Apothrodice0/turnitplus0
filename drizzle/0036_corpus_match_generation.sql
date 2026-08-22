-- A global, monotonically-increasing counter for "corpus eligibility was
-- ADDED" events (a promotion newly indexed, or a deactivated fingerprint
-- reactivated) — see lib/report-historical-match.ts's own header comment
-- for the full argument. Deliberately NOT scoped to a representation:
-- targeted, per-representation invalidation (report_historical_match_snapshots
-- rows already referencing a changed representation) cannot discover a
-- report whose cached snapshot doesn't reference that representation YET
-- but should, once the newly-eligible content is checked against it — by
-- definition, a search over what's ALREADY stored can never find what's
-- MISSING. A global epoch, compared the same way matcher/fingerprint/
-- canonicalization version tags already are, is the only way to make every
-- cached snapshot eligible for a fresh check without knowing in advance
-- which ones are actually affected.
--
-- Eligibility REMOVED (deactivation) does not need this: it can only ever
-- take away a match a report's snapshot already has cached, which targeted,
-- per-representation invalidation already finds correctly (see
-- lib/corpus-admission-admin-actions.ts's own deactivateAcceptedRepresentation,
-- unchanged).
--
-- Single-row table (id=1 enforced by CHECK) rather than a bare config
-- value on some other table, so a bump is one plain UPDATE with no lookup
-- key. Every promotion/reactivation bumps it by 1, even when several land
-- in the same sweep tick or transaction batch — that produces more bumps
-- than strictly necessary (any one of them already invalidates the whole
-- cache), which is wasted work, never wrong behavior.
CREATE TABLE IF NOT EXISTS corpus_match_generation (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  generation INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

INSERT OR IGNORE INTO corpus_match_generation (id, generation) VALUES (1, 0);

-- The generation value a snapshot was computed AT. A cached row is only
-- reused when its own corpus_generation is still >= the CURRENT global
-- generation (lib/report-historical-match.ts's own isCurrentVersion) —
-- exactly the same staleness pattern the existing matcher/fingerprint/
-- canonicalization version columns already use, just a 4th tag.
ALTER TABLE report_historical_match_snapshots ADD COLUMN corpus_generation INTEGER NOT NULL DEFAULT 0;
