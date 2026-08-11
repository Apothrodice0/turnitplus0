-- 0004_phase2.sql recreated document_chunks (DROP TABLE + rename) after
-- 0003_indexes_and_uniques.sql had already created
-- ux_document_chunks_document_chunk_idx on it. SQLite drops indexes when
-- their table is dropped, so the unique constraint was silently lost.
-- This restores it. IF NOT EXISTS makes it safe to run both against a
-- fresh database (applied right after 0004) and against an
-- already-migrated database that is missing only this index.
CREATE UNIQUE INDEX IF NOT EXISTS ux_document_chunks_document_chunk_idx ON document_chunks(document_id, chunk_index);
