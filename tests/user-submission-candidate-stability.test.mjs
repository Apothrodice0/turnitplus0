import assert from "node:assert/strict";
import test from "node:test";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { tokens } from "../lib/similarity-core.ts";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import {
  indexDocumentSubmissionIntoCorpus,
  createReusableDocumentRepresentation,
  recordCorpusShingles,
  findCandidateCorpusRepresentations,
  corpusShingleHashes,
  CORPUS_FINGERPRINT_VERSION,
  CANONICALIZATION_VERSION,
} from "../lib/user-submission-corpus.ts";
import {
  matchAgainstUserSubmissionCorpus,
  USER_SUBMISSION_MATCH_THRESHOLDS,
  USER_SUBMISSION_CANDIDATE_PAGE_SIZE,
} from "../lib/user-submission-matching.ts";
import { getOrComputeHistoricalMatchSnapshot, getCurrentCorpusMatchGeneration, SNAPSHOT_MATCHER_VERSION } from "../lib/report-historical-match.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";

/**
 * Prior-submission candidate stability.
 *
 * The defect: the matcher took the ten highest-ranked candidate rows first
 * and worked out each one's relationship afterwards. An author's own earlier
 * drafts share almost every shingle with their new submission, so ten of
 * them filled all ten slots, were then classified SELF and excluded from the
 * score — and the one genuine cross-account source of a copied passage was
 * never verified. Adding the author's OWN documents to the corpus took the
 * score from 20 % to 0 %.
 *
 * The invariant under test: a candidate that cannot score never keeps a
 * candidate that can from being verified — however many there are, by rank
 * or by making the copied passage look common.
 *
 * Every corpus is synthetic and in memory.
 */

const priorCorpusSourceFlag = process.env.CORPUS_SOURCE_MATCHING_ENABLED;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
test.after(() => {
  if (priorCorpusSourceFlag === undefined) delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  else process.env.CORPUS_SOURCE_MATCHING_ENABLED = priorCorpusSourceFlag;
});

const drizzleDir = path.join(path.resolve("."), "drizzle");
const MAX = USER_SUBMISSION_MATCH_THRESHOLDS.maxCandidates;

async function freshCorpus() {
  const client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  await applyMigrationsLibsql(client, drizzleDir);
  const users = new Set();
  const api = {
    client,
    async ensureUser(accountId) {
      if (accountId === null || users.has(accountId)) return;
      users.add(accountId);
      await client.execute({
        sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
        args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"],
      });
    },
    /** Indexes one submission by `accountId`; returns the id of the representation it is recorded against. */
    async index(accountId, title, rawText) {
      await api.ensureUser(accountId);
      const identity = await createDocumentIdentity(client, { accountId, title, author: null, rawText });
      await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
      const row = await client.execute({ sql: "SELECT representation_id FROM corpus_submission_references WHERE document_identity_id = ?", args: [identity.id] });
      return String(row.rows[0].representation_id);
    },
    /** A representation backed only by an active admission promotion from `accountId` — a TurnitPlus corpus source. */
    async promote(accountId, rawText) {
      const canonicalText = canonicalizeText(rawText);
      const rep = await createReusableDocumentRepresentation(client, { canonicalText });
      await recordCorpusShingles(client, rep.id, canonicalText);
      const decisionId = randomUUID();
      await client.execute({
        sql: `INSERT INTO corpus_admission_decisions (id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes, dry_run) VALUES (?,?,?,?,?,?,?,?)`,
        args: [decisionId, `report-upload:account=${accountId}:device=d:report=r`, "v1", "ACCEPT", "[]", 1, "[]", 0],
      });
      const acceptedId = randomUUID();
      await client.execute({
        sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version) VALUES (?,?,?,?,?)`,
        args: [acceptedId, decisionId, randomUUID(), 50, CORPUS_FINGERPRINT_VERSION],
      });
      await client.execute({
        sql: `INSERT INTO corpus_admission_promotions (id, decision_id, accepted_representation_id, representation_id, link_type, fingerprint_version, status, attempt_count) VALUES (?,?,?,?,?,?,'indexed',1)`,
        args: [randomUUID(), decisionId, acceptedId, rep.id, "NEW_CONTENT_REPRESENTATION", CORPUS_FINGERPRINT_VERSION],
      });
      return rep.id;
    },
    mature: () => matureCorpusBackings(client),
    close() { client.close(); },
  };
  return api;
}

// Deterministic pseudo-vocabulary: every word is three syllables, none a
// common or generic-register word, so every 5-gram is informative and two
// different seeds share no passage.
const SYLLABLES = ["ka", "lo", "mi", "tre", "vun", "sor", "bel", "dra", "phi", "quen", "zor", "tal", "mer", "nix", "ost", "ula", "rin", "vek", "dom", "sha", "gri", "pol", "wex", "yun"];
function words(count, seed) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length]);
  return out.join(" ");
}

// A 600-word submission: 200 own words, a 120-word passage copied from
// another account's document, 280 own words.
const PASSAGE = words(120, 777);
const HEAD = words(200, 11);
const TAIL = words(280, 22);
const SUBMISSION = `${HEAD} ${PASSAGE} ${TAIL}`;
const SOURCE_X = `${words(250, 31)} ${PASSAGE} ${words(250, 32)}`;
const WORD_COUNT = tokens(SUBMISSION).length;
const PASSAGE_START = tokens(HEAD).length;
const PASSAGE_POSITIONS = Array.from({ length: tokens(PASSAGE).length }, (_, i) => PASSAGE_START + i);
const SUBMITTER = "submitter";

/** An earlier draft by the submitter: the whole submission plus a few different closing words — it out-ranks every other candidate. */
const ownDraft = (k) => `${SUBMISSION} ${words(20, 1000 + k)}`;

/**
 * A cross-account document sharing 24 separate 12-word fragments of the
 * submitter's own text: 192 shared 5-grams (source X shares 116), no 30-word
 * span, containment well under 0.5. It out-ranks X and FAILS verification.
 */
function fragmentDocument(seed) {
  const own = `${HEAD} ${TAIL}`.split(" ");
  const parts = [];
  for (let start = 0, k = 0; start + 12 <= own.length; start += 20, k += 1) {
    parts.push(own.slice(start, start + 12).join(" "), words(6, seed * 1000 + k));
  }
  return `${parts.join(" ")} ${words(700, seed * 7919)}`;
}

/** A cross-account document holding the first 130 words of the submission verbatim: 126 shared 5-grams, it out-ranks X and VERIFIES. */
const headBlockDocument = (seed) => `${words(200, seed * 13)} ${HEAD.split(" ").slice(0, 130).join(" ")} ${words(200, seed * 17)}`;

async function evaluate(corpus, overrides = {}) {
  const diagnostics = {};
  const result = await matchAgainstUserSubmissionCorpus(corpus.client, {
    accountId: SUBMITTER,
    canonicalText: SUBMISSION,
    excludeAccountId: SUBMITTER,
    diagnostics,
    ...overrides,
  });
  const matches = result.status === "MATCHED" ? result.matches : [];
  const unified = computeUnifiedSimilarity({ wordCount: WORD_COUNT, historicalSubmissionMatch: { status: result.status, matches } });
  return { result, matches, unified, diagnostics };
}
const entryFor = (matches, representationId) => matches.find((m) => m.matchedRepresentationId === representationId);
const relationshipCounts = (matches) => matches.reduce((counts, m) => ({ ...counts, [m.relationshipType]: (counts[m.relationshipType] ?? 0) + 1 }), {});

function assertPassageScored(evaluation, xId, label) {
  const x = entryFor(evaluation.matches, xId);
  assert.ok(x, `${label}: the cross-account source must be verified`);
  assert.equal(x.relationshipType, "PRIOR_SUBMISSION", label);
  assert.equal(x.matchedWordCount, 120, label);
  assert.equal(evaluation.unified.unifiedScore, 20, `${label}: 120 of 600 words`);
  assert.deepEqual(evaluation.unified.matchedPositions, PASSAGE_POSITIONS, `${label}: exactly the copied passage is credited — nothing else`);
  assert.notEqual(evaluation.result.partial, true, label);
}

// ---------------------------------------------------------------------------
// 1-3. The reproduced defect
// ---------------------------------------------------------------------------

test("baseline: one cross-account source holding a 120-word copied passage scores 20 %", async () => {
  const corpus = await freshCorpus();
  try {
    const xId = await corpus.index("other-account", "source-x", SOURCE_X);
    await corpus.mature();
    const evaluation = await evaluate(corpus);
    assertPassageScored(evaluation, xId, "baseline");
    assert.deepEqual(relationshipCounts(evaluation.matches), { PRIOR_SUBMISSION: 1 });
    assert.equal(evaluation.diagnostics.stopReason, "CANDIDATES_EXHAUSTED");
  } finally { corpus.close(); }
});

test("adding 10 of the submitter's own earlier drafts does not displace the cross-account source: 20 % stays 20 %", async () => {
  const corpus = await freshCorpus();
  try {
    const xId = await corpus.index("other-account", "source-x", SOURCE_X);
    await corpus.mature();
    const before = await evaluate(corpus);
    assertPassageScored(before, xId, "before the drafts");

    for (let k = 1; k <= 10; k += 1) await corpus.index(SUBMITTER, `draft-${k}`, ownDraft(k));
    await corpus.mature();

    // The ten drafts hold the first ten ranked rows; X is the eleventh.
    const ranked = await findCandidateCorpusRepresentations(corpus.client, corpusShingleHashes(SUBMISSION, 5), {
      fingerprintVersion: CORPUS_FINGERPRINT_VERSION, minSharedShingles: 3, limit: 50, excludeAccountId: SUBMITTER,
    });
    assert.equal(ranked.findIndex((c) => c.representationId === xId), 10, "test setup sanity: all ten drafts out-rank the source");

    const after = await evaluate(corpus);
    assertPassageScored(after, xId, "after 10 own drafts");
    assert.deepEqual(relationshipCounts(after.matches), { SELF: 10, PRIOR_SUBMISSION: 1 }, "the drafts are still reported as SELF, exactly as before");
    assert.deepEqual(after.unified.matchedPositions, before.unified.matchedPositions, "the corpus only grew; no verified position may be lost");
    assert.equal(after.diagnostics.rawCandidatesConsidered, 11);
    assert.equal(after.diagnostics.eligibleCandidatesConsidered, 1);
    assert.equal(after.diagnostics.candidatePagesFetched, 1, "one discovery round trip, as before");
  } finally { corpus.close(); }
});

test("adding 50 own drafts — enough to push the copied passage past the document-frequency ceiling — still leaves 20 %", async () => {
  const corpus = await freshCorpus();
  try {
    const xId = await corpus.index("other-account", "source-x", SOURCE_X);
    for (let k = 1; k <= 50; k += 1) await corpus.index(SUBMITTER, `draft-${k}`, ownDraft(k));
    await corpus.mature();

    // 50 drafts + X hold every passage shingle: 51 representations, over the
    // maxDF ceiling of 50. Counted that way the passage is pruned as "common"
    // and X shares nothing that is still searched.
    assert.equal(USER_SUBMISSION_MATCH_THRESHOLDS.maxCandidateShingleDocumentFrequency, 50);
    const discovery = { fingerprintVersion: CORPUS_FINGERPRINT_VERSION, minSharedShingles: 3, limit: 100, excludeAccountId: SUBMITTER, maxDocumentFrequency: 50 };
    const countingOwnDrafts = await findCandidateCorpusRepresentations(corpus.client, corpusShingleHashes(SUBMISSION, 5), discovery);
    assert.ok(!countingOwnDrafts.some((c) => c.representationId === xId), "test setup sanity: with the requester's own drafts counted, the source is pruned out of discovery");
    const notCountingOwnDrafts = await findCandidateCorpusRepresentations(corpus.client, corpusShingleHashes(SUBMISSION, 5), { ...discovery, requesterAccountId: SUBMITTER });
    assert.ok(notCountingOwnDrafts.some((c) => c.representationId === xId), "the requester's own drafts do not count toward document frequency");
    assert.equal(notCountingOwnDrafts.length, 51, "and they are all still candidates — only the frequency count changed");

    const evaluation = await evaluate(corpus);
    assertPassageScored(evaluation, xId, "after 50 own drafts");
    assert.deepEqual(relationshipCounts(evaluation.matches), { SELF: MAX, PRIOR_SUBMISSION: 1 });
    assert.equal(evaluation.diagnostics.rawCandidatesConsidered, 51);
    assert.equal(evaluation.diagnostics.candidatesVerified, MAX + 1, "only the SELF budget's worth of drafts is ever loaded and compared");

    // Another account is not the requester: for it the same 51 documents are
    // ordinary evidence that the passage is widely held, and pruning applies.
    const otherReader = await matchAgainstUserSubmissionCorpus(corpus.client, { accountId: "third-account", canonicalText: PASSAGE });
    assert.equal(otherReader.status, "MATCHED", "sanity: the passage is matchable for an unrelated reader through the low-information fallback");
  } finally { corpus.close(); }
});

test("the candidate list is read to its end, a page at a time: the result does not depend on the page size", async () => {
  const corpus = await freshCorpus();
  try {
    const xId = await corpus.index("other-account", "source-x", SOURCE_X);
    for (let k = 1; k <= 30; k += 1) await corpus.index(SUBMITTER, `draft-${k}`, ownDraft(k));
    await corpus.mature();

    const onePage = await evaluate(corpus);
    const smallPages = await evaluate(corpus, { config: { candidatePageSize: 7 } });
    assert.ok(USER_SUBMISSION_CANDIDATE_PAGE_SIZE > 31);
    assert.equal(onePage.diagnostics.candidatePagesFetched, 1);
    assert.equal(smallPages.diagnostics.candidatePagesFetched, 5, "31 candidates at 7 per page");
    assertPassageScored(smallPages, xId, "X sits on the fifth page of seven");
    assert.deepEqual(smallPages.result, onePage.result, "same candidates, same order, same result");
    assert.equal(smallPages.diagnostics.rawCandidatesConsidered, 31);
  } finally { corpus.close(); }
});

// ---------------------------------------------------------------------------
// 4. Eligible candidates
// ---------------------------------------------------------------------------

test("eligible candidates that fail verification, ranked above the source, do not displace it", async () => {
  const corpus = await freshCorpus();
  try {
    const xId = await corpus.index("other-account", "source-x", SOURCE_X);
    for (let k = 1; k <= 12; k += 1) await corpus.index(`fragment-account-${k}`, `fragment-${k}`, fragmentDocument(k));
    await corpus.mature();

    const ranked = await findCandidateCorpusRepresentations(corpus.client, corpusShingleHashes(SUBMISSION, 5), {
      fingerprintVersion: CORPUS_FINGERPRINT_VERSION, minSharedShingles: 3, limit: 50, excludeAccountId: SUBMITTER,
    });
    assert.equal(ranked.findIndex((c) => c.representationId === xId), 12, "test setup sanity: twelve cross-account documents out-rank the source");

    const evaluation = await evaluate(corpus);
    assertPassageScored(evaluation, xId, "after 12 higher-ranked failing candidates");
    assert.deepEqual(relationshipCounts(evaluation.matches), { PRIOR_SUBMISSION: 1 }, "the twelve fragment documents were compared and rejected");
    assert.equal(evaluation.diagnostics.eligibleCandidatesConsidered, 13);
    assert.equal(evaluation.diagnostics.candidatesVerified, 13);
    assert.equal(evaluation.diagnostics.stopReason, "CANDIDATES_EXHAUSTED");
  } finally { corpus.close(); }
});

test("a time budget that stops the pass early is reported as partial, never as a finished result", async () => {
  const corpus = await freshCorpus();
  try {
    await corpus.index("other-account", "source-x", SOURCE_X);
    for (let k = 1; k <= 12; k += 1) await corpus.index(`fragment-account-${k}`, `fragment-${k}`, fragmentDocument(k));
    await corpus.mature();
    const evaluation = await evaluate(corpus, { config: { matchTimeBudgetMs: 0 } });
    assert.equal(evaluation.result.status, "NO_HISTORICAL_MATCH");
    assert.equal(evaluation.result.partial, true);
    assert.equal(evaluation.diagnostics.stopReason, "TIME_BUDGET");
    assert.equal(evaluation.diagnostics.candidatesVerified, 0);
  } finally { corpus.close(); }
});

test("the one remaining rank cut: once maxCandidates scoring sources have verified, lower-ranked candidates are not read — and the diagnostics say so", async () => {
  const corpus = await freshCorpus();
  try {
    const xId = await corpus.index("other-account", "source-x", SOURCE_X);
    for (let k = 1; k <= MAX; k += 1) await corpus.index(`block-account-${k}`, `block-${k}`, headBlockDocument(k));
    await corpus.mature();
    const evaluation = await evaluate(corpus);
    assert.deepEqual(relationshipCounts(evaluation.matches), { PRIOR_SUBMISSION: MAX });
    assert.equal(entryFor(evaluation.matches, xId), undefined, "the eleventh verified source is below the cut");
    assert.equal(evaluation.diagnostics.stopReason, "SCORING_BUDGET_FULL", "this is where a truncation signal for the report has to originate");
    assert.notEqual(evaluation.result.partial, true, "not partial: recomputing would give the same answer");
  } finally { corpus.close(); }
});

// ---------------------------------------------------------------------------
// 5-7. Semantics that must not move
// ---------------------------------------------------------------------------

test("SELF sources never contribute evidence, and SELF drafts beyond their own budget are not even loaded", async () => {
  const corpus = await freshCorpus();
  try {
    for (let k = 1; k <= 15; k += 1) await corpus.index(SUBMITTER, `draft-${k}`, ownDraft(k));
    await corpus.mature();
    const evaluation = await evaluate(corpus);
    assert.equal(evaluation.result.status, "MATCHED");
    assert.deepEqual(relationshipCounts(evaluation.matches), { SELF: MAX });
    assert.equal(evaluation.unified.unifiedScore, 0);
    assert.deepEqual(evaluation.unified.matchedPositions, []);
    assert.ok(evaluation.unified.selfExcludedWords > 0, "the SELF matches are tallied as excluded, as before");
    assert.equal(evaluation.diagnostics.rawCandidatesConsidered, 15);
    assert.equal(evaluation.diagnostics.eligibleCandidatesConsidered, 0);
    assert.equal(evaluation.diagnostics.candidatesVerified, MAX);
  } finally { corpus.close(); }
});

test("a representation the submitter AND another account both submitted is still SELF (SELF priority unchanged)", async () => {
  const corpus = await freshCorpus();
  try {
    const sharedId = await corpus.index("other-account", "shared", SOURCE_X);
    assert.equal(await corpus.index(SUBMITTER, "shared-again", SOURCE_X), sharedId, "test setup sanity: an exact duplicate reuses the representation");
    await corpus.mature();
    const evaluation = await evaluate(corpus);
    assert.equal(entryFor(evaluation.matches, sharedId).relationshipType, "SELF");
    assert.equal(entryFor(evaluation.matches, sharedId).historicalSubmissionCount, 1);
    assert.equal(evaluation.unified.unifiedScore, 0);
  } finally { corpus.close(); }
});

test("the 7-day maturity rule is unchanged: an immature source is not a candidate, with or without mature own drafts around it", async () => {
  const corpus = await freshCorpus();
  try {
    for (let k = 1; k <= 10; k += 1) await corpus.index(SUBMITTER, `draft-${k}`, ownDraft(k));
    await corpus.mature();
    const xId = await corpus.index("other-account", "source-x", SOURCE_X); // indexed now — immature

    const now = new Date();
    const immature = await evaluate(corpus, { asOf: now });
    assert.deepEqual(relationshipCounts(immature.matches), { SELF: 10 });
    assert.equal(entryFor(immature.matches, xId), undefined);
    assert.equal(immature.unified.unifiedScore, 0);
    assert.equal(immature.diagnostics.rawCandidatesConsidered, 10, "the immature source never reaches the candidate list");

    const sixDaysOn = await evaluate(corpus, { asOf: new Date(now.getTime() + 6 * 86_400_000) });
    assert.equal(entryFor(sixDaysOn.matches, xId), undefined, "still inside the 7-day window");

    const eightDaysOn = await evaluate(corpus, { asOf: new Date(now.getTime() + 8 * 86_400_000) });
    assertPassageScored(eightDaysOn, xId, "8 days after the source was indexed");
  } finally { corpus.close(); }
});

test("a legitimate cross-account exact duplicate is found first, whatever else ties with it", async () => {
  const corpus = await freshCorpus();
  try {
    const exactId = await corpus.index("other-account", "the same paper", SUBMISSION);
    // Twelve own drafts contain the whole submission, so they share exactly as
    // many shingles with it as the exact duplicate does.
    for (let k = 1; k <= 12; k += 1) await corpus.index(SUBMITTER, `draft-${k}`, ownDraft(k));
    await corpus.mature();
    const evaluation = await evaluate(corpus);
    const exact = entryFor(evaluation.matches, exactId);
    assert.equal(exact.relationshipType, "PRIOR_SUBMISSION");
    assert.equal(exact.matchType, "EXACT_CANONICAL_MATCH");
    assert.equal(evaluation.matches[0], exact, "exact match sorts first");
    assert.equal(evaluation.unified.unifiedScore, 100);
  } finally { corpus.close(); }
});

test("UNKNOWN_RELATIONSHIP is unchanged for an anonymous reader, and cannot displace a TurnitPlus corpus source", async () => {
  const corpus = await freshCorpus();
  try {
    const corpusSourceId = await corpus.promote("promoting-account", SOURCE_X);
    for (let k = 1; k <= 12; k += 1) await corpus.index(`block-account-${k}`, `block-${k}`, headBlockDocument(k));
    await corpus.mature();

    const evaluation = await evaluate(corpus, { accountId: null, excludeAccountId: undefined });
    assert.deepEqual(relationshipCounts(evaluation.matches), { UNKNOWN_RELATIONSHIP: MAX, TURNITPLUS_CORPUS_SOURCE: 1 }, "twelve higher-ranked submissions are UNKNOWN for an anonymous reader; only their budget's worth is reported");
    assert.equal(entryFor(evaluation.matches, corpusSourceId).relationshipType, "TURNITPLUS_CORPUS_SOURCE");
    assert.deepEqual(evaluation.unified.matchedPositions, PASSAGE_POSITIONS, "UNKNOWN_RELATIONSHIP never scores; the corpus source does");
  } finally { corpus.close(); }
});

// ---------------------------------------------------------------------------
// 8. Determinism
// ---------------------------------------------------------------------------

test("candidate order is total: equal shared-shingle counts are ordered by representation id, and offset windows tile the list", async () => {
  const corpus = await freshCorpus();
  try {
    // Fourteen cross-account documents holding the SAME 130-word block: all
    // tie on shared shingles.
    const ids = [];
    for (let k = 1; k <= 14; k += 1) ids.push(await corpus.index(`block-account-${k}`, `block-${k}`, headBlockDocument(k)));
    await corpus.mature();
    const shingles = corpusShingleHashes(SUBMISSION, 5);
    const options = { fingerprintVersion: CORPUS_FINGERPRINT_VERSION, minSharedShingles: 3, excludeAccountId: SUBMITTER };

    const all = await findCandidateCorpusRepresentations(corpus.client, shingles, { ...options, limit: 100 });
    assert.equal(all.length, 14);
    assert.equal(new Set(all.map((c) => c.sharedShingleCount)).size, 1, "test setup sanity: every candidate ties");
    assert.deepEqual(all.map((c) => c.representationId), [...ids].sort(), "ties are broken by representation id, not by row or insertion order");

    const windows = [];
    for (let offset = 0; offset < 20; offset += 4) {
      windows.push(...await findCandidateCorpusRepresentations(corpus.client, shingles, { ...options, limit: 4, offset, omitContainment: true }));
    }
    assert.deepEqual(windows.map((c) => c.representationId), all.map((c) => c.representationId), "successive windows are disjoint and enumerate every candidate once, in the same order");

    // The matcher's own result is identical run to run and across page sizes.
    const first = await evaluate(corpus);
    const second = await evaluate(corpus);
    const paged = await evaluate(corpus, { config: { candidatePageSize: 3 } });
    assert.deepEqual(second.result, first.result);
    assert.deepEqual(paged.result, first.result);
    assert.deepEqual(first.matches.map((m) => m.matchedRepresentationId), [...ids].sort().slice(0, MAX), "the ten verified are the ten lowest ids among the tie");
  } finally { corpus.close(); }
});

// ---------------------------------------------------------------------------
// 10. Stored reports
// ---------------------------------------------------------------------------

test("stored snapshots are not recomputed: the snapshot tag's inputs are untouched and a version-current row is served as stored", async () => {
  // lib/report-historical-match.ts digests USER_SUBMISSION_MATCH_THRESHOLDS
  // into every snapshot's matcher_version. This change adds no key to that
  // object and changes no value in it, so no stored row is invalidated.
  assert.equal(USER_SUBMISSION_MATCH_THRESHOLDS.maxCandidates, 10);
  assert.ok(!("candidatePageSize" in USER_SUBMISSION_MATCH_THRESHOLDS));

  const corpus = await freshCorpus();
  try {
    const xId = await corpus.index("other-account", "source-x", SOURCE_X);
    for (let k = 1; k <= 10; k += 1) await corpus.index(SUBMITTER, `draft-${k}`, ownDraft(k));
    await corpus.mature();
    const saveReport = (deviceKey, reportId) => corpus.client.execute({
      sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: [reportId, deviceKey, `sub-${reportId}`, "Fixture Report", new Date().toISOString(), WORD_COUNT, 0, "Low", "{}", SUBMITTER],
    });

    // A report whose snapshot was stored earlier, complete and current.
    await saveReport("device-stored", "report-stored");
    const storedComputedAt = new Date(Date.now() - 60_000).toISOString();
    await corpus.client.execute({
      sql: `INSERT INTO report_historical_match_snapshots
              (report_device_key, report_id, status, matcher_version, fingerprint_version, canonicalization_version, result_json, candidate_count, processing_duration_ms, error_message, computed_at, is_partial, corpus_generation, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
      args: ["device-stored", "report-stored", "NO_HISTORICAL_MATCH", SNAPSHOT_MATCHER_VERSION, CORPUS_FINGERPRINT_VERSION, CANONICALIZATION_VERSION, null, null, 7, null, storedComputedAt, 0, await getCurrentCorpusMatchGeneration(corpus.client)],
    });
    const stored = await getOrComputeHistoricalMatchSnapshot(corpus.client, { reportDeviceKey: "device-stored", reportId: "report-stored", accountId: SUBMITTER, rawText: SUBMISSION, excludeAccountId: SUBMITTER });
    assert.equal(stored.status, "NO_HISTORICAL_MATCH", "the stored result is returned as stored");
    assert.equal(stored.computedAt, storedComputedAt, "and was not recomputed");

    // A report with no stored snapshot gets the corrected computation.
    await saveReport("device-fresh", "report-fresh");
    const fresh = await getOrComputeHistoricalMatchSnapshot(corpus.client, { reportDeviceKey: "device-fresh", reportId: "report-fresh", accountId: SUBMITTER, rawText: SUBMISSION, excludeAccountId: SUBMITTER });
    assert.equal(fresh.status, "MATCHED");
    assert.equal(fresh.matcherVersion, SNAPSHOT_MATCHER_VERSION);
    assert.equal(entryFor(fresh.matches, xId).relationshipType, "PRIOR_SUBMISSION");
    assert.notEqual(fresh.partial, true);
  } finally { corpus.close(); }
});
