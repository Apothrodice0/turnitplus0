-- Restores ON DELETE CASCADE on document_chunks.document_id -> documents.id.
-- 0002_handy_forgotten_one.sql originally set this FK to CASCADE;
-- 0004_phase2.sql's unrelated table rebuild (dropping the `text` column,
-- adding `token_start`) silently reverted it to NO ACTION as a side effect
-- of recreating the table, and also dropped the unique index that
-- 0005_restore_document_chunks_unique_index.sql later restored. This
-- migration rebuilds document_chunks again with CASCADE reinstated, and
-- recreates that same unique index in the same transaction so it is not
-- lost a second time.
--
-- Every other document-owned child table (chunk_fingerprints, analysis_runs,
-- matches, match_segments, contributions) already cascades from its parent;
-- this brings document_chunks in line with that pattern, matching what 0002
-- originally intended.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS __new_document_chunks (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  document_id text NOT NULL,
  chunk_index integer NOT NULL,
  token_count integer NOT NULL,
  token_start integer NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON UPDATE NO ACTION ON DELETE CASCADE
);
INSERT INTO __new_document_chunks (id, document_id, chunk_index, token_count, token_start, created_at)
  SELECT id, document_id, chunk_index, token_count, token_start, created_at FROM document_chunks;
DROP TABLE document_chunks;
ALTER TABLE __new_document_chunks RENAME TO document_chunks;

CREATE UNIQUE INDEX IF NOT EXISTS ux_document_chunks_document_chunk_idx ON document_chunks(document_id, chunk_index);

COMMIT;
PRAGMA foreign_keys=ON;
