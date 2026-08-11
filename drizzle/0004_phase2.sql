PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

-- Add contribution policy column to documents
ALTER TABLE documents ADD COLUMN contribution_policy_version TEXT;

-- Recreate document_chunks without raw text column and with token_start
CREATE TABLE IF NOT EXISTS __new_document_chunks (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  document_id text NOT NULL,
  chunk_index integer NOT NULL,
  token_count integer NOT NULL,
  token_start integer NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);
INSERT INTO __new_document_chunks (id, document_id, chunk_index, token_count, token_start, created_at)
  SELECT id, document_id, chunk_index, token_count, 0, created_at FROM document_chunks;
DROP TABLE document_chunks;
ALTER TABLE __new_document_chunks RENAME TO document_chunks;

-- Create contributions table for contribution identifiers
CREATE TABLE IF NOT EXISTS contributions (
  contribution_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  contribution_policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
);

COMMIT;
PRAGMA foreign_keys=ON;
