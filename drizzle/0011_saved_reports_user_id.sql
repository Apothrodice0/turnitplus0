-- Adds optional account scoping to saved_reports, additively. This is a
-- brand-new nullable column with a REFERENCES clause, which SQLite/libSQL
-- support as a plain ALTER TABLE ADD COLUMN (no table rebuild) — a rebuild
-- (see 0007) is only required when an EXISTING column's constraint changes.
-- Existing rows get NULL, i.e. they remain anonymous/device_key-only.
ALTER TABLE saved_reports ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_saved_reports_user_id_created ON saved_reports(user_id, report_created_at);
