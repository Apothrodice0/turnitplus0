import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createSession, SESSION_COOKIE_NAME } from "../lib/auth-session.ts";
import { resetAdminRateForTest } from "../lib/rate-limit.js";
import { buildReportAdmissionSourceRef } from "../lib/corpus-admission-source-ref.ts";
import { ARCHIVE_COMPACT_FINGERPRINT_VERSION } from "../lib/archive-fingerprint.ts";
import {
  isRepresentationEligibleForMatching,
  corpusMaturityCutoff,
  resolveAdminEligibilityPredicates,
  sqliteUtcTimestamp,
  CORPUS_ACTIVATION_DELAY_DAYS,
} from "../lib/user-submission-corpus.ts";
import {
  getArchiveExplorerSummary,
  getArchiveExplorerCardMetrics,
  listArchiveExplorerSources,
  getArchiveExplorerSourceDetail,
  ARCHIVE_EXPLORER_MAX_PAGE_SIZE,
} from "../lib/corpus-admission-archive-explorer.ts";
import { formatCompactCount } from "../components/admin/archive/archive-format.ts";
import * as listRoute from "../app/api/admin/archive/route.ts";
import * as detailRoute from "../app/api/admin/archive/[id]/route.ts";

/**
 * Admin Archive / Corpus Explorer: admin authorization, metric/state
 * derivation, the maturity-vs-active distinction (pinned to the real
 * matcher predicate), pagination/search/filters, privacy-safe
 * serialization, and read-only behavior. Every fixture is synthetic, seeded
 * with explicit timestamps relative to a frozen ASOF.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_archive_explorer.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

const ASOF = new Date("2026-09-28T12:00:00.000Z");
const at = (iso) => iso.replace("T", " ").replace(/\.\d+Z$|Z$/, "").slice(0, 19);
const daysBefore = (days, hours = 0) => at(new Date(ASOF.getTime() - days * 86_400_000 - hours * 3_600_000).toISOString());

// Secrets / identifiers that must never appear in any explorer payload.
const SECRET_MARKERS = [];
function secret(value) {
  SECRET_MARKERS.push(value);
  return value;
}

let seq = 0;
const uid = (prefix) => `${prefix}-${String(++seq).padStart(4, "0")}-5f0c-4e7a-9b1d-${String(seq).padStart(12, "0")}`;

async function insertUser(id, role = "user") {
  const email = secret(`${id}@customer-private.example`);
  await client.execute({
    sql: "INSERT INTO users (id, email, username, password_hash, role) VALUES (?,?,?,?,?)",
    args: [secret(id), email, id, "not-a-real-hash", role],
  });
}

async function insertRepresentation({ id, sha, words = 4200, firstSeenAt }) {
  await client.execute({
    sql: `INSERT INTO corpus_document_representations
          (id, canonical_sha256, canonical_text, word_count, language, canonicalization_version, extractor_version, first_seen_at, created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [id, sha, secret(`CANONICAL-TEXT-MARKER-${id} private manuscript body`), words, "English", "canonical-text-v1", "v1", firstSeenAt, firstSeenAt],
  });
}

const sha = (n) => `${String(n).padStart(4, "0")}abcdef${"0123456789abcdef".repeat(4)}`.slice(0, 64);

async function insertArchive({ articleId, title, repId, shaValue, createdAt, fingerprinted }) {
  await insertRepresentation({ id: repId, sha: shaValue, words: 5100, firstSeenAt: createdAt });
  await client.execute({
    sql: `INSERT INTO archive_document_representations
          (archive_article_id, representation_id, title, source_type, original_similarity, archive_order, corpus_version, fingerprint_version, created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [articleId, repId, title, "Publication", 12, 3, "archive-v5-test", "archive-shingle-v1", createdAt],
  });
  if (fingerprinted) {
    await client.execute({
      sql: "INSERT INTO archive_document_fingerprints (representation_id, fingerprint_hash, optional_position, fingerprint_version, created_at) VALUES (?,?,?,?,?)",
      args: [repId, "fp-hash-1", 0, ARCHIVE_COMPACT_FINGERPRINT_VERSION, createdAt],
    });
  }
}

async function insertDecision({ accountId, decision, createdAt, familyRelation = "NONE", reasonCodes = [], hardGatePassed = true, hardGateFailureCodes = [], words = 3600 }) {
  const id = uid("dec");
  const deviceKey = secret(`device-key-${id}`);
  const reportId = secret(`report-id-${id}`);
  const sourceRef = secret(buildReportAdmissionSourceRef({ accountId, deviceKey, reportId }));
  const canonical = sha(seq + 100);
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?)`,
    args: [
      id, null, sourceRef, "corpus-admission-policy-v1", decision, JSON.stringify(reasonCodes), hardGatePassed ? 1 : 0, JSON.stringify(hardGateFailureCodes),
      "txt", words, "English", 0.99, canonical, "v1",
      null, 88.5, "q-v1", "{}", "{}", "fv1",
      0.8, "cv-v1", familyRelation, familyRelation === "NONE" ? null : secret(buildReportAdmissionSourceRef({ accountId, deviceKey: "other-device", reportId: "other-report" })), familyRelation === "NONE" ? null : 1,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0, createdAt,
    ],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_report_jobs (id, source_ref, account_id, device_key, report_id, status, decision_id, attempt_count, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [uid("job"), sourceRef, accountId, deviceKey, reportId, "succeeded", id, 1, createdAt, createdAt],
  });
  return { id, canonical };
}

async function acceptAndStore(opts) {
  const { id, canonical } = await insertDecision({ ...opts, decision: "ACCEPT", reasonCodes: ["MEETS_ALL_HARD_GATES", "QUALITY_ABOVE_ACCEPT_THRESHOLD"] });
  await client.execute({
    sql: "INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, extractor_version, retention_basis, stored_at) VALUES (?,?,?,?,?,?,?)",
    args: [uid("cs"), id, canonical, secret(`RETAINED-TEXT-MARKER-${id} private manuscript body`), "v1", "CONSENT_GRANTED", opts.createdAt],
  });
  const arId = uid("ar");
  await client.execute({
    sql: "INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at) VALUES (?,?,?,?,?,?,?)",
    args: [arId, id, canonical, opts.words ?? 3600, "corpus-admission-accepted-shingle-v1", opts.revokedAt ?? null, opts.createdAt],
  });
  let representationId = null;
  if (opts.promoteAt) {
    representationId = uid("rep");
    await insertRepresentation({ id: representationId, sha: canonical, firstSeenAt: opts.promoteAt });
    await client.execute({
      sql: `INSERT INTO corpus_admission_promotions
            (id, decision_id, accepted_representation_id, representation_id, link_type, fingerprint_version, status, attempt_count, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: [uid("pro"), id, arId, representationId, "NEW_CONTENT_REPRESENTATION", "corpus-shingle-v1", "indexed", 1, opts.promoteAt, opts.promoteAt],
    });
  }
  return { decisionId: id, canonical, representationId };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACCOUNT_A = "acct-a-7c1f0e62";
const ACCOUNT_B_EXEMPT = "acct-b-91d4a0f3";
const ADMIN_ID = "admin-archive-explorer";
const ORDINARY_ID = "ordinary-archive-explorer";
await insertUser(ACCOUNT_A);
await insertUser(ACCOUNT_B_EXEMPT);
await insertUser(ADMIN_ID, "admin");
await insertUser(ORDINARY_ID, "user");
await client.execute({ sql: "INSERT INTO developer_corpus_maturity_exemptions (user_id, created_at, created_by_user_id) VALUES (?,?,?)", args: [ACCOUNT_B_EXEMPT, daysBefore(3), ADMIN_ID] });

const ARCHIVE_TODAY = { articleId: "arch-today-001", title: "Coastal Erosion and Policy Response", repId: uid("rep"), shaValue: sha(1), createdAt: daysBefore(0, 1), fingerprinted: true };
const ARCHIVE_OLD = { articleId: "arch-old-002", title: "A Survey of Maritime Law", repId: uid("rep"), shaValue: sha(2), createdAt: at("2026-06-01T10:00:00.000Z"), fingerprinted: false };
await insertArchive(ARCHIVE_TODAY);
await insertArchive(ARCHIVE_OLD);

// Legacy (pre-admission-gate) representations.
const LEGACY_OLD = uid("rep");
await insertRepresentation({ id: LEGACY_OLD, sha: sha(3), firstSeenAt: at("2026-07-01T09:00:00.000Z") });
const docIdentity = uid("doc");
await client.execute({
  sql: "INSERT INTO document_identities (id, account_id, title, author, raw_sha256, canonical_sha256, created_at) VALUES (?,?,?,?,?,?,?)",
  args: [docIdentity, ACCOUNT_A, secret("Private Thesis Title Of Account A"), null, sha(4), sha(3), at("2026-07-01T09:00:00.000Z")],
});
await client.execute({
  sql: "INSERT INTO corpus_submission_references (representation_id, document_identity_id, link_type, created_at) VALUES (?,?,?,?)",
  args: [LEGACY_OLD, docIdentity, "NEW_CONTENT_REPRESENTATION", at("2026-07-01T09:00:00.000Z")],
});
const LEGACY_RECENT = uid("rep");
await insertRepresentation({ id: LEGACY_RECENT, sha: sha(5), firstSeenAt: daysBefore(1) });

// Admissions.
const D1_MATURING = await acceptAndStore({ accountId: ACCOUNT_A, createdAt: daysBefore(2) });
const D2_AWAITING_INDEX = await acceptAndStore({ accountId: ACCOUNT_A, createdAt: daysBefore(20) });
const D3_ACTIVE = await acceptAndStore({ accountId: ACCOUNT_A, createdAt: daysBefore(20), promoteAt: daysBefore(19) });
const D4_INDEXED_MATURING = await acceptAndStore({ accountId: ACCOUNT_A, createdAt: daysBefore(2), promoteAt: daysBefore(1) });
const D5_EXEMPT_ACTIVE = await acceptAndStore({ accountId: ACCOUNT_B_EXEMPT, createdAt: daysBefore(2), promoteAt: daysBefore(1) });
const D6_REMOVED = await acceptAndStore({ accountId: ACCOUNT_A, createdAt: daysBefore(20), revokedAt: daysBefore(8) });
const D7_DUPLICATE = await insertDecision({ accountId: ACCOUNT_A, decision: "REJECT", createdAt: daysBefore(0, 2), familyRelation: "EXACT_DUPLICATE", reasonCodes: ["MEETS_ALL_HARD_GATES", "DUPLICATE_ALREADY_REPRESENTED"] });
const D8_REJECTED = await insertDecision({ accountId: ACCOUNT_A, decision: "REJECT", createdAt: daysBefore(3), hardGatePassed: false, hardGateFailureCodes: ["WORD_COUNT_BELOW_MINIMUM"], reasonCodes: ["WORD_COUNT_BELOW_MINIMUM"], words: 900 });
const D9_REVIEW = await insertDecision({ accountId: ACCOUNT_A, decision: "REVIEW", createdAt: daysBefore(1), reasonCodes: ["MEETS_ALL_HARD_GATES", "LANGUAGE_UNCERTAIN"] });
// A pending admission job (no decision yet).
await client.execute({
  sql: "INSERT INTO corpus_admission_report_jobs (id, source_ref, account_id, device_key, report_id, status, attempt_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  args: [uid("job"), secret(buildReportAdmissionSourceRef({ accountId: ACCOUNT_A, deviceKey: "pending-device", reportId: "pending-report" })), ACCOUNT_A, "pending-device", "pending-report", "pending", 0, daysBefore(0, 1), daysBefore(0, 1)],
});

const TOTAL_SOURCES = 2 + 2 + 9;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function auditing(inner, log) {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "execute") {
        return (stmt) => {
          log.push(typeof stmt === "string" ? stmt : stmt.sql);
          return target.execute(stmt);
        };
      }
      if (prop === "batch" || prop === "transaction" || prop === "executeMultiple" || prop === "migrate") {
        return () => { throw new Error(`explorer must not call client.${String(prop)}`); };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function listAll(params = {}) {
  const rows = [];
  let page = 1;
  for (;;) {
    const result = await listArchiveExplorerSources(client, { ...params, page, pageSize: 4 }, { asOf: ASOF });
    rows.push(...result.rows);
    if (page * result.pageSize >= result.totalCount) return { rows, totalCount: result.totalCount };
    page += 1;
  }
}

function assertNoSecrets(payload, label) {
  const json = JSON.stringify(payload);
  for (const marker of SECRET_MARKERS) {
    assert.equal(json.includes(marker), false, `${label} must not contain ${marker}`);
  }
  assert.doesNotMatch(json, /report-upload:/, `${label} must not contain any admission source_ref`);
  assert.doesNotMatch(json, /@customer-private\.example/, `${label} must not contain an email`);
  assert.doesNotMatch(json, /MARKER/, `${label} must not contain any manuscript text`);
}

let ipCounter = 0;
async function callRoute(handler, url, { token, params } = {}) {
  ipCounter += 1;
  const headers = { "x-forwarded-for": `archive-explorer-test-${ipCounter}` };
  if (token) headers.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  await resetAdminRateForTest(headers["x-forwarded-for"]);
  const request = new Request(`http://localhost${url}`, { headers });
  return params ? handler(request, { params: Promise.resolve(params) }) : handler(request);
}

const adminToken = await createSession(client, ADMIN_ID);
const ordinaryToken = await createSession(client, ORDINARY_ID);

// ---------------------------------------------------------------------------
// Admin authorization
// ---------------------------------------------------------------------------

test("AUTH: list + detail routes return a bare 404 (no body, no-store) for anonymous and ordinary accounts, 200 for an admin", async () => {
  const detailId = `admission:${D3_ACTIVE.decisionId}`;
  for (const token of [undefined, ordinaryToken]) {
    const list = await callRoute(listRoute.GET, "/api/admin/archive", { token });
    assert.equal(list.status, 404);
    assert.equal(await list.text(), "");
    assert.equal(list.headers.get("cache-control"), "no-store");
    const detail = await callRoute(detailRoute.GET, `/api/admin/archive/${encodeURIComponent(detailId)}`, { token, params: { id: detailId } });
    assert.equal(detail.status, 404);
    assert.equal(await detail.text(), "");
    assert.equal(detail.headers.get("cache-control"), "no-store");
  }
  const list = await callRoute(listRoute.GET, "/api/admin/archive", { token: adminToken });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("cache-control"), "no-store");
  const detail = await callRoute(detailRoute.GET, `/api/admin/archive/${encodeURIComponent(detailId)}`, { token: adminToken, params: { id: detailId } });
  assert.equal(detail.status, 200);
  assert.equal(detail.headers.get("cache-control"), "no-store");
});

test("AUTH: a non-admin sending invalid parameters still gets the bare 404, never a 400 that would reveal the route", async () => {
  for (const token of [undefined, ordinaryToken]) {
    const response = await callRoute(listRoute.GET, "/api/admin/archive?class=bogus&state=bogus&sort=bogus", { token });
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "");
  }
  const adminResponse = await callRoute(listRoute.GET, "/api/admin/archive?class=bogus", { token: adminToken });
  assert.equal(adminResponse.status, 400);
});

test("AUTH: both explorer routes are GET-only (no mutation verb exported)", () => {
  for (const mod of [listRoute, detailRoute]) {
    const verbs = Object.keys(mod).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k));
    assert.deepEqual(verbs, ["GET"]);
  }
});

test("AUTH (structural): /admin/archive gates generateMetadata and the page body behind loadAdminGate; the landing page links it", () => {
  const source = fs.readFileSync(path.join(repoRoot, "app/admin/archive/page.tsx"), "utf8");
  const meta = source.match(/export async function generateMetadata\([^)]*\)[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(meta, "generateMetadata must exist");
  const gateIndex = meta[1].search(/loadAdminGate\(\)/);
  const earlyReturn = meta[1].match(/if\s*\(\s*!\s*\w+\s*\)\s*return\s*\{\s*\}\s*;/);
  assert.ok(gateIndex !== -1 && earlyReturn && earlyReturn.index > gateIndex, "metadata must return {} for a non-admin, after loadAdminGate()");
  const titleIndex = meta[1].search(/title\s*:/);
  assert.ok(titleIndex === -1 || titleIndex > earlyReturn.index);
  const body = source.match(/export default async function \w+\([^)]*\)[^{]*\{([\s\S]*)\}\s*$/);
  assert.ok(body, "page component must exist");
  const bodyGate = body[1].search(/loadAdminGate\(\)/);
  const notFound = body[1].match(/if\s*\(\s*!\s*\w+\s*\)\s*notFound\(\)\s*;/);
  assert.ok(bodyGate !== -1 && notFound && notFound.index > bodyGate, "page must notFound() a non-admin after loadAdminGate()");

  const landing = fs.readFileSync(path.join(repoRoot, "app/admin/page.tsx"), "utf8");
  assert.match(landing, /href="\/admin\/archive"/);
  assert.match(landing, /title="Archive"/);
});

// ---------------------------------------------------------------------------
// Metrics / status derivation
// ---------------------------------------------------------------------------

test("METRICS: summary counts are derived from the fixtures exactly", async () => {
  const summary = await getArchiveExplorerSummary(client, { asOf: ASOF });

  assert.equal(summary.maturityWindowDays, CORPUS_ACTIVATION_DELAY_DAYS);
  assert.deepEqual(summary.referenceArchive, {
    total: 2,
    active: 2,
    corpusVersions: [{ version: "archive-v5-test", count: 2 }],
    activeFingerprintVersion: ARCHIVE_COMPACT_FINGERPRINT_VERSION,
    fingerprintedUnderActiveVersion: 1,
  });
  assert.deepEqual(summary.legacy, { total: 2, active: 1, maturing: 1 });
  assert.deepEqual(
    {
      storedTotal: summary.admissions.storedTotal,
      active: summary.admissions.active,
      maturing: summary.admissions.maturing,
      awaitingIndex: summary.admissions.awaitingIndex,
      removed: summary.admissions.removed,
      review: summary.admissions.review,
      rejected: summary.admissions.rejected,
      duplicate: summary.admissions.duplicate,
      evaluated: summary.admissions.evaluated,
      pendingEvaluation: summary.admissions.pendingEvaluation,
    },
    { storedTotal: 5, active: 2, maturing: 2, awaitingIndex: 1, removed: 1, review: 1, rejected: 1, duplicate: 1, evaluated: 9, pendingEvaluation: 1 },
  );
  // Stored reconciles with the existing /admin/corpus "Total corpus representations" figure.
  assert.equal(summary.admissions.existingDashboardActiveRepresentations, summary.admissions.storedTotal);
  // Distinct match-eligible sources: 2 reference + legacy-old + D3 + D5 (exempt).
  assert.deepEqual(summary.activeMatchingSources, { total: 5, referenceArchive: 2, priorSubmissions: 3 });
  // Added = stored sources only (never rejected/duplicate/review). UTC calendar days.
  assert.deepEqual(summary.added, { today: 1, last7Days: 5, last30Days: 8 });
  assert.deepEqual(summary.rejectedOrDuplicate, { total: 2, last7Days: 2 });
});

test("CARD: the /admin Archive card figures are the explorer summary's own values (one derivation), read-only and privacy-safe", async () => {
  const summary = await getArchiveExplorerSummary(client, { asOf: ASOF });
  const log = [];
  const card = await getArchiveExplorerCardMetrics(auditing(client, log), { asOf: ASOF });
  assert.deepEqual(card, {
    active: summary.activeMatchingSources.total,
    addedLast7Days: summary.added.last7Days,
    maturing: summary.admissions.maturing,
    rejectedOrDuplicateLast7Days: summary.rejectedOrDuplicate.last7Days,
  });
  assert.deepEqual(card, { active: 5, addedLast7Days: 5, maturing: 2, rejectedOrDuplicateLast7Days: 2 });
  for (const sql of log) assert.match(sql.trimStart(), /^(WITH|SELECT)\b/i);
  assertNoSecrets(card, "card metrics");

  // Maturing on the card never includes a match-eligible source.
  const maturingRows = (await listAll({ sourceClass: "admitted_submission", state: "maturing" })).rows;
  assert.equal(maturingRows.length, card.maturing);
  assert.ok(maturingRows.every((row) => row.matchEligible === false));
});

test("GROWTH: 30 UTC day buckets ending today, attributed per class/outcome", async () => {
  const { growth } = await getArchiveExplorerSummary(client, { asOf: ASOF });
  assert.equal(growth.length, 30);
  assert.equal(growth[29].day, "2026-09-28");
  assert.equal(growth[0].day, "2026-08-30");
  const byDay = Object.fromEntries(growth.map((g) => [g.day, g]));
  assert.deepEqual(byDay["2026-09-28"], { day: "2026-09-28", accepted: 0, duplicate: 1, rejected: 0, review: 0, referenceAdded: 1, legacyAdded: 0 });
  assert.deepEqual(byDay["2026-09-27"], { day: "2026-09-27", accepted: 0, duplicate: 0, rejected: 0, review: 1, referenceAdded: 0, legacyAdded: 1 });
  assert.equal(byDay["2026-09-26"].accepted, 3);
  assert.equal(byDay["2026-09-25"].rejected, 1);
  assert.equal(byDay["2026-09-08"].accepted, 3);
});

test("ACTIVITY: recent events are derived from existing timestamps only, newest first, and are privacy-safe", async () => {
  const { activity } = await getArchiveExplorerSummary(client, { asOf: ASOF });
  assert.ok(activity.length > 0 && activity.length <= 14);
  for (let i = 1; i < activity.length; i += 1) assert.ok(activity[i - 1].at >= activity[i].at, "sorted newest first");
  const kinds = new Set(activity.map((e) => e.kind));
  for (const kind of ["reference_added", "duplicate", "admitted", "indexed", "review", "legacy_added", "rejected"]) {
    assert.ok(kinds.has(kind), `expected a ${kind} event`);
  }
  // "matured" = T0 + 7 days, only for accepted decisions whose window elapsed.
  const matured = activity.filter((e) => e.kind === "matured").map((e) => e.sourceId);
  for (const id of matured) assert.ok([D2_AWAITING_INDEX, D3_ACTIVE, D6_REMOVED].some((d) => id === `admission:${d.decisionId}`));
  assert.ok(activity.every((e) => e.at <= ASOF.toISOString()), "no event from the future");
  assertNoSecrets(activity, "activity");
});

// ---------------------------------------------------------------------------
// Maturity vs active
// ---------------------------------------------------------------------------

test("MATURITY: maturing rows are never match-eligible; an indexed-but-immature admission stays MATURING; exemption applies exactly as the matcher's", async () => {
  const { rows } = await listAll({ state: "maturing" });
  assert.deepEqual(
    rows.map((r) => r.sourceId).sort(),
    [`admission:${D1_MATURING.decisionId}`, `admission:${D4_INDEXED_MATURING.decisionId}`, `legacy:${LEGACY_RECENT}`].sort(),
  );
  assert.ok(rows.every((r) => r.matchEligible === false));

  const d4 = await getArchiveExplorerSourceDetail(client, `admission:${D4_INDEXED_MATURING.decisionId}`, { asOf: ASOF });
  assert.equal(d4.state, "maturing");
  assert.equal(d4.promotionStatus, "indexed");
  assert.equal(d4.matchEligible, false);
  assert.equal(d4.mature, false);
  assert.equal(await isRepresentationEligibleForMatching(client, D4_INDEXED_MATURING.representationId, { asOf: ASOF }), false);

  const d5 = await getArchiveExplorerSourceDetail(client, `admission:${D5_EXEMPT_ACTIVE.decisionId}`, { asOf: ASOF });
  assert.equal(d5.state, "active");
  assert.equal(d5.maturityExemptionApplies, true);
  assert.equal(await isRepresentationEligibleForMatching(client, D5_EXEMPT_ACTIVE.representationId, { asOf: ASOF }), true);

  const d2 = await getArchiveExplorerSourceDetail(client, `admission:${D2_AWAITING_INDEX.decisionId}`, { asOf: ASOF });
  assert.equal(d2.state, "stored", "mature but never indexed is STORED (awaiting index), never ACTIVE");
  assert.equal(d2.matchEligible, false);
  assert.equal(d2.mature, true);
});

test("MATURITY: every row's matchEligible equals the real matcher predicate for its representation", async () => {
  const { rows } = await listAll();
  assert.equal(rows.length, TOTAL_SOURCES);
  for (const row of rows) {
    if (row.sourceClass === "legacy_submission") {
      const repId = row.sourceId.slice("legacy:".length);
      assert.equal(row.matchEligible, await isRepresentationEligibleForMatching(client, repId, { asOf: ASOF }), row.sourceId);
      assert.equal(row.state, row.matchEligible ? "active" : "maturing");
    }
    if (row.sourceClass === "admitted_submission") {
      const detail = await getArchiveExplorerSourceDetail(client, row.sourceId, { asOf: ASOF });
      assert.equal(detail.state, row.state, `${row.sourceId} list/detail state agree`);
    }
    if (row.state === "active") assert.equal(row.matchEligible, true, `${row.sourceId}: ACTIVE implies match-eligible`);
  }
});

test("MATURITY: the admission-backing maturity term matches the real predicate at the inclusive 7-day boundary", async () => {
  const cutoff = corpusMaturityCutoff(ASOF);
  const onBoundary = await acceptAndStore({ accountId: ACCOUNT_A, createdAt: cutoff, promoteAt: cutoff });
  const oneSecondLate = await acceptAndStore({ accountId: ACCOUNT_A, createdAt: at(new Date(new Date(`${cutoff.replace(" ", "T")}Z`).getTime() + 1000).toISOString()), promoteAt: cutoff });
  for (const [fixture, expectedEligible, expectedState] of [[onBoundary, true, "active"], [oneSecondLate, false, "maturing"]]) {
    const predicate = await isRepresentationEligibleForMatching(client, fixture.representationId, { asOf: ASOF });
    assert.equal(predicate, expectedEligible);
    const detail = await getArchiveExplorerSourceDetail(client, `admission:${fixture.decisionId}`, { asOf: ASOF });
    assert.equal(detail.mature, expectedEligible, "explorer maturity == predicate maturity");
    assert.equal(detail.matchEligible, expectedEligible);
    assert.equal(detail.state, expectedState);
  }
  await client.execute({ sql: "DELETE FROM corpus_admission_promotions WHERE decision_id IN (?, ?)", args: [onBoundary.decisionId, oneSecondLate.decisionId] });
  await client.execute({ sql: "DELETE FROM corpus_document_representations WHERE id IN (?, ?)", args: [onBoundary.representationId, oneSecondLate.representationId] });
  await client.execute({ sql: "DELETE FROM corpus_admission_decisions WHERE id IN (?, ?)", args: [onBoundary.decisionId, oneSecondLate.decisionId] });
});

test("LIFECYCLE: a new accepted upload is Stored +1 / Maturing +1 (never Active); once mature AND indexed it moves Maturing -1 / Active +1", async () => {
  const before = await getArchiveExplorerSummary(client, { asOf: ASOF });
  const fresh = await acceptAndStore({ accountId: ACCOUNT_A, createdAt: daysBefore(0, 3), promoteAt: daysBefore(0, 2) });
  const after = await getArchiveExplorerSummary(client, { asOf: ASOF });
  assert.equal(after.admissions.storedTotal - before.admissions.storedTotal, 1);
  assert.equal(after.admissions.maturing - before.admissions.maturing, 1);
  assert.equal(after.admissions.active - before.admissions.active, 0);
  assert.equal(after.activeMatchingSources.priorSubmissions - before.activeMatchingSources.priorSubmissions, 0);

  const later = new Date(ASOF.getTime() + 8 * 86_400_000);
  const freshLater = await getArchiveExplorerSourceDetail(client, `admission:${fresh.decisionId}`, { asOf: later });
  assert.equal(freshLater.state, "active");
  assert.equal(await isRepresentationEligibleForMatching(client, fresh.representationId, { asOf: later }), true);
  // Same maturity, never indexed -> STORED (awaiting index), never ACTIVE.
  const d1Later = await getArchiveExplorerSourceDetail(client, `admission:${D1_MATURING.decisionId}`, { asOf: later });
  assert.equal(d1Later.state, "stored");
  assert.equal(d1Later.matchEligible, false);

  await client.execute({ sql: "DELETE FROM corpus_admission_promotions WHERE decision_id = ?", args: [fresh.decisionId] });
  await client.execute({ sql: "DELETE FROM corpus_document_representations WHERE id = ?", args: [fresh.representationId] });
  await client.execute({ sql: "DELETE FROM corpus_admission_decisions WHERE id = ?", args: [fresh.decisionId] });
});

// ---------------------------------------------------------------------------
// Pagination / search / filter
// ---------------------------------------------------------------------------

test("PAGINATION: pages partition the full result set with no duplicates, newest first; pageSize is clamped", async () => {
  const { rows, totalCount } = await listAll();
  assert.equal(totalCount, TOTAL_SOURCES);
  assert.equal(new Set(rows.map((r) => r.sourceId)).size, TOTAL_SOURCES);
  for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i - 1].addedAt >= rows[i].addedAt);

  const oldest = await listArchiveExplorerSources(client, { sort: "oldest", pageSize: 1 }, { asOf: ASOF });
  assert.equal(oldest.rows[0].sourceId, `archive:${ARCHIVE_OLD.articleId}`);

  const clamped = await listArchiveExplorerSources(client, { pageSize: 10_000 }, { asOf: ASOF });
  assert.equal(clamped.pageSize, ARCHIVE_EXPLORER_MAX_PAGE_SIZE);
  const beyond = await listArchiveExplorerSources(client, { page: 99, pageSize: 5 }, { asOf: ASOF });
  assert.deepEqual(beyond.rows, []);
  assert.equal(beyond.totalCount, TOTAL_SOURCES);

  const viaRoute = await callRoute(listRoute.GET, "/api/admin/archive?pageSize=500&page=1", { token: adminToken });
  const body = await viaRoute.json();
  assert.equal(body.pageSize, ARCHIVE_EXPLORER_MAX_PAGE_SIZE);
});

test("FILTERS: class and state filters, with facet counts computed under the search term only", async () => {
  const archiveOnly = await listArchiveExplorerSources(client, { sourceClass: "reference_archive" }, { asOf: ASOF });
  assert.equal(archiveOnly.totalCount, 2);
  assert.ok(archiveOnly.rows.every((r) => r.sourceClass === "reference_archive" && r.state === "active" && r.maturesAt === null));
  assert.deepEqual(archiveOnly.facets.bySourceClass, { reference_archive: 2, admitted_submission: 9, legacy_submission: 2 });
  assert.deepEqual(archiveOnly.facets.byState, { active: 5, maturing: 3, stored: 1, removed: 1, review: 1, rejected: 1, duplicate: 1 });

  const duplicates = await listArchiveExplorerSources(client, { state: "duplicate" }, { asOf: ASOF });
  assert.deepEqual(duplicates.rows.map((r) => r.sourceId), [`admission:${D7_DUPLICATE.id}`]);
  const rejected = await listArchiveExplorerSources(client, { state: "rejected" }, { asOf: ASOF });
  assert.deepEqual(rejected.rows.map((r) => r.sourceId), [`admission:${D8_REJECTED.id}`]);
  const review = await listArchiveExplorerSources(client, { state: "review" }, { asOf: ASOF });
  assert.deepEqual(review.rows.map((r) => r.sourceId), [`admission:${D9_REVIEW.id}`]);
  const removed = await listArchiveExplorerSources(client, { state: "removed" }, { asOf: ASOF });
  assert.deepEqual(removed.rows.map((r) => r.sourceId), [`admission:${D6_REMOVED.decisionId}`]);
  const activeAdmissions = await listArchiveExplorerSources(client, { sourceClass: "admitted_submission", state: "active" }, { asOf: ASOF });
  assert.deepEqual(activeAdmissions.rows.map((r) => r.sourceId).sort(), [`admission:${D3_ACTIVE.decisionId}`, `admission:${D5_EXEMPT_ACTIVE.decisionId}`].sort());
  assert.equal(activeAdmissions.totalCount, 2);
});

test("SEARCH: title (case-insensitive), source id and fingerprint prefix match server-side; account ids, emails and source_ref never do", async () => {
  const byTitle = await listArchiveExplorerSources(client, { q: "maritime LAW" }, { asOf: ASOF });
  assert.deepEqual(byTitle.rows.map((r) => r.sourceId), [`archive:${ARCHIVE_OLD.articleId}`]);
  assert.equal(byTitle.facets.bySourceClass.reference_archive, 1);

  const byId = await listArchiveExplorerSources(client, { q: D3_ACTIVE.decisionId.slice(0, 12) }, { asOf: ASOF });
  assert.deepEqual(byId.rows.map((r) => r.sourceId), [`admission:${D3_ACTIVE.decisionId}`]);

  const byFingerprint = await listArchiveExplorerSources(client, { q: sha(3).slice(0, 10) }, { asOf: ASOF });
  assert.deepEqual(byFingerprint.rows.map((r) => r.sourceId), [`legacy:${LEGACY_OLD}`]);

  for (const probe of [ACCOUNT_A, `${ACCOUNT_A}@customer-private.example`, "report-upload:", "device-key-", "Private Thesis Title", "%", "_"]) {
    const result = await listArchiveExplorerSources(client, { q: probe }, { asOf: ASOF });
    assert.equal(result.totalCount, 0, `search for ${probe} must match nothing`);
  }
});

// ---------------------------------------------------------------------------
// Privacy-safe serialization + read-only
// ---------------------------------------------------------------------------

test("PRIVACY: summary, every list row and every detail payload are free of emails, account/device/report ids, source_ref and text", async () => {
  const summary = await getArchiveExplorerSummary(client, { asOf: ASOF });
  assertNoSecrets(summary, "summary");
  const { rows } = await listAll();
  assertNoSecrets(rows, "list");
  for (const row of rows) {
    if (row.sourceClass !== "reference_archive") assert.match(row.displayName, /^(Private|Legacy) submission · [0-9a-z]{8}$/);
    const detail = await getArchiveExplorerSourceDetail(client, row.sourceId, { asOf: ASOF });
    assert.ok(detail, row.sourceId);
    assertNoSecrets(detail, `detail ${row.sourceId}`);
    if (detail.fingerprintPrefix) assert.equal(detail.fingerprintPrefix.length, 12);
    for (const forbidden of ["accountId", "accountEmail", "deviceKey", "reportId", "sourceRef", "familyMatchedSourceRef", "canonicalText", "canonicalSha256"]) {
      assert.equal(forbidden in detail, false, `${row.sourceId} detail must not carry ${forbidden}`);
    }
  }
  const viaRoute = await callRoute(detailRoute.GET, "/api/admin/archive/x", { token: adminToken, params: { id: `admission:${D7_DUPLICATE.id}` } });
  const body = await viaRoute.json();
  assert.equal(body.familyRelation, "EXACT_DUPLICATE");
  assertNoSecrets(body, "detail route");
});

test("PRIVACY: malformed or unknown ids are a 404 without distinguishing why", async () => {
  for (const id of ["nope", "admission:", "archive:does-not-exist", `legacy:${ARCHIVE_TODAY.repId}`, `legacy:${D3_ACTIVE.representationId}`]) {
    assert.equal(await getArchiveExplorerSourceDetail(client, id, { asOf: ASOF }), null, id);
    const response = await callRoute(detailRoute.GET, "/api/admin/archive/x", { token: adminToken, params: { id } });
    assert.equal(response.status, 404);
  }
});

test("READ-ONLY: summary, list and detail issue only SELECT/WITH statements and leave every table unchanged", async () => {
  const countsBefore = await tableCounts();
  const log = [];
  const audited = auditing(client, log);
  await getArchiveExplorerSummary(audited, { asOf: ASOF });
  const page = await listArchiveExplorerSources(audited, { q: "a", pageSize: 50 }, { asOf: ASOF });
  for (const row of page.rows) await getArchiveExplorerSourceDetail(audited, row.sourceId, { asOf: ASOF });
  assert.ok(log.length > 0);
  for (const sql of log) assert.match(sql.trimStart(), /^(WITH|SELECT)\b/i, `non-read statement: ${sql.slice(0, 80)}`);
  assert.deepEqual(await tableCounts(), countsBefore);
});

async function tableCounts() {
  const tables = [
    "corpus_document_representations", "corpus_submission_references", "archive_document_representations",
    "corpus_admission_decisions", "corpus_admission_accepted_representations", "corpus_admission_promotions",
    "corpus_admission_content_store", "corpus_admission_report_jobs", "developer_corpus_maturity_exemptions",
  ];
  const out = {};
  for (const table of tables) out[table] = Number((await client.execute(`SELECT COUNT(*) AS c FROM ${table}`)).rows[0].c);
  return out;
}

test("STRUCTURAL: the explorer module never selects source_ref, account/device/report ids, emails or text columns", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/corpus-admission-archive-explorer.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  for (const forbidden of [/\bsource_ref\b/, /\bfamily_matched_source_ref\b/, /\baccount_id\b/, /\bdevice_key\b/, /\breport_id\b/, /\bemail\b/, /\bcanonical_text\b/, /\busers\b/, /\bsaved_reports\b/]) {
    assert.doesNotMatch(source, forbidden);
  }
});

// ---------------------------------------------------------------------------
// Maturity-rule reuse, removed escape hatch, /admin card wiring
// ---------------------------------------------------------------------------

function codeOf(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("MATURITY RULE: the admin predicates reuse corpusMaturityCutoff (CORPUS_ACTIVATION_DELAY_DAYS) and the matcher's own exemption binds; the backing term is arm 2's verbatim text", async () => {
  const predicates = await resolveAdminEligibilityPredicates(client, ASOF);
  const expectedCutoff = sqliteUtcTimestamp(new Date(ASOF.getTime() - CORPUS_ACTIVATION_DELAY_DAYS * 86_400_000));
  assert.equal(predicates.maturityCutoff, expectedCutoff);
  assert.equal(predicates.maturityCutoff, corpusMaturityCutoff(ASOF));
  // The single-backing maturity term is a verbatim substring of the live MATCHING
  // predicate (arm 2), so it cannot drift from the matcher without failing here.
  assert.ok(predicates.matching.sql.includes(` AND ${predicates.admissionBackingMaturity.sql}`), "backing maturity term must be arm 2's own text");
  // Same cutoff and the same exemption list the MATCHING predicate is bound with
  // (MATCHING bind order: cutoff, prefix x3, cutoff, exemptJson, cutoff).
  assert.deepEqual(predicates.admissionBackingMaturity.args, [predicates.matching.args[4], predicates.matching.args[5]]);
  assert.equal(predicates.matching.args[0], expectedCutoff);
  assert.deepEqual(JSON.parse(predicates.matching.args[5]).length, 1, "the one exempt account's prefix is bound");

  // No second literal maturity window anywhere in the explorer's code.
  const helperSource = codeOf("lib/user-submission-corpus.ts").match(/export async function resolveAdminEligibilityPredicates[\s\S]*?\n\}/);
  assert.ok(helperSource, "resolveAdminEligibilityPredicates must exist");
  assert.doesNotMatch(helperSource[0], /\b7\b|86_?400_?000/, "the helper must derive its cutoff via corpusMaturityCutoff, never a literal window");
  assert.match(helperSource[0], /corpusMaturityCutoff\(asOf\)/);
  const explorer = codeOf("lib/corpus-admission-archive-explorer.ts");
  assert.match(explorer, /CORPUS_ACTIVATION_DELAY_DAYS/);
  const sevens = explorer.split("\n").filter((line) => /\b7\b/.test(line));
  assert.deepEqual(sevens.map((l) => l.trim()), ["const RECENT_WINDOW_DAYS = 7;"], "the only literal 7 is the named 7-day reporting window");
  for (const file of fs.readdirSync(path.join(repoRoot, "components/admin/archive"))) {
    assert.doesNotMatch(codeOf(`components/admin/archive/${file}`), /\b7[- ]day\b/i, `${file} must render the maturity window from data, not a literal`);
  }
});

test("PRIVACY: the explorer never links to /admin/corpus (whose admission record shows the account email)", () => {
  const files = [
    "app/admin/archive/page.tsx",
    "lib/corpus-admission-archive-explorer.ts",
    ...fs.readdirSync(path.join(repoRoot, "components/admin/archive")).map((f) => `components/admin/archive/${f}`),
  ];
  for (const file of files) {
    assert.doesNotMatch(codeOf(file), /\/admin\/corpus/, `${file} must not link to the email-revealing admission record`);
  }
});

test("CARD (structural): /admin loads the Archive figures only after the admin gate, from getArchiveExplorerCardMetrics, and never hardcodes a figure", () => {
  const page = codeOf("app/admin/page.tsx");
  const body = page.match(/export default async function \w+\([^)]*\)[^{]*\{([\s\S]*)\}\s*$/)[1];
  const notFoundAt = body.search(/if\s*\(\s*!\s*\w+\s*\)\s*notFound\(\)\s*;/);
  const loadAt = body.search(/getArchiveExplorerCardMetrics\(/);
  assert.ok(notFoundAt !== -1 && loadAt > notFoundAt, "figures load only after the non-admin notFound()");
  assert.match(page, /<ArchiveCardMetrics metrics=\{archiveMetrics\} \/>/);
  assert.match(page, /href="\/admin\/archive"/);
  const card = codeOf("components/admin/archive/archive-card-metrics.tsx");
  for (const label of ["Active", "This week", "Maturing", "Rejected · 7d"]) assert.ok(card.includes(`label="${label}"`), label);
  assert.doesNotMatch(card, /value=\{\d/, "no hardcoded figure");
  assert.match(card, /unavailable/, "a failed load says so instead of showing zeros");
});

test("CARD: compact figures stay short enough for the narrowest launcher card", () => {
  assert.equal(formatCompactCount(0), "0");
  assert.equal(formatCompactCount(9_999), "9,999");
  assert.equal(formatCompactCount(12_345), "12.3K");
  assert.equal(formatCompactCount(105_024), "105K");
  assert.equal(formatCompactCount(1_234_567), "1.2M");
  for (const n of [0, 7, 321, 9_999, 10_000, 99_999, 105_024, 999_999, 1_234_567, 98_765_432]) {
    assert.ok(formatCompactCount(n).length <= 6, `${n} -> ${formatCompactCount(n)}`);
  }
});
