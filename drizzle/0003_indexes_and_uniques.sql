PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

-- Unique constraints enforced via unique indexes
CREATE UNIQUE INDEX IF NOT EXISTS ux_documents_provenance_sha256 ON documents(provenance_sha256);
CREATE UNIQUE INDEX IF NOT EXISTS ux_document_chunks_document_chunk_idx ON document_chunks(document_id, chunk_index);
CREATE UNIQUE INDEX IF NOT EXISTS ux_index_versions_corpus_version ON index_versions(corpus_version);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_chunk_fingerprints_shingle_hash ON chunk_fingerprints(shingle_hash);
CREATE INDEX IF NOT EXISTS idx_chunk_fingerprints_chunk_id ON chunk_fingerprints(chunk_id);
CREATE INDEX IF NOT EXISTS idx_matches_analysis_run_id ON matches(analysis_run_id);
CREATE INDEX IF NOT EXISTS idx_matches_source_document_id ON matches(source_document_id);
CREATE INDEX IF NOT EXISTS idx_analysis_runs_document_id ON analysis_runs(document_id);

COMMIT;
PRAGMA foreign_keys=ON;
