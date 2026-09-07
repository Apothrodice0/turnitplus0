import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import {
  createPendingReportAdmissionJob,
  processReportAdmissionJob,
} from "../lib/corpus-admission-report-integration.ts";
import { resolvePrimarySimilaritySummary } from "../lib/report-primary-similarity.ts";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";

/**
 * Product decision: cross-account TurnitPlus corpus / prior-submission
 * LOOKUP is mandatory for every authenticated report — no account preference
 * can disable it, and the Account page's former opt-in checkbox/paragraph/
 * status banner have been removed with no replacement toggle (see app/page.tsx
 * and its own removed-strings assertions in tests/account-me-identity-
 * rendering.test.mjs Section C).
 *
 * Investigation performed before writing this file (per the task's own
 * "inspect all uses of corpus_reuse_consented_at before changing behavior"
 * instruction) found exactly ONE behavioral consumer of that column in the
 * entire codebase: corpus ADMISSION (app/api/reports/route.ts's pending-
 * admission-job creation, and lib/corpus-admission-report-integration.ts's
 * fresh re-check inside processReportAdmissionJob / its revocation path) —
 * i.e. whether *this account's own* future uploads may be added to the
 * searchable corpus. Every production LOOKUP call
 * (resolvePrimarySimilaritySummary -> getOrComputeHistoricalMatchSnapshot ->
 * matchAgainstUserSubmissionCorpus) contains zero references to that column;
 * it is gated only by the global CORPUS_SOURCE_MATCHING_ENABLED flag and by
 * accountId/excludeAccountId (self-match exclusion). The two concepts are
 * therefore cleanly separable — this file pins that LOOKUP is unconditional
 * regardless of an account's (now-unreachable-from-the-UI) consent state,
 * without touching ADMISSION's own still-consent-gated mechanics at all
 * (left completely unmodified — see lib/corpus-admission-report-integration.ts).
 *
 * Fixture pattern mirrors tests/corpus-admission-self-match-exclusion.test.mjs's
 * own ensureUser/seedSavedReport/finalizeAndPersist/admitAndAutoPromote
 * helpers exactly, so this suite exercises the same real admission ->
 * promotion -> lookup pipeline, not a synthetic shortcut.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_lookup_mandatory.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const dbUrl = `file:${dbFile}`;
const client = createClient({ url: dbUrl });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);
const openConnection = () => createClient({ url: dbUrl });

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

const originalAdmissionFlag = process.env.CORPUS_ADMISSION_ENABLED;
const originalPromotionFlag = process.env.CORPUS_PROMOTION_ENABLED;
const originalSourceMatchingFlag = process.env.CORPUS_SOURCE_MATCHING_ENABLED;
test.after(() => {
  if (originalAdmissionFlag === undefined) delete process.env.CORPUS_ADMISSION_ENABLED; else process.env.CORPUS_ADMISSION_ENABLED = originalAdmissionFlag;
  if (originalPromotionFlag === undefined) delete process.env.CORPUS_PROMOTION_ENABLED; else process.env.CORPUS_PROMOTION_ENABLED = originalPromotionFlag;
  if (originalSourceMatchingFlag === undefined) delete process.env.CORPUS_SOURCE_MATCHING_ENABLED; else process.env.CORPUS_SOURCE_MATCHING_ENABLED = originalSourceMatchingFlag;
});
process.env.CORPUS_ADMISSION_ENABLED = "true";
process.env.CORPUS_PROMOTION_ENABLED = "true";
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";

let userCounter = 0;
/**
 * `consented`: true -> corpus_reuse_consented_at set (the former UI "ON"
 * state); false -> left NULL (the former UI "OFF"/default state, and the
 * ONLY state any new account can ever reach now that the checkbox is gone).
 * Only ever used here to grant a fixture account admission eligibility
 * (unrelated to what this file is actually testing: LOOKUP) or to exercise
 * the "does the viewer's own consent state change lookup" question directly.
 */
async function ensureUser(consented) {
  userCounter += 1;
  const accountId = `lookup-mandatory-account-${userCounter}`;
  await client.execute({
    sql: consented
      ? "INSERT INTO users (id, email, username, password_hash, corpus_reuse_consented_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)"
      : "INSERT INTO users (id, email, username, password_hash, corpus_reuse_consented_at) VALUES (?,?,?,?,NULL)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"],
  });
  return accountId;
}

async function setConsent(accountId, consented) {
  await client.execute({
    sql: consented
      ? "UPDATE users SET corpus_reuse_consented_at = CURRENT_TIMESTAMP WHERE id = ?"
      : "UPDATE users SET corpus_reuse_consented_at = NULL WHERE id = ?",
    args: [accountId],
  });
}

let reportCounter = 0;
async function seedSavedReport(accountId, rawText) {
  reportCounter += 1;
  const deviceKey = `lookup-mandatory-device-${reportCounter}`;
  const reportId = `lookup-mandatory-report-${reportCounter}`;
  const payload = { version: 11, id: reportId, submissionId: `sub-${reportCounter}`, title: `Fixture ${reportCounter}`, text: rawText };
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, ai_score, ai_tone, payload_json, user_id, room_number, ai_status, updated_at)
          VALUES (?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [reportId, deviceKey, payload.submissionId, payload.title, 40, 0, "Low", 0, "low", JSON.stringify(payload), accountId, 0, "ready"],
  });
  return { deviceKey, reportId };
}

const WORD_BANK = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu", "nu", "xi", "omicron", "pi", "rho", "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega", "corpus", "policy", "framework", "governance", "economic", "structural"];
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

/** Mirrors tests/corpus-admission-self-match-exclusion.test.mjs's own finalizeAndPersist — the real write-time-finalization call. */
async function finalizeAndPersist({ deviceKey, id, userId, text, wordCount, archiveScore = 0, archiveMatchedPositions = null }) {
  await matureCorpusBackings(client);
  return resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: deviceKey, reportId: id, accountId: userId, rawText: text,
    wordCount, archiveMatchedPositions, externalAcademicEvidence: null, archiveScore,
  });
}

/** Real admission + automatic promotion, via the actual job pipeline. Requires the account's CURRENT consent state to be true at call time (processReportAdmissionJob always re-checks fresh). */
async function admitAndAutoPromote({ accountId, deviceKey, reportId }) {
  const created = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });
  const outcome = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection });
  assert.equal(outcome.outcome, "succeeded", "test setup sanity: admission job must succeed");
  assert.equal(outcome.decision, "ACCEPT", "test setup sanity: this fixture must genuinely ACCEPT");
  return outcome;
}

// ======================================================================
// (a) former preference OFF (consent NULL) still performs corpus lookup
// ======================================================================

test("REQUIRED: an authenticated account with corpus_reuse_consented_at NULL (former UI \"OFF\" / the only state any account can reach now) still performs a full cross-account corpus lookup and matches a genuine prior-submission representation", async () => {
  const text = plausibleArticleText(9001);

  // Source account: consents (needed only to make ITS OWN content admission-
  // eligible — this is the ADMISSION primitive, deliberately untouched here).
  const source = await ensureUser(true);
  const { deviceKey: sourceDevice, reportId: sourceReport } = await seedSavedReport(source, text);
  await finalizeAndPersist({ deviceKey: sourceDevice, id: sourceReport, userId: source, text, wordCount: 40 });
  await admitAndAutoPromote({ accountId: source, deviceKey: sourceDevice, reportId: sourceReport });

  // Viewer: NEVER consented (NULL) — the mandatory-lookup case under test.
  const viewer = await ensureUser(false);
  const viewerRow = await client.execute({ sql: "SELECT corpus_reuse_consented_at FROM users WHERE id = ?", args: [viewer] });
  assert.equal(viewerRow.rows[0].corpus_reuse_consented_at, null, "test setup sanity: viewer genuinely never consented");

  const { deviceKey: viewerDevice, reportId: viewerReport } = await seedSavedReport(viewer, text);
  const result = await finalizeAndPersist({ deviceKey: viewerDevice, id: viewerReport, userId: viewer, text, wordCount: 40 });

  assert.equal(result.historicalSubmissionMatch.status, "MATCHED", "REQUIRED: lookup must run and match even though the viewer's own corpus_reuse_consented_at is NULL");
  assert.ok(result.unifiedSimilarity.unifiedScore > 0, "REQUIRED: the cross-account match must contribute a real, non-zero score for a never-consented viewer");
});

// ======================================================================
// (b) former preference ON performs an IDENTICAL corpus lookup
// ======================================================================

test("REQUIRED: an authenticated account with corpus_reuse_consented_at SET (former UI \"ON\") performs the identical cross-account corpus lookup as a never-consented account — consent state produces no behavioral difference in lookup", async () => {
  const text = plausibleArticleText(9002);

  const source = await ensureUser(true);
  const { deviceKey: sourceDevice, reportId: sourceReport } = await seedSavedReport(source, text);
  await finalizeAndPersist({ deviceKey: sourceDevice, id: sourceReport, userId: source, text, wordCount: 40 });
  await admitAndAutoPromote({ accountId: source, deviceKey: sourceDevice, reportId: sourceReport });

  const viewerOff = await ensureUser(false);
  const { deviceKey: offDevice, reportId: offReport } = await seedSavedReport(viewerOff, text);
  const resultOff = await finalizeAndPersist({ deviceKey: offDevice, id: offReport, userId: viewerOff, text, wordCount: 40 });

  const viewerOn = await ensureUser(true);
  const { deviceKey: onDevice, reportId: onReport } = await seedSavedReport(viewerOn, text);
  const resultOn = await finalizeAndPersist({ deviceKey: onDevice, id: onReport, userId: viewerOn, text, wordCount: 40 });

  assert.equal(resultOn.historicalSubmissionMatch.status, "MATCHED");
  assert.equal(resultOn.historicalSubmissionMatch.status, resultOff.historicalSubmissionMatch.status, "REQUIRED: identical lookup outcome regardless of the viewer's own consent state");
  assert.equal(resultOn.unifiedSimilarity.unifiedScore, resultOff.unifiedSimilarity.unifiedScore, "REQUIRED: identical score regardless of the viewer's own consent state");
});

// ======================================================================
// (own prior/corpus contribution = 0) self-exclusion survives even after
// the account's consent has since been cleared to NULL
// ======================================================================

test("REQUIRED: own prior/corpus contribution stays 0 — an account's own admitted representation is still excluded from its own later report, even after that account's corpus_reuse_consented_at has since reverted to NULL", async () => {
  const text = plausibleArticleText(9003);

  const accountId = await ensureUser(true); // must be true to be admission-eligible
  const { deviceKey: firstDevice, reportId: firstReport } = await seedSavedReport(accountId, text);
  await finalizeAndPersist({ deviceKey: firstDevice, id: firstReport, userId: accountId, text, wordCount: 40 });
  await admitAndAutoPromote({ accountId, deviceKey: firstDevice, reportId: firstReport });

  // Consent now reverts to NULL — e.g. the account had it granted long ago
  // under the old UI, and it has since lapsed/been cleared. Mandatory
  // cross-account LOOKUP must still run (this account has no way to disable
  // it), but the ACCOUNT-LEVEL self-exclusion invariant must still hold: this
  // account's own new report must never match its own prior admission.
  await setConsent(accountId, false);
  const row = await client.execute({ sql: "SELECT corpus_reuse_consented_at FROM users WHERE id = ?", args: [accountId] });
  assert.equal(row.rows[0].corpus_reuse_consented_at, null, "test setup sanity: consent genuinely cleared");

  const { deviceKey: secondDevice, reportId: secondReport } = await seedSavedReport(accountId, text);
  const result = await finalizeAndPersist({ deviceKey: secondDevice, id: secondReport, userId: accountId, text, wordCount: 40 });

  assert.equal(result.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH", "REQUIRED: a report must never match its own account's sole admission backing, regardless of the account's current consent state");
  assert.equal(result.unifiedSimilarity.unifiedScore, 0, "REQUIRED: own prior/corpus contribution must stay 0");
});

// ======================================================================
// independent archive evidence survives mandatory corpus lookup
// ======================================================================

test("REQUIRED: independent archive evidence still contributes to the primary score when mandatory corpus lookup finds nothing to match — corpus lookup does not suppress or replace non-corpus evidence", async () => {
  const text = plausibleArticleText(9004);
  const viewer = await ensureUser(false); // never consented — mandatory-lookup case
  const { deviceKey, reportId } = await seedSavedReport(viewer, text);

  const archiveMatchedPositions = Array.from({ length: 20 }, (_, i) => i); // 20 of 40 words "matched" by the (independent) archive pipeline
  const result = await finalizeAndPersist({
    deviceKey, id: reportId, userId: viewer, text, wordCount: 40,
    archiveScore: 50, archiveMatchedPositions,
  });

  assert.equal(result.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH", "test setup sanity: nothing in the corpus for this viewer to match");
  assert.equal(result.isUnified, true, "the computation must still succeed and unify whatever independent evidence is available");
  assert.equal(result.unifiedSimilarity.archiveOnlyWords, 20, "REQUIRED: every one of the 20 independently-archive-matched words must still be counted");
  assert.equal(result.unifiedSimilarity.previousUploadOnlyWords, 0, "test setup sanity: no corpus/previous-upload words exist here — the non-zero score below comes from archive evidence alone");
  assert.ok(result.unifiedSimilarity.unifiedScore > 0, "REQUIRED: independent archive evidence must still contribute a non-zero score even though the mandatory corpus lookup found nothing");
  assert.equal(result.primaryScore, result.unifiedSimilarity.unifiedScore, "REQUIRED: the primary score reflects the unified (archive-inclusive) result, not the archive-only fallback — the mandatory corpus lookup ran and resolved, it just found nothing");
});

// ======================================================================
// UI: no consent checkbox, no explanatory paragraph, no ON/OFF banner
// ======================================================================

test("UI: app/page.tsx contains no corpus-reuse-consent checkbox, no explanatory paragraph, and no cross-account ON/OFF status banner — and does not send corpusReuseConsent from the profile-edit form", () => {
  const src = fs.readFileSync(path.join(repoRoot, "app/page.tsx"), "utf8");

  assert.doesNotMatch(src, /Check my uploads against other TurnitPlus users/, "REQUIRED: the consent checkbox label must be gone");
  assert.doesNotMatch(src, /corpusReuseConsent/, "REQUIRED: no corpusReuseConsent wiring (checkbox, form field, or account state) may remain in the client");
  assert.doesNotMatch(src, /Cross-account prior-submission checking is (ON|OFF)/, "REQUIRED: the Account-page ON/OFF status banner must be gone");
  assert.doesNotMatch(src, /account-consent-toggle/, "the removed checkbox's CSS hook must not remain referenced");

  const css = fs.readFileSync(path.join(repoRoot, "app/globals.css"), "utf8");
  assert.doesNotMatch(css, /\.account-consent-toggle/, "the removed checkbox's now-dead CSS rules must not remain");
});
