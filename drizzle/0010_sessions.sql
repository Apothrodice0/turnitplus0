-- Server-side session store. token_hash is SHA-256 (fast hash) of the raw
-- session token that lives in the httpOnly cookie — deliberately NOT
-- scrypt: the token is already 256 bits of random entropy, not a low-
-- entropy human secret, and this table is looked up on every authenticated
-- request, so a slow KDF here would add real latency to every request.
--
-- created_at/expires_at are epoch-millisecond integers, not the TEXT
-- CURRENT_TIMESTAMP convention used elsewhere in this schema: expires_at is
-- range-compared (WHERE expires_at > ?) on every request, and mixing
-- SQLite's CURRENT_TIMESTAMP string format with app-generated values in a
-- comparison would be a real lexicographic-ordering bug. Integers avoid it.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
