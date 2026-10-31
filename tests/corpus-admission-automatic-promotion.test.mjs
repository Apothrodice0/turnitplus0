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
import { randomUUID } from "node:crypto";
import { canonicalSha256 } from "../lib/document-identity.ts";
import {
  runCorpusAdmissionPromotionSweep,
  stageCorpusAdmissionPromotionForDecision,
  stageAndClaimCorpusAdmissionPromotionForDecision,
  processCorpusAdmissionPromotion,
} from "../lib/corpus-admission-promotion.ts";
import { findCandidateCorpusRepresentations as _findCandidateCorpusRepresentations, corpusShingleHashes } from "../lib/user-submission-corpus.ts";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";

// Phase A safe-by-default maturity: these tests assert that auto-promotion
// makes a representation matchable "immediately" — written before the 7-day
// activation clock existed. findCandidateCorpusRepresentations now enforces
// maturity for MATCHING callers by default, so age the freshly-promoted
// backing past the window first. (The activation clock itself is covered by
// tests/corpus-activation-7day.test.mjs.)
const findCandidateCorpusRepresentations = async (client, hashes, opts) => {
  await matureCorpusBackings(client);
  return _findCandidateCorpusRepresentations(client, hashes, opts);
};
import { deactivateAcceptedRepresentation } from "../lib/corpus-admission-admin-actions.ts";
import { getCurrentCorpusMatchGeneration } from "../lib/report-historical-match.ts";

/**
 * Automatic corpus promotion after ACCEPT / re-ACCEPT: previously, ACCEPT
 * relied exclusively on the scheduled sweep (app/api/internal/corpus-
 * admission-promotion-sweep/route.ts, daily) to ever get staged/indexed —
 * a decision could sit ACCEPTed, with active fingerprint and retained
 * content, for up to a full day (or indefinitely, if
 * CORPUS_PROMOTION_ENABLED happened to be off at accept time) before
 * becoming matchable. lib/corpus-admission-report-integration.ts's
 * processReportAdmissionJob now stages and immediately attempts promotion
 * at the same async job boundary every real trigger (deferred post-save
 * callback, manual retry, the report-admission sweep) already awaits — see
 * that function's own inline comment for the exact reasoning. The
 * scheduled sweep remains the recovery/retry path, unchanged. Every
 * fixture here is synthetic.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_automatic_promotion.db");
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
test.after(() => {
  if (originalAdmissionFlag === undefined) delete process.env.CORPUS_ADMISSION_ENABLED;
  else process.env.CORPUS_ADMISSION_ENABLED = originalAdmissionFlag;
  if (originalPromotionFlag === undefined) delete process.env.CORPUS_PROMOTION_ENABLED;
  else process.env.CORPUS_PROMOTION_ENABLED = originalPromotionFlag;
});

let userCounter = 0;
async function ensureUser() {
  userCounter += 1;
  const accountId = `auto-promotion-account-${userCounter}`;
  await client.execute({
    sql: "INSERT INTO users (id, email, username, password_hash, corpus_reuse_consented_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"],
  });
  return accountId;
}

let reportCounter = 0;
async function seedSavedReport(accountId, rawText) {
  reportCounter += 1;
  const deviceKey = `auto-promotion-device-${reportCounter}`;
  const reportId = `auto-promotion-report-${reportCounter}`;
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, updated_at)
          VALUES (?,?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [reportId, deviceKey, `sub-${reportCounter}`, "T", 3300, 10, "low", JSON.stringify({ text: rawText }), accountId],
  });
  return { deviceKey, reportId };
}

// Same fixture-generation shape as tests/corpus-admission-report-integration.test.mjs
// (kept as its own local copy rather than a shared import, matching this
// codebase's existing convention of each admission test file owning its
// own synthetic-text generator).
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

async function uploadAndProcess(seed) {
  const accountId = await ensureUser();
  const text = plausibleArticleText(seed);
  const { deviceKey, reportId } = await seedSavedReport(accountId, text);
  const sourceRef = buildReportAdmissionSourceRef({ accountId, deviceKey, reportId });
  const created = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });
  const outcome = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection });
  return { accountId, text, deviceKey, reportId, sourceRef, jobId: created.jobId, outcome };
}

async function promotionRowForDecision(decisionId) {
  const result = await client.execute({ sql: "SELECT * FROM corpus_admission_promotions WHERE decision_id = ?", args: [decisionId] });
  return result.rows[0] ?? null;
}
async function promotionCountForDecision(decisionId) {
  const result = await client.execute({ sql: "SELECT COUNT(*) AS c FROM corpus_admission_promotions WHERE decision_id = ?", args: [decisionId] });
  return Number(result.rows[0].c);
}
async function representationCountByHash(hash) {
  const result = await client.execute({ sql: "SELECT COUNT(*) AS c FROM corpus_document_representations WHERE canonical_sha256 = ?", args: [hash] });
  return Number(result.rows[0].c);
}
async function jobRowFor(sourceRef) {
  const result = await client.execute({ sql: "SELECT * FROM corpus_admission_report_jobs WHERE source_ref = ?", args: [sourceRef] });
  return result.rows[0] ?? null;
}
async function decisionRowFor(sourceRef) {
  const result = await client.execute({ sql: "SELECT * FROM corpus_admission_decisions WHERE source_ref = ?", args: [sourceRef] });
  return result.rows[0] ?? null;
}

// --- 1: first ACCEPT automatically stages and indexes without a sweep ------

test("REQUIRED: first ACCEPT automatically stages AND indexes a promotion — no sweep call anywhere in this test", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  process.env.CORPUS_PROMOTION_ENABLED = "true";

  const { text, sourceRef, outcome } = await uploadAndProcess(1001);
  assert.equal(outcome.outcome, "succeeded");
  assert.equal(outcome.decision, "ACCEPT", "test setup sanity: this fixture must genuinely ACCEPT");

  const decision = await decisionRowFor(sourceRef);
  const promotion = await promotionRowForDecision(decision.id);
  assert.ok(promotion, "REQUIRED: a corpus_admission_promotions row must exist immediately — no sweep was ever called in this test");
  assert.equal(promotion.status, "indexed", "REQUIRED: not merely staged — the immediate attempt must have actually processed it to completion");
  assert.ok(promotion.representation_id, "an indexed promotion must carry a real representation_id");
  assert.equal(Number(promotion.attempt_count), 1);

  const hash = decision.canonical_sha256;
  assert.equal(await representationCountByHash(hash), 1, "exactly one corpus_document_representations row for this content");
});

// --- 2: cross-account matching sees the promoted representation ------------

test("REQUIRED: cross-account matching sees the promoted representation immediately, via the real findCandidateCorpusRepresentations eligibility join", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  process.env.CORPUS_PROMOTION_ENABLED = "true";

  const { text } = await uploadAndProcess(1002);
  const shingles = corpusShingleHashes(text);
  const candidates = await findCandidateCorpusRepresentations(client, shingles);
  assert.ok(candidates.length > 0, "REQUIRED: the freshly-promoted representation must be a real matching candidate, not merely present in an admin-only table");
});

// --- 3: duplicate invocation is idempotent ----------------------------------

test("REQUIRED: stageCorpusAdmissionPromotionForDecision is idempotent — calling it twice for the same decision returns the same id and creates no second row", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  process.env.CORPUS_PROMOTION_ENABLED = "true";

  const { sourceRef } = await uploadAndProcess(1003);
  const decision = await decisionRowFor(sourceRef);

  const idFromSecondCall = await stageCorpusAdmissionPromotionForDecision(client, decision.id);
  assert.ok(idFromSecondCall, "a promotion id must exist by now (already staged+indexed during upload)");
  const promotion = await promotionRowForDecision(decision.id);
  assert.equal(idFromSecondCall, promotion.id, "REQUIRED: a duplicate staging call must return the SAME id, never generate a new one");
  assert.equal(await promotionCountForDecision(decision.id), 1, "REQUIRED: exactly one corpus_admission_promotions row must ever exist for one decision");
});

test("REQUIRED: reprocessing an already-succeeded admission job never attempts a second promotion", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  process.env.CORPUS_PROMOTION_ENABLED = "true";

  const { sourceRef, jobId } = await uploadAndProcess(1004);
  const decision = await decisionRowFor(sourceRef);
  const attemptCountAfterFirst = Number((await promotionRowForDecision(decision.id)).attempt_count);

  const secondOutcome = await processReportAdmissionJob(client, { jobId, openConnection });
  assert.equal(secondOutcome.outcome, "already_succeeded", "test setup sanity: the job's own early-return must fire before this fix's promotion block is ever reached again");

  const promotionAfterSecondCall = await promotionRowForDecision(decision.id);
  assert.equal(Number(promotionAfterSecondCall.attempt_count), attemptCountAfterFirst, "REQUIRED: reprocessing an already-succeeded job must never re-attempt promotion");
  assert.equal(await promotionCountForDecision(decision.id), 1);
});

// --- 4/5/6: deactivate -> matching lost; re-ACCEPT -> auto-promotes again; canonical duplicate re-link ---

test("REQUIRED (full lifecycle): deactivate removes matching, a later re-ACCEPT of the SAME content automatically restores it via an EXACT_CANONICAL_DUPLICATE re-link — no sweep, no manual promotion, anywhere in this test", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  process.env.CORPUS_PROMOTION_ENABLED = "true";

  const text = plausibleArticleText(1005);
  const shingles = corpusShingleHashes(text);

  // --- First ACCEPT, automatic promotion ---
  const accountA = await ensureUser();
  const { deviceKey: deviceA, reportId: reportA } = await seedSavedReport(accountA, text);
  const sourceRefA = buildReportAdmissionSourceRef({ accountId: accountA, deviceKey: deviceA, reportId: reportA });
  const createdA = await createPendingReportAdmissionJob(client, { accountId: accountA, deviceKey: deviceA, reportId: reportA });
  const outcomeA = await processReportAdmissionJob(client, { jobId: createdA.jobId, openConnection });
  assert.equal(outcomeA.outcome, "succeeded");
  assert.equal(outcomeA.decision, "ACCEPT");
  const decisionA = await decisionRowFor(sourceRefA);
  const promotionA = await promotionRowForDecision(decisionA.id);
  assert.equal(promotionA.status, "indexed", "test setup sanity: first accept must auto-promote");

  assert.ok(
    (await findCandidateCorpusRepresentations(client, shingles)).length > 0,
    "test setup sanity: matchable right after the first accept",
  );

  // --- 4: admin deactivates -> matching lost ---
  const deactivateResult = await deactivateAcceptedRepresentation({
    decisionId: decisionA.id, adminUserId: "admin-test", reason: "test deactivate", openConnection,
  });
  assert.equal(deactivateResult.outcome, "deactivated");
  assert.equal(
    (await findCandidateCorpusRepresentations(client, shingles)).length,
    0,
    "REQUIRED: deactivation must remove this content from matching",
  );

  // --- 5: a fresh upload of the SAME content re-ACCEPTs and auto-promotes again ---
  const accountB = await ensureUser();
  const { deviceKey: deviceB, reportId: reportB } = await seedSavedReport(accountB, text);
  const sourceRefB = buildReportAdmissionSourceRef({ accountId: accountB, deviceKey: deviceB, reportId: reportB });
  const createdB = await createPendingReportAdmissionJob(client, { accountId: accountB, deviceKey: deviceB, reportId: reportB });
  const outcomeB = await processReportAdmissionJob(client, { jobId: createdB.jobId, openConnection });
  assert.equal(outcomeB.outcome, "succeeded");
  assert.equal(outcomeB.decision, "ACCEPT", "REQUIRED: re-uploading content whose only prior acceptance was deactivated must re-ACCEPT as a genuinely new decision");

  const decisionB = await decisionRowFor(sourceRefB);
  assert.notEqual(decisionB.id, decisionA.id, "must be a distinct decision, not a reuse of the deactivated one");

  const promotionB = await promotionRowForDecision(decisionB.id);
  assert.ok(promotionB, "REQUIRED: the re-ACCEPT must ALSO be automatically staged — no sweep was ever called");
  assert.equal(promotionB.status, "indexed", "REQUIRED: the re-ACCEPT must be automatically promoted to completion, not merely staged");

  // --- 6: canonical duplicate re-link path ---
  assert.equal(promotionB.link_type, "EXACT_CANONICAL_DUPLICATE", "REQUIRED: identical content must legitimately re-link to the existing representation, not create a duplicate");
  assert.equal(promotionB.representation_id, promotionA.representation_id, "REQUIRED: the re-linked promotion must reference the SAME underlying corpus_document_representations row");
  assert.equal(await representationCountByHash(decisionA.canonical_sha256), 1, "REQUIRED: an EXACT_CANONICAL_DUPLICATE re-link must never create a second representation row");

  // --- matching restored ---
  assert.ok(
    (await findCandidateCorpusRepresentations(client, shingles)).some((c) => c.canonicalSha256 === decisionA.canonical_sha256),
    "REQUIRED: the re-ACCEPT's own automatic promotion must restore the active matching relationship",
  );
});

// --- 7/8: promotion failure isolation + sweep recoverability ---------------

/**
 * Wraps a real openConnection factory so stageCorpusAdmissionPromotionForDecision's
 * own opening read throws — precisely targets that function's own exact
 * query text, NOT every mention of corpus_admission_promotions: admission's
 * own family-resolution phase (computeEvaluationCore's call to
 * findCandidateCorpusRepresentations) legitimately joins against that same
 * table for its eligibility check ("an 'indexed' promotion whose own
 * accepted_representation is not revoked") — a broader substring match
 * would incorrectly fail admission itself, not just the promotion attempt
 * below it. Targets openConnection (not the plain client) because
 * stageAndClaimCorpusAdmissionPromotionForDecision takes openConnection and
 * opens its own fresh connections per attempt (the claim-safety fix's own
 * SQLITE_BUSY-retry requirement — see that function's own header comment).
 */
function wrapOpenConnectionToFailPromotionStaging(realOpenConnection) {
  return async () => {
    const realClient = await realOpenConnection();
    // Explicit method delegation, not a Proxy: admission's own accept-
    // transaction (lib/corpus-admission-gate.ts's acceptWithAtomicDedupCriticalSection)
    // also calls openConnection() and needs a real .transaction()/.batch()
    // on whatever it gets back — a Proxy's default property-access
    // semantics would call those methods with `this` bound to the Proxy,
    // not the real client, risking breaking @libsql/client's own internal
    // state. Binding each delegated method directly to realClient sidesteps
    // that entirely; only .execute is ever actually intercepted.
    return {
      execute: (stmt) => {
        const sql = typeof stmt === "string" ? stmt : stmt.sql;
        if (typeof sql === "string" && sql.includes("SELECT id FROM corpus_admission_promotions WHERE decision_id")) {
          throw new Error("simulated promotion-staging failure (test-only fault injection)");
        }
        return realClient.execute(stmt);
      },
      transaction: (...args) => realClient.transaction(...args),
      batch: (...args) => realClient.batch(...args),
      close: (...args) => realClient.close(...args),
    };
  };
}

test("REQUIRED: a genuine immediate-promotion failure never turns ACCEPT into REVIEW/REJECT, and never fails the admission job — the decision and job both stay exactly as a normal successful ACCEPT would leave them", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  process.env.CORPUS_PROMOTION_ENABLED = "true";

  const accountId = await ensureUser();
  const text = plausibleArticleText(1006);
  const { deviceKey, reportId } = await seedSavedReport(accountId, text);
  const sourceRef = buildReportAdmissionSourceRef({ accountId, deviceKey, reportId });
  const created = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });

  const outcome = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection: wrapOpenConnectionToFailPromotionStaging(openConnection) });

  assert.equal(outcome.outcome, "succeeded", "REQUIRED: admission itself must succeed even though the immediate promotion attempt below it fails");
  assert.equal(outcome.decision, "ACCEPT", "REQUIRED: a promotion failure must never downgrade an otherwise-valid ACCEPT to REVIEW/REJECT");

  const job = await jobRowFor(sourceRef);
  assert.equal(job.status, "succeeded");
  assert.equal(job.decision_id, outcome.decisionId);

  const decision = await decisionRowFor(sourceRef);
  assert.equal(decision.decision, "ACCEPT");
  assert.ok(decision.content_store_id, "REQUIRED: retained content must still exist — the admission write itself is untouched by a downstream promotion failure");
});

test("REQUIRED: a failed immediate promotion attempt (staging itself never completed) remains discoverable and retryable by the existing scheduled sweep — no manual intervention needed", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  process.env.CORPUS_PROMOTION_ENABLED = "true";

  const accountId = await ensureUser();
  const text = plausibleArticleText(1007);
  const { deviceKey, reportId } = await seedSavedReport(accountId, text);
  const sourceRef = buildReportAdmissionSourceRef({ accountId, deviceKey, reportId });
  const created = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });

  const outcome = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection: wrapOpenConnectionToFailPromotionStaging(openConnection) });
  assert.equal(outcome.outcome, "succeeded", "test setup sanity: admission itself must succeed");

  const decision = await decisionRowFor(sourceRef);
  assert.equal(await promotionCountForDecision(decision.id), 0, "test setup sanity: staging itself must never have completed under the fault injection");

  // The existing scheduled sweep — the real recovery mechanism, untouched
  // by this fix — must still find and fully index it.
  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const sweepOutcome = sweep.results.find((r) => r.decisionId === decision.id);
  assert.ok(sweepOutcome, "REQUIRED: the sweep must discover this decision — never permanently lost by a failed immediate attempt");
  assert.equal(sweepOutcome.outcome, "indexed");

  const promotion = await promotionRowForDecision(decision.id);
  assert.equal(promotion.status, "indexed");
});

// --- 9: promotion-disabled flag preserves current disabled behavior --------

test("REQUIRED: CORPUS_PROMOTION_ENABLED off preserves current disabled behavior — ACCEPT still succeeds, nothing is staged immediately, and the scheduled sweep (once enabled) still discovers and promotes it exactly as before this fix", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  process.env.CORPUS_PROMOTION_ENABLED = "false";

  const { sourceRef } = await uploadAndProcess(1008);
  const decision = await decisionRowFor(sourceRef);
  assert.equal(decision.decision, "ACCEPT", "admission itself must be completely unaffected by the promotion flag");
  assert.equal(await promotionCountForDecision(decision.id), 0, "REQUIRED: with the flag off, nothing is staged immediately — matches the sweep's own pre-existing disabled short-circuit");

  process.env.CORPUS_PROMOTION_ENABLED = "true";
  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const sweepOutcome = sweep.results.find((r) => r.decisionId === decision.id);
  assert.ok(sweepOutcome, "REQUIRED: once the flag is later turned on, the sweep must still discover this decision exactly as it always could");
  assert.equal(sweepOutcome.outcome, "indexed");
});

// --- 10: no promotion occurs for REVIEW/REJECT ------------------------------

test("REQUIRED: no promotion row is ever created for a REVIEW or REJECT decision", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  process.env.CORPUS_PROMOTION_ENABLED = "true";

  const accountId = await ensureUser();
  // Far below the word-count hard gate — a genuine, deterministic non-ACCEPT.
  const shortText = "A short document with far too few words to ever pass the corpus admission hard gate for this specific automatic-promotion regression test.";
  const { deviceKey, reportId } = await seedSavedReport(accountId, shortText);
  const sourceRef = buildReportAdmissionSourceRef({ accountId, deviceKey, reportId });
  const created = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });
  const outcome = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection });

  assert.equal(outcome.outcome, "succeeded", "test setup sanity: the JOB itself still completes even though the decision is not ACCEPT");
  assert.notEqual(outcome.decision, "ACCEPT", "test setup sanity: this fixture must genuinely fail to ACCEPT");

  const decision = await decisionRowFor(sourceRef);
  assert.equal(await promotionCountForDecision(decision.id), 0, "REQUIRED: a REVIEW/REJECT decision must never get a corpus_admission_promotions row");
});

// --- 11: corpus generation changes only according to existing indexing semantics ---

test("REQUIRED: corpus_match_generation is bumped exactly once per successful indexing, by indexPromotionAtomically alone — staging by itself never bumps it, and the immediate path introduces no extra bump beyond existing semantics", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  process.env.CORPUS_PROMOTION_ENABLED = "true";

  const generationBeforeStaging = await getCurrentCorpusMatchGeneration(client);

  const accountId = await ensureUser();
  const text = plausibleArticleText(1009);
  const { deviceKey, reportId } = await seedSavedReport(accountId, text);
  const sourceRef = buildReportAdmissionSourceRef({ accountId, deviceKey, reportId });

  // Stage only (no processing yet) — via the SAME helper the immediate path
  // and the sweep both share — and confirm staging alone never touches the
  // generation counter.
  const created = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });
  // Run admission only, with promotion disabled, so a promotions row never
  // gets created OR processed by this call — isolates "staging alone" from
  // "staging + indexing" for this specific assertion.
  process.env.CORPUS_PROMOTION_ENABLED = "false";
  const admissionOutcome = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection });
  assert.equal(admissionOutcome.decision, "ACCEPT");
  const decision = await decisionRowFor(sourceRef);

  const stagedOnlyId = await stageCorpusAdmissionPromotionForDecision(client, decision.id);
  assert.ok(stagedOnlyId);
  const generationAfterStagingOnly = await getCurrentCorpusMatchGeneration(client);
  assert.equal(generationAfterStagingOnly, generationBeforeStaging, "REQUIRED: staging a promotion (no indexing yet) must never bump corpus_match_generation");

  // Now actually index it — this is the ONLY step that has ever bumped the
  // generation, before or after this fix.
  const processed = await processCorpusAdmissionPromotion(client, { promotionId: stagedOnlyId, openConnection });
  assert.equal(processed.outcome, "indexed");
  const generationAfterIndexing = await getCurrentCorpusMatchGeneration(client);
  assert.equal(generationAfterIndexing, generationBeforeStaging + 1, "REQUIRED: exactly one bump per successful indexing — unchanged from pre-existing bumpCorpusMatchGeneration semantics");

  // Sanity: the FULLY AUTOMATIC path (immediate stage+process together, as
  // exercised by every other test in this file) produces the identical
  // single-bump behavior — no double-counting from running both steps
  // back-to-back inside processReportAdmissionJob.
  process.env.CORPUS_PROMOTION_ENABLED = "true";
  const generationBeforeSecondUpload = await getCurrentCorpusMatchGeneration(client);
  const second = await uploadAndProcess(1010);
  assert.equal(second.outcome.decision, "ACCEPT");
  const generationAfterSecondUpload = await getCurrentCorpusMatchGeneration(client);
  assert.equal(generationAfterSecondUpload, generationBeforeSecondUpload + 1, "REQUIRED: the fully-automatic immediate path must bump the generation exactly once per new representation, matching pre-existing semantics exactly");
});

// ============================================================================
// Claim-safety fix: single-owner claim semantics + terminal idempotency.
// stageAndClaimCorpusAdmissionPromotionForDecision + processCorpusAdmission
// Promotion's own defensive guard together ensure the immediate path can
// never double-process a promotion the sweep is also touching, and can
// never re-index an already-terminal (indexed/skipped) row.
// ============================================================================

test("REQUIRED: calling processCorpusAdmissionPromotion twice on an already-indexed promotion causes zero second generation bump and zero second attempt", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  process.env.CORPUS_PROMOTION_ENABLED = "true";

  const { sourceRef } = await uploadAndProcess(3001);
  const decision = await decisionRowFor(sourceRef);
  const firstPromotion = await promotionRowForDecision(decision.id);
  assert.equal(firstPromotion.status, "indexed", "test setup sanity");
  assert.equal(Number(firstPromotion.attempt_count), 1);

  const generationAfterFirst = await getCurrentCorpusMatchGeneration(client);

  // Direct re-call, bypassing the claim entirely — proves
  // processCorpusAdmissionPromotion's OWN defensive guard, independent of
  // whether a caller correctly checked ownership first.
  const secondCallOutcome = await processCorpusAdmissionPromotion(client, { promotionId: firstPromotion.id, openConnection });
  assert.equal(secondCallOutcome.outcome, "indexed");
  assert.equal(secondCallOutcome.representationId, firstPromotion.representation_id, "REQUIRED: must return the EXISTING indexed outcome, never re-derive a new one");
  assert.equal(secondCallOutcome.linkType, firstPromotion.link_type);

  const promotionAfterSecondCall = await promotionRowForDecision(decision.id);
  assert.equal(Number(promotionAfterSecondCall.attempt_count), 1, "REQUIRED: zero second attempt — attempt_count must stay exactly 1");

  const generationAfterSecondCall = await getCurrentCorpusMatchGeneration(client);
  assert.equal(generationAfterSecondCall, generationAfterFirst, "REQUIRED: zero second generation bump");
});

test("REQUIRED: an existing indexed promotion returned by single-decision staging is not processed again — claimed comes back false", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  process.env.CORPUS_PROMOTION_ENABLED = "true";

  const { sourceRef } = await uploadAndProcess(3002);
  const decision = await decisionRowFor(sourceRef);
  const promotionBefore = await promotionRowForDecision(decision.id);
  assert.equal(promotionBefore.status, "indexed", "test setup sanity");

  const staged = await stageAndClaimCorpusAdmissionPromotionForDecision(openConnection, decision.id);
  assert.equal(staged.staged, true, "the row exists — staging itself is still a no-op success");
  assert.equal(staged.promotionId, promotionBefore.id);
  assert.equal(staged.claimed, false, "REQUIRED: an already-indexed promotion must never be claimable — status IN ('staged','failed') excludes it");

  // Mirrors processReportAdmissionJob's own gate exactly: only process when claimed.
  if (staged.claimed) {
    assert.fail("must not reach here — this is exactly the bug this fix closes");
  }
  const promotionAfter = await promotionRowForDecision(decision.id);
  assert.equal(Number(promotionAfter.attempt_count), Number(promotionBefore.attempt_count), "no attempt made");
});

test("REQUIRED: failed remains retryable — stageAndClaimCorpusAdmissionPromotionForDecision successfully claims a 'failed' row and processing proceeds normally", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  process.env.CORPUS_PROMOTION_ENABLED = "true";

  const accountId = await ensureUser();
  const text = plausibleArticleText(3003);
  const { deviceKey, reportId } = await seedSavedReport(accountId, text);
  const sourceRef = buildReportAdmissionSourceRef({ accountId, deviceKey, reportId });
  const created = await createPendingReportAdmissionJob(client, { accountId, deviceKey, reportId });

  const admissionOutcome = await processReportAdmissionJob(client, { jobId: created.jobId, openConnection: wrapOpenConnectionToFailPromotionStaging(openConnection) });
  assert.equal(admissionOutcome.outcome, "succeeded", "test setup sanity: admission succeeds even though staging is fault-injected");

  const decision = await decisionRowFor(sourceRef);
  assert.equal(await promotionCountForDecision(decision.id), 0, "test setup sanity: nothing staged yet under the fault injection");

  // Force a genuine 'failed' promotion via the real fault-injection
  // mechanism (mirrors tests/corpus-admission-promotion-sweep.test.mjs's
  // own PARTIAL-WRITE ROLLBACK test) rather than hand-writing a status.
  const stagedForFailure = await stageCorpusAdmissionPromotionForDecision(client, decision.id);
  const failedOutcome = await processCorpusAdmissionPromotion(client, { promotionId: stagedForFailure, openConnection, simulateFailureAfterShingles: true });
  assert.equal(failedOutcome.outcome, "failed");
  const failedRow = await promotionRowForDecision(decision.id);
  assert.equal(failedRow.status, "failed");
  assert.equal(failedRow.claimed_at, null, "a terminal failed write must release any claim");

  const claim = await stageAndClaimCorpusAdmissionPromotionForDecision(openConnection, decision.id);
  assert.equal(claim.staged, true);
  assert.equal(claim.claimed, true, "REQUIRED: a 'failed' promotion must remain claimable — it is one of the two retryable statuses");

  const retried = await processCorpusAdmissionPromotion(client, { promotionId: claim.promotionId, openConnection });
  assert.equal(retried.outcome, "indexed", "a genuine retry (no fault injected this time) must succeed normally");
});

test("REQUIRED: skipped remains terminal — never claimable, and a direct re-call returns the same skipped outcome without re-attempting", async () => {
  process.env.CORPUS_PROMOTION_ENABLED = "true";

  // A decision genuinely ACCEPTed with resolved retention still needs a
  // content_store row to be indexable — manufactured directly (mirrors
  // tests/corpus-admission-promotion-sweep.test.mjs's own insertDecision/
  // insertAcceptedRepresentation helpers) to reach 'skipped' deterministically,
  // rather than fighting the real gate's own retention-resolution logic.
  const text = "Skipped-promotion fixture: an accepted decision with no retained content at all.";
  const hash = canonicalSha256(text);
  const decisionId = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      decisionId, null, `automatic-promotion-skipped-test-${randomUUID()}`, "v1", "ACCEPT", "[]", 1, "[]",
      "txt", 50, "English", 0.95, hash, "v1", null, 80, "v1",
      "{}", "{}", "v1", 0.9, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  const acceptedRepresentationId = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
    args: [acceptedRepresentationId, decisionId, hash, 50, "v1"],
  });
  // Deliberately no corpus_admission_content_store row.

  const staged = await stageAndClaimCorpusAdmissionPromotionForDecision(openConnection, decisionId);
  assert.equal(staged.claimed, true, "test setup sanity: a fresh 'staged' row must be claimable");
  const outcome = await processCorpusAdmissionPromotion(client, { promotionId: staged.promotionId, openConnection });
  assert.equal(outcome.outcome, "skipped", "test setup sanity: no retained text must produce 'skipped'");

  const claimAfterSkip = await stageAndClaimCorpusAdmissionPromotionForDecision(openConnection, decisionId);
  assert.equal(claimAfterSkip.staged, true);
  assert.equal(claimAfterSkip.claimed, false, "REQUIRED: 'skipped' must never be claimable — it is permanently terminal, unlike 'failed'");

  const rowBeforeRecall = await promotionRowForDecision(decisionId);
  const recallOutcome = await processCorpusAdmissionPromotion(client, { promotionId: staged.promotionId, openConnection });
  assert.deepEqual(recallOutcome, outcome, "REQUIRED: a direct re-call must return the SAME skipped outcome, not re-derive or re-attempt");
  const rowAfterRecall = await promotionRowForDecision(decisionId);
  assert.equal(Number(rowAfterRecall.attempt_count), Number(rowBeforeRecall.attempt_count), "REQUIRED: no re-attempt — attempt_count unchanged");
});

test("REQUIRED: immediate path racing the sweep's own claim results in exactly one indexing attempt, one generation bump, and one terminal indexed transition — the loser never processes", async () => {
  process.env.CORPUS_ADMISSION_ENABLED = "true";
  // Isolate the race from automatic immediate promotion so this test
  // controls exactly when staging/claiming first becomes possible.
  process.env.CORPUS_PROMOTION_ENABLED = "false";
  const { sourceRef } = await uploadAndProcess(3004);
  const decision = await decisionRowFor(sourceRef);
  assert.equal(await promotionCountForDecision(decision.id), 0, "test setup sanity: nothing staged yet");
  process.env.CORPUS_PROMOTION_ENABLED = "true";

  const generationBefore = await getCurrentCorpusMatchGeneration(client);

  const immediatePathAttempt = (async () => {
    const staged = await stageAndClaimCorpusAdmissionPromotionForDecision(openConnection, decision.id);
    if (staged.staged && staged.claimed) {
      return { won: true, result: await processCorpusAdmissionPromotion(client, { promotionId: staged.promotionId, openConnection }) };
    }
    return { won: false, result: null };
  })();
  const sweepAttempt = runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });

  const [immediateOutcome, sweepOutcome] = await Promise.all([immediatePathAttempt, sweepAttempt]);

  const promotion = await promotionRowForDecision(decision.id);
  assert.ok(promotion, "REQUIRED: exactly one promotion row must exist, staged by whichever side got there first");
  assert.equal(promotion.status, "indexed", "REQUIRED: the row must reach a real terminal indexed state despite the race");
  assert.equal(Number(promotion.attempt_count), 1, "REQUIRED: exactly one real indexing attempt total, regardless of which side won the claim");

  const generationAfter = await getCurrentCorpusMatchGeneration(client);
  assert.equal(generationAfter, generationBefore + 1, "REQUIRED: exactly one corpus-generation bump total — never two from the race");

  const sweepProcessedIt = sweepOutcome.results.some((r) => r.decisionId === decision.id && r.outcome === "indexed");
  const immediateProcessedIt = immediateOutcome.won && immediateOutcome.result?.outcome === "indexed";
  assert.notEqual(immediateProcessedIt, sweepProcessedIt, "REQUIRED: exactly one of the two racing participants must have actually indexed it — never both, never neither");
});
