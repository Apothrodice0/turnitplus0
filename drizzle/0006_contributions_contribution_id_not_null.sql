-- 0004_phase2.sql created `contributions` with `contribution_id TEXT PRIMARY KEY`
-- but no explicit NOT NULL. Unlike an INTEGER PRIMARY KEY (a rowid alias,
-- always implicitly NOT NULL), a TEXT PRIMARY KEY in SQLite is NOT
-- automatically NOT NULL — this table was the only one in the schema left
-- without it, discovered by the permanent schema-drift check. Application
-- code (ingestDocument/ingestDocumentLibsql) always supplies a generated
-- UUID here, so this does not change any current behavior; it closes a real
-- gap between the declared primary key and what SQLite actually enforces.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS __new_contributions (
  contribution_id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL,
  contribution_policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
);
INSERT INTO __new_contributions (contribution_id, document_id, contribution_policy_version, created_at)
  SELECT contribution_id, document_id, contribution_policy_version, created_at FROM contributions;
DROP TABLE contributions;
ALTER TABLE __new_contributions RENAME TO contributions;

COMMIT;
PRAGMA foreign_keys=ON;
