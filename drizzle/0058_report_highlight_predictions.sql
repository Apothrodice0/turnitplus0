-- HIGHLIGHT PREDICTIONS — the passages the highlight model predicts for one saved report, computed once in the background
-- and read back on every later view, so reopening or downloading a report never calls the model. Additive only: one new
-- table, nothing existing is altered and nothing is backfilled. Nothing reads or writes it while
-- HIGHLIGHT_MODEL_ENABLED is off (lib/highlight-model.ts), so an environment can apply this before it turns the feature on.
--
-- One row per saved report; there is no manuscript text here, only character offsets into that report's own text.
--   account_id    the report's owner. Reuse of an earlier result never crosses accounts.
--   model_version the exact model that produced the ranges, and text_sha256 the exact text it read (sha-256 of
--                 comparisonText): a row answers only for that pair.
--   status        pending | running | complete | failed. 'failed' is final and leaves the verified report as it was.
--   attempts, lease_until, next_attempt_at   one worker at a time, bounded retries with backoff.
-- Every timestamp is INTEGER milliseconds since the Unix epoch (UTC), the convention of drizzle/0057.
--
-- Rows are deleted with their report (lib/account-deletion.ts, app/api/reports), including by subscription-expiry
-- cleanup. There is no foreign key: saved_reports has none to offer on (device_key, id), as with
-- report_historical_match_snapshots.
CREATE TABLE IF NOT EXISTS report_highlight_predictions (
  report_device_key TEXT NOT NULL,
  report_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  ranges_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (report_device_key, report_id)
);
CREATE INDEX IF NOT EXISTS report_highlight_predictions_reuse
  ON report_highlight_predictions (account_id, model_version, text_sha256, status);
CREATE INDEX IF NOT EXISTS report_highlight_predictions_due
  ON report_highlight_predictions (status, next_attempt_at);

-- The daily usage ceiling: words sent to the model service per UTC day (YYYY-MM-DD), reserved before each call and
-- never more than HIGHLIGHT_MODEL_DAILY_WORD_LIMIT, so spending stops at once when the day's budget is used. A call
-- that does not fit waits for the next day. Holds counts only.
CREATE TABLE IF NOT EXISTS highlight_model_usage_daily (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL,
  words INTEGER NOT NULL
);
