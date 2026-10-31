import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createPendingReportAdmissionJob, isCorpusAdmissionEnabled, processReportAdmissionJob } from "../lib/corpus-admission-report-integration.ts";
import { isCorpusPromotionEnabled } from "../lib/corpus-admission-promotion.ts";
import { isCorpusSourceMatchingEnabled } from "../lib/corpus-source-matching-flag.ts";
import { customerCorpusRetentionAuthorized } from "../lib/customer-corpus-policy.ts";
import { applyRetainedCorpusPurge, planRetainedCorpusPurge } from "../lib/customer-corpus-purge.ts";
import { deleteAllReportDataForAccount } from "../lib/account-deletion.ts";
import { deleteReportDerivedRecords, REPORT_DERIVED_TABLES } from "../lib/report-derived-records.ts";

/**
 * CUSTOMER CORPUS RETENTION OFF (owner decision 2026-10-31): the flags Production still carries change nothing, permission
 * is never assumed, and when a customer's data goes, every copy goes, while the independent archive is untouched. Retained
 * text is created here by the real pipeline, as earlier releases created it, with the test-only authorization on. Synthetic.
 */
const repoRoot = path.resolve(".");
const dbFile = path.join(repoRoot, "test_customer_corpus_retention.db");
const clean = () => { for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* none */ } } };
clean();
const dbUrl = `file:${dbFile}`;
const client = createClient({ url: dbUrl });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(repoRoot, "drizzle"));
const openConnection = () => createClient({ url: dbUrl });
const saved = { ...process.env };
test.after(() => { client.close(); clean(); process.env = saved; });
for (const flag of ["CORPUS_ADMISSION_ENABLED", "CORPUS_PROMOTION_ENABLED", "CORPUS_SOURCE_MATCHING_ENABLED"]) process.env[flag] = "true"; // as on Production
delete process.env.VERCEL; delete process.env.VERCEL_ENV;
const authorize = (on) => { if (on) process.env.CUSTOMER_CORPUS_RETENTION_AUTHORIZED = "1"; else delete process.env.CUSTOMER_CORPUS_RETENTION_AUTHORIZED; };

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
  const id = `retention-account-${++seq}`;
  await client.execute({ sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)", args: [id, `${id}@example.test`, id, "x"] });
  return id;
}
async function report(accountId, text) {
  const reportId = `retention-report-${++seq}`, deviceKey = `retention-device-${seq}`;
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, saved_at)
          VALUES (?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [reportId, deviceKey, `sub-${seq}`, "T", 3300, 10, "low", JSON.stringify({ text }), accountId],
  });
  return { deviceKey, reportId };
}
async function admit(accountId, text) {
  const { deviceKey, reportId } = await report(accountId, text);
  const job = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });
  return { deviceKey, reportId, job, outcome: job ? await processReportAdmissionJob(client, { jobId: job.jobId, openConnection }) : null };
}
const retained = () => n("SELECT COUNT(*) AS n FROM corpus_admission_content_store");

test("a flag left on a deployment retains nothing and matches no customer against another", async () => {
  authorize(false);
  assert.equal(isCorpusAdmissionEnabled(), false);
  assert.equal(isCorpusPromotionEnabled(), false);
  assert.equal(isCorpusSourceMatchingEnabled(), false);
  const { job } = await admit(await account(), article(101));
  assert.equal(job, null, "no admission job for a customer upload");
  assert.equal(await retained(), 0);
});

test("no hosted deployment can authorize retention with a variable", () => {
  const on = { CUSTOMER_CORPUS_RETENTION_AUTHORIZED: "1" };
  assert.equal(customerCorpusRetentionAuthorized(on), true);
  assert.equal(customerCorpusRetentionAuthorized({ ...on, VERCEL: "1" }), false);
  assert.equal(customerCorpusRetentionAuthorized({ ...on, VERCEL_ENV: "preview" }), false);
  assert.equal(customerCorpusRetentionAuthorized({ ...on, VERCEL_ENV: "production" }), false);
  assert.equal(customerCorpusRetentionAuthorized({}), false);
});

test("a job left pending by an earlier release retains nothing when it runs now, and permission is never recorded as granted", async () => {
  authorize(true);
  const accountId = await account();
  const { deviceKey, reportId } = await report(accountId, article(202));
  const job = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });
  authorize(false);
  const before = await retained();
  await processReportAdmissionJob(client, { jobId: job.jobId, openConnection });
  assert.equal(await retained(), before, "nothing stored");
  assert.equal(await n("SELECT COUNT(*) AS n FROM corpus_admission_content_store WHERE retention_basis = 'CONSENT_GRANTED' AND decision_id NOT IN (SELECT id FROM corpus_admission_decisions WHERE source_ref LIKE 'report-upload:%')"), 0);
  assert.equal(await n("SELECT COUNT(*) AS n FROM corpus_admission_decisions WHERE source_ref LIKE ? AND consent_metadata LIKE '%\"consented\":true%'", `%${reportId}`), 0, "not recorded as consented");
});

test("expiry-style deletion removes the customer's text and every index of it, and leaves other customers and the archive alone", async () => {
  authorize(true);
  const leaving = await account(), staying = await account();
  const gone = await admit(leaving, article(303));
  const kept = await admit(staying, article(404));
  assert.equal(gone.outcome?.decision ?? "ACCEPT", "ACCEPT");
  const counts = async () => ({ texts: await retained(), reps: await n("SELECT COUNT(*) AS n FROM corpus_document_representations"), shingles: await n("SELECT COUNT(*) AS n FROM corpus_document_shingles") });
  const start = await counts();
  assert.ok(start.texts >= 2 && start.reps >= 2 && start.shingles > 0, JSON.stringify(start));
  const ownReps = (await client.execute({ sql: "SELECT p.representation_id AS id FROM corpus_admission_promotions p JOIN corpus_admission_decisions d ON d.id = p.decision_id WHERE d.source_ref LIKE ?", args: [`report-upload:account=${staying}:%`] })).rows.map((r) => String(r.id));
  assert.equal(ownReps.length, 1);
  // the staying customer's text is also an archive document: a purge may drop the customer's link, never the archive row
  await client.execute({ sql: "INSERT INTO archive_document_representations (archive_article_id, representation_id, title, corpus_version, fingerprint_version) VALUES ('archive-1', ?, 'Archive article', 'v', 'f')", args: [ownReps[0]] });
  authorize(false);
  const plan = await planRetainedCorpusPurge(client, { accountId: leaving });
  assert.equal(plan.retainedTexts, 1); assert.equal(plan.representationsRemoved, 1); assert.ok(plan.representationShinglesRemoved > 0);
  assert.deepEqual(await counts(), start, "a plan writes nothing");
  await deleteAllReportDataForAccount(client, leaving, { preserveActivelyPromotedRepresentations: true, purgeRetainedCorpusContent: true });
  assert.equal(await n("SELECT COUNT(*) AS n FROM saved_reports WHERE user_id = ?", leaving), 0);
  assert.equal(await n("SELECT COUNT(*) AS n FROM corpus_admission_decisions WHERE source_ref LIKE ?", `report-upload:account=${leaving}:%`), 0);
  const end = await counts();
  assert.equal(end.texts, start.texts - 1); assert.equal(end.reps, start.reps - 1); assert.ok(end.shingles < start.shingles);
  assert.equal(await n("SELECT COUNT(*) AS n FROM corpus_admission_accepted_shingles WHERE accepted_representation_id NOT IN (SELECT id FROM corpus_admission_accepted_representations)"), 0, "no orphaned fingerprints");
  assert.equal(await n("SELECT COUNT(*) AS n FROM saved_reports WHERE id = ?", kept.reportId), 1, "another customer's report is untouched");
  // purging everything: the customer's retained text goes, the archive document stays
  const all = await applyRetainedCorpusPurge(client, { allCustomerUploads: true });
  assert.equal(all.representationsKeptArchive, 1);
  assert.equal(await retained(), 0);
  assert.equal(await n("SELECT COUNT(*) AS n FROM corpus_document_representations WHERE id = ?", ownReps[0]), 1, "archive representation kept");
  assert.equal(await n("SELECT COUNT(*) AS n FROM archive_document_representations"), 1);
  assert.equal(await n("SELECT COUNT(*) AS n FROM corpus_admission_promotions"), 0);
  assert.equal(await n("SELECT COUNT(*) AS n FROM corpus_admission_decisions WHERE source_ref LIKE 'report-upload:%'"), 0);
});

test("search diagnostics and shadow evaluations go with the report, and another report's stay", async () => {
  authorize(false);
  const device = "derived-device";
  await client.execute({ sql: "INSERT INTO academic_search_run_diagnostics (report_device_key, report_id, status, total_latency_ms, stats_json, queries_json) VALUES (?,?,?,?,?,?)", args: [device, "r1", "COMPLETE", 1, "{}", '["a sentence from the manuscript"]'] });
  await client.execute({ sql: "INSERT INTO academic_search_run_diagnostics (report_device_key, report_id, status, total_latency_ms, stats_json, queries_json) VALUES (?,?,?,?,?,?)", args: [device, "r2", "COMPLETE", 1, "{}", "[]"] });
  assert.ok(REPORT_DERIVED_TABLES.includes("academic_search_run_diagnostics"));
  await deleteReportDerivedRecords(client, [{ device_key: device, id: "r1" }]);
  assert.equal(await n("SELECT COUNT(*) AS n FROM academic_search_run_diagnostics WHERE report_id = 'r1'"), 0);
  assert.equal(await n("SELECT COUNT(*) AS n FROM academic_search_run_diagnostics WHERE report_id = 'r2'"), 1);
});
