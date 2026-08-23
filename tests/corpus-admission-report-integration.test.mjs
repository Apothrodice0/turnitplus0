import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import {
  createPendingReportAdmissionJob,
  processReportAdmissionJob,
  runReportAdmissionRetrySweep,
  deleteReportCorpusAdmissionData,
  revokeConsentAndCancelPendingAdmissionJobs,
  buildReportAdmissionSourceRef,
  isCorpusAdmissionEnabled,
} from "../lib/corpus-admission-report-integration.ts";
import { _getActiveExtractionWorkerCountForTesting } from "../lib/corpus-text-extraction.ts";

/**
 * Controlled live-report integration: covers the flag default, durable
 * synchronous job creation (survives a "crash before after() ever starts"),
 * atomic concurrent-sweep claiming (including abandoned-claim recovery),
 * the consent-revocation race, report/owner-scoped deletion (not
 * document_identity_id-scoped), double-save idempotency, failure
 * visibility, retry idempotency, and the retention policy that accepted
 * corpus content survives both consent changes and report/account
 * deletion — only not-yet-accepted work is ever cancelled or removed.
 * Every fixture here is synthetic.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_report_integration.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const dbUrl = `file:${dbFile}`;
const client = createClient({ url: dbUrl });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

function openConnection() {
  return createClient({ url: dbUrl });
}

const originalFlag = process.env.CORPUS_ADMISSION_ENABLED;
test.after(() => {
  if (originalFlag === undefined) delete process.env.CORPUS_ADMISSION_ENABLED;
  else process.env.CORPUS_ADMISSION_ENABLED = originalFlag;
});

let userCounter = 0;
async function ensureUser(consented) {
  userCounter += 1;
  const accountId = `report-integration-account-${userCounter}`;
  await client.execute({
    sql: "INSERT INTO users (id, email, username, password_hash, corpus_reuse_consented_at) VALUES (?,?,?,?,?)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash", consented ? new Date().toISOString() : null],
  });
  return accountId;
}

async function setConsent(accountId, consented) {
  await client.execute({
    sql: "UPDATE users SET corpus_reuse_consented_at = ? WHERE id = ?",
    args: [consented ? new Date().toISOString() : null, accountId],
  });
}

let reportCounter = 0;
async function seedSavedReport(accountId, rawText) {
  reportCounter += 1;
  const deviceKey = `device-${reportCounter}`;
  const reportId = `report-${reportCounter}`;
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, updated_at)
          VALUES (?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [reportId, deviceKey, `sub-${reportCounter}`, "T", 3300, 10, "low", JSON.stringify({ text: rawText }), accountId],
  });
  return { deviceKey, reportId };
}

async function jobRowFor(sourceRef) {
  const result = await client.execute({ sql: "SELECT * FROM corpus_admission_report_jobs WHERE source_ref = ?", args: [sourceRef] });
  return result.rows[0] ?? null;
}
async function jobRowById(jobId) {
  const result = await client.execute({ sql: "SELECT * FROM corpus_admission_report_jobs WHERE id = ?", args: [jobId] });
  return result.rows[0] ?? null;
}
async function decisionCountFor(sourceRef) {
  const result = await client.execute({ sql: "SELECT COUNT(*) AS c FROM corpus_admission_decisions WHERE source_ref = ?", args: [sourceRef] });
  return Number(result.rows[0].c);
}
async function decisionRowFor(sourceRef) {
  const result = await client.execute({ sql: "SELECT * FROM corpus_admission_decisions WHERE source_ref = ?", args: [sourceRef] });
  return result.rows[0] ?? null;
}
async function contentStoreCountFor(sourceRef) {
  const result = await client.execute({
    sql: `SELECT COUNT(*) AS c FROM corpus_admission_content_store cs
          JOIN corpus_admission_decisions d ON d.id = cs.decision_id
          WHERE d.source_ref = ?`,
    args: [sourceRef],
  });
  return Number(result.rows[0].c);
}
async function acceptedRepresentationFor(sourceRef) {
  const result = await client.execute({
    sql: `SELECT r.* FROM corpus_admission_accepted_representations r
          JOIN corpus_admission_decisions d ON d.id = r.decision_id
          WHERE d.source_ref = ?`,
    args: [sourceRef],
  });
  return result.rows[0] ?? null;
}
async function consentedAtFor(accountId) {
  const result = await client.execute({ sql: "SELECT corpus_reuse_consented_at FROM users WHERE id = ?", args: [accountId] });
  return result.rows[0]?.corpus_reuse_consented_at ?? null;
}

const WORD_BANK = [
  "research", "analysis", "population", "sample", "variable", "hypothesis", "method", "outcome", "region",
  "temperature", "pressure", "reaction", "material", "structure", "process", "signal", "pattern", "network",
  "sediment", "species", "habitat", "climate", "growth", "measurement", "instrument", "observation", "protocol",
  "significant", "distinct", "gradual", "consistent", "notable", "substantial", "minor", "extensive", "localized",
  "documented", "identified", "recorded", "analyzed", "examined", "compared", "measured", "observed", "reported",
];
function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 0xffffffff; };
}
function plausibleArticleText(seed, targetWords = 3300) {
  const rng = seededRandom(seed);
  const paragraphs = [];
  let wordCount = 0;
  while (wordCount < targetWords) {
    const sentence = `The ${Array.from({ length: 10 + Math.floor(rng() * 18) }, () => WORD_BANK[Math.floor(rng() * WORD_BANK.length)]).join(" ")}.`;
    const paragraph = Array.from({ length: 5 + Math.floor(rng() * 4) }, () => sentence).join(" ");
    paragraphs.push(paragraph);
    wordCount += paragraph.split(/\s+/).length;
  }
  return paragraphs.join("\n\n");
}

// --- flag: off by default -----------------------------------------------

test("CORPUS_ADMISSION_ENABLED is off by default, and createPendingReportAdmissionJob is a total no-op while it is off", async () => {
  delete process.env.CORPUS_ADMISSION_ENABLED;
  assert.equal(isCorpusAdmissionEnabled(), false);

  const accountId = await ensureUser(true);
  const { deviceKey, reportId } = await seedSavedReport(accountId, plausibleArticleText(1));
  const sourceRef = buildReportAdmissionSourceRef({ accountId, deviceKey, reportId });

  const created = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });
  assert.equal(created, null);
  assert.equal(await jobRowFor(sourceRef), null);
});

// --- CRASH-BEFORE-AFTER(): job creation must be durable on its own ------

test("CRASH-BEFORE-AFTER(): a pending job created synchronously survives even if processing never runs, and a later sweep still finds and completes it", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  const accountId = await ensureUser(true);
  const text = plausibleArticleText(100);
  const { deviceKey, reportId } = await seedSavedReport(accountId, text);
  const sourceRef = buildReportAdmissionSourceRef({ accountId, deviceKey, reportId });

  // Simulates exactly the scenario the fix targets: the synchronous phase
  // (this call, mirroring app/api/reports/route.ts's own pre-response
  // step) completes and the response could be sent, but the process is
  // then killed/recycled — runAfterResponse's deferred callback (which
  // would call processReportAdmissionJob) never starts. processReportAdmissionJob
  // is deliberately never called here.
  const created = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });
  assert.ok(created?.jobId, "job creation itself must succeed synchronously");

  const jobRightAfterCrash = await jobRowFor(sourceRef);
  assert.ok(jobRightAfterCrash, "the pending job row must exist durably, independent of whether processing ever ran");
  assert.equal(jobRightAfterCrash.status, "pending");
  assert.equal(jobRightAfterCrash.decision_id, null);
  assert.equal(await decisionCountFor(sourceRef), 0, "no decision may exist yet — nothing has actually been processed");

  // A later, independent sweep (simulating a scheduled recovery run) must
  // still find and successfully complete this exact job.
  const sweep = await runReportAdmissionRetrySweep(client, { openConnection });
  assert.ok(sweep.claimedJobIds.includes(created.jobId), "the sweep must claim the crash-surviving job");
  const outcome = sweep.results[sweep.claimedJobIds.indexOf(created.jobId)];
  assert.equal(outcome.outcome, "succeeded");
  assert.equal(outcome.decision, "ACCEPT");

  const jobAfterSweep = await jobRowFor(sourceRef);
  assert.equal(jobAfterSweep.status, "succeeded");
  assert.equal(await decisionCountFor(sourceRef), 1);
});

// --- consent-gated, re-checked fresh (never a snapshot) ------------------

test("CONSENT-REVOCATION RACE: consent granted at job-creation time, then revoked before processing runs — the fresh re-check sees the revocation and cancels the job", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  const accountId = await ensureUser(true);
  const { deviceKey, reportId } = await seedSavedReport(accountId, plausibleArticleText(2));
  const sourceRef = buildReportAdmissionSourceRef({ accountId, deviceKey, reportId });

  const created = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });
  await setConsent(accountId, false); // simulates PATCH /api/auth/me revoking consent before processing runs

  const outcome = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection });
  assert.deepEqual(outcome, { outcome: "consent_not_granted", jobId: created.jobId });

  const job = await jobRowFor(sourceRef);
  assert.equal(job.status, "cancelled");
  assert.equal(await decisionCountFor(sourceRef), 0);
});

// --- successful admission ----------------------------------------------

test("a consented, ACCEPT-quality submission succeeds: job status=succeeded, one decision row, one content-store row", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  const accountId = await ensureUser(true);
  const text = plausibleArticleText(4);
  const { deviceKey, reportId } = await seedSavedReport(accountId, text);
  const sourceRef = buildReportAdmissionSourceRef({ accountId, deviceKey, reportId });

  const created = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });
  const outcome = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection });
  assert.equal(outcome.outcome, "succeeded");
  assert.equal(outcome.decision, "ACCEPT");

  const job = await jobRowFor(sourceRef);
  assert.equal(job.status, "succeeded");
  assert.equal(job.decision_id, outcome.decisionId);
  assert.equal(job.claimed_at, null, "claimed_at must be released once processing concludes");
  assert.equal(Number(job.attempt_count), 1);
  assert.equal(await decisionCountFor(sourceRef), 1);
  assert.equal(await contentStoreCountFor(sourceRef), 1);
});

// --- WORKER-01: live report integration must never hit EXTRACTION_WORKER_TERMINATED ---
// This is the exact call site the production bug came from: this function
// wraps a saved report's already-extracted text as filename:
// "live-submission.txt" and feeds it through evaluateCorpusAdmissionCandidate
// (see this file's own "the underlying report ... has no retained text"
// branch just above). Before the fix, that always routed through the
// isolated worker — which cannot load in a deployed Vercel serverless
// function — so this job failed identically to the real production
// decision (44e51035-261b-41f1-85e3-a93060222cdb) every time. The .txt
// bypass added to lib/corpus-text-extraction.ts's extractCorpusCandidateText
// closes it. This test still runs under `node --import tsx`, same as every
// other test in this file — it proves the JOB PIPELINE'S OWN behavior
// (word count/language/hash/quality end to end, zero worker slots), not the
// "does this survive a tsx-less runtime" property, which
// tests/corpus-text-extraction.test.mjs and the separate plain-node/
// production-build verification cover directly.
test("WORKER-01: live report integration produces a real decision (word count, language, hash, quality) instead of EXTRACTION_WORKER_TERMINATED, and never spawns a worker", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  assert.equal(_getActiveExtractionWorkerCountForTesting(), 0, "sanity: no worker active before this test runs");

  const accountId = await ensureUser(true);
  // seed 3: every other single-digit seed in this file (1, 2, 4, 5, 6, 7) is
  // already used by another test sharing this same database — a collision
  // would make this text resolve as an EXACT_DUPLICATE family match against
  // an unrelated test's own content, corrupting both.
  const text = plausibleArticleText(3);
  const { deviceKey, reportId } = await seedSavedReport(accountId, text);
  const sourceRef = buildReportAdmissionSourceRef({ accountId, deviceKey, reportId });

  const created = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });
  const outcome = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection });

  assert.equal(outcome.outcome, "succeeded", outcome.outcome === "failed" ? `job failed: ${outcome.error}` : undefined);
  assert.equal(outcome.decision, "ACCEPT");

  const decisionRow = await decisionRowFor(sourceRef);
  assert.ok(decisionRow, "a decision row must exist");
  assert.equal(decisionRow.detected_format, "txt", "the synthetic live-submission.txt wrapper must be classified as txt");
  assert.ok(Number(decisionRow.extracted_word_count) > 0, `expected a real word count, got ${decisionRow.extracted_word_count}`);
  assert.equal(typeof decisionRow.detected_language, "string");
  assert.ok(decisionRow.detected_language.length > 0);
  assert.equal(typeof decisionRow.canonical_sha256, "string");
  assert.equal(decisionRow.canonical_sha256.length, 64);
  assert.equal(typeof decisionRow.quality_score, "number");
  assert.doesNotMatch(String(decisionRow.hard_gate_failure_codes ?? ""), /EXTRACTION_WORKER_TERMINATED/, "the exact production bug this fix closes must never reappear here");

  assert.equal(_getActiveExtractionWorkerCountForTesting(), 0, "the live-report-integration path must never acquire a worker slot for its synthetic txt candidate");
});

// --- double-save idempotency ---------------------------------------------

test("DOUBLE-SAVE: creating the pending job twice for the same report never disturbs an already-succeeded job, and processing it again is a no-op", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  const accountId = await ensureUser(true);
  const text = plausibleArticleText(5);
  const { deviceKey, reportId } = await seedSavedReport(accountId, text);
  const sourceRef = buildReportAdmissionSourceRef({ accountId, deviceKey, reportId });

  const created = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });
  const succeeded = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection });
  assert.equal(succeeded.outcome, "succeeded");

  // Simulates the enrichment resave calling job-creation a second time —
  // must be a pure no-op against the already-succeeded row.
  const createdAgain = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });
  assert.equal(createdAgain.jobId, created.jobId, "the same job row must be reused, never duplicated");
  const jobAfterSecondCreate = await jobRowFor(sourceRef);
  assert.equal(jobAfterSecondCreate.status, "succeeded", "a second creation call must never reset an already-succeeded job back to pending");
  assert.equal(jobAfterSecondCreate.decision_id, succeeded.decisionId);

  const processedAgain = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection });
  assert.deepEqual(processedAgain, { outcome: "already_succeeded", jobId: created.jobId, decisionId: succeeded.decisionId });
  assert.equal(await decisionCountFor(sourceRef), 1, "no second decision row may ever be created for one report");

  const jobResult = await client.execute({ sql: "SELECT COUNT(*) AS c FROM corpus_admission_report_jobs WHERE source_ref = ?", args: [sourceRef] });
  assert.equal(Number(jobResult.rows[0].c), 1, "exactly one job row must ever exist for one report");
});

// --- failure visibility (durable, not only console.error) ---------------

test("FAILURE-STATUS: a genuine admission failure is persisted to corpus_admission_report_jobs (status=failed, last_error set), not only logged", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  const accountId = await ensureUser(true);
  const text = plausibleArticleText(6);
  const { deviceKey, reportId } = await seedSavedReport(accountId, text);
  const sourceRef = buildReportAdmissionSourceRef({ accountId, deviceKey, reportId });
  const created = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });

  // Fails on exactly the 2nd call (the gate's own first internal write
  // attempt, right after the 1st call serves the fresh consent check) and
  // succeeds on every other call, including the "mark this job failed"
  // write that follows — simulating one genuine write-path failure during
  // evaluation, not a permanently broken connection factory (which would
  // make even persisting the failure itself impossible).
  let calls = 0;
  function flakyOpenConnection() {
    calls += 1;
    if (calls === 2) throw new Error("simulated connection failure for the admission write path");
    return createClient({ url: dbUrl });
  }

  const outcome = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection: flakyOpenConnection });
  assert.equal(outcome.outcome, "failed");
  assert.match(outcome.error, /simulated connection failure/);

  const job = await jobRowFor(sourceRef);
  assert.equal(job.status, "failed");
  assert.match(job.last_error, /simulated connection failure/);
  assert.equal(job.claimed_at, null);
  assert.equal(Number(job.attempt_count), 1);
  assert.equal(await decisionCountFor(sourceRef), 0);
});

// --- retry idempotency ---------------------------------------------------

test("RETRY-IDEMPOTENCY: reprocessing a failed job succeeds once content can be evaluated, and reprocessing an already-succeeded job is a safe no-op", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  const accountId = await ensureUser(true);
  const text = plausibleArticleText(7);
  const { deviceKey, reportId } = await seedSavedReport(accountId, text);
  const sourceRef = buildReportAdmissionSourceRef({ accountId, deviceKey, reportId });
  const created = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });

  let calls = 0;
  function flakyOnceOpenConnection() {
    calls += 1;
    if (calls === 2) throw new Error("simulated failure — the gate's own first write attempt only");
    return createClient({ url: dbUrl });
  }
  const failed = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection: flakyOnceOpenConnection });
  assert.equal(failed.outcome, "failed");
  assert.equal((await jobRowFor(sourceRef)).status, "failed");

  const retried = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection });
  assert.equal(retried.outcome, "succeeded");
  assert.equal(retried.decision, "ACCEPT");
  const succeededJob = await jobRowFor(sourceRef);
  assert.equal(succeededJob.status, "succeeded");
  assert.equal(Number(succeededJob.attempt_count), 2);
  assert.equal(await decisionCountFor(sourceRef), 1);

  const attemptCountAfterSuccess = Number(succeededJob.attempt_count);
  const retriedAgain = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection });
  assert.deepEqual(retriedAgain, { outcome: "already_succeeded", jobId: created.jobId, decisionId: retried.decisionId });
  assert.equal(await decisionCountFor(sourceRef), 1, "reprocessing an already-succeeded job must never create a second decision row");
  const jobAfterNoop = await jobRowFor(sourceRef);
  assert.equal(Number(jobAfterNoop.attempt_count), attemptCountAfterSuccess, "a no-op reprocess must never bump attempt_count");
});

// --- CONCURRENT-SWEEP: atomic claiming ------------------------------------

test("CONCURRENT-SWEEP: multiple sweeps racing against the same batch of pending jobs never double-claim or double-process a job", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  const accountId = await ensureUser(true);
  const N = 8;
  const sourceRefs = [];
  for (let i = 0; i < N; i += 1) {
    const text = plausibleArticleText(9100 + i);
    const { deviceKey, reportId } = await seedSavedReport(accountId, text);
    sourceRefs.push(buildReportAdmissionSourceRef({ accountId, deviceKey, reportId }));
    await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });
  }

  // Four independent sweep callers, each with its own connection, racing
  // concurrently against the same batch — genuine same-process concurrency
  // exercising the sweep's own atomic-claim transaction (the identical
  // BEGIN IMMEDIATE mechanism this session's cross-process suite already
  // verified holds across real OS processes too).
  const sweepClients = Array.from({ length: 4 }, () => createClient({ url: dbUrl }));
  try {
    // batchSize generous enough to cover this test's own N jobs plus any
    // still-eligible ('failed') leftovers from earlier tests in this same
    // file/database — the point of this test is proving no double-claim
    // ever happens, not asserting exclusive ownership of the whole table.
    const sweeps = await Promise.all(
      sweepClients.map((sweepClient) => runReportAdmissionRetrySweep(sweepClient, { batchSize: 100, openConnection })),
    );

    const allClaimedIds = sweeps.flatMap((s) => s.claimedJobIds);
    assert.equal(allClaimedIds.length, new Set(allClaimedIds).size, "no job id may ever be claimed by more than one concurrent sweep");

    // Every one of THIS test's own N jobs must have been claimed and
    // successfully processed by exactly one of the four racing sweeps.
    for (const sourceRef of sourceRefs) {
      const job = await jobRowFor(sourceRef);
      assert.equal(job.status, "succeeded", `report ${sourceRef} must have been processed to 'succeeded' by exactly one sweep`);
      assert.equal(job.claimed_at, null, "claimed_at must be released after processing, not left stuck");
      assert.equal(await decisionCountFor(sourceRef), 1, `report ${sourceRef} must have exactly one decision row, never zero or two`);
    }
  } finally {
    for (const c of sweepClients) c.close();
  }
});

// --- ABANDONED-CLAIM RECOVERY: a stale claim is reclaimed; a fresh one is not ---

test("ABANDONED-CLAIM RECOVERY: a job whose claim is older than staleClaimMs is reclaimed and completed by a later sweep, while a freshly-claimed job is left alone", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  const accountId = await ensureUser(true);

  // Simulates a worker that claimed this job (e.g. the deferred callback,
  // or an earlier sweep) and then crashed before ever calling
  // processReportAdmissionJob to completion — claimed_at is set, but
  // status is still 'pending', and it is old enough to count as abandoned.
  const textAbandoned = plausibleArticleText(9500);
  const { deviceKey: dkAbandoned, reportId: ridAbandoned } = await seedSavedReport(accountId, textAbandoned);
  const sourceRefAbandoned = buildReportAdmissionSourceRef({ accountId, deviceKey: dkAbandoned, reportId: ridAbandoned });
  const jobAbandoned = await createPendingReportAdmissionJob(client, { accountId, deviceKey: dkAbandoned, reportId: ridAbandoned });
  await client.execute({
    sql: "UPDATE corpus_admission_report_jobs SET claimed_at = datetime('now', '-10 minutes') WHERE id = ?",
    args: [jobAbandoned.jobId],
  });

  // A genuinely fresh claim — simulates a worker that is (as far as this
  // sweep can tell) actively working on it right now.
  const textFresh = plausibleArticleText(9501);
  const { deviceKey: dkFresh, reportId: ridFresh } = await seedSavedReport(accountId, textFresh);
  const sourceRefFresh = buildReportAdmissionSourceRef({ accountId, deviceKey: dkFresh, reportId: ridFresh });
  const jobFresh = await createPendingReportAdmissionJob(client, { accountId, deviceKey: dkFresh, reportId: ridFresh });
  await client.execute({
    sql: "UPDATE corpus_admission_report_jobs SET claimed_at = CURRENT_TIMESTAMP WHERE id = ?",
    args: [jobFresh.jobId],
  });

  // staleClaimMs of 1 second: the 10-minutes-old claim is unambiguously
  // stale; the just-set claim is unambiguously not.
  const sweep = await runReportAdmissionRetrySweep(client, { openConnection, staleClaimMs: 1000 });

  assert.ok(sweep.claimedJobIds.includes(jobAbandoned.jobId), "the abandoned (stale-claimed) job must be reclaimed");
  assert.ok(!sweep.claimedJobIds.includes(jobFresh.jobId), "the freshly-claimed job must NOT be reclaimed out from under its (apparent) active worker");

  const abandonedJobAfter = await jobRowFor(sourceRefAbandoned);
  assert.equal(abandonedJobAfter.status, "succeeded", "the reclaimed job must have actually been processed to completion, not just re-claimed");
  assert.equal(abandonedJobAfter.claimed_at, null, "claimed_at must be released once processing concludes");
  assert.equal(await decisionCountFor(sourceRefAbandoned), 1);

  const freshJobAfter = await jobRowFor(sourceRefFresh);
  assert.equal(freshJobAfter.status, "pending", "the freshly-claimed job must remain untouched — still pending, not processed by this sweep");
  assert.notEqual(freshJobAfter.claimed_at, null, "the freshly-claimed job's claim must be left exactly as it was");
  assert.equal(await decisionCountFor(sourceRefFresh), 0);
});

// --- consent-revocation: only cancels not-yet-accepted work -------------

test("CONSENT-REVOCATION: cancels only not-yet-accepted (pending/failed) jobs; a 'succeeded' job — including its retained content and fingerprint — is never touched, scoped to that account only", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  const accountId = await ensureUser(true);
  const otherAccountId = await ensureUser(true);

  // Two independently-accepted reports for the revoking account.
  const textA = plausibleArticleText(9201);
  const { deviceKey: dkA, reportId: ridA } = await seedSavedReport(accountId, textA);
  const sourceRefA = buildReportAdmissionSourceRef({ accountId, deviceKey: dkA, reportId: ridA });
  const jobA = await createPendingReportAdmissionJob(client, { accountId, deviceKey: dkA, reportId: ridA });
  const outcomeA = await processReportAdmissionJob(client, { jobId: jobA.jobId, openConnection });
  assert.equal(outcomeA.outcome, "succeeded");
  assert.equal(outcomeA.decision, "ACCEPT");

  const textB = plausibleArticleText(9202);
  const { deviceKey: dkB, reportId: ridB } = await seedSavedReport(accountId, textB);
  const sourceRefB = buildReportAdmissionSourceRef({ accountId, deviceKey: dkB, reportId: ridB });
  const jobB = await createPendingReportAdmissionJob(client, { accountId, deviceKey: dkB, reportId: ridB });
  const outcomeB = await processReportAdmissionJob(client, { jobId: jobB.jobId, openConnection });
  assert.equal(outcomeB.outcome, "succeeded");
  assert.equal(outcomeB.decision, "ACCEPT");

  // A still-pending job (never processed) for the same account.
  const textC = plausibleArticleText(9203);
  const { deviceKey: dkC, reportId: ridC } = await seedSavedReport(accountId, textC);
  const sourceRefC = buildReportAdmissionSourceRef({ accountId, deviceKey: dkC, reportId: ridC });
  await createPendingReportAdmissionJob(client, { accountId, deviceKey: dkC, reportId: ridC });

  // A DIFFERENT account's own accepted report — must be completely
  // unaffected by revoking the first account's consent.
  const textOther = plausibleArticleText(9204);
  const { deviceKey: dkOther, reportId: ridOther } = await seedSavedReport(otherAccountId, textOther);
  const sourceRefOther = buildReportAdmissionSourceRef({ accountId: otherAccountId, deviceKey: dkOther, reportId: ridOther });
  const jobOther = await createPendingReportAdmissionJob(client, { accountId: otherAccountId, deviceKey: dkOther, reportId: ridOther });
  const outcomeOther = await processReportAdmissionJob(client, { jobId: jobOther.jobId, openConnection });
  assert.equal(outcomeOther.outcome, "succeeded");
  assert.equal(outcomeOther.decision, "ACCEPT");

  assert.notEqual(await consentedAtFor(accountId), null, "sanity: consent must still be granted before revocation runs");

  const result = await revokeConsentAndCancelPendingAdmissionJobs(accountId, openConnection);
  assert.deepEqual(result, { cancelledJobCount: 1 }, "only the single still-pending job may be cancelled — nothing accepted is ever counted here");

  assert.equal(await consentedAtFor(accountId), null, "the consent flag itself must be cleared atomically alongside the cancellation");

  // A and B: completely untouched — accepted corpus content is durable and
  // outlives a later consent change. Status, decision, content, and
  // fingerprint all remain exactly as they were.
  assert.equal(await contentStoreCountFor(sourceRefA), 1, "accepted content must survive consent revocation");
  assert.equal(await decisionCountFor(sourceRefA), 1);
  const jobAAfter = await jobRowFor(sourceRefA);
  assert.equal(jobAAfter.status, "succeeded", "a succeeded job must never be touched by consent revocation");
  assert.equal(jobAAfter.decision_id, outcomeA.decisionId);
  const repA = await acceptedRepresentationFor(sourceRefA);
  assert.ok(repA);
  assert.equal(repA.revoked_at, null, "revoked_at must stay unset — it is reserved for a future admin removal flow, not consent revocation");

  assert.equal(await contentStoreCountFor(sourceRefB), 1);
  assert.equal(await decisionCountFor(sourceRefB), 1);
  assert.equal((await jobRowFor(sourceRefB)).status, "succeeded");
  assert.equal((await acceptedRepresentationFor(sourceRefB)).revoked_at, null);

  // C: was pending, never had content, now cancelled.
  const jobCAfter = await jobRowFor(sourceRefC);
  assert.equal(jobCAfter.status, "cancelled");
  assert.equal(await contentStoreCountFor(sourceRefC), 0);
  assert.equal(await decisionCountFor(sourceRefC), 0);

  // The OTHER account's accepted content, fingerprint, and consent flag
  // must be completely untouched.
  assert.equal(await contentStoreCountFor(sourceRefOther), 1);
  assert.equal((await jobRowFor(sourceRefOther)).status, "succeeded");
  assert.equal((await acceptedRepresentationFor(sourceRefOther)).revoked_at, null);
  assert.notEqual(await consentedAtFor(otherAccountId), null, "a different account's consent flag must never be touched");

  // Idempotent: calling it again finds nothing left to cancel.
  const secondCall = await revokeConsentAndCancelPendingAdmissionJobs(accountId, openConnection);
  assert.deepEqual(secondCall, { cancelledJobCount: 0 });
});

// --- REPLACEMENT-ADMISSION: a revoked fingerprint stops blocking, a later authorized copy becomes canonical ---
// revoked_at is reserved for a future, explicitly admin-triggered removal
// flow that does not exist yet — consent revocation never sets it (see the
// test above). This test simulates that future flow directly via SQL (the
// only way to produce a revoked fingerprint today) purely to prove
// lib/corpus-admission-gate.ts's own exclusion behavior still works
// whenever that flow does ship.

async function activeAcceptedRepresentationsForHash(canonicalSha256) {
  const result = await client.execute({
    sql: "SELECT * FROM corpus_admission_accepted_representations WHERE canonical_sha256 = ? AND revoked_at IS NULL",
    args: [canonicalSha256],
  });
  return result.rows;
}
async function allAcceptedRepresentationsForHash(canonicalSha256) {
  const result = await client.execute({ sql: "SELECT * FROM corpus_admission_accepted_representations WHERE canonical_sha256 = ?", args: [canonicalSha256] });
  return result.rows;
}

test("REPLACEMENT-ADMISSION: once a fingerprint is marked revoked (simulating a future admin removal flow — never consent revocation), it is excluded from active family matching, and a later authorized copy becomes canonical", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  const originalAccountId = await ensureUser(true);
  const replacementAccountId = await ensureUser(true);
  const text = plausibleArticleText(9301);

  // First admission, by the original account.
  const { deviceKey: dk1, reportId: rid1 } = await seedSavedReport(originalAccountId, text);
  const sourceRef1 = buildReportAdmissionSourceRef({ accountId: originalAccountId, deviceKey: dk1, reportId: rid1 });
  const job1 = await createPendingReportAdmissionJob(client, { accountId: originalAccountId, deviceKey: dk1, reportId: rid1 });
  const outcome1 = await processReportAdmissionJob(client, { jobId: job1.jobId, openConnection });
  assert.equal(outcome1.outcome, "succeeded");
  assert.equal(outcome1.decision, "ACCEPT");
  const canonicalHash = (await acceptedRepresentationFor(sourceRef1)).canonical_sha256;

  // While still active, a second submission of the SAME content is
  // correctly rejected as an already-represented duplicate — sanity check
  // that this test's setup actually exercises real family matching.
  const { deviceKey: dkDupBefore, reportId: ridDupBefore } = await seedSavedReport(replacementAccountId, text);
  const jobDupBefore = await createPendingReportAdmissionJob(client, { accountId: replacementAccountId, deviceKey: dkDupBefore, reportId: ridDupBefore });
  const outcomeDupBefore = await processReportAdmissionJob(client, { jobId: jobDupBefore.jobId, openConnection });
  assert.equal(outcomeDupBefore.outcome, "succeeded");
  assert.equal(outcomeDupBefore.decision, "REJECT", "sanity: while the original fingerprint is still active, a duplicate must be rejected");

  // Revoking the original account's CONSENT must NOT affect the
  // fingerprint at all (proven above) — so a duplicate submitted right
  // after is still correctly rejected.
  await revokeConsentAndCancelPendingAdmissionJobs(originalAccountId, openConnection);
  assert.equal((await activeAcceptedRepresentationsForHash(canonicalHash)).length, 1, "consent revocation must never affect the fingerprint's active status");

  // Directly simulate the future admin-removal flow — the only way a
  // fingerprint becomes revoked today, since no such admin action is built
  // yet and consent revocation deliberately never does this.
  await client.execute({
    sql: "UPDATE corpus_admission_accepted_representations SET revoked_at = CURRENT_TIMESTAMP WHERE decision_id = ?",
    args: [(await acceptedRepresentationFor(sourceRef1)).decision_id],
  });
  assert.equal((await activeAcceptedRepresentationsForHash(canonicalHash)).length, 0, "no ACTIVE fingerprint may remain for this hash once marked revoked");
  assert.equal((await allAcceptedRepresentationsForHash(canonicalHash)).length, 1, "the revoked fingerprint row itself must still exist as an audit record");
  // The underlying accepted content itself is untouched by this — only the
  // fingerprint's matching eligibility changes.
  assert.equal(await contentStoreCountFor(sourceRef1), 1, "marking a fingerprint revoked must not delete the retained content it was derived from");

  // A later, independently authorized submission of the exact same content
  // — by a different, fully consenting account — must now be evaluated
  // fresh, not blocked by the revoked fingerprint, and become the new
  // canonical accepted representation.
  const { deviceKey: dk2, reportId: rid2 } = await seedSavedReport(replacementAccountId, text);
  const sourceRef2 = buildReportAdmissionSourceRef({ accountId: replacementAccountId, deviceKey: dk2, reportId: rid2 });
  const job2 = await createPendingReportAdmissionJob(client, { accountId: replacementAccountId, deviceKey: dk2, reportId: rid2 });
  const outcome2 = await processReportAdmissionJob(client, { jobId: job2.jobId, openConnection });
  assert.equal(outcome2.outcome, "succeeded");
  assert.equal(outcome2.decision, "ACCEPT", "a later authorized submission of previously-revoked content must be free to become canonical");
  assert.notEqual(outcome2.decisionId, outcome1.decisionId);

  const activeNow = await activeAcceptedRepresentationsForHash(canonicalHash);
  assert.equal(activeNow.length, 1, "exactly one ACTIVE fingerprint must exist for this hash — the new, replacement one");
  assert.notEqual(activeNow[0].decision_id, (await acceptedRepresentationFor(sourceRef1)).decision_id, "the active fingerprint must belong to the NEW decision, not the revoked original");

  const allNow = await allAcceptedRepresentationsForHash(canonicalHash);
  assert.equal(allNow.length, 2, "the original (revoked) and the new (active) fingerprint rows must both exist side by side");

  assert.equal(await contentStoreCountFor(sourceRef2), 1, "the new submission's retained text must exist");
  assert.equal(await contentStoreCountFor(sourceRef1), 1, "the original's retained content is STILL untouched — only its fingerprint's matching eligibility changed");
});

// --- FAILURE-RECOVERY: consent revocation is atomic and safely retryable, and accepted content survives either way ---

test("FAILURE-RECOVERY: a consent-revocation attempt that fails partway leaves the account completely unchanged, a subsequent retry completes it correctly, and accepted content survives both outcomes", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  const accountId = await ensureUser(true);

  // An already-accepted report — must remain untouched no matter what
  // happens to the revocation attempt below.
  const acceptedText = plausibleArticleText(9401);
  const { deviceKey: acceptedDeviceKey, reportId: acceptedReportId } = await seedSavedReport(accountId, acceptedText);
  const sourceRefAccepted = buildReportAdmissionSourceRef({ accountId, deviceKey: acceptedDeviceKey, reportId: acceptedReportId });
  const acceptedJob = await createPendingReportAdmissionJob(client, { accountId, deviceKey: acceptedDeviceKey, reportId: acceptedReportId });
  const acceptedOutcome = await processReportAdmissionJob(client, { jobId: acceptedJob.jobId, openConnection });
  assert.equal(acceptedOutcome.outcome, "succeeded");
  assert.equal(acceptedOutcome.decision, "ACCEPT");
  assert.equal(await contentStoreCountFor(sourceRefAccepted), 1);

  // A still-pending report for the same account — this IS in scope for
  // cancellation once revocation succeeds.
  const pendingText = plausibleArticleText(9402);
  const { deviceKey: pendingDeviceKey, reportId: pendingReportId } = await seedSavedReport(accountId, pendingText);
  const sourceRefPending = buildReportAdmissionSourceRef({ accountId, deviceKey: pendingDeviceKey, reportId: pendingReportId });
  const pendingJob = await createPendingReportAdmissionJob(client, { accountId, deviceKey: pendingDeviceKey, reportId: pendingReportId });

  // A connection factory that always fails — simulates the revocation
  // transaction never being able to open/commit at all (a genuine,
  // persistent failure, not a transient BUSY that this function's own
  // retry loop would already absorb).
  function alwaysBrokenOpenConnection() {
    throw new Error("simulated persistent connection failure during revocation");
  }
  await assert.rejects(
    () => revokeConsentAndCancelPendingAdmissionJobs(accountId, alwaysBrokenOpenConnection),
    /simulated persistent connection failure/,
  );

  // Nothing must have changed: the transaction never committed, so this is
  // a full rollback, not a partial cleanup.
  assert.notEqual(await consentedAtFor(accountId), null, "consent must remain granted — the failed attempt must not have flipped it");
  assert.equal((await jobRowFor(sourceRefPending)).status, "pending", "the pending job's status must be unchanged by a failed revocation attempt");
  assert.equal((await jobRowFor(sourceRefAccepted)).status, "succeeded", "the accepted job must remain untouched by a failed revocation attempt");
  assert.equal(await contentStoreCountFor(sourceRefAccepted), 1);

  // Retrying with a working connection factory must complete correctly —
  // no persistent-job bookkeeping was needed for this to be safe, since a
  // rolled-back attempt left nothing to reconcile; simply calling it again
  // (exactly what happens if the browser retries the failed PATCH) suffices.
  const retried = await revokeConsentAndCancelPendingAdmissionJobs(accountId, openConnection);
  assert.deepEqual(retried, { cancelledJobCount: 1 });
  assert.equal(await consentedAtFor(accountId), null);
  assert.equal((await jobRowFor(sourceRefPending)).status, "cancelled");

  // The accepted report is STILL completely untouched — a successful
  // revocation is exactly as non-destructive to accepted content as a
  // failed one.
  const acceptedJobAfter = await jobRowFor(sourceRefAccepted);
  assert.equal(acceptedJobAfter.status, "succeeded");
  assert.equal(acceptedJobAfter.decision_id, acceptedOutcome.decisionId);
  assert.equal(await contentStoreCountFor(sourceRefAccepted), 1);
  assert.equal((await acceptedRepresentationFor(sourceRefAccepted)).revoked_at, null);
});

// --- report/owner-scoped deletion: job tracking is removed, but accepted content survives ---

test("REPORT-SCOPED DELETION: deleting a report always removes its own job-tracking row; accepted corpus content survives, unaccepted content does not, and another report's data is never touched", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  const accountId = await ensureUser(true);

  // A: an ACCEPTed report — its content must survive deletion.
  const textA = plausibleArticleText(8001);
  const { deviceKey: deviceKeyA, reportId: reportIdA } = await seedSavedReport(accountId, textA);
  const sourceRefA = buildReportAdmissionSourceRef({ accountId, deviceKey: deviceKeyA, reportId: reportIdA });
  const jobA = await createPendingReportAdmissionJob(client, { accountId, deviceKey: deviceKeyA, reportId: reportIdA });
  const outcomeA = await processReportAdmissionJob(client, { jobId: jobA.jobId, openConnection });
  assert.equal(outcomeA.outcome, "succeeded");
  assert.equal(outcomeA.decision, "ACCEPT");

  // B: a second, independent ACCEPTed report for the SAME account — proves
  // deleting A never reaches B's data (the "shared identity" concern).
  const textB = plausibleArticleText(8002);
  const { deviceKey: deviceKeyB, reportId: reportIdB } = await seedSavedReport(accountId, textB);
  const sourceRefB = buildReportAdmissionSourceRef({ accountId, deviceKey: deviceKeyB, reportId: reportIdB });
  const jobB = await createPendingReportAdmissionJob(client, { accountId, deviceKey: deviceKeyB, reportId: reportIdB });
  const outcomeB = await processReportAdmissionJob(client, { jobId: jobB.jobId, openConnection });
  assert.equal(outcomeB.outcome, "succeeded");
  assert.equal(outcomeB.decision, "ACCEPT");

  // R: a REJECTed report (too short) — nothing corpus-valuable to preserve,
  // so its decision row is fully removed on deletion, unlike A/B.
  const shortText = "This is far too short to ever pass the corpus admission word-count hard gate.";
  const { deviceKey: deviceKeyR, reportId: reportIdR } = await seedSavedReport(accountId, shortText);
  const sourceRefR = buildReportAdmissionSourceRef({ accountId, deviceKey: deviceKeyR, reportId: reportIdR });
  const jobR = await createPendingReportAdmissionJob(client, { accountId, deviceKey: deviceKeyR, reportId: reportIdR });
  const outcomeR = await processReportAdmissionJob(client, { jobId: jobR.jobId, openConnection });
  assert.equal(outcomeR.outcome, "succeeded");
  assert.equal(outcomeR.decision, "REJECT");
  assert.equal(await contentStoreCountFor(sourceRefR), 0, "sanity: a REJECT never retains content in the first place");

  assert.notEqual(sourceRefA, sourceRefB);

  await deleteReportCorpusAdmissionData(client, { accountId, deviceKey: deviceKeyA, reportId: reportIdA });
  await deleteReportCorpusAdmissionData(client, { accountId, deviceKey: deviceKeyR, reportId: reportIdR });

  // A: job-tracking row removed, but the accepted decision AND its
  // retained content survive — accepted corpus content is durable.
  assert.equal(await jobRowFor(sourceRefA), null, "the report's own job-tracking row must always be removed");
  assert.equal(await decisionCountFor(sourceRefA), 1, "an ACCEPTed decision must survive report deletion");
  assert.equal(await contentStoreCountFor(sourceRefA), 1, "accepted content must survive report deletion");

  // R: job-tracking row removed, AND the decision row (which never held
  // any retained content) is fully removed too — nothing worth preserving.
  assert.equal(await jobRowFor(sourceRefR), null);
  assert.equal(await decisionCountFor(sourceRefR), 0, "a REJECTed decision has nothing corpus-valuable to preserve, so it is fully removed");

  // B: completely untouched by deleting A or R.
  const jobBAfter = await jobRowFor(sourceRefB);
  assert.ok(jobBAfter, "report B's job row must be completely untouched by deleting reports A and R");
  assert.equal(jobBAfter.status, "succeeded");
  assert.equal(jobBAfter.decision_id, outcomeB.decisionId);
  assert.equal(await decisionCountFor(sourceRefB), 1);
  assert.equal(await contentStoreCountFor(sourceRefB), 1);
});
