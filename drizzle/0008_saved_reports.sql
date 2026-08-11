-- Phase 1 persistent reports. Independent of the corpus-contribution schema
-- (documents/document_chunks/.../contributions) — this table stores a user's
-- own completed similarity/AI report for later retrieval, not corpus data,
-- so it deliberately has no foreign keys into that schema.
--
-- No authentication exists yet. device_key is a client-generated random
-- identifier (soft scoping, not an authenticated user id) sent with every
-- request; it is part of the primary key so two different browsers can never
-- collide on the same report id.
CREATE TABLE IF NOT EXISTS saved_reports (
  id TEXT NOT NULL,
  device_key TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  title TEXT NOT NULL,
  report_created_at TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  archive_score INTEGER NOT NULL,
  score_band TEXT NOT NULL,
  ai_score INTEGER,
  ai_tone TEXT,
  payload_json TEXT NOT NULL,
  saved_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  PRIMARY KEY (device_key, id)
);

CREATE INDEX IF NOT EXISTS idx_saved_reports_device_key_created ON saved_reports(device_key, report_created_at);
