import assert from "node:assert/strict";
import test from "node:test";
import path from "path";
import crypto from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { tokens } from "../lib/similarity-core.ts";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import {
  indexDocumentSubmissionIntoCorpus,
  createReusableDocumentRepresentation,
  recordCorpusShingles,
} from "../lib/user-submission-corpus.ts";
import { buildReportAdmissionSourceRef } from "../lib/corpus-admission-source-ref.ts";
import { matchAgainstUserSubmissionCorpus } from "../lib/user-submission-matching.ts";
import { resolvePrimarySimilaritySummary } from "../lib/report-primary-similarity.ts";
import { priorSubmissionBranchState } from "../lib/report-evidence-interpretation.ts";
import { resolveReportCompletion, unknownExtractionDiagnostic } from "../lib/evidence-interpretation/index.ts";
import { DEVICE_PASSPORT_ALGORITHM } from "../lib/device-passport-server.ts";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";

/**
 * Common-block coverage vs same-device SELF.
 *
 * A block of copied text held by more than 50 documents is resolved from its
 * own posting list, and one verified holder covers it. The same-device SELF
 * rule runs only after matching (lib/report-primary-similarity.ts). When the
 * first holder in posting order was a source uploaded from the report's own
 * verified device, it covered the block, the walk stopped, SELF then took it
 * out of the score, and the eligible cross-account holder behind it was never
 * tried: the block left the score.
 *
 * Now a holder the SELF rule will exclude never settles a block; the walk goes
 * on to the next holder. Every corpus here is synthetic and in memory.
 */

const priorCorpusSourceFlag = process.env.CORPUS_SOURCE_MATCHING_ENABLED;
const priorSelfFlag = process.env.DEVICE_PASSPORT_SELF_ENABLED;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
test.after(() => {
  if (priorCorpusSourceFlag === undefined) delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  else process.env.CORPUS_SOURCE_MATCHING_ENABLED = priorCorpusSourceFlag;
  if (priorSelfFlag === undefined) delete process.env.DEVICE_PASSPORT_SELF_ENABLED;
  else process.env.DEVICE_PASSPORT_SELF_ENABLED = priorSelfFlag;
});

function withSelfScoring(enabled, fn) {
  const original = process.env.DEVICE_PASSPORT_SELF_ENABLED;
  if (enabled) process.env.DEVICE_PASSPORT_SELF_ENABLED = "true";
  else delete process.env.DEVICE_PASSPORT_SELF_ENABLED;
  return Promise.resolve(fn()).finally(() => {
    if (original === undefined) delete process.env.DEVICE_PASSPORT_SELF_ENABLED;
    else process.env.DEVICE_PASSPORT_SELF_ENABLED = original;
  });
}

const drizzleDir = path.join(path.resolve("."), "drizzle");
const SUBMITTER = "submitter";
const DEVICE_KEY = "device-key";
const PASSPORT = "passport-of-the-report";

// Three-syllable pseudo-words: every 5-gram is informative, no generic register.
const SYLLABLES = ["ka", "lo", "mi", "tre", "vun", "sor", "bel", "dra", "phi", "quen", "zor", "tal", "mer", "nix", "ost", "ula", "rin", "vek", "dom", "sha", "gri", "pol", "wex", "yun"];
function words(count, seed) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length]);
  return out.join(" ");
}

// 600-word submission: a 130-word block at the start that many documents
// hold, a 120-word passage that one other document (X) holds.
const HEAD = words(200, 11);
const PASSAGE = words(120, 777);
const TAIL = words(280, 22);
const SUBMISSION = `${HEAD} ${PASSAGE} ${TAIL}`;
const WORD_COUNT = tokens(SUBMISSION).length;
const BLOCK = HEAD.split(" ").slice(0, 130).join(" ");
const SOURCE_X = `${words(250, 31)} ${PASSAGE} ${words(250, 32)}`;
const blockHolder = (k) => `${words(200, k * 13)} ${BLOCK} ${words(200, k * 17)}`;
const range = (from, count) => Array.from({ length: count }, (_, i) => from + i);
const BLOCK_POSITIONS = range(0, 130);
const PASSAGE_POSITIONS = range(200, 120);
const BLOCK_AND_PASSAGE = [...BLOCK_POSITIONS, ...PASSAGE_POSITIONS];
const CHUNK_A = TAIL.split(" ").slice(0, 60).join(" "); // submission positions 320..379
const CHUNK_B = TAIL.split(" ").slice(80, 140).join(" "); // submission positions 400..459

async function freshCorpus() {
  const client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  await applyMigrationsLibsql(client, drizzleDir);
  const users = new Set();
  const ensureUser = async (accountId) => {
    if (users.has(accountId)) return;
    users.add(accountId);
    await client.execute({ sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)", args: [accountId, `${accountId}@example.test`, accountId, "x"] });
  };
  const ensurePassport = (passportId) =>
    client.execute({
      sql: "INSERT OR IGNORE INTO device_passports (id, public_key_spki, algorithm, created_at, provenance_generation) VALUES (?,?,?,?,0)",
      args: [passportId, Buffer.from(`spki-${passportId}`), DEVICE_PASSPORT_ALGORITHM, Date.now()],
    });
  let reportSeq = 0;
  return {
    client,
    /** A prior submission by another account: PRIOR_SUBMISSION. */
    async index(accountId, rawText) {
      await ensureUser(accountId);
      const identity = await createDocumentIdentity(client, { accountId, title: "t", author: null, rawText });
      await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
      const row = await client.execute({ sql: "SELECT representation_id FROM corpus_submission_references WHERE document_identity_id = ?", args: [identity.id] });
      return String(row.rows[0].representation_id);
    },
    /**
     * A corpus source admitted from the report's own verified device under
     * another account, with no other backing: TURNITPLUS_CORPUS_SOURCE in the
     * matcher, an effective same-device SELF for the report.
     */
    async sameDevice(rawText, sourceAccountId = "same-device-other-account") {
      await ensureUser(sourceAccountId);
      await ensurePassport(PASSPORT);
      const canonicalText = canonicalizeText(rawText);
      const representation = await createReusableDocumentRepresentation(client, { canonicalText });
      await recordCorpusShingles(client, representation.id, canonicalText);
      const decisionId = crypto.randomUUID();
      const sourceRef = buildReportAdmissionSourceRef({ accountId: sourceAccountId, deviceKey: `src-${crypto.randomUUID()}`, reportId: `src-${crypto.randomUUID()}` });
      await client.execute({
        sql: "INSERT INTO corpus_admission_decisions (id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes, dry_run) VALUES (?,?,?,?,?,?,?,?)",
        args: [decisionId, sourceRef, "v1", "ACCEPT", "[]", 1, "[]", 0],
      });
      const acceptedId = crypto.randomUUID();
      await client.execute({
        sql: "INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version) VALUES (?,?,?,?,?)",
        args: [acceptedId, decisionId, crypto.randomBytes(32).toString("hex"), 50, "corpus-shingle-v1"],
      });
      await client.execute({
        sql: "INSERT INTO corpus_admission_promotions (id, decision_id, accepted_representation_id, representation_id, link_type, fingerprint_version, status, attempt_count) VALUES (?,?,?,?,?,?,'indexed',1)",
        args: [crypto.randomUUID(), decisionId, acceptedId, representation.id, "NEW_CONTENT_REPRESENTATION", "corpus-shingle-v1"],
      });
      await client.execute({
        sql: "INSERT INTO corpus_admission_decision_device_provenance (decision_id, device_passport_id, verified_at) VALUES (?,?,?)",
        args: [decisionId, PASSPORT, Date.now()],
      });
      return representation.id;
    },
    /** A saved report of SUBMISSION by SUBMITTER, uploaded with PASSPORT. */
    async report() {
      await ensureUser(SUBMITTER);
      await ensurePassport(PASSPORT);
      const reportId = `report-${++reportSeq}`;
      const payload = JSON.stringify({ version: 11, id: reportId, submissionId: `sub-${reportId}`, title: "t.pdf", text: SUBMISSION, wordCount: WORD_COUNT, score: 0, archiveScore: 0, sources: [], repeats: [] });
      await client.execute({
        sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id, document_identity_id)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [reportId, DEVICE_KEY, `sub-${reportId}`, "t.pdf", new Date().toISOString(), WORD_COUNT, 0, "Low", payload, SUBMITTER, PASSPORT, null],
      });
      return reportId;
    },
    close() { client.close(); },
  };
}

/** The real resolution every write-capable path runs: snapshot, same-device SELF, union. */
async function resolve(client, reportId, { selfScoring }) {
  await matureCorpusBackings(client);
  return withSelfScoring(selfScoring, () =>
    resolvePrimarySimilaritySummary(client, {
      reportDeviceKey: DEVICE_KEY, reportId, accountId: SUBMITTER, rawText: SUBMISSION,
      wordCount: WORD_COUNT, archiveScore: 0, scoringNormalizationVersion: 1,
    }),
  );
}
const matchedIds = (resolution) => new Set((resolution.historicalSubmissionMatch.matches ?? []).map((m) => m.matchedRepresentationId));
async function addBlockHolders(corpus, from, to) {
  const ids = [];
  for (let k = from; k <= to; k += 1) ids.push(await corpus.index(`holder-${k}`, blockHolder(k)));
  return ids;
}
function assertNoDoubleCount(unified, label) {
  assert.equal(new Set(unified.matchedPositions).size, unified.matchedPositions.length, `${label}: no position listed twice`);
  assert.equal(unified.uniqueMatchedWords, unified.matchedPositions.length, `${label}: matched words = distinct positions`);
}
function assertCompleteThroughToCompletion(resolution) {
  assert.notEqual(resolution.historicalSubmissionMatch.partial, true);
  assert.equal(priorSubmissionBranchState(resolution.historicalSubmissionMatch), "COMPLETE");
}
function assertPartialThroughToCompletion(historicalMatch) {
  assert.equal(historicalMatch.partial, true);
  assert.equal(priorSubmissionBranchState(historicalMatch), "PARTIAL");
  assert.equal(resolveReportCompletion({ priorSubmission: priorSubmissionBranchState(historicalMatch), extraction: unknownExtractionDiagnostic() }).state, "PARTIAL");
}

// ---------------------------------------------------------------------------

test("1: same-device holder first, eligible cross-account holder second -> the block is still credited, SELF still excluded", async () => {
  const corpus = await freshCorpus();
  try {
    const self = await corpus.sameDevice(blockHolder(1000)); // first in every posting list of the block
    await corpus.index("other-account", SOURCE_X);
    const eligible = await addBlockHolders(corpus, 1, 55); // 56 holders: the block's shingles are pruned
    const reportId = await corpus.report();

    const on = await resolve(corpus.client, reportId, { selfScoring: true });
    assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [self], "the same-device holder is still an effective SELF");
    assert.ok(matchedIds(on).has(self), "it was verified");
    assert.ok(matchedIds(on).has(eligible[0]), "and the next holder was tried and verified");
    assert.equal(on.unifiedSimilarity.unifiedScore, 42);
    assert.deepEqual(on.unifiedSimilarity.matchedPositions, BLOCK_AND_PASSAGE, "block + passage, nothing from the same-device copy alone");
    assert.ok(on.unifiedSimilarity.deviceSelfExcludedWords > 0);
    assertNoDoubleCount(on.unifiedSimilarity, "flag on");
    assertCompleteThroughToCompletion(on);
  } finally { corpus.close(); }
});

test("1b: flag off computes the same coverage, and the snapshot stays right across a flag flip", async () => {
  const corpus = await freshCorpus();
  try {
    const self = await corpus.sameDevice(blockHolder(1000));
    await corpus.index("other-account", SOURCE_X);
    const eligible = await addBlockHolders(corpus, 1, 55);
    const reportId = await corpus.report();

    // Snapshot computed with the SELF flag off ...
    const off = await resolve(corpus.client, reportId, { selfScoring: false });
    assert.deepEqual(off.effectiveDeviceSelfRepresentationIds, []);
    assert.ok(matchedIds(off).has(self) && matchedIds(off).has(eligible[0]), "the eligible holder is verified even with the flag off");
    assert.deepEqual(off.unifiedSimilarity.matchedPositions, BLOCK_AND_PASSAGE);
    assertNoDoubleCount(off.unifiedSimilarity, "flag off");
    // ... then read with it on: the same snapshot already holds the eligible holder.
    const on = await resolve(corpus.client, reportId, { selfScoring: true });
    assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [self]);
    assert.deepEqual(on.unifiedSimilarity.matchedPositions, BLOCK_AND_PASSAGE);
  } finally { corpus.close(); }
});

test("1c: a same-device source the search itself found does not settle the block either", async () => {
  const corpus = await freshCorpus();
  try {
    // The same-device copy also shares un-pruned text (CHUNK_A), so the ranked
    // search verifies it before any block is resolved.
    const self = await corpus.sameDevice(`${words(100, 5001)} ${BLOCK} ${words(50, 5002)} ${CHUNK_A} ${words(100, 5003)}`);
    await corpus.index("other-account", SOURCE_X);
    const eligible = await addBlockHolders(corpus, 1, 55);
    const reportId = await corpus.report();

    const on = await resolve(corpus.client, reportId, { selfScoring: true });
    assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [self]);
    assert.ok(matchedIds(on).has(eligible[0]));
    assert.deepEqual(on.unifiedSimilarity.matchedPositions, BLOCK_AND_PASSAGE, "block credited; CHUNK_A (same-device only) is not");
    assertCompleteThroughToCompletion(on);
  } finally { corpus.close(); }
});

test("2: same-device holders only -> no score from the block, and the pass is complete", async () => {
  // (a) One same-device holder: the search finds it, SELF excludes it.
  const single = await freshCorpus();
  try {
    const self = await single.sameDevice(blockHolder(1000));
    await single.index("other-account", SOURCE_X);
    const reportId = await single.report();
    const on = await resolve(single.client, reportId, { selfScoring: true });
    assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [self]);
    assert.deepEqual(on.unifiedSimilarity.matchedPositions, PASSAGE_POSITIONS);
    assertCompleteThroughToCompletion(on);
  } finally { single.close(); }

  // (b) 56 same-device holders: pruned, every one is walked, none settles it.
  const many = await freshCorpus();
  try {
    const selves = [];
    for (let k = 1; k <= 56; k += 1) selves.push(await many.sameDevice(blockHolder(1000 + k), `same-device-account-${k}`));
    await many.index("other-account", SOURCE_X);
    const reportId = await many.report();
    const on = await resolve(many.client, reportId, { selfScoring: true });
    assert.deepEqual([...on.effectiveDeviceSelfRepresentationIds].sort(), [...selves].sort());
    assert.deepEqual(on.unifiedSimilarity.matchedPositions, PASSAGE_POSITIONS, "no position from the block");
    assertCompleteThroughToCompletion(on);

    const selfIds = new Set(selves);
    const diagnostics = {};
    const result = await matchAgainstUserSubmissionCorpus(many.client, {
      accountId: SUBMITTER, canonicalText: SUBMISSION, excludeAccountId: SUBMITTER, diagnostics,
      excludedAfterMatching: async (match) => selfIds.has(match.matchedRepresentationId),
    });
    assert.equal(diagnostics.commonBlockRuns, 1);
    assert.equal(diagnostics.commonBlockRunsRecovered, 0);
    assert.equal(diagnostics.commonBlockHoldersExcludedAfterMatching, 56, "every same-device holder was tried and none settled the block");
    assert.equal(diagnostics.stopReason, "CANDIDATES_EXHAUSTED");
    assert.notEqual(result.partial, true);
  } finally { many.close(); }
});

test("3: same-device holder plus several eligible holders -> one union, no double count", async () => {
  const corpus = await freshCorpus();
  try {
    const self = await corpus.sameDevice(`${words(100, 5001)} ${BLOCK} ${words(50, 5002)} ${CHUNK_A} ${words(100, 5003)}`);
    // An eligible holder the search finds (block + CHUNK_B), and 54 that hold only the block.
    const extra = await corpus.index("extra-account", `${words(100, 6001)} ${BLOCK} ${words(50, 6002)} ${CHUNK_B} ${words(100, 6003)}`);
    await corpus.index("other-account", SOURCE_X);
    await addBlockHolders(corpus, 1, 54);
    const reportId = await corpus.report();

    const on = await resolve(corpus.client, reportId, { selfScoring: true });
    assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [self]);
    assert.ok(matchedIds(on).has(extra));
    const expected = [...BLOCK_POSITIONS, ...PASSAGE_POSITIONS, ...range(400, 60)];
    assert.deepEqual(on.unifiedSimilarity.matchedPositions, expected, "block, passage and CHUNK_B — CHUNK_A is same-device only");
    assertNoDoubleCount(on.unifiedSimilarity, "SELF + eligible");
    assert.equal(on.unifiedSimilarity.unifiedScore, Math.round((expected.length / WORD_COUNT) * 100));
  } finally { corpus.close(); }
});

test("4: insertion order does not change the score or the positions", async () => {
  const forward = await freshCorpus();
  const reverse = await freshCorpus();
  try {
    await forward.sameDevice(blockHolder(1000));
    await forward.index("other-account", SOURCE_X);
    await addBlockHolders(forward, 1, 55);

    await reverse.index("other-account", SOURCE_X);
    for (let k = 55; k >= 1; k -= 1) await reverse.index(`holder-${k}`, blockHolder(k));
    await reverse.sameDevice(blockHolder(1000)); // last in every posting list

    const a = await resolve(forward.client, await forward.report(), { selfScoring: true });
    const b = await resolve(reverse.client, await reverse.report(), { selfScoring: true });
    assert.equal(a.unifiedSimilarity.unifiedScore, 42);
    assert.equal(b.unifiedSimilarity.unifiedScore, a.unifiedSimilarity.unifiedScore);
    assert.deepEqual(b.unifiedSimilarity.matchedPositions, a.unifiedSimilarity.matchedPositions);
  } finally { forward.close(); reverse.close(); }
});

test("5: the budget running out while looking past a same-device holder is PARTIAL, through to the report completion", async () => {
  const corpus = await freshCorpus();
  try {
    const self = await corpus.sameDevice(blockHolder(1000));
    await corpus.index("other-account", SOURCE_X);
    await addBlockHolders(corpus, 1, 55);
    const reportId = await corpus.report();
    // Loading the same-device holder's text takes longer than the whole pass
    // budget (2.5 s): once it is verified and turns out not to count, there
    // is no time left to try the next holder.
    const slow = {
      execute: async (stmt) => {
        const sql = typeof stmt === "string" ? stmt : stmt.sql;
        const args = typeof stmt === "string" ? [] : stmt.args ?? [];
        if (/canonical_text/.test(sql) && /WHERE id = \?/.test(sql) && args.includes(self)) await new Promise((resolve) => setTimeout(resolve, 3_000));
        return corpus.client.execute(stmt);
      },
      batch: (...args) => corpus.client.batch(...args),
      transaction: (...args) => corpus.client.transaction(...args),
      close: () => {},
    };
    const on = await resolve(slow, reportId, { selfScoring: true });
    assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [self]);
    assert.deepEqual(on.unifiedSimilarity.matchedPositions, PASSAGE_POSITIONS, "the block is not credited from the same-device copy");
    assertPartialThroughToCompletion(on.historicalSubmissionMatch);
  } finally { corpus.close(); }
});

test("5a: a coverage check whose device read fails once is asked again by the re-run pass -> the block is credited, complete", async () => {
  const corpus = await freshCorpus();
  try {
    const self = await corpus.sameDevice(blockHolder(1000));
    await corpus.index("other-account", SOURCE_X);
    const eligible = await addBlockHolders(corpus, 1, 55);
    const reportId = await corpus.report();
    // The report's own device provenance cannot be read the first time it is
    // asked for; nothing else fails, and nothing in the corpus changes.
    let failedReads = 0;
    const flaky = {
      execute: (stmt) => {
        const sql = typeof stmt === "string" ? stmt : stmt.sql;
        if (failedReads === 0 && /SELECT verified_device_passport_id, document_identity_id FROM saved_reports/.test(sql)) {
          failedReads += 1;
          return Promise.reject(new Error("simulated transient read failure"));
        }
        return corpus.client.execute(stmt);
      },
      batch: (...args) => corpus.client.batch(...args),
      transaction: (...args) => corpus.client.transaction(...args),
      close: () => {},
    };
    const on = await resolve(flaky, reportId, { selfScoring: true });
    assert.equal(failedReads, 1, "the first pass met the failed read");
    assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [self]);
    assert.ok(matchedIds(on).has(eligible[0]), "the re-run pass looked past the same-device holder");
    assert.equal(on.unifiedSimilarity.unifiedScore, 42);
    assert.deepEqual(on.unifiedSimilarity.matchedPositions, BLOCK_AND_PASSAGE);
    assertCompleteThroughToCompletion(on);
  } finally { corpus.close(); }
});

test("5b: a coverage check that cannot answer in time stops the pass as PARTIAL, never assuming either way", async () => {
  const corpus = await freshCorpus();
  try {
    const self = await corpus.sameDevice(blockHolder(1000));
    await corpus.index("other-account", SOURCE_X);
    await addBlockHolders(corpus, 1, 55);
    await matureCorpusBackings(corpus.client);
    let answered = false;
    // Earlier tests can leave cleanup on the event loop; let it finish first.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const diagnostics = {};
    const result = await matchAgainstUserSubmissionCorpus(corpus.client, {
      accountId: SUBMITTER, canonicalText: SUBMISSION, excludeAccountId: SUBMITTER, diagnostics, config: { matchTimeBudgetMs: 800 },
      excludedAfterMatching: async () => {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        answered = true;
        return true;
      },
    });
    assert.equal(answered, false, "the pass returned without waiting for the check");
    assert.equal(diagnostics.stopReason, "QUERY_FAILED");
    assert.equal(diagnostics.commonBlockRunsRecovered, 0, "the block was not assumed covered");
    assert.ok(result.status === "MATCHED" && result.matches.some((m) => m.matchedRepresentationId === self));
    assertPartialThroughToCompletion({ status: result.status, matches: result.matches, computedAt: "x", matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x", partial: result.partial });
  } finally { corpus.close(); }
});
