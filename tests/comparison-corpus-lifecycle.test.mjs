import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createPendingReportAdmissionJob, processReportAdmissionJob } from "../lib/corpus-admission-report-integration.ts";
import { matchAgainstUserSubmissionCorpus } from "../lib/user-submission-matching.ts";
import { cleanupExpiredSubscriptionReports } from "../lib/subscription-expiry-cleanup.ts";
import { reportAccessRefusalFor, resetEntitlementTableCacheForTest } from "../lib/account-entitlements.ts";
import { COMPARISON_SOURCE_TABLES, REPORT_ARTIFACT_TABLES } from "../lib/comparison-source-lifecycle.ts";
import { CUSTOMER_UPLOAD_CORPUS_POLICY } from "../lib/corpus-admission-types.ts";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";

/**
 * THE ACTIVE CUSTOMER COMPARISON CORPUS (owner decision 2026-10-31), end to end through the real admission gate, promotion,
 * matcher and subscription expiry, with the flags Production carries. An eligible upload becomes a comparison source; a
 * different customer matches it; its own account never does; expiry removes the report and its artifacts and leaves the
 * source matchable; a resave never adds a second source; provenance is the product policy, never consent. Synthetic text.
 */
const repoRoot = path.resolve(".");
const dbFile = path.join(repoRoot, "test_comparison_corpus_lifecycle.db");
const clean = () => { for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* none */ } } };
clean();
const dbUrl = `file:${dbFile}`;
process.env.TURSO_DATABASE_URL = dbUrl;
const client = createClient({ url: dbUrl });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(repoRoot, "drizzle"));
const openConnection = () => createClient({ url: dbUrl });
const saved = { ...process.env };
for (const flag of ["CORPUS_ADMISSION_ENABLED", "CORPUS_PROMOTION_ENABLED", "CORPUS_SOURCE_MATCHING_ENABLED"]) process.env[flag] = "true";
process.env.ACCOUNT_ACTIVATION_ENFORCED = "1";
test.after(() => { client.close(); clean(); process.env = saved; resetEntitlementTableCacheForTest(); });

const WORDS = "research analysis population sample variable hypothesis method outcome region temperature pressure reaction material structure process signal pattern network sediment species habitat climate growth measurement instrument observation protocol significant distinct gradual consistent notable substantial minor extensive localized documented identified recorded analyzed examined compared measured observed reported".split(" ");
function article(seed) {
  let state = seed >>> 0 || 1; const rng = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 0xffffffff; };
  const paragraphs = []; let words = 0;
  while (words < 3300) {
    const sentence = `The ${Array.from({ length: 10 + Math.floor(rng() * 18) }, () => WORDS[Math.floor(rng() * WORDS.length)]).join(" ")}.`;
    const paragraph = Array.from({ length: 5 + Math.floor(rng() * 4) }, () => sentence).join(" ");
    paragraphs.push(paragraph); words += paragraph.split(/\s+/).length;
  }
  return paragraphs.join("\n\n");
}
const n = async (sql, ...args) => Number((await client.execute({ sql, args })).rows[0].n);
let seq = 0;
async function account() {
  const id = `lifecycle-account-${++seq}`;
  await client.execute({ sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)", args: [id, `${id}@example.test`, id, "x"] });
  const now = Date.now();
  await client.execute({ sql: "INSERT INTO account_entitlements (user_id, status, plan_days, rooms, activated_at, expires_at, created_at, updated_at) VALUES (?, 'active', 30, 3, ?, ?, ?, ?)", args: [id, now, now + 30 * 86_400_000, now, now] });
  return id;
}
async function upload(accountId, text) {
  const reportId = `lifecycle-report-${++seq}`, deviceKey = `lifecycle-device-${seq}`;
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, room_number, saved_at)
          VALUES (?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,0,datetime('now','-1 minute'))`,
    args: [reportId, deviceKey, `sub-${seq}`, "T", 3300, 10, "low", JSON.stringify({ text }), accountId],
  });
  // the report's own artifacts, as a real check leaves them
  await client.execute({ sql: "INSERT INTO academic_search_run_diagnostics (report_device_key, report_id, status, total_latency_ms, stats_json, queries_json) VALUES (?,?,?,?,?,?)", args: [deviceKey, reportId, "COMPLETE", 1, "{}", '["a sentence of the manuscript"]'] });
  await client.execute({ sql: "INSERT INTO historical_match_shadow_evaluations (report_device_key, report_id, policy_version, proposed_evidence, created_at) SELECT ?, ?, 'v', '[]', CURRENT_TIMESTAMP WHERE 0", args: [deviceKey, reportId] }).catch(() => {});
  const job = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });
  return { reportId, deviceKey, job };
}
const run = (job) => processReportAdmissionJob(client, { jobId: job.jobId, openConnection });
const match = async (viewer, text) => { await matureCorpusBackings(client); return matchAgainstUserSubmissionCorpus(client, { accountId: viewer, excludeAccountId: viewer, canonicalText: text }); };

const A_TEXT = article(1101);
let A, B, first;

test("a new eligible upload enters the active comparison corpus, recorded under the product policy, not as consent", async () => {
  A = await account(); B = await account();
  first = await upload(A, A_TEXT);
  assert.ok(first.job, "an admission job exists for a customer upload");
  const outcome = await run(first.job);
  assert.equal(outcome.outcome, "succeeded", JSON.stringify(outcome));
  const row = (await client.execute({ sql: "SELECT cs.retention_basis AS basis, d.consent_metadata AS consent FROM corpus_admission_content_store cs JOIN corpus_admission_decisions d ON d.id = cs.decision_id WHERE d.source_ref LIKE ?", args: [`report-upload:account=${A}:%`] })).rows[0];
  assert.equal(row.basis, "SERVICE_POLICY");
  assert.deepEqual(JSON.parse(String(row.consent)), { kind: "SERVICE_POLICY", policy: CUSTOMER_UPLOAD_CORPUS_POLICY });
  assert.equal(await n("SELECT COUNT(*) AS n FROM corpus_admission_content_store WHERE retention_basis = 'CONSENT_GRANTED'"), 0);
  assert.equal(await n("SELECT COUNT(*) AS n FROM corpus_admission_promotions WHERE status = 'indexed'"), 1, "promoted into the matchable corpus");
});

test("a different customer matches the earlier upload, with the right source reference; the uploader never matches itself", async () => {
  const sourceRep = String((await client.execute({ sql: "SELECT p.representation_id AS id FROM corpus_admission_promotions p JOIN corpus_admission_decisions d ON d.id = p.decision_id WHERE d.source_ref LIKE ?", args: [`report-upload:account=${A}:%`] })).rows[0].id);
  const other = await match(B, A_TEXT);
  assert.equal(other.status, "MATCHED");
  assert.equal(other.matches.length, 1);
  assert.equal(other.matches[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");
  assert.equal(other.matches[0].matchedRepresentationId, sourceRep, "the match points at the promoted source of A's upload");
  assert.ok(other.matches[0].matchedWordCount > 3000, String(other.matches[0].matchedWordCount));
  assert.ok(!JSON.stringify(other).includes(A), "no account identity of the source reaches the other customer");
  const own = await match(A, A_TEXT);
  assert.equal(own.status, "NO_HISTORICAL_MATCH", "a document cannot match itself through its own account's source");
});

test("a resave or retry of the same report never adds a second comparison source", async () => {
  const before = await n("SELECT COUNT(*) AS n FROM corpus_admission_content_store");
  const again = await createPendingReportAdmissionJob(client, { accountId: A, deviceKey: first.deviceKey, reportId: first.reportId });
  assert.equal(again?.jobId, first.job.jobId, "one job per report");
  await run(first.job);
  assert.equal(await n("SELECT COUNT(*) AS n FROM corpus_admission_content_store"), before);
  assert.equal(await n("SELECT COUNT(*) AS n FROM corpus_admission_decisions WHERE source_ref LIKE ?", `report-upload:account=${A}:%`), 1);
  // the same text uploaded again as a NEW report by the same account is a duplicate, not a second source
  const second = await upload(A, A_TEXT);
  await run(second.job);
  assert.equal(await n("SELECT COUNT(*) AS n FROM corpus_admission_content_store"), before);
  assert.equal(await n("SELECT COUNT(*) AS n FROM corpus_document_representations"), 1);
});

test("expiry refuses the report at once, deletes the report and its artifacts, and the comparison source stays matchable", async () => {
  // a decision is a comparison source only once accepted with retained text; a rejected one (here: the duplicate) is a report artifact
  const counts = async (tables) => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await n(t === "corpus_admission_decisions" ? `SELECT COUNT(*) AS n FROM ${t} WHERE content_store_id IS NOT NULL` : `SELECT COUNT(*) AS n FROM ${t}`)])));
  const sourceBefore = await counts(COMPARISON_SOURCE_TABLES);
  await client.execute({ sql: "UPDATE account_entitlements SET expires_at = ? WHERE user_id = ?", args: [Date.now() - 1000, A] });
  resetEntitlementTableCacheForTest();
  const refusal = await reportAccessRefusalFor(client, { id: A, email: `${A}@example.test`, username: A, role: "user" });
  assert.equal(refusal?.code, "PLAN_EXPIRED", "no access from the moment of expiry");
  const result = await cleanupExpiredSubscriptionReports(client, { id: A, email: `${A}@example.test` }, Date.now(), "on");
  assert.equal(result.ran, true);
  for (const t of REPORT_ARTIFACT_TABLES) {
    const col = t === "saved_reports" ? "user_id" : t === "document_identities" ? "account_id" : null;
    if (col) assert.equal(await n(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`, A), 0, t);
  }
  assert.equal(await n("SELECT COUNT(*) AS n FROM academic_search_run_diagnostics WHERE report_id IN (?, ?)", first.reportId, "x"), 0, "search diagnostics went with the report");
  assert.equal(await n("SELECT COUNT(*) AS n FROM corpus_admission_report_jobs WHERE account_id = ?", A), 0);
  const sourceAfter = await counts(COMPARISON_SOURCE_TABLES);
  assert.deepEqual(sourceAfter, sourceBefore, "the comparison source has its own lifecycle and is untouched");
  const stillMatched = await match(B, A_TEXT);
  assert.equal(stillMatched.status, "MATCHED", "retained source text is still searchable after the report expired");
});
