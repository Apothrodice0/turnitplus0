import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createSession, SESSION_COOKIE_NAME } from "../lib/auth-session.ts";
import { resetAdminRateForTest } from "../lib/rate-limit.js";
import * as deactivateRoute from "../app/api/admin/corpus/[id]/deactivate/route.ts";
import { findCandidateCorpusRepresentations, CORPUS_FINGERPRINT_VERSION } from "../lib/user-submission-corpus.ts";

/**
 * Task B1A: admin "Remove" beside Inspect (components/admin/corpus-search.tsx),
 * built entirely on the EXISTING deactivate mechanism
 * (lib/corpus-admission-admin-actions.ts's deactivateAcceptedRepresentation,
 * via app/api/admin/corpus/[id]/deactivate/route.ts — the same route
 * components/admin/corpus-detail.tsx already used before this change).
 *
 * This file does NOT re-test revocation/audit/idempotency/conflict
 * mechanics already covered by tests/corpus-admission-admin-actions.test.mjs
 * and tests/corpus-admission-admin-routes.test.mjs — it proves only what is
 * new here: the list repo's acceptedRepresentationActive field (see
 * tests/corpus-admission-admin-repo.test.mjs for that), the new UI's own
 * shape (structural, source-level — this codebase has no jsdom/
 * testing-library dependency; component tests elsewhere use
 * renderToStaticMarkup for static server components only, which cannot
 * exercise this "use client" component's interactivity), and the two
 * end-to-end guarantees the task explicitly calls out: shared-backing
 * eligibility (findCandidateCorpusRepresentations) is unaffected, and
 * reports/users/receipts are untouched by the reused action.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_remove_ui.db");
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
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `remove-ui-test-${ipCounter}`;
}

let userCounter = 0;
async function ensureUser(role) {
  userCounter += 1;
  const accountId = `remove-ui-account-${role}-${userCounter}`;
  await client.execute({
    sql: "INSERT INTO users (id, email, username, password_hash, role) VALUES (?,?,?,?,?)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash", role],
  });
  const token = await createSession(client, accountId);
  return { accountId, token };
}

function headersFor({ cookie, origin, host } = {}) {
  const headers = { "x-forwarded-for": nextIp(), "content-type": "application/json" };
  if (cookie) headers.cookie = `${SESSION_COOKIE_NAME}=${cookie}`;
  if (origin !== undefined) headers.origin = origin;
  if (host !== undefined) headers.host = host;
  return headers;
}
async function resetRateFor(headers) {
  await resetAdminRateForTest(headers["x-forwarded-for"]);
}
const SAME_ORIGIN = { origin: "http://localhost", host: "localhost" };

// callDeactivate mirrors the EXACT request shape components/admin/corpus-search.tsx's
// confirmRemove() sends — same method, headers, and JSON body — so these tests
// exercise the real path the new Remove button drives, not a re-implementation.
async function callDeactivate(rowId, opts, body) {
  const headers = headersFor(opts);
  await resetRateFor(headers);
  return deactivateRoute.POST(
    new Request(`http://localhost/api/admin/corpus/${encodeURIComponent(rowId)}/deactivate`, { method: "POST", headers, body: JSON.stringify(body ?? { reason: "test reason" }) }),
    { params: Promise.resolve({ id: rowId }) },
  );
}

async function seedAcceptedDecision(canonicalSha256) {
  const decisionId = randomUUID();
  const hash = canonicalSha256 ?? randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      decisionId, null, `remove-ui-seed-${randomUUID()}`, "v1", "ACCEPT", "[]", 1, "[]",
      "txt", 3300, "English", 0.95, hash, "v1", null, 90, "v1", "{}", "{}", "v1", 0.9, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  const acceptedRepresentationId = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
    args: [acceptedRepresentationId, decisionId, hash, 3300, "v1"],
  });
  return { decisionId, acceptedRepresentationId, canonicalSha256: hash };
}

// ============================================================================
// STRUCTURAL: components/admin/corpus-search.tsx — the new UI's own shape
// ============================================================================

const SEARCH_SOURCE = fs.readFileSync(path.join(repoRoot, "components/admin/corpus-search.tsx"), "utf8");

test("STRUCTURAL: Remove is rendered beside Inspect, gated on acceptedRepresentationActive — inactive rows show 'Removed' instead", () => {
  assert.match(SEARCH_SOURCE, /Inspect<\/Link>/, "Inspect link must remain");
  assert.match(SEARCH_SOURCE, /row\.acceptedRepresentationActive/, "the Remove/Removed choice must be driven by the list row's own acceptedRepresentationActive field");
  assert.match(SEARCH_SOURCE, />Remove<\/button>/, "an active row must render a Remove trigger");
  assert.match(SEARCH_SOURCE, />Removed<\/span>/, "an already-deactivated row must visibly show as removed, not silently drop the affordance");
});

test("STRUCTURAL: Remove requires an explicit confirmation step — the row trigger only opens a dialog, it never fetches directly", () => {
  const removeButtonMatch = SEARCH_SOURCE.match(/<button type="button" onClick=\{\(\) => (\w+)\(row\.rowId\)\}>Remove<\/button>/);
  assert.ok(removeButtonMatch, "expected the row's Remove button to call a named opener function with the row id");
  const opener = removeButtonMatch[1];
  assert.doesNotMatch(opener, /fetch|confirm|deactivate/i, `the row-level trigger ("${opener}") must only open the dialog, never perform the mutation itself`);

  assert.match(SEARCH_SOURCE, /role="dialog"/, "a confirmation dialog must exist");
  assert.match(SEARCH_SOURCE, /Remove this item from the TurnitPlus corpus\?/);
  assert.match(SEARCH_SOURCE, /Existing reports, receipts, users and submission\s+history will not be deleted/);
  assert.match(SEARCH_SOURCE, />Cancel<\/button>/);
  assert.match(SEARCH_SOURCE, />\s*Remove from corpus\s*<\/button>/);
});

test("STRUCTURAL: the reason field is required — the confirm button is disabled until a non-empty reason is entered", () => {
  assert.match(SEARCH_SOURCE, /Reason \(required\)/);
  assert.match(SEARCH_SOURCE, /disabled=\{removeLoading \|\| removeReason\.trim\(\)\.length === 0\}/, "the confirm button must stay disabled until a non-empty reason is present");
});

test("STRUCTURAL: the confirm action calls the EXISTING deactivate endpoint — no new route, no direct DB/action-layer import", () => {
  assert.match(SEARCH_SOURCE, /\/api\/admin\/corpus\/\$\{encodeURIComponent\(removeDialogRowId\)\}\/deactivate/, "must POST to the existing per-decision deactivate route");
  assert.doesNotMatch(SEARCH_SOURCE, /\/remove\b/i, "must not introduce a new /remove-shaped route");

  // Only the import lines matter here — the file's own explanatory comments
  // legitimately NAME lib/corpus-admission-admin-actions.ts (the module the
  // reused endpoint is backed by) without importing it. Mirrors
  // tests/corpus-admission-privacy.test.mjs's own importLines() convention.
  const importLines = SEARCH_SOURCE.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join("\n");
  assert.doesNotMatch(importLines, /corpus-admission-admin-actions|corpus-admission-admin-repo|admin-gate/, "a client component must never import the server-only action/repo/gate modules directly — see tests/corpus-admission-privacy.test.mjs's closed-door check");
  assert.doesNotMatch(importLines, /@libsql\/client/, "must stay a plain HTTP-fetching client component");
});

test("STRUCTURAL: a successful removal reloads the list through the SAME fetch path used for filters/pagination, and shows a success message — never a second, parallel list fetch", () => {
  const effectDepsMatch = SEARCH_SOURCE.match(/\}, \[status, language, q, page, (\w+)\]\);/);
  assert.ok(effectDepsMatch, "expected the list-loading effect's dependency array to include a reload-trigger state variable");
  const reloadVar = effectDepsMatch[1];
  const setterName = `set${reloadVar[0].toUpperCase()}${reloadVar.slice(1)}`;
  assert.match(SEARCH_SOURCE, new RegExp(`${setterName}\\(`), `expected confirmRemove's success branch to call ${setterName}, the same state setter the load effect depends on`);
  assert.match(SEARCH_SOURCE, /successMessage/);
});

test("STRUCTURAL: on failure, only a safe status's server-provided message or a fixed generic message is shown — never a raw caught error", () => {
  assert.match(SEARCH_SOURCE, /REMOVE_SAFE_ERROR_STATUSES/);
  assert.match(SEARCH_SOURCE, /REMOVE_GENERIC_ERROR/);
  assert.doesNotMatch(SEARCH_SOURCE, /catch \(err\)[\s\S]{0,80}err\.message[\s\S]{0,20}setRemoveError\(err\.message\)/, "must never directly surface a caught error's raw message");
});

test("STRUCTURAL: no account id, email, retained text, or internal identifier is introduced in the dialog beyond what the list row already carries", () => {
  const dialogMatch = SEARCH_SOURCE.match(/role="dialog"[\s\S]*?<\/div>\s*\)\s*\}/);
  assert.ok(dialogMatch, "expected to isolate the dialog's own JSX block");
  const dialogBody = dialogMatch[0];
  for (const forbidden of ["accountEmail", "canonical_text", "canonicalSha256", "preview", "content_store", "hasRetainedText"]) {
    assert.doesNotMatch(dialogBody, new RegExp(forbidden), `the removal dialog must not reference ${forbidden}`);
  }
});

test("STRUCTURAL: the account column shows 'Account owner' / the resolved email (falling back to 'unknown'), never the raw account UUID", () => {
  assert.match(SEARCH_SOURCE, /<th>Account owner<\/th>/, "the column header must say 'Account owner', not 'Account'");
  assert.match(SEARCH_SOURCE, /\{row\.accountEmail \?\? "unknown"\}/, "the cell must render accountEmail, falling back to the literal string 'unknown'");
  assert.doesNotMatch(SEARCH_SOURCE, /\{row\.accountId(?:\s*\?\?[^}]*)?\}/, "the list must never render the raw account UUID directly — see components/admin/corpus-detail.tsx for the separate, existing detail-view fallback that is deliberately not reused here");
});

// ============================================================================
// BEHAVIORAL: exercised through the real route — the exact path Remove drives
// ============================================================================

test("AUTHORIZATION: the Remove flow's request (real deactivate route, same-origin, JSON body) still 404s for no session and for a non-admin session — client-side hiding is never the security boundary", async () => {
  const { decisionId, acceptedRepresentationId } = await seedAcceptedDecision();
  const nonAdmin = await ensureUser("user");
  const admin = await ensureUser("admin");

  const anon = await callDeactivate(`decision:${decisionId}`, SAME_ORIGIN, { reason: "attempted removal" });
  assert.equal(anon.status, 404);

  const asNonAdmin = await callDeactivate(`decision:${decisionId}`, { ...SAME_ORIGIN, cookie: nonAdmin.token }, { reason: "attempted removal" });
  assert.equal(asNonAdmin.status, 404);

  const row = await client.execute({ sql: "SELECT revoked_at FROM corpus_admission_accepted_representations WHERE id = ?", args: [acceptedRepresentationId] });
  assert.equal(row.rows[0].revoked_at, null, "neither an anonymous nor a non-admin request may change the fingerprint's active state");

  const asAdmin = await callDeactivate(`decision:${decisionId}`, { ...SAME_ORIGIN, cookie: admin.token }, { reason: "legitimate takedown" });
  assert.equal(asAdmin.status, 200);
});

test("REASON REQUIRED + IDEMPOTENT: the Remove flow rejects an empty reason with 400 and never mutates state; confirming twice is a safe no-op the second time", async () => {
  const { decisionId, acceptedRepresentationId } = await seedAcceptedDecision();
  const admin = await ensureUser("admin");

  const emptyReason = await callDeactivate(`decision:${decisionId}`, { ...SAME_ORIGIN, cookie: admin.token }, { reason: "" });
  assert.equal(emptyReason.status, 400);
  let row = await client.execute({ sql: "SELECT revoked_at FROM corpus_admission_accepted_representations WHERE id = ?", args: [acceptedRepresentationId] });
  assert.equal(row.rows[0].revoked_at, null);

  const first = await callDeactivate(`decision:${decisionId}`, { ...SAME_ORIGIN, cookie: admin.token }, { reason: "confirmed removal" });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).outcome, "deactivated");
  row = await client.execute({ sql: "SELECT revoked_at FROM corpus_admission_accepted_representations WHERE id = ?", args: [acceptedRepresentationId] });
  const revokedAtFirst = row.rows[0].revoked_at;
  assert.notEqual(revokedAtFirst, null);

  // Same request repeated (double-click, or the admin re-opening the dialog and confirming again).
  const second = await callDeactivate(`decision:${decisionId}`, { ...SAME_ORIGIN, cookie: admin.token }, { reason: "confirmed removal again" });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).outcome, "already_inactive");
  row = await client.execute({ sql: "SELECT revoked_at FROM corpus_admission_accepted_representations WHERE id = ?", args: [acceptedRepresentationId] });
  assert.equal(row.rows[0].revoked_at, revokedAtFirst, "a repeated removal must never change the already-recorded revocation timestamp");

  const audit = await client.execute({ sql: "SELECT * FROM corpus_admission_admin_audit_log WHERE decision_id = ? AND action = 'deactivate'", args: [decisionId] });
  assert.equal(audit.rows.length, 1, "a no-op repeat must never write a second audit row");
});

test("PRESERVED: reports, receipts (rendered from saved_reports), and users are untouched by Remove", async () => {
  const admin = await ensureUser("admin");
  const owner = await ensureUser("user");

  const deviceKey = `remove-ui-dk-${randomUUID()}`;
  const reportId = `remove-ui-rid-${randomUUID()}`;
  await client.execute({
    sql: `INSERT INTO saved_reports
          (id, device_key, user_id, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, saved_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [
      reportId, deviceKey, owner.accountId, `remove-ui-sub-${randomUUID()}`, "unrelated-report.txt",
      new Date().toISOString(), 500, 5, "Low",
      JSON.stringify({ text: "unrelated report content, must survive Remove untouched" }),
    ],
  });

  const beforeUser = await client.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [owner.accountId] });
  const beforeReport = await client.execute({ sql: "SELECT * FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, reportId] });
  assert.equal(beforeReport.rows.length, 1);

  const { decisionId } = await seedAcceptedDecision();
  const res = await callDeactivate(`decision:${decisionId}`, { ...SAME_ORIGIN, cookie: admin.token }, { reason: "unrelated removal, must not cascade" });
  assert.equal(res.status, 200);

  const afterUser = await client.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [owner.accountId] });
  const afterReport = await client.execute({ sql: "SELECT * FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, reportId] });
  assert.equal(afterUser.rows.length, 1, "the unrelated user row must still exist");
  assert.equal(afterReport.rows.length, 1, "the unrelated saved_reports row must still exist");
  for (const column of ["id", "email", "username", "password_hash", "role", "corpus_reuse_consented_at"]) {
    assert.equal(afterUser.rows[0][column], beforeUser.rows[0][column], `users.${column} must be unchanged`);
  }
  for (const column of ["id", "device_key", "user_id", "submission_id", "title", "payload_json", "archive_score", "score_band"]) {
    assert.equal(afterReport.rows[0][column], beforeReport.rows[0][column], `saved_reports.${column} (what a rendered receipt is built from) must be unchanged`);
  }
});

// ============================================================================
// BEHAVIORAL: shared-backing eligibility (findCandidateCorpusRepresentations)
// is unaffected — the "one vote" semantics survive this feature untouched.
// ============================================================================

async function seedRealRepresentation(shingleHashes) {
  const representationId = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_document_representations (id, canonical_sha256, canonical_text, word_count, language, canonicalization_version, created_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [representationId, randomUUID(), "shared real-corpus representation used by two independent admission decisions", 12, "English", "v1"],
  });
  for (const hash of shingleHashes) {
    await client.execute({
      sql: `INSERT INTO corpus_document_shingles (representation_id, shingle_hash, fingerprint_version, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)`,
      args: [representationId, hash, CORPUS_FINGERPRINT_VERSION],
    });
  }
  return representationId;
}

// linkType matters: findCandidateCorpusRepresentations rescues a
// representation with NO 'NEW_CONTENT_REPRESENTATION' promotion at all
// (treating it as a legacy/pre-existing row never created by the promotion
// pipeline — see that function's own header comment). To genuinely exercise
// the "one vote" eligibility path rather than that unrelated rescue, exactly
// one seeded source must be the 'NEW_CONTENT_REPRESENTATION' promotion that
// created the representation; any other source referencing the same
// representation is 'EXACT_CANONICAL_DUPLICATE', mirroring how
// lib/corpus-admission-promotion.ts's indexPromotionAtomically actually
// assigns link_type.
async function seedIndexedPromotion(representationId, linkType) {
  const { decisionId, acceptedRepresentationId } = await seedAcceptedDecision();
  const promotionId = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_promotions
          (id, decision_id, accepted_representation_id, representation_id, link_type, fingerprint_version, status, attempt_count, created_at, updated_at)
          VALUES (?,?,?,?,?,?,'indexed',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [promotionId, decisionId, acceptedRepresentationId, representationId, linkType, CORPUS_FINGERPRINT_VERSION],
  });
  return { decisionId, acceptedRepresentationId };
}

test("SHARED BACKING: deactivating one of two sources backing the same representation removes only one vote — it stays matchable until the last vote is gone", async () => {
  const admin = await ensureUser("admin");
  const shingleHashes = [randomUUID(), randomUUID(), randomUUID()];
  const representationId = await seedRealRepresentation(shingleHashes);

  const sourceA = await seedIndexedPromotion(representationId, "NEW_CONTENT_REPRESENTATION");
  const sourceB = await seedIndexedPromotion(representationId, "EXACT_CANONICAL_DUPLICATE");

  const shingleSet = new Set(shingleHashes);
  const beforeAny = await findCandidateCorpusRepresentations(client, shingleSet, { minSharedShingles: 1 });
  assert.ok(beforeAny.some((c) => c.representationId === representationId), "the representation must be a candidate while backed by two active sources");

  const removeA = await callDeactivate(`decision:${sourceA.decisionId}`, { ...SAME_ORIGIN, cookie: admin.token }, { reason: "removing source A only" });
  assert.equal(removeA.status, 200);

  const afterOneRemoved = await findCandidateCorpusRepresentations(client, shingleSet, { minSharedShingles: 1 });
  assert.ok(afterOneRemoved.some((c) => c.representationId === representationId), "removing one of two backing sources must never hide a representation the other source still backs");

  const removeB = await callDeactivate(`decision:${sourceB.decisionId}`, { ...SAME_ORIGIN, cookie: admin.token }, { reason: "removing the last remaining source" });
  assert.equal(removeB.status, 200);

  const afterBothRemoved = await findCandidateCorpusRepresentations(client, shingleSet, { minSharedShingles: 1 });
  assert.ok(!afterBothRemoved.some((c) => c.representationId === representationId), "once every backing source is removed, the representation must no longer be a matching candidate");
});
