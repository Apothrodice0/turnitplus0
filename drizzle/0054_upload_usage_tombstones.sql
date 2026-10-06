-- Daily upload quota — USAGE THAT OUTLIVES ITS REPORT. Purely additive: one
-- small table and one trigger. No existing table, column or row is altered,
-- and nothing is backfilled.
--
-- WHY THIS EXISTS
-- The daily quota (lib/upload-limit.ts) counts the saved_reports rows an
-- account saved today. That is exact for as long as the rows exist — a resave
-- never inserts a row and never changes saved_at — but a row that is deleted
-- stops being counted, so deleting a report gave its upload back: upload,
-- delete, upload again, without limit. The same happened whenever anything
-- else removed the row (a room's replacement of its expired occupant, the
-- developer rooms reset).
--
-- upload_usage_tombstones holds exactly what that count loses: one row for
-- each report an account uploaded TODAY (UTC) whose saved_reports row no
-- longer exists. The quota is then
--     saved_reports rows saved today  +  tombstones of today
-- which is the number of uploads the server accepted today, whatever became
-- of them. saved_reports stays the one record of an upload while its report
-- exists; this table is only its remainder, not a second count of the same
-- thing.
--
--   user_id   the account that uploaded the deleted report. Deliberately NOT a
--             foreign key: the row is written by a trigger inside a report
--             deletion, and a deletion must never fail because of it.
--             Account deletion removes an account's rows explicitly
--             (lib/account-deletion.ts invalidateSessionsAndDeleteUser).
--   used_at   the deleted row's own saved_at — when the upload was accepted —
--             in SQLite's CURRENT_TIMESTAMP form ("YYYY-MM-DD HH:MM:SS", UTC),
--             so the quota's day window reads it exactly as it reads saved_at.
-- Nothing identifying the report or the device is kept.
--
-- THE TRIGGER
-- Written by the database, not by each deleting code path, so that no present
-- or future way of removing a saved_reports row can give an upload back:
-- DELETE /api/reports/[id], the room replacement in POST /api/reports,
-- lib/account-deletion.ts's bulk delete, an operator's own DELETE.
--   OLD.user_id IS NOT NULL            an anonymous legacy report belongs to no
--                                      account and was never metered.
--   date(OLD.saved_at) = date('now')   only an upload of the current UTC day
--                                      is still inside the quota window; an
--                                      older report's deletion changes no
--                                      count, so nothing is recorded for it.
-- A row is therefore inert from the next UTC midnight on. Old rows may be
-- purged at any time (DELETE ... WHERE used_at < date('now')); none of them
-- is ever read again.
--
-- NOT RECORDED: a report deleted before this migration was applied. Its upload
-- left no trace anywhere, and none is invented.
--
-- ORDER: apply this BEFORE deploying the code that reads the table (the save
-- route's quota check, GET /api/upload-limit, account deletion). It is
-- harmless to code that does not know it.
CREATE TABLE IF NOT EXISTS upload_usage_tombstones (
  id       INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id  TEXT NOT NULL,
  used_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upload_usage_tombstones_user_used_at
  ON upload_usage_tombstones(user_id, used_at);

CREATE TRIGGER IF NOT EXISTS trg_upload_usage_tombstone_on_report_delete
AFTER DELETE ON saved_reports
FOR EACH ROW
WHEN OLD.user_id IS NOT NULL AND date(OLD.saved_at) = date('now')
BEGIN
  INSERT INTO upload_usage_tombstones (user_id, used_at)
  VALUES (OLD.user_id, OLD.saved_at);
END;
