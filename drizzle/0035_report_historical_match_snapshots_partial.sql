-- Marks a cached report_historical_match_snapshots row as the product of a
-- soft time-budget exit (lib/user-submission-matching.ts's own
-- matchTimeBudgetMs — see that file's TIMEOUT HONESTY comment) rather than a
-- complete computation. A partial row is never treated as final — see
-- lib/report-historical-match.ts's isCurrentVersion, extended to always
-- recompute it on next view, the same "never cache the incomplete case as
-- settled" rule NO_HISTORICAL_MATCH already gets (Phase E8E). NULL/0 means
-- the computation ran to completion; this is the common case for every
-- existing row, so no backfill is needed.
ALTER TABLE report_historical_match_snapshots ADD COLUMN is_partial INTEGER NOT NULL DEFAULT 0;
