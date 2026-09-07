import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import * as loginRoute from "../app/api/auth/login/route.ts";
import * as meRoute from "../app/api/auth/me/route.ts";
import * as citiesRoute from "../app/api/identity/cities/route.ts";
import * as institutionsRoute from "../app/api/identity/institutions/route.ts";
import { __setRorClientFetchForTest } from "../lib/ror-client.ts";
import { resolveSignupIdentity } from "../lib/account-identity-signup.ts";
import { resetAuthRateForTest, resetRateForTest, resetReadRateForTest } from "../lib/rate-limit.js";
import { hashPassword } from "../lib/auth-crypto.ts";

/**
 * A2 — Strict Account Signup. Server-authoritative structured identity, atomic
 * users+profile+session creation, canonical city (bundled GeoNames re-resolve)
 * and institution (ROR re-resolve, stubbed here), everything UNVERIFIED, no
 * fingerprints, no automatic admin promotion, same-origin guard, legacy accounts
 * grandfathered.
 */

const repo = path.resolve(".");
const drizzleDir = path.join(repo, "drizzle");
const dbFile = path.join(repo, "test_account_identity_signup.db");
for (const s of ["", "-wal", "-shm", "-journal"]) {
  try { fs.unlinkSync(dbFile + s); } catch { /* ignore */ }
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.ADMIN_EMAIL;

const setup = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setup, drizzleDir);
setup.close();

// Stub the ROR registry: only MIT (042nb2s44) resolves; everything else 404s.
const MIT = {
  id: "https://ror.org/042nb2s44", status: "active",
  names: [{ value: "Massachusetts Institute of Technology", types: ["ror_display"] }],
  locations: [{ geonames_details: { country_code: "US", name: "Cambridge" } }],
  types: ["education"],
};
function rorStub(fn) {
  __setRorClientFetchForTest(fn ?? (async (url) =>
    String(url).includes("/042nb2s44")
      ? new Response(JSON.stringify(MIT), { status: 200 })
      : String(url).includes("?query=")
        ? new Response(JSON.stringify({ number_of_results: 1, items: [MIT] }), { status: 200 })
        : new Response("{}", { status: 404 })));
}
rorStub();
test.after(() => {
  __setRorClientFetchForTest(null);
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.ADMIN_EMAIL;
  for (const s of ["", "-wal", "-shm", "-journal"]) {
    try { fs.unlinkSync(dbFile + s); } catch { /* ignore */ }
  }
});

const NYC = 5128581;   // New York City, US   (bundled GeoNames)
const LONDON = 2643743; // London, GB
const PARIS = 2988507;  // Paris, FR

let seq = 0;
const uniqEmail = (p) => `${p}-${++seq}@example.test`;

function baseIdentity(over = {}) {
  return {
    fullName: "Ada Lovelace",
    accountType: "researcher",
    countryCode: "US",
    cityGeonamesId: NYC,
    phone: { number: "+14155552671" },
    institution: { status: "ROR", rorId: "042nb2s44" },
    ...over,
  };
}

async function postSignup(body, { ip = `sg-${seq}`, origin } = {}) {
  await resetAuthRateForTest(ip);
  const headers = { "content-type": "application/json", "x-forwarded-for": ip };
  if (origin) headers.origin = origin;
  return signupRoute.POST(new Request("http://localhost/api/auth/signup", { method: "POST", headers, body: JSON.stringify(body) }));
}
async function postLogin(body, ip = `lg-${seq}`) {
  await resetAuthRateForTest(ip);
  return loginRoute.POST(new Request("http://localhost/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body),
  }));
}
const cookieOf = (r) => (r.headers.get("set-cookie") || "").match(/tp_session_v1=([^;]*)/)?.[1] ?? null;
function db() { return createClient({ url: `file:${dbFile}` }); }
async function one(sql, args = []) {
  const c = db();
  try { return (await c.execute({ sql, args })).rows[0] ?? null; } finally { c.close(); }
}

// ===========================================================================
// 1 — valid signup: atomic users + profile + session, resolved identity echoed
// ===========================================================================

test("1: a valid signup creates the account, the 1:1 profile and a session, all UNVERIFIED", async () => {
  const email = uniqEmail("valid");
  const res = await postSignup({ email, password: "correct-horse-1", username: "adauser", ...baseIdentity() });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.user.email, email);
  assert.equal(body.identity.accountType, "researcher");
  assert.equal(body.identity.city.name, "New York City");
  assert.equal(body.identity.institution.status, "ROR");
  assert.equal(body.identity.institution.name, "Massachusetts Institute of Technology");
  assert.ok(cookieOf(res), "a session cookie is issued");
  assert.equal(JSON.stringify(body).toLowerCase().includes("fingerprint"), false);

  const profile = await one(
    "SELECT p.* FROM account_identity_profiles p JOIN users u ON u.id = p.user_id WHERE u.email = ?",
    [email],
  );
  assert.ok(profile, "the 1:1 profile row exists");
  assert.equal(profile.account_type, "researcher");
  assert.equal(profile.full_name, "Ada Lovelace");
  assert.equal(profile.country_code, "US");
  assert.equal(Number(profile.city_geonames_id), NYC);
  assert.equal(profile.institution_ror_id, "042nb2s44");
  assert.equal(profile.phone_e164, "+14155552671");
  assert.equal(profile.email_verified_at, null);
  assert.equal(profile.phone_verified_at, null);
  assert.equal(profile.institution_verified_at, null);

  const fpCount = await one("SELECT COUNT(*) c FROM account_identity_fingerprints");
  assert.equal(Number(fpCount.c), 0, "no identity fingerprint is ever written");
});

// ===========================================================================
// 2 — every required field missing -> rejected, nothing written
// ===========================================================================

test("2: a signup with NO identity fields is rejected and writes nothing", async () => {
  const email = uniqEmail("bare");
  const res = await postSignup({ email, password: "correct-horse-1", username: "bareuser" });
  assert.equal(res.status, 400);
  const body = await res.json();
  const fields = new Set(body.fields.map((f) => f.field));
  for (const f of ["fullName", "accountType", "countryCode", "city", "phone"]) assert.ok(fields.has(f), `missing ${f} reported`);
  assert.equal(await one("SELECT id FROM users WHERE email = ?", [email]), null, "no users row");
});

// ===========================================================================
// 3 — garbage / crafted values are rejected field by field
// ===========================================================================

test("3: garbage and crafted values are rejected with value-free field codes", async () => {
  const res = await postSignup({
    email: uniqEmail("garbage"), password: "correct-horse-1", username: "garbuser",
    ...baseIdentity({
      fullName: "Ann" + String.fromCodePoint(0x202e) + "evil", // bidi override
      accountType: "wizard",
      countryCode: "ZZ",
      cityGeonamesId: "'; DROP TABLE users; --",
      phone: { number: "+1 not a phone 5551234secret" },
      institution: { status: "ROR", rorId: "0deadbeef" },
    }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  const byField = Object.fromEntries(body.fields.map((f) => [f.field, f.code]));
  assert.equal(byField.fullName, "UNSAFE_CHARACTERS");
  assert.equal(byField.accountType, "UNKNOWN_ACCOUNT_TYPE");
  assert.equal(byField.countryCode, "UNKNOWN_COUNTRY");
  assert.equal(byField.city, "UNKNOWN_CITY");
  assert.ok(byField.phone.startsWith("PHONE_"));
  assert.ok(byField.institution === "INVALID_ROR_ID" || byField.institution === "UNKNOWN_ROR");
  // no raw value echoed
  assert.equal(JSON.stringify(body).includes("secret"), false);
  assert.equal(JSON.stringify(body).includes("DROP TABLE"), false);
  assert.equal(JSON.stringify(body).includes("evil"), false);
});

// ===========================================================================
// 4 — unknown country / city / ROR ids
// ===========================================================================

test("4: unknown canonical ids (country, city, ROR) are each rejected", async () => {
  const bad = [
    ["countryCode", { countryCode: "QX" }, "UNKNOWN_COUNTRY"],
    ["city", { cityGeonamesId: 999999999 }, "UNKNOWN_CITY"],
    ["institution", { institution: { status: "ROR", rorId: "03vek6s52" } }, "UNKNOWN_ROR"], // valid checksum, ROR stub 404s it
  ];
  for (const [field, over, code] of bad) {
    const res = await postSignup({ email: uniqEmail("unk"), password: "correct-horse-1", username: "unkuser", ...baseIdentity(over) });
    assert.equal(res.status, 400, `${field} unknown -> 400`);
    const body = await res.json();
    assert.equal(body.fields.find((f) => f.field === field)?.code, code);
  }
});

// ===========================================================================
// 5 — mismatched city / country (client name never trusted; server re-resolves)
// ===========================================================================

test("5: a city whose own country != residence country is rejected; the client city name is ignored", async () => {
  const res = await postSignup({
    email: uniqEmail("mismatch"), password: "correct-horse-1", username: "mmuser",
    ...baseIdentity({ countryCode: "US", cityGeonamesId: LONDON, cityName: "New York City" /* attacker-supplied name, ignored */ }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).fields.find((f) => f.field === "city").code, "CITY_COUNTRY_MISMATCH");

  // the resolver re-derives the name from the id, never the client string
  const r = await resolveSignupIdentity(baseIdentity({ countryCode: "GB", cityGeonamesId: LONDON, cityName: "Atlantis" }));
  assert.equal(r.ok, true);
  assert.equal(r.identity.display.city.name, "London");
  assert.equal(r.identity.normalized.cityGeonamesId, LONDON);
});

// ===========================================================================
// 6 — independent may use institution NONE; affiliated types may not
// ===========================================================================

test("6: independent+NONE succeeds; student/instructor/researcher+NONE is rejected", async () => {
  const indep = await postSignup({
    email: uniqEmail("indep"), password: "correct-horse-1", username: "indepuser",
    ...baseIdentity({ accountType: "independent", institution: { status: "NONE" } }),
  });
  assert.equal(indep.status, 201);
  assert.equal((await indep.json()).identity.institution.status, "NONE");

  for (const accountType of ["student", "instructor", "researcher"]) {
    const res = await postSignup({
      email: uniqEmail(`aff-${accountType}`), password: "correct-horse-1", username: "affuser",
      ...baseIdentity({ accountType, institution: { status: "NONE" } }),
    });
    assert.equal(res.status, 400, `${accountType}+NONE -> 400`);
    assert.equal((await res.json()).fields.find((f) => f.field === "institution").code, "INSTITUTION_REQUIRED");
  }
});

// ===========================================================================
// 7 — arbitrary trusted university text is rejected
// ===========================================================================

test("7: a free-text institution (UNVERIFIED_TEXT) is rejected at signup — no arbitrary trusted university text", async () => {
  const res = await postSignup({
    email: uniqEmail("insttext"), password: "correct-horse-1", username: "ituser",
    ...baseIdentity({ institution: { status: "UNVERIFIED_TEXT", name: "Definitely A Real University" } }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).fields.find((f) => f.field === "institution").code, "TEXT_NOT_ALLOWED");
});

// ===========================================================================
// 8 — malformed phone
// ===========================================================================

test("8: a malformed phone is rejected; a valid one is stored as E.164 with a separate region", async () => {
  for (const number of ["", "12345", "+1 555 CALL NOW", "not-a-number", "++4471234"]) {
    const res = await postSignup({ email: uniqEmail("ph"), password: "correct-horse-1", username: "phuser", ...baseIdentity({ phone: { number } }) });
    assert.equal(res.status, 400, `${JSON.stringify(number)} -> 400`);
    assert.ok((await res.json()).fields.some((f) => f.field === "phone"));
  }
  // residence FR, phone US -> stored separately
  const ok = await postSignup({
    email: uniqEmail("phok"), password: "correct-horse-1", username: "phokuser",
    ...baseIdentity({ countryCode: "FR", cityGeonamesId: PARIS, institution: { status: "NONE" }, accountType: "independent", phone: { number: "+1 415 555 2671" } }),
  });
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).identity.phoneRegion, "US");
});

// ===========================================================================
// 9 — client-supplied VERIFIED state is ignored; role:admin is ignored
// ===========================================================================

test("9: verification state and role sent by the client are ignored — profile stays UNVERIFIED, role stays user", async () => {
  const email = uniqEmail("liar");
  const res = await postSignup({
    email, password: "correct-horse-1", username: "liaruser",
    ...baseIdentity({
      emailVerified: true, phoneVerified: true, institutionVerified: true,
      email_verified_at: 111, phone_verified_at: 222, institution_verified_at: 333,
      role: "admin", normalization_version: 999,
    }),
  });
  assert.equal(res.status, 201);
  const row = await one(
    "SELECT p.email_verified_at, p.phone_verified_at, p.institution_verified_at, p.normalization_version, u.role FROM account_identity_profiles p JOIN users u ON u.id = p.user_id WHERE u.email = ?",
    [email],
  );
  assert.equal(row.email_verified_at, null);
  assert.equal(row.phone_verified_at, null);
  assert.equal(row.institution_verified_at, null);
  assert.equal(Number(row.normalization_version), 1);
  assert.equal(row.role, "user");
});

// ===========================================================================
// 10 — atomic rollback: identity failure -> no users row, no profile, no session
// ===========================================================================

test("10: when identity resolution fails, NOTHING is persisted (no users row, no profile, no session)", async () => {
  const before = Number((await one("SELECT COUNT(*) c FROM users")).c);
  const email = uniqEmail("rollback");

  // ROR registry down -> the institution can't be re-resolved -> whole signup fails
  rorStub(async () => new Response("{}", { status: 503 }));
  const res = await postSignup({ email, password: "correct-horse-1", username: "rbuser", ...baseIdentity() });
  rorStub();
  assert.equal(res.status, 400);
  assert.equal(await one("SELECT id FROM users WHERE email = ?", [email]), null, "no users row");
  assert.equal(Number((await one("SELECT COUNT(*) c FROM users")).c), before, "user count unchanged");
  assert.equal(
    Number((await one("SELECT COUNT(*) c FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?", [email])).c),
    0,
    "no session",
  );
});

// ===========================================================================
// 11 — existing legacy account (no identity profile) still logs in
// ===========================================================================

test("11: a pre-A2 account with no identity profile is grandfathered — login works, me returns identity:null", async () => {
  const c = db();
  const hash = await hashPassword("legacy-pass-1");
  await c.execute({ sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)", args: ["legacy-acct-1", "legacy@example.test", "legacy", hash] });
  c.close();

  const res = await postLogin({ email: "legacy@example.test", password: "legacy-pass-1" });
  assert.equal(res.status, 200);
  const cookie = cookieOf(res);
  await resetRateForTest("legacy-me");
  const meRes = await meRoute.GET(new Request("http://localhost/api/auth/me", { headers: { cookie: `tp_session_v1=${cookie}`, "x-forwarded-for": "legacy-me" } }));
  const meBody = await meRes.json();
  assert.equal(meBody.user.email, "legacy@example.test");
  assert.equal(meBody.identity, null, "no profile -> identity:null, never an error");
});

// ===========================================================================
// 12 — admin-email privilege escalation regression
// ===========================================================================

test("12: a signup (or login) with the configured ADMIN_EMAIL NEVER gains the admin role", async () => {
  process.env.ADMIN_EMAIL = "The-Boss@Example.com";
  try {
    const email = "the-boss@example.com";
    const s = await postSignup({ email, password: "correct-horse-1", username: "bossuser", ...baseIdentity({ accountType: "independent", institution: { status: "NONE" } }) });
    assert.equal(s.status, 201);
    assert.equal((await one("SELECT role FROM users WHERE email = ?", [email])).role, "user", "signup with ADMIN_EMAIL does not promote");

    const l = await postLogin({ email, password: "correct-horse-1" });
    assert.equal(l.status, 200);
    assert.equal((await one("SELECT role FROM users WHERE email = ?", [email])).role, "user", "login with ADMIN_EMAIL does not promote either");
  } finally {
    delete process.env.ADMIN_EMAIL;
  }
});

// ===========================================================================
// 13 — same-origin guard on signup + identity PATCH
// ===========================================================================

test("13: a cross-origin signup or identity PATCH is rejected 403; a same-origin / headerless one is allowed", async () => {
  const cross = await postSignup({ email: uniqEmail("xo"), password: "correct-horse-1", username: "xouser", ...baseIdentity() }, { origin: "https://attacker.example" });
  assert.equal(cross.status, 403);

  // a real signup (no Origin header, like the existing tests / non-browser callers)
  const okRes = await postSignup({ email: uniqEmail("xo-ok"), password: "correct-horse-1", username: "xookuser", ...baseIdentity({ accountType: "independent", institution: { status: "NONE" } }) });
  assert.equal(okRes.status, 201);
  const cookie = cookieOf(okRes);

  await resetRateForTest("xo-patch");
  const crossPatch = await meRoute.PATCH(new Request("http://localhost/api/auth/me", {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: `tp_session_v1=${cookie}`, "x-forwarded-for": "xo-patch", origin: "https://attacker.example" },
    body: JSON.stringify({ username: "xookuser", email: "xo-ok-1@example.test" }),
  }));
  assert.equal(crossPatch.status, 403, "a cross-origin identity PATCH is rejected before any write");
});

// ===========================================================================
// 14 — account edit (me PATCH) applies the SAME server-side validation
// ===========================================================================

test("14: PATCH /api/auth/me re-validates identity the same way; a bad edit changes nothing", async () => {
  const email = uniqEmail("edit");
  const s = await postSignup({ email, password: "correct-horse-1", username: "edituser", ...baseIdentity({ accountType: "independent", institution: { status: "NONE" } }) });
  assert.equal(s.status, 201);
  const cookie = cookieOf(s);

  // bad edit: mismatched city/country
  await resetRateForTest("edit-bad");
  const bad = await meRoute.PATCH(new Request("http://localhost/api/auth/me", {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: `tp_session_v1=${cookie}`, "x-forwarded-for": "edit-bad" },
    body: JSON.stringify({ username: "edituser", email, identity: baseIdentity({ accountType: "independent", institution: { status: "NONE" }, countryCode: "US", cityGeonamesId: PARIS }) }),
  }));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).fields.find((f) => f.field === "city").code, "CITY_COUNTRY_MISMATCH");
  assert.equal(Number((await one("SELECT city_geonames_id FROM account_identity_profiles p JOIN users u ON u.id=p.user_id WHERE u.email=?", [email])).city_geonames_id), NYC, "profile unchanged after a failed edit");

  // good edit: change country + city + become a researcher at MIT
  await resetRateForTest("edit-ok");
  const ok = await meRoute.PATCH(new Request("http://localhost/api/auth/me", {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: `tp_session_v1=${cookie}`, "x-forwarded-for": "edit-ok" },
    body: JSON.stringify({ username: "edituser", email, identity: baseIdentity({ accountType: "researcher", countryCode: "US", cityGeonamesId: NYC, institution: { status: "ROR", rorId: "042nb2s44" } }) }),
  }));
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.identity.accountType, "researcher");
  assert.equal(okBody.identity.institution.rorId, "042nb2s44");
  // never any fingerprint / owner-link / SELF / cross-account leak
  for (const forbidden of ["fingerprint", "owner", "self status", "crossaccount", "cross_account"]) {
    assert.equal(JSON.stringify(okBody).toLowerCase().includes(forbidden), false, `no ${forbidden}`);
  }
});

// ===========================================================================
// 15 — canonical search proxies work without a session and are bounded
// ===========================================================================

test("15: /api/identity/cities and /api/identity/institutions return bounded canonical results without a session", async () => {
  await resetReadRateForTest("search-c");
  const cRes = await citiesRoute.GET(new Request("http://localhost/api/identity/cities?q=paris&country=FR", { headers: { "x-forwarded-for": "search-c" } }));
  assert.equal(cRes.status, 200);
  const cities = (await cRes.json()).results;
  assert.ok(Array.isArray(cities) && cities.length > 0 && cities.length <= 20);
  assert.ok(cities.every((c) => typeof c.geonamesId === "number" && c.countryCode === "FR"));

  await resetReadRateForTest("search-i");
  const iRes = await institutionsRoute.GET(new Request("http://localhost/api/identity/institutions?q=Massachusetts+Institute", { headers: { "x-forwarded-for": "search-i" } }));
  assert.equal(iRes.status, 200);
  const insts = (await iRes.json()).results;
  assert.ok(Array.isArray(insts) && insts.length > 0);
  assert.ok(insts.every((i) => /^0[0-9a-hjkmnp-tv-z]{6}[0-9]{2}$/.test(i.rorId)));
});
