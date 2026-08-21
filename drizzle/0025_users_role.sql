-- Developer/admin authorization: adds users.role, additive and backward
-- compatible (every existing row gets the same "user" default a brand-new
-- signup gets — see db/schema.ts's own comment on this column). The only
-- code path that ever writes "admin" is lib/admin-role.ts's
-- maybePromoteToAdmin(), called from /api/auth/login and /api/auth/signup,
-- which compares the account's own normalized email against the single
-- ADMIN_EMAIL environment variable — that address is never hardcoded into
-- this repository.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
