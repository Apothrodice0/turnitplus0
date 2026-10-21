-- REPORT DOCUMENT LAYOUT (2026-10-21) — the original document's formatting, captured in the customer's browser
-- during the ONE upload (lib/report-document-layout-client.ts) and used for the printed report's manuscript pages
-- (components/report/report-v2/formatted-manuscript.tsx). Additive only: no existing table changes.
--
-- Private by construction: rows are keyed by the report AND its owner, and are only ever read or written through
-- app/api/reports/[id]/document-layout (session + saved_reports ownership check). Never public, never in logs.
-- Removed with the report (report delete, room replacement, account deletion).
--
-- layout_json: versioned structure only (paragraphs, runs, lists, tables, image references) — no original file.
-- report_document_media: the document's own embedded images, downscaled in the browser before upload.

CREATE TABLE IF NOT EXISTS report_document_layouts (
  report_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  layout_version INTEGER NOT NULL,
  text_sha256 TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  media_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (report_id, user_id)
);

CREATE TABLE IF NOT EXISTS report_document_media (
  report_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  media_index INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (report_id, user_id, media_index)
);

CREATE INDEX IF NOT EXISTS report_document_layouts_user_idx ON report_document_layouts (user_id);
CREATE INDEX IF NOT EXISTS report_document_media_user_idx ON report_document_media (user_id);
