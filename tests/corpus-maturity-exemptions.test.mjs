import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import {
  indexDocumentSubmissionIntoCorpus,
  createReusableDocumentRepresentation,
  recordCorpusShingles,
  isRepresentationEligibleForMatching,
  corpusMaturityCutoff,
} from "../lib/user-submission-corpus.ts";
import { matchAgainstUserSubmissionCorpus } from "../lib/user-submission-matching.ts";
import {
  addCorpusMaturityExemption,
  removeCorpusMaturityExemption,
  listCorpusMaturityExemptions,
} from "../lib/developer-corpus-maturity-exemptions.ts";
import * as exemptionsRoute from "../app/api/developer/corpus-maturity-exemptions/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest } from "../lib/rate-limit.js";
import { withTestIdentity, grantTestAdmin } from "./helpers/test-signup.mjs";

/**
 * Developer control — "Corpus maturity exemptions" (drizzle/0047,
 * developer_corpus_maturity_exemptions). Pins:
 *   - a normal source waits the full 7-day maturity window;
 *   - an exempt source is mature immediately, at day 0;
 *   - removing the exemption restores the normal 7-day wait;
 *   - exemption affects ONLY maturity — same-account self-exclusion (the
 *     mechanism backing "same-Passport SELF" at the corpus layer) and the
 *     ADMISSION_DEDUP bypass (duplicate suppression) are unaffected;
 *   - the email is a lookup key only: an unknown email creates nothing, and
 *     only an admin session can add/remove via the API route.
 */

const repoRoot = path.resolve(".");
const dbFile = path.join(repoRoot, "test_corpus_maturity_exemptions.db");
for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(repoRoot, "drizzle"));

test.after(() => {
  client.close();
  for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
});

test.beforeEach(async () => {
  for (const t of [
    "corpus_document_shingles",
    "corpus_submission_references",
    "corpus_admission_promotions",
    "corpus_admission_accepted_representations",
    "corpus_admission_decisions",
    "corpus_document_representations",
    "document_identities",
    "report_historical_match_snapshots",
    "developer_corpus_maturity_exemptions",
  ]) {
    await client.execute(`DELETE FROM ${t}`);
  }
});

const DAY = 86_400_000;
const NOW = Date.now();
const asOf = (offsetDays) => new Date(NOW + offsetDays * DAY);
const cutoff = (offsetDays) => corpusMaturityCutoff(asOf(offsetDays));
const sqlTs = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString().replace("T", " ").slice(0, 19);

let seq = 0;
function uniqueCanonicalText() {
  seq += 1;
  return canonicalizeText(
    "Seismologists deploying a temporary broadband array across a subduction forearc recorded low-frequency tremor " +
    "bursts that migrated updip during the weeks following a slow-slip event near this exact trench-parallel profile. " +
    `Distinct marker paragraph number ${seq} keeps each fixture's canonical fingerprint and corpus representation ` +
    "unambiguous so the exemption resolver stays deterministic across every scenario tested.",
  );
}

/** Emails are canonicalized (trim + lowercase) by addCorpusMaturityExemption — store them already-lowercase so a mixed-case account id fixture still round-trips. */
function emailFor(id) {
  return `${id.toLowerCase()}@cme.test`;
}

async function account(id) {
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id,email,username,password_hash) VALUES (?,?,?,?)",
    args: [id, emailFor(id), id, "h"],
  });
}

const DEV_ID = "dev-exemption-admin";
await account(DEV_ID);

async function exempt(accountId) {
  const result = await addCorpusMaturityExemption(client, { email: emailFor(accountId), createdByUserId: DEV_ID });
  assert.equal(result.kind, "ok", `exempt(${accountId}) should succeed`);
  return result.userId;
}

async function unexempt(accountId) {
  await removeCorpusMaturityExemption(client, accountId);
}

// Route-level admin-gate fixtures. Established BEFORE any test() registration
// below (this file's own convention, matching tests/developer-reset-account-
// rooms.test.mjs) — node:test begins executing registered tests only after
// the whole module's top-level await chain settles, but interleaving fixture
// setup with test registrations invites exactly the kind of accidental
// cross-test ordering this avoids entirely.
let routeCallSeq = 0;
async function callRoute(method, cookie, body) {
  const ip = `cme-route-${routeCallSeq++}`;
  await resetRateForTest(ip);
  const headers = { "content-type": "application/json", "x-forwarded-for": ip };
  if (cookie) headers["cookie"] = `tp_session_v1=${cookie}`;
  const handler = method === "GET" ? exemptionsRoute.GET : method === "POST" ? exemptionsRoute.POST : exemptionsRoute.DELETE;
  const res = await handler(new Request("http://localhost/api/developer/corpus-maturity-exemptions", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

function extractCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  const match = setCookie && setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

let signupSeq = 0;
async function signup(email) {
  const ip = `cme-signup-${signupSeq++}`;
  await resetAuthRateForTest(ip);
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(withTestIdentity({
      email,
      password: "corpus-maturity-exemptions-pw-1",
      username: email.split("@")[0].replace(/[^a-z0-9]/gi, ""),
      deviceKey: `device-${email}`,
    })),
  }));
  assert.equal(res.status, 201, `signup ${email}`);
  return extractCookie(res);
}

const ADMIN_EMAIL = "admin@cme.test";
process.env.ADMIN_EMAIL = ADMIN_EMAIL;
const adminCookie = await signup(ADMIN_EMAIL);
await grantTestAdmin(dbFile, ADMIN_EMAIL);
const nonAdminCookie = await signup("plain-user@cme.test");

/** A direct admission-promotion backing (the live corpus-admission path) — mirrors tests/corpus-activation-7day.test.mjs's own seedAdmissionBacking. */
async function seedAdmissionBacking(text, accountId, decisionDaysAgo) {
  await account(accountId);
  const rep = await createReusableDocumentRepresentation(client, { canonicalText: text });
  await recordCorpusShingles(client, rep.id, text);
  await client.execute({
    sql: "UPDATE corpus_document_representations SET first_seen_at = ?, created_at = ? WHERE id = ?",
    args: [sqlTs(decisionDaysAgo), sqlTs(decisionDaysAgo), rep.id],
  });
  const uid = randomUUID();
  const decId = `dec-${uid}`;
  const arId = `ar-${uid}`;
  const srcRef = `report-upload:account=${accountId}:device=dev-${uid}:report=r-${uid}`;
  await client.execute({
    sql: "INSERT INTO corpus_admission_decisions (id,source_ref,policy_version,decision,reason_codes,hard_gate_passed,hard_gate_failure_codes,canonical_sha256,dry_run,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    args: [decId, srcRef, "p1", "ACCEPT", "[]", 1, "[]", randomUUID().replace(/-/g, "").padEnd(64, "0"), 0, sqlTs(decisionDaysAgo)],
  });
  await client.execute({
    sql: "INSERT INTO corpus_admission_accepted_representations (id,decision_id,canonical_sha256,word_count,fingerprint_version,created_at,revoked_at) VALUES (?,?,?,?,?,?,?)",
    args: [arId, decId, randomUUID().replace(/-/g, "").padEnd(64, "0"), 40, "adm-fp", sqlTs(decisionDaysAgo), null],
  });
  await client.execute({
    sql: "INSERT INTO corpus_admission_promotions (id,decision_id,accepted_representation_id,representation_id,link_type,fingerprint_version,status,attempt_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    args: [`prom-${uid}`, decId, arId, rep.id, "NEW_CONTENT_REPRESENTATION", "corpus-shingle-v1", "indexed", 1, sqlTs(decisionDaysAgo), sqlTs(0)],
  });
  return { representationId: rep.id, decisionId: decId };
}

async function matchAsOf(reportText, reportAccount, asOfDays) {
  return matchAgainstUserSubmissionCorpus(client, {
    accountId: reportAccount,
    canonicalText: reportText,
    excludeAccountId: reportAccount ?? undefined,
    corpusSourceMatchingEnabled: true,
    maturityCutoff: cutoff(asOfDays),
  });
}

// ===========================================================================
// Maturity gate: normal vs exempt
// ===========================================================================

test("normal source at day 0 -> immature", async () => {
  const text = uniqueCanonicalText();
  const { representationId } = await seedAdmissionBacking(text, "normal-d0", 0);
  assert.equal(await isRepresentationEligibleForMatching(client, representationId, { maturityCutoff: cutoff(0) }), false);
});

test("exempt source at day 0 -> mature", async () => {
  const text = uniqueCanonicalText();
  const { representationId } = await seedAdmissionBacking(text, "exempt-d0", 0);
  assert.equal(await isRepresentationEligibleForMatching(client, representationId, { maturityCutoff: cutoff(0) }), false, "not yet exempt");
  await exempt("exempt-d0");
  assert.equal(await isRepresentationEligibleForMatching(client, representationId, { maturityCutoff: cutoff(0) }), true, "exempt owner's source is mature immediately");
});

test("remove exemption -> same source becomes immature again until day 7", async () => {
  const text = uniqueCanonicalText();
  const { representationId } = await seedAdmissionBacking(text, "remove-exempt", 0);
  await exempt("remove-exempt");
  assert.equal(await isRepresentationEligibleForMatching(client, representationId, { maturityCutoff: cutoff(0) }), true, "mature while exempt");

  await unexempt("remove-exempt");
  assert.equal(await isRepresentationEligibleForMatching(client, representationId, { maturityCutoff: cutoff(0) }), false, "immature again immediately after removal");
  assert.equal(await isRepresentationEligibleForMatching(client, representationId, { maturityCutoff: cutoff(6) }), false, "still immature at day 6");
  assert.equal(await isRepresentationEligibleForMatching(client, representationId, { maturityCutoff: cutoff(7) }), true, "mature again at day 7 on its own T0");
});

test("normal source at day 7+ -> mature", async () => {
  const text = uniqueCanonicalText();
  const { representationId } = await seedAdmissionBacking(text, "normal-d7", 0);
  assert.equal(await isRepresentationEligibleForMatching(client, representationId, { maturityCutoff: cutoff(6) }), false);
  assert.equal(await isRepresentationEligibleForMatching(client, representationId, { maturityCutoff: cutoff(7) }), true);
});

test("exemption applies to the submission-reference backing arm too (arm 1, owner via document_identities.account_id)", async () => {
  const text = uniqueCanonicalText();
  await account("exempt-arm1");
  const identity = await createDocumentIdentity(client, { accountId: "exempt-arm1", title: "d", author: null, rawText: text });
  const res = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText: text });
  assert.equal(res.status, "INDEXED");

  assert.equal(await isRepresentationEligibleForMatching(client, res.representationId, { maturityCutoff: cutoff(0) }), false, "freshly indexed, not yet exempt");
  await exempt("exempt-arm1");
  assert.equal(await isRepresentationEligibleForMatching(client, res.representationId, { maturityCutoff: cutoff(0) }), true, "exempt owner's submission-reference backing is mature immediately");
});

// ===========================================================================
// Exemption affects ONLY maturity — self-exclusion and dedup are unaffected
// ===========================================================================

test("exempt source still obeys same-account self-exclusion (the mechanism backing same-Passport SELF at the corpus layer)", async () => {
  const text = uniqueCanonicalText();
  const { representationId } = await seedAdmissionBacking(text, "OWNER-exempt-self", 0);
  await exempt("OWNER-exempt-self");
  assert.equal(await isRepresentationEligibleForMatching(client, representationId, { maturityCutoff: cutoff(0) }), true, "mature immediately for a third party");

  const ownerView = await matchAsOf(text, "OWNER-exempt-self", 0);
  assert.equal(ownerView.status, "NO_HISTORICAL_MATCH", "the owner still cannot match their own (now mature-early) source — self-exclusion is unaffected by exemption");

  const otherView = await matchAsOf(text, "OTHER-exempt-self", 0);
  assert.equal(otherView.status, "MATCHED", "a different account sees it immediately, at day 0, because the owner is exempt");
  assert.equal(otherView.matches[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");
});

test("exempt source still obeys duplicate suppression (ADMISSION_DEDUP bypass is unaffected by exemption)", async () => {
  const text = uniqueCanonicalText();
  const { representationId } = await seedAdmissionBacking(text, "exempt-dedup", 0);
  // Even with NO exemption granted, ADMISSION_DEDUP already sees this immature
  // backing (the one sanctioned bypass) — exemption changes nothing about it.
  assert.equal(
    await isRepresentationEligibleForMatching(client, representationId, { eligibilityMode: "ADMISSION_DEDUP" }),
    true,
    "ADMISSION_DEDUP sees the fresh backing regardless of exemption",
  );
  await exempt("exempt-dedup");
  assert.equal(
    await isRepresentationEligibleForMatching(client, representationId, { eligibilityMode: "ADMISSION_DEDUP" }),
    true,
    "still visible to ADMISSION_DEDUP once exempt — no behavior change",
  );
});

// ===========================================================================
// A -> B exact-copy scenario
// ===========================================================================

test("A exempt, A's source newly admitted (day 0), B (different account) uploads an exact copy -> A's source participates immediately", async () => {
  const text = uniqueCanonicalText();
  await seedAdmissionBacking(text, "A-exact-copy", 0);
  await exempt("A-exact-copy");

  const bView = await matchAsOf(text, "B-exact-copy", 0);
  assert.equal(bView.status, "MATCHED", "B's exact copy matches A's day-0 source because A is exempt");
  assert.equal(bView.matches[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");
});

test("contrast: without exemption, the same day-0 admission backing is NOT yet visible to a different account", async () => {
  const text = uniqueCanonicalText();
  await seedAdmissionBacking(text, "A-no-exempt", 0);
  const bView = await matchAsOf(text, "B-no-exempt", 0);
  assert.equal(bView.status, "NO_HISTORICAL_MATCH");
});

// ===========================================================================
// Lookup-key-only semantics
// ===========================================================================

test("unknown email cannot create an exemption", async () => {
  const result = await addCorpusMaturityExemption(client, { email: "nobody-at-all@cme.test", createdByUserId: DEV_ID });
  assert.equal(result.kind, "not_found");
  const row = await client.execute({ sql: "SELECT COUNT(*) AS c FROM developer_corpus_maturity_exemptions", args: [] });
  assert.equal(Number(row.rows[0].c), 0, "no row inserted for an unresolved email");
});

test("list/add/remove round trip persists user_id, not the raw email", async () => {
  await account("roundtrip-user");
  const added = await addCorpusMaturityExemption(client, { email: "ROUNDTRIP-USER@CME.TEST", createdByUserId: DEV_ID });
  assert.equal(added.kind, "ok");
  assert.equal(added.userId, "roundtrip-user", "canonicalized email resolves to the real user id");

  const stored = await client.execute({ sql: "SELECT user_id, created_by_user_id FROM developer_corpus_maturity_exemptions WHERE user_id = ?", args: ["roundtrip-user"] });
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0].user_id, "roundtrip-user");
  assert.equal(stored.rows[0].created_by_user_id, DEV_ID);

  const listed = await listCorpusMaturityExemptions(client);
  assert.ok(listed.some((row) => row.userId === "roundtrip-user" && row.email === "roundtrip-user@cme.test"));

  await removeCorpusMaturityExemption(client, "roundtrip-user");
  const after = await listCorpusMaturityExemptions(client);
  assert.ok(!after.some((row) => row.userId === "roundtrip-user"));
});

// ===========================================================================
// API route — admin gate
// ===========================================================================

test("non-developer cannot add an exemption via the route (plain 404, no row written)", async () => {
  await account("route-target-1");
  for (const cookie of [nonAdminCookie, null]) {
    const { status } = await callRoute("POST", cookie, { email: "route-target-1@cme.test" });
    assert.equal(status, 404);
  }
  const row = await client.execute({ sql: "SELECT COUNT(*) AS c FROM developer_corpus_maturity_exemptions WHERE user_id = ?", args: ["route-target-1"] });
  assert.equal(Number(row.rows[0].c), 0);
});

test("non-developer cannot remove an exemption via the route (plain 404, row untouched)", async () => {
  await account("route-target-2");
  const userId = await exempt("route-target-2");
  for (const cookie of [nonAdminCookie, null]) {
    const { status } = await callRoute("DELETE", cookie, { userId });
    assert.equal(status, 404);
  }
  const row = await client.execute({ sql: "SELECT COUNT(*) AS c FROM developer_corpus_maturity_exemptions WHERE user_id = ?", args: [userId] });
  assert.equal(Number(row.rows[0].c), 1, "the exemption survives a non-admin's attempted removal");
});

test("non-developer cannot even list exemptions via the route (plain 404)", async () => {
  for (const cookie of [nonAdminCookie, null]) {
    const { status } = await callRoute("GET", cookie, undefined);
    assert.equal(status, 404);
  }
});

test("admin: full add / list / remove round trip via the route", async () => {
  await account("route-admin-target");
  const added = await callRoute("POST", adminCookie, { email: "route-admin-target@cme.test" });
  assert.equal(added.status, 200);
  assert.equal(added.body.found, true);
  assert.equal(added.body.userId, "route-admin-target");

  const listed = await callRoute("GET", adminCookie, undefined);
  assert.equal(listed.status, 200);
  assert.ok(listed.body.exemptions.some((row) => row.userId === "route-admin-target"));

  const removed = await callRoute("DELETE", adminCookie, { userId: "route-admin-target" });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.removed, true);

  const listedAfter = await callRoute("GET", adminCookie, undefined);
  assert.ok(!listedAfter.body.exemptions.some((row) => row.userId === "route-admin-target"));
});

test("admin: unknown email via the route reports not-found and writes nothing", async () => {
  const result = await callRoute("POST", adminCookie, { email: "route-nobody@cme.test" });
  assert.equal(result.status, 200);
  assert.equal(result.body.found, false);
});
