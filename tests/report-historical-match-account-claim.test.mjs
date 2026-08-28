import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import {
  createPendingReportAdmissionJob,
  processReportAdmissionJob,
  buildReportAdmissionSourceRef,
} from "../lib/corpus-admission-report-integration.ts";
import { resolvePrimarySimilaritySummary } from "../lib/report-primary-similarity.ts";
import { claimAnonymousReports } from "../lib/auth-session.ts";
import { getCurrentCorpusMatchGeneration } from "../lib/report-historical-match.ts";

/**
 * ANONYMOUS -> ACCOUNT CLAIM: a report's cached historical-match snapshot is
 * keyed on (report_device_key, report_id) only — NOT on the requester
 * account. claimAnonymousReports (lib/auth-session.ts, run on every
 * signup/login) flips saved_reports.user_id from NULL to a real account
 * without changing device_key or id, so a snapshot computed while the report
 * was anonymous (excludeAccountId undefined — a BROADER, no-own-account-
 * exclusion search) can later be served verbatim to that same report viewed
 * as its new owner account A (excludeAccountId = A — a NARROWER search).
 *
 * Direction safety:
 *   - a cached NO_HISTORICAL_MATCH is SAFE to keep: the broader anonymous
 *     search already found nothing, so the narrower account-excluded search
 *     can only also find nothing.
 *   - a cached MATCHED is NOT safe: the broader anonymous search may have
 *     matched a promoted representation that is backed ONLY by account A's
 *     own admission(s). Once the report belongs to A, that representation
 *     must be excluded as same-account (the CORE INVARIANT), but the stale
 *     snapshot still reports it — and with CORPUS_SOURCE_MATCHING_ENABLED
 *     on, that entry (TURNITPLUS_CORPUS_SOURCE) still inflates the unified
 *     score.
 *
 * The fix: claimAnonymousReports invalidates the historical-match snapshot
 * of every report it claims, so the next view recomputes under the new
 * owner's own exclusion context.
 *
 * Every fixture here is synthetic.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_report_historical_match_account_claim.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const dbUrl = `file:${dbFile}`;
const client = createClient({ url: dbUrl });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);
const openConnection = () => createClient({ url: dbUrl });

const originalAdmissionFlag = process.env.CORPUS_ADMISSION_ENABLED;
const originalPromotionFlag = process.env.CORPUS_PROMOTION_ENABLED;
const originalSourceMatchingFlag = process.env.CORPUS_SOURCE_MATCHING_ENABLED;
process.env.CORPUS_ADMISSION_ENABLED = "true";
process.env.CORPUS_PROMOTION_ENABLED = "true";
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";

test.after(() => {
  client.close();
  if (originalAdmissionFlag === undefined) delete process.env.CORPUS_ADMISSION_ENABLED; else process.env.CORPUS_ADMISSION_ENABLED = originalAdmissionFlag;
  if (originalPromotionFlag === undefined) delete process.env.CORPUS_PROMOTION_ENABLED; else process.env.CORPUS_PROMOTION_ENABLED = originalPromotionFlag;
  if (originalSourceMatchingFlag === undefined) delete process.env.CORPUS_SOURCE_MATCHING_ENABLED; else process.env.CORPUS_SOURCE_MATCHING_ENABLED = originalSourceMatchingFlag;
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

let userCounter = 0;
async function ensureUser() {
  userCounter += 1;
  const accountId = `claim-account-${userCounter}`;
  await client.execute({
    sql: "INSERT INTO users (id, email, username, password_hash, corpus_reuse_consented_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"],
  });
  return accountId;
}

let reportCounter = 0;
async function seedSavedReport(accountIdOrNull, deviceKey, rawText) {
  reportCounter += 1;
  const reportId = `claim-report-${reportCounter}`;
  const payload = { version: 11, id: reportId, submissionId: `sub-${reportCounter}`, title: `Fixture ${reportCounter}`, text: rawText };
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_score, ai_tone, payload_json, user_id, room_number, ai_status, updated_at)
          VALUES (?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [reportId, deviceKey, payload.submissionId, payload.title, 40, 0, "Low", 0, "low", JSON.stringify(payload), accountIdOrNull, 0, "ready"],
  });
  return { deviceKey, reportId };
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

async function finalize({ deviceKey, reportId, accountId, text }) {
  return resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText: text,
    wordCount: 40, archiveMatchedPositions: null, externalAcademicEvidence: null, archiveScore: 0,
  });
}

async function admitAndAutoPromote({ accountId, deviceKey, reportId }) {
  const created = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });
  const outcome = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection });
  assert.equal(outcome.outcome, "succeeded", "test setup sanity: admission job must succeed");
  assert.equal(outcome.decision, "ACCEPT", "test setup sanity: this fixture must genuinely ACCEPT");
  return outcome;
}

test("REQUIRED: an anonymous report's cached MATCHED snapshot is not served after the report is claimed by the account that solely backs the matched representation", async () => {
  const accountA = await ensureUser();
  const text = plausibleArticleText(7001);

  // 1. Account A uploads the content through an authenticated report and it
  //    is admitted + auto-promoted — the representation is backed ONLY by
  //    A's own admission (source_ref carries account=A).
  const { deviceKey: deviceA, reportId: reportA } = await seedSavedReport(accountA, "claim-device-A", text);
  await finalize({ deviceKey: deviceA, reportId: reportA, accountId: accountA, text });
  await admitAndAutoPromote({ accountId: accountA, deviceKey: deviceA, reportId: reportA });

  // 2. The SAME person, logged out, re-uploads the identical content on a
  //    fresh anonymous device. The anonymous computation (excludeAccountId
  //    undefined) sees A's promoted representation and reports a match.
  const anonDevice = "claim-device-anon";
  const { reportId: reportAnon } = await seedSavedReport(null, anonDevice, text);
  const anonResolution = await finalize({ deviceKey: anonDevice, reportId: reportAnon, accountId: null, text });
  assert.equal(anonResolution.historicalSubmissionMatch.status, "MATCHED", "test setup sanity: an anonymous upload of A's promoted content matches it");
  assert.equal(anonResolution.historicalSubmissionMatch.matches[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");

  const generationBeforeClaim = await getCurrentCorpusMatchGeneration(client);

  // 3. The person signs in as account A on that anonymous device —
  //    claimAnonymousReports attaches the anonymous report to A.
  await claimAnonymousReports(client, accountA, anonDevice);
  const claimed = await client.execute({ sql: "SELECT user_id FROM saved_reports WHERE device_key = ? AND id = ?", args: [anonDevice, reportAnon] });
  assert.equal(claimed.rows[0].user_id, accountA, "test setup sanity: the report is now owned by account A");

  // No unrelated corpus event happened, so the global generation is
  // unchanged — the ONLY thing that could invalidate the stale snapshot is
  // the claim itself.
  assert.equal(await getCurrentCorpusMatchGeneration(client), generationBeforeClaim, "test setup sanity: nothing else bumped the generation");

  // 4. The person views the now-claimed report as account A. The matched
  //    representation is backed only by A's own admission, so the correct
  //    result is NO_HISTORICAL_MATCH — the stale anonymous MATCHED must not
  //    survive the ownership change.
  const afterClaim = await finalize({ deviceKey: anonDevice, reportId: reportAnon, accountId: accountA, text });
  assert.equal(afterClaim.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH", "REQUIRED: a claimed report must not match a representation backed solely by its new owner account");
  assert.equal(afterClaim.unifiedSimilarity.unifiedScore, 0, "REQUIRED: no self-inflated score from the new owner's own promoted representation");
});

test("REQUIRED: a claimed report still matches a representation backed by a DIFFERENT account (the claim invalidates the cache, it does not globally suppress)", async () => {
  const accountOwner = await ensureUser();
  const claimant = await ensureUser();
  const text = plausibleArticleText(7002);

  // A different account backs the representation.
  const { deviceKey: deviceOwner, reportId: reportOwner } = await seedSavedReport(accountOwner, "claim-device-owner-2", text);
  await finalize({ deviceKey: deviceOwner, reportId: reportOwner, accountId: accountOwner, text });
  await admitAndAutoPromote({ accountId: accountOwner, deviceKey: deviceOwner, reportId: reportOwner });

  // Anonymous upload of the same content, then claimed by a DIFFERENT
  // account than the one backing the representation.
  const anonDevice = "claim-device-anon-2";
  const { reportId: reportAnon } = await seedSavedReport(null, anonDevice, text);
  await finalize({ deviceKey: anonDevice, reportId: reportAnon, accountId: null, text });
  await claimAnonymousReports(client, claimant, anonDevice);

  const afterClaim = await finalize({ deviceKey: anonDevice, reportId: reportAnon, accountId: claimant, text });
  assert.equal(afterClaim.historicalSubmissionMatch.status, "MATCHED", "REQUIRED: the claimant is a different account from the backing account — the match must remain");
  assert.ok(afterClaim.unifiedSimilarity.unifiedScore > 0, "REQUIRED: the cross-account match still contributes a real score after the claim");
});

test("REQUIRED: a cached anonymous NO_HISTORICAL_MATCH survives a claim unchanged (the safe direction — no needless recompute regression)", async () => {
  const claimant = await ensureUser();
  const text = plausibleArticleText(7003);

  // Nothing in the corpus matches this content.
  const anonDevice = "claim-device-anon-3";
  const { reportId: reportAnon } = await seedSavedReport(null, anonDevice, text);
  const anonResolution = await finalize({ deviceKey: anonDevice, reportId: reportAnon, accountId: null, text });
  assert.equal(anonResolution.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH");

  await claimAnonymousReports(client, claimant, anonDevice);

  const afterClaim = await finalize({ deviceKey: anonDevice, reportId: reportAnon, accountId: claimant, text });
  assert.equal(afterClaim.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH", "REQUIRED: a genuine no-match stays a no-match after the claim");
});
