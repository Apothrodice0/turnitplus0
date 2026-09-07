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
