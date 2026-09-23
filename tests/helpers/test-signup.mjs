/**
 * Shared A2 test fixture. Signup now requires a full, server-validated identity
 * profile (canonical country, re-resolved GeoNames city, re-resolved ROR
 * institution or an explicit NONE, libphonenumber-js phone). The vast majority
 * of the suite only needs "an authenticated account to exist", not a specific
 * identity — so those tests spread TEST_SIGNUP_IDENTITY into their signup body.
 *
 * The default is an `independent` account with institution NONE, so it needs NO
 * ROR network call. City 5128581 = New York City (US), country US — a real row
 * in the bundled GeoNames dataset that re-resolves offline and deterministically.
 */
export const TEST_SIGNUP_IDENTITY = Object.freeze({
  fullName: "Test Person",
  accountType: "independent",
  countryCode: "US",
  cityGeonamesId: 5128581,
  phone: { number: "+14155552671" },
  institution: { status: "NONE" },
});

/** Merge the default identity UNDER any explicit fields the caller set. */
export function withTestIdentity(body) {
  return { ...TEST_SIGNUP_IDENTITY, ...body };
}

/**
 * A2: automatic admin promotion from an email string is GONE (lib/admin-role.ts).
 * The admin role is granted only by a deliberate operator UPDATE. Tests that
 * need an admin fixture create the account normally, then call this. `email`
 * defaults to the value in process.env.ADMIN_EMAIL (call BEFORE deleting it).
 */
export async function grantTestAdmin(dbFile, email = process.env.ADMIN_EMAIL) {
  if (!email) throw new Error("grantTestAdmin: no email (pass one, or set process.env.ADMIN_EMAIL first)");
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: `file:${dbFile}` });
  try {
    await client.execute({ sql: "UPDATE users SET role = 'admin' WHERE lower(email) = lower(?)", args: [email] });
  } finally {
    client.close();
  }
}

/**
 * A3 completion (account-activation report-creation gate, app/api/reports/route.ts's
 * own EMAIL VERIFICATION GATE): POST /api/reports now refuses an authenticated account
 * whose users.email_verified_at is still NULL. The vast majority of the suite only
 * needs "an authenticated account that CAN create a report" — not to exercise the
 * verification flow itself (that flow is exhaustively covered by its own dedicated
 * suites: tests/email-verification.test.mjs and
 * tests/account-page-email-verification-render.test.mjs) — so a fixture account is
 * marked verified with a direct UPDATE, exactly like grantTestAdmin above bypasses the
 * real admin-promotion path for the same reason.
 *
 * `dbFile` is the CALLER's own sqlite file path (every affected test file already has one
 * at module scope, passed to its own `createClient({ url: `file:${dbFile}` })`) —
 * matching grantTestAdmin's own signature just above, on purpose: several call sites only
 * ever open a setup client long enough to run migrations and close it immediately
 * afterward (it is never meant to be reused later, from inside a per-test fixture
 * helper), so accepting an already-open client here would silently break the moment a
 * caller's own client isn't guaranteed to still be open — as a first version of this
 * helper actually did (CLIENT_CLOSED from libsql). Opening one short-lived connection per
 * call, exactly like grantTestAdmin, side-steps that lifetime question entirely.
 *
 * Deploy-ordering safety, matching lib/email-verification.ts's own
 * usersHaveEmailVerifiedAtColumn gate: a fixture DB that deliberately omits migration
 * 0046 (a pre-migration/legacy-schema test) has no email_verified_at column to set, and
 * the production gate itself no-ops in that state — so this no-ops too (returns false)
 * rather than throwing on a missing column. A legacy-schema fixture should not call this
 * at all (it wants the column-absent behavior), but calling it by mistake must not turn
 * into a spurious failure.
 *
 * Once the column IS present, this fails loudly (throws) if the UPDATE does not affect
 * exactly one row — a typo'd/mismatched email must never silently leave the fixture
 * account unverified and produce a confusing downstream 403 instead of a clear setup
 * error.
 */
export async function markTestAccountEmailVerified(dbFile, email, now = Date.now()) {
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: `file:${dbFile}` });
  try {
    const info = await client.execute("PRAGMA table_info('users')");
    const hasColumn = info.rows.some((r) => String(r.name) === "email_verified_at");
    if (!hasColumn) return false;
    const result = await client.execute({
      sql: "UPDATE users SET email_verified_at = ? WHERE lower(email) = lower(?)",
      args: [now, email],
    });
    if (Number(result.rowsAffected) !== 1) {
      throw new Error(`markTestAccountEmailVerified: expected to verify exactly 1 account for email ${email}, updated ${result.rowsAffected}`);
    }
    return true;
  } finally {
    client.close();
  }
}
