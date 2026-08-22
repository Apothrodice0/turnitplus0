-- Real per-account room/slot ownership (replaces the old CAST(id AS INTEGER)
-- % 10 visual grouping, which let unlimited reports silently accumulate in
-- the same room tile — the room number is now an explicit fact recorded at
-- upload time, chosen by the room the user actually opened, not derived from
-- a client-generated id after the fact).
--
-- NULL for every row saved before this migration and for every anonymous
-- (user_id IS NULL) row going forward — rooms are an authenticated-account
-- concept only; anonymous/local history is untouched.
--
-- Backfill: every existing authenticated (user_id IS NOT NULL) report gets
-- room_number = the OLD id%10 formula, preserving exactly which tile it
-- already appeared under today. No rows are deleted or moved — this only
-- ever ADDS a column and fills it in. The one visible behavior change is
-- deliberate and safe: a room's "current occupant" is now derived as the
-- single most-recent report in that room_number less than 24h old (see
-- lib/report-rooms.ts), so a legacy room that had accumulated several
-- reports under the old bug will show only its most recent one as the
-- active occupant going forward; every older row remains in this table,
-- untouched, still reachable at its own permalink and via developer/admin
-- lookup.
ALTER TABLE saved_reports ADD COLUMN room_number INTEGER;

UPDATE saved_reports
SET room_number = CAST(id AS INTEGER) % 10
WHERE user_id IS NOT NULL AND room_number IS NULL;

CREATE INDEX idx_saved_reports_user_room ON saved_reports (user_id, room_number);
