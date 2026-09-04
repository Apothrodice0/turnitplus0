import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import {
  readAccountIdentityProfile,
  upsertAccountIdentityProfile,
  deleteAccountIdentityProfile,
  countAccountIdentityProfiles,
  readAccountIdentityFingerprints,
  deleteAccountIdentityFingerprintStatement,
  AccountIdentityValidationException,
} from "../lib/account-identity-repo.ts";
import * as repoModule from "../lib/account-identity-repo.ts";

/**
 * Account Identity FOUNDATION (A1) - SCHEMA + STORAGE guard. Proves drizzle/0045
 * is PURELY ADDITIVE (two new tables, nothing altered on `users` or any other
 * existing table), pins the exact table/column/index/FK shape and the CHECK
 * constraints, and exercises the repo: the 1:1 upsert, the value-free validation
 * failure, the CASCADE cleanup, and that this module still has no
 * insert/upsert writer for account_identity_fingerprints (A3c's VERIFIED_EMAIL
 * writer lives in lib/email-verification.ts instead, pinned end-to-end in
 * tests/email-verification.test.mjs — this file only pins the repo's own
 * deleteAccountIdentityFingerprintStatement, used for email-change cleanup).
 */

const repo = path.resolve(".");
const drizzleDir = path.join(repo, "drizzle");

function freshDbFile(name) {
  const f = path.join(repo, name);
  for (const s of ["", "-wal", "-shm", "-journal"]) {
    try {
      fs.unlinkSync(f + s);
    } catch {
      /* ignore */
    }
  }
  return f;
}
function cleanup(f) {
  for (const s of ["", "-wal", "-shm", "-journal"]) {
    try {
      fs.unlinkSync(f + s);
    } catch {
      /* ignore */
    }
  }
}

async function applyExcluding(client, exclude) {
  const files = fs.readdirSync(drizzleDir).filter((f) => f.endsWith(".sql") && !exclude.includes(f)).sort();
  for (const file of files) {
    await client.executeMultiple(fs.readFileSync(path.join(drizzleDir, file), "utf8"));
  }
}

async function tableSet(client) {
  const r = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  return new Set(r.rows.map((x) => String(x.name)));
}
async function columnSet(client, table) {
  const r = await client.execute(`PRAGMA table_info('${table}')`);
  return new Set(r.rows.map((x) => String(x.name)));
}
async function indexList(client, table) {
  const r = await client.execute(`PRAGMA index_list('${table}')`);
  const out = [];
  for (const row of r.rows) {
    const info = await client.execute(`PRAGMA index_info('${row.name}')`);
    out.push({ name: String(row.name), unique: Number(row.unique) === 1, columns: info.rows.map((c) => String(c.name)) });
  }
  return out;
}
async function foreignKeys(client, table) {
  const r = await client.execute(`PRAGMA foreign_key_list('${table}')`);
  return r.rows.map((x) => ({ from: String(x.from), table: String(x.table), onDelete: String(x.on_delete).toUpperCase() }));
}
async function primaryKey(client, table) {
  const r = await client.execute(`PRAGMA table_info('${table}')`);
  return r.rows.filter((x) => Number(x.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((x) => String(x.name));
}

// ===========================================================================
// 1 - drizzle/0045 is PURELY ADDITIVE
// ===========================================================================

test("1: 0045 adds exactly two tables and alters nothing else", async () => {
  const beforeFile = freshDbFile("test_account_identity_before.db");
  const afterFile = freshDbFile("test_account_identity_after.db");
  const before = createClient({ url: `file:${beforeFile}` });
  const after = createClient({ url: `file:${afterFile}` });
  try {
    // Measure 0045 in isolation: `before` = everything up to 0044, `after` =
    // that plus 0045. 0046 (which adds users.email_verified_at + the
    // email-verification challenge table) is excluded from BOTH so it never
    // shows up in this 0045-only diff.
    await applyExcluding(before, ["0045_account_identity.sql", "0046_email_verification_challenges.sql"]);
    await applyExcluding(after, ["0046_email_verification_challenges.sql"]);

    const beforeTables = await tableSet(before);
    const afterTables = await tableSet(after);
    const added = [...afterTables].filter((t) => !beforeTables.has(t)).sort();
    const removed = [...beforeTables].filter((t) => !afterTables.has(t));
    assert.deepEqual(added, ["account_identity_fingerprints", "account_identity_profiles"]);
    assert.deepEqual(removed, [], "0045 removes no table");

    // every pre-existing table keeps the exact same column set
    for (const t of beforeTables) {
      assert.deepEqual(
        [...(await columnSet(after, t))].sort(),
        [...(await columnSet(before, t))].sort(),
        `0045 must not add/remove a column on the pre-existing table "${t}"`,
      );
    }
    // `users` in particular is completely untouched
    assert.deepEqual(
      [...(await columnSet(after, "users"))].sort(),
      ["corpus_reuse_consented_at", "created_at", "email", "id", "password_hash", "role", "updated_at", "username"].sort(),
      "users must gain no new column - identity lives in a sibling table",
    );
  } finally {
    before.close();
    after.close();
    cleanup(beforeFile);
    cleanup(afterFile);
  }
});

// ===========================================================================
// 2 - exact table / column / index / FK shape
// ===========================================================================

test("2: account_identity_profiles + account_identity_fingerprints have the declared shape", async () => {
  const f = freshDbFile("test_account_identity_shape.db");
  const client = createClient({ url: `file:${f}` });
  try {
    await applyMigrationsLibsql(client, drizzleDir);

    assert.deepEqual(
      [...(await columnSet(client, "account_identity_profiles"))].sort(),
      [
        "user_id", "account_type", "full_name", "country_code",
        "institution_status", "institution_ror_id", "institution_unverified_name",
        "city_status", "city_geonames_id", "city_unverified_name",
        "phone_e164", "phone_region",
        "email_verified_at", "phone_verified_at", "institution_verified_at",
        "normalization_version", "created_at", "updated_at",
      ].sort(),
    );
    assert.deepEqual(await primaryKey(client, "account_identity_profiles"), ["user_id"], "user_id is the 1:1 PK");
    const profFk = await foreignKeys(client, "account_identity_profiles");
    assert.equal(profFk.length, 1);
    assert.equal(profFk[0].table, "users");
    assert.equal(profFk[0].from, "user_id");
    assert.equal(profFk[0].onDelete, "CASCADE", "profile is per-account PII - deleted with the account");

    const profIdx = new Set((await indexList(client, "account_identity_profiles")).map((i) => i.name));
    for (const n of [
      "idx_account_identity_profiles_institution_ror",
      "idx_account_identity_profiles_city_geonames",
      "idx_account_identity_profiles_country_code",
    ]) {
      assert.ok(profIdx.has(n), `missing index ${n}`);
    }

    assert.deepEqual(
      [...(await columnSet(client, "account_identity_fingerprints"))].sort(),
      ["id", "user_id", "fingerprint_kind", "fingerprint", "key_version", "source_verified_at", "created_at"].sort(),
    );
    const fpFk = await foreignKeys(client, "account_identity_fingerprints");
    assert.equal(fpFk[0].table, "users");
    assert.equal(fpFk[0].onDelete, "CASCADE");
    const fpIdx = await indexList(client, "account_identity_fingerprints");
    const uq = fpIdx.find((i) => i.name === "ux_account_identity_fingerprints_kind");
    assert.ok(uq && uq.unique, "ux_account_identity_fingerprints_kind must be UNIQUE");
    assert.deepEqual(uq.columns, ["user_id", "fingerprint_kind", "key_version"]);
    assert.ok(fpIdx.some((i) => i.name === "idx_account_identity_fingerprints_lookup"));
  } finally {
    client.close();
    cleanup(f);
  }
});

// ===========================================================================
// 3 - CHECK constraints and the 1:1 invariant are enforced
// ===========================================================================

test("3: CHECK constraints + 1:1 PK + CASCADE cleanup all behave", async () => {
  const f = freshDbFile("test_account_identity_checks.db");
  const client = createClient({ url: `file:${f}` });
  try {
    await applyMigrationsLibsql(client, drizzleDir);
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute({
      sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
      args: ["u-ai-1", "u-ai-1@e.test", "u-ai-1", "h"],
    });

    const insertProfile = (over = {}) => {
      const base = {
        user_id: "u-ai-1", account_type: "student", full_name: "Test Name", country_code: null,
        institution_status: "NONE", institution_ror_id: null, institution_unverified_name: null,
        city_status: "NONE", city_geonames_id: null, city_unverified_name: null,
        phone_e164: null, phone_region: null, normalization_version: 1, created_at: 1, updated_at: 1,
        ...over,
      };
      const cols = Object.keys(base);
      return client.execute({
        sql: `INSERT INTO account_identity_profiles (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
        args: cols.map((c) => base[c]),
      });
    };

    await assert.rejects(() => insertProfile({ full_name: null }), /NOT NULL constraint/i, "full_name is NOT NULL");
    await assert.rejects(() => insertProfile({ account_type: "wizard" }), /CHECK constraint/i, "account_type vocab");
    await assert.rejects(() => insertProfile({ institution_status: "USER_TEXT" }), /CHECK constraint/i);
    await assert.rejects(
      () => insertProfile({ institution_status: "NONE", institution_ror_id: "03vek6s52" }),
      /CHECK constraint/i,
      "NONE must not carry a ror id",
    );
    await assert.rejects(
      () => insertProfile({ institution_status: "ROR" }),
      /CHECK constraint/i,
      "ROR requires a ror id",
    );
    await assert.rejects(
      () => insertProfile({ city_status: "GEONAMES" }),
      /CHECK constraint/i,
      "GEONAMES requires an id",
    );
    await assert.rejects(() => insertProfile({ country_code: "us" }), /CHECK constraint/i, "country must be uppercase alpha-2");
    await assert.rejects(() => insertProfile({ country_code: "USA" }), /CHECK constraint/i, "no alpha-3 in storage");

    // The E.164 backstop CHECK must reject these at the SQLite layer (GLOB '*'
    // wildcards alone would let several through) - direct migration proof:
    for (const bad of ["+1abcdefg", "+123-4567", "++1234567", "+12 34567", "+01234567", "not-a-phone", "12345678", "+1", "+00000000"]) {
      await assert.rejects(
        () => insertProfile({ phone_e164: bad, phone_region: "US" }),
        /CHECK constraint/i,
        `E.164 CHECK must reject ${JSON.stringify(bad)}`,
      );
    }
    // ...while a well-formed normalized E.164 is accepted
    {
      const okFile = freshDbFile("test_account_identity_e164_ok.db");
      const okClient = createClient({ url: `file:${okFile}` });
      try {
        await applyMigrationsLibsql(okClient, drizzleDir);
        await okClient.execute({ sql: "INSERT INTO users (id,email,username,password_hash) VALUES ('e','e@e.test','e','h')" });
        for (const good of ["+14155552671", "+442079460958", "+61491570156", "+1234567"]) {
          await okClient.execute({
            sql: "INSERT INTO account_identity_profiles (user_id, account_type, full_name, institution_status, city_status, phone_e164, phone_region, normalization_version, created_at, updated_at) VALUES ('e','student','N','NONE','NONE',?,?,1,1,1) ON CONFLICT(user_id) DO UPDATE SET phone_e164 = excluded.phone_e164",
            args: [good, "US"],
          });
        }
      } finally {
        okClient.close();
        cleanup(okFile);
      }
    }

    // a valid canonical row (all *_verified_at left NULL - the A1 resting state)
    await insertProfile({
      account_type: "researcher",
      country_code: "GB",
      institution_status: "ROR",
      institution_ror_id: "02mhbdp94",
      city_status: "GEONAMES",
      city_geonames_id: 2643743,
      phone_e164: "+442079460958",
      phone_region: "GB",
    });
    const row = (
      await client.execute({ sql: "SELECT * FROM account_identity_profiles WHERE user_id = ?", args: ["u-ai-1"] })
    ).rows[0];
    assert.equal(row.email_verified_at, null);
    assert.equal(row.phone_verified_at, null);
    assert.equal(row.institution_verified_at, null);
    assert.equal(Number(row.normalization_version), 1);

    // 1:1 - a second profile row for the same user is rejected
    await assert.rejects(() => insertProfile(), /UNIQUE constraint|PRIMARY KEY/i, "one profile per account");

    // a fingerprint row, then CASCADE cleanup on account deletion
    await client.execute({
      sql: "INSERT INTO account_identity_fingerprints (id, user_id, fingerprint_kind, fingerprint, key_version, source_verified_at, created_at) VALUES (?,?,?,?,?,?,?)",
      args: ["fp-1", "u-ai-1", "VERIFIED_EMAIL", "deadbeef", 1, 1, 1],
    });
    await assert.rejects(
      () => client.execute({
        sql: "INSERT INTO account_identity_fingerprints (id, user_id, fingerprint_kind, fingerprint, key_version, source_verified_at, created_at) VALUES (?,?,?,?,?,?,?)",
        args: ["fp-2", "u-ai-1", "VERIFIED_EMAIL", "cafe", 1, 1, 1],
      }),
      /UNIQUE constraint/i,
      "one fingerprint per (account, kind, key version)",
    );

    await client.execute({ sql: "DELETE FROM users WHERE id = ?", args: ["u-ai-1"] });
    assert.equal(
      Number((await client.execute("SELECT COUNT(*) c FROM account_identity_profiles")).rows[0].c),
      0,
      "profile CASCADE-deleted with the account",
    );
    assert.equal(
      Number((await client.execute("SELECT COUNT(*) c FROM account_identity_fingerprints")).rows[0].c),
      0,
      "fingerprints CASCADE-deleted with the account",
    );
  } finally {
    client.close();
    cleanup(f);
  }
});

// ===========================================================================
// 4 - the repo: 1:1 upsert, value-free validation failure, no INSERT/UPSERT
// fingerprint writer (deletion for email-change cleanup is a deliberate A3c
// exception, pinned separately below)
// ===========================================================================

test("4: account-identity-repo upserts a 1:1 profile, never marks anything verified, and has no INSERT/UPSERT fingerprint writer", async () => {
  const f = freshDbFile("test_account_identity_repo.db");
  const client = createClient({ url: `file:${f}` });
  try {
    await applyMigrationsLibsql(client, drizzleDir);
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute({
      sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
      args: ["ru-1", "ru-1@e.test", "ru-1", "h"],
    });

    assert.equal(await readAccountIdentityProfile(client, "ru-1"), null);

    const created = await upsertAccountIdentityProfile(client, "ru-1", {
      accountType: "instructor",
      fullName: "  Grace   Hopper ",
      countryCode: "us",
      institution: { status: "UNVERIFIED_TEXT", name: "Some Naval Lab" },
      phone: { number: "+1 202 456 1111" },
    });
    assert.equal(created.created, true);
    assert.equal(created.profile.accountType, "instructor");
    assert.equal(created.profile.fullName, "Grace Hopper");
    assert.equal(created.profile.countryCode, "US");
    assert.equal(created.profile.institutionStatus, "UNVERIFIED_TEXT");
    assert.equal(created.profile.phoneE164, "+12024561111");
    assert.equal(created.profile.emailVerifiedAt, null);
    assert.equal(created.profile.phoneVerifiedAt, null);
    assert.equal(created.profile.institutionVerifiedAt, null);
    assert.equal(await countAccountIdentityProfiles(client), 1);

    // upsert again -> updates the SAME row (still 1:1), created = false
    const updated = await upsertAccountIdentityProfile(client, "ru-1", {
      accountType: "researcher",
      fullName: "Grace B. Hopper",
      institution: { status: "ROR", rorId: "https://ror.org/03vek6s52" },
    });
    assert.equal(updated.created, false);
    assert.equal(updated.profile.accountType, "researcher");
    assert.equal(updated.profile.institutionStatus, "ROR");
    assert.equal(updated.profile.institutionRorId, "03vek6s52");
    assert.equal(updated.profile.fullName, "Grace B. Hopper", "name updated on the same row");
    assert.equal(updated.profile.phoneE164, null, "phone not carried over from the first upsert");
    assert.equal(await countAccountIdentityProfiles(client), 1, "still exactly one profile row");

    // a missing name is rejected by the repo (full_name is NOT NULL / REQUIRED)
    await assert.rejects(
      () => upsertAccountIdentityProfile(client, "ru-1", { accountType: "student" }),
      (err) => {
        assert.ok(err instanceof AccountIdentityValidationException);
        assert.deepEqual(err.errors.filter((e) => e.field === "fullName").map((e) => e.code), ["REQUIRED"]);
        return true;
      },
    );

    // invalid input -> value-free exception, nothing written
    await assert.rejects(
      () =>
        upsertAccountIdentityProfile(client, "ru-1", {
          fullName: "bad" + String.fromCodePoint(0x202e) + "name",
          phone: { number: "+1 555 sekritpart" },
        }),
      (err) => {
        assert.ok(err instanceof AccountIdentityValidationException);
        assert.ok(!/sekritpart/.test(err.message), "the exception must not echo the raw value");
        assert.ok(Array.isArray(err.errors) && err.errors.length >= 1);
        return true;
      },
    );

    // account_identity_fingerprints: reader returns [], and there is no
    // INSERT/UPSERT writer export in THIS module (deleteAccountIdentityFingerprintStatement
    // is deliberately exempt — it removes evidence, never creates it; pinned below).
    assert.deepEqual(await readAccountIdentityFingerprints(client, "ru-1"), []);
    const fingerprintWriters = Object.keys(repoModule).filter(
      (k) => /fingerprint/i.test(k) && /(insert|write|upsert|create|add|record|set|save|put|store)/i.test(k),
    );
    assert.deepEqual(fingerprintWriters, [], `no INSERT/UPSERT fingerprint writer may exist in this module: ${fingerprintWriters.join(", ")}`);

    // deleteAccountIdentityFingerprintStatement (A3c, used by the email-change
    // transaction): removes exactly one account's fingerprint of one kind, a
    // no-op for a kind/account with none, and leaves other kinds/accounts alone.
    await client.execute({
      sql: "INSERT INTO account_identity_fingerprints (id, user_id, fingerprint_kind, fingerprint, key_version, source_verified_at, created_at) VALUES (?,?,?,?,?,?,?)",
      args: ["fp-ru-1-email", "ru-1", "VERIFIED_EMAIL", "deadbeef", 1, 1, 1],
    });
    await client.execute({
      sql: "INSERT INTO account_identity_fingerprints (id, user_id, fingerprint_kind, fingerprint, key_version, source_verified_at, created_at) VALUES (?,?,?,?,?,?,?)",
      args: ["fp-ru-1-ror", "ru-1", "VERIFIED_INSTITUTION_ROR", "cafe", 1, 1, 1],
    });
    await client.execute(deleteAccountIdentityFingerprintStatement("ru-1", "VERIFIED_EMAIL"));
    const afterDelete = await readAccountIdentityFingerprints(client, "ru-1");
    assert.deepEqual(afterDelete.map((r) => r.fingerprintKind), ["VERIFIED_INSTITUTION_ROR"], "only the targeted kind was removed");
    // a no-op when there is nothing to delete
    await client.execute(deleteAccountIdentityFingerprintStatement("ru-1", "VERIFIED_EMAIL"));
    await client.execute(deleteAccountIdentityFingerprintStatement("no-such-user", "VERIFIED_INSTITUTION_ROR"));
    assert.equal((await readAccountIdentityFingerprints(client, "ru-1")).length, 1, "the untouched kind survives repeated/foreign deletes");

    await deleteAccountIdentityProfile(client, "ru-1");
    assert.equal(await readAccountIdentityProfile(client, "ru-1"), null);
    assert.equal(
      Number((await client.execute("SELECT COUNT(*) c FROM users WHERE id = 'ru-1'")).rows[0].c),
      1,
      "deleting the profile leaves the account intact",
    );
  } finally {
    client.close();
    cleanup(f);
  }
});

// ===========================================================================
// 5 - 0045 stays OUT of the frozen e8-tables migration runner
// ===========================================================================

test("5: lib/e8-tables-migration-runner.ts does not know about account_identity (A1 leaves it untouched)", () => {
  const runner = fs.readFileSync(path.join(repo, "lib", "e8-tables-migration-runner.ts"), "utf8");
  assert.doesNotMatch(runner, /account_identity/, "0045 gets its own reviewed Preview application step later");
  assert.doesNotMatch(runner, /0045/, "0045 is applied only by ingest.ts + the test paths in A1");
});
