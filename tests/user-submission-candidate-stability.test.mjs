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
  USER_SUBMISSION_MATCHER_VERSION,
} from "../lib/user-submission-matching.ts";
import {
  getOrComputeHistoricalMatchSnapshot,
  getPersistedHistoricalMatchSnapshot,
  isHistoricalMatchSnapshotCurrent,
  getCurrentCorpusMatchGeneration,
  SNAPSHOT_MATCHER_VERSION,
} from "../lib/report-historical-match.ts";
import { resolvePersistedSimilarityDisplay, resolvePrimarySimilaritySummary, selfHealUnifiedSimilarity } from "../lib/report-primary-similarity.ts";
import { DEVICE_PASSPORT_ALGORITHM } from "../lib/device-passport-server.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";

/**
 * Prior-submission candidate stability.
 *
 * Two defects, one shape — the corpus grew and the score fell:
 *
 *  1. The matcher took the ten highest-ranked candidate rows first and worked
 *     out each one's relationship afterwards. An author's own earlier drafts
 *     share almost every shingle with their new submission, so ten of them
 *     filled all ten slots, were then classified SELF and excluded from the
 *     score — and the one genuine cross-account source of a copied passage
 *     was never verified. Adding the author's OWN documents took 20 % to 0 %.
 *
 *  2. At most ten VERIFIED scoring sources were kept. A source plus nine
 *     documents sharing another block scored 42 %; a tenth such document
 *     pushed the source out and took it to 22 %.
 *
 * The invariants under test: a candidate that cannot score never keeps a
 * candidate that can from being verified; every verified scoring source the
 * pass reaches contributes its positions to the union, however many there
 * are; and a pass that could not verify everything it discovered says so.
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
    async ensurePassport(passportId) {
      await client.execute({
        sql: "INSERT OR IGNORE INTO device_passports (id, public_key_spki, algorithm, created_at, provenance_generation) VALUES (?,?,?,?,0)",
        args: [passportId, Buffer.from(`spki-${passportId}`), DEVICE_PASSPORT_ALGORITHM, Date.now()],
      });
    },
    /** A representation backed only by an active admission promotion from `accountId` — a TurnitPlus corpus source. `passportId` records the verified device that backing was made on. */
    async promote(accountId, rawText, { passportId = null } = {}) {
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
      if (passportId) {
        await api.ensurePassport(passportId);
        await client.execute({
          sql: "INSERT INTO corpus_admission_decision_device_provenance (decision_id, device_passport_id, verified_at) VALUES (?,?,?)",
          args: [decisionId, passportId, Date.now()],
        });
      }
      return rep.id;
    },
    /** A representation nobody submitted and nothing promoted — eligible for discovery, never reportable to a signed-in reader. */
    async legacy(rawText) {
      const canonicalText = canonicalizeText(rawText);
      const rep = await createReusableDocumentRepresentation(client, { canonicalText });
      await recordCorpusShingles(client, rep.id, canonicalText);
      return rep.id;
    },
    /** A saved report of the submission by the submitter. `payload` becomes its payload_json; `passportId` is the verified device it was uploaded from. */
    async saveReport(deviceKey, reportId, payload = {}, passportId = null) {
      await api.ensureUser(SUBMITTER);
      if (passportId) await api.ensurePassport(passportId);
      await client.execute({
        sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        args: [reportId, deviceKey, `sub-${reportId}`, "Fixture Report", new Date().toISOString(), WORD_COUNT, 0, "Low", JSON.stringify(payload), SUBMITTER, passportId],
      });
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
const HEAD_BLOCK_POSITIONS = Array.from({ length: 130 }, (_, i) => i);

/**
 * Twelve cross-account documents, each holding a DIFFERENT 40-word slice of
 * the submitter's own text (HEAD + TAIL = 480 words = 12 slices). Each
 * verifies on its own; together with source X they cover all 600 words.
 */
const OWN_TEXT_WORDS = `${HEAD} ${TAIL}`.split(" ");
const SLICE_COUNT = 12;
const sliceDocument = (k) => `${words(150, 9000 + k)} ${OWN_TEXT_WORDS.slice(k * 40, k * 40 + 40).join(" ")} ${words(150, 9500 + k)}`;
const ALL_POSITIONS = Array.from({ length: WORD_COUNT }, (_, i) => i);
const sortedUnique = (positions) => [...new Set(positions)].sort((a, b) => a - b);
/** Every position credited exactly once: the union is a set, never a sum. */
function assertNoDoubleCount(unified, label) {
  assert.equal(new Set(unified.matchedPositions).size, unified.matchedPositions.length, `${label}: no position listed twice`);
  assert.equal(unified.uniqueMatchedWords, unified.matchedPositions.length, `${label}: matched words = distinct positions`);
}

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

test("an oversized scoring candidate cannot be verified, so the result is partial; an oversized SELF candidate changes nothing", async () => {
  const corpus = await freshCorpus();
  try {
    const xId = await corpus.index("other-account", "source-x", SOURCE_X);
    const secondSourceId = await corpus.index("second-account", "second-source", `${words(300, 41)} ${PASSAGE} ${words(300, 42)}`);
    const draftId = await corpus.index(SUBMITTER, "draft", ownDraft(1));
    await corpus.mature();
    const inflate = (id) => corpus.client.execute({ sql: "UPDATE corpus_document_representations SET word_count = 999999 WHERE id = ?", args: [id] });

    await inflate(draftId);
    const selfOversized = await evaluate(corpus);
    assert.notEqual(selfOversized.result.partial, true, "a SELF candidate that is never compared cannot change the score — not partial");
    assert.equal(selfOversized.diagnostics.oversizedScoringCandidatesSkipped, 0);
    assert.equal(selfOversized.unified.unifiedScore, 20);

    await inflate(secondSourceId);
    const scoringOversized = await evaluate(corpus);
    assert.equal(scoringOversized.result.partial, true, "a discovered scoring candidate went unverified — the score is a lower bound and must say so");
    assert.equal(scoringOversized.diagnostics.oversizedScoringCandidatesSkipped, 1);
    assert.equal(scoringOversized.diagnostics.stopReason, "CANDIDATES_EXHAUSTED", "the pass itself still read every candidate");
    assert.ok(entryFor(scoringOversized.matches, xId), "what could be verified is still reported");
    assert.equal(entryFor(scoringOversized.matches, secondSourceId), undefined);
  } finally { corpus.close(); }
});

// ---------------------------------------------------------------------------
// The verified-source cap: adding a verified source never lowers the score
// ---------------------------------------------------------------------------

test("the verified-source cap is gone: a source plus 9, 10 and 30 documents sharing another block all score 42 %", async () => {
  const corpus = await freshCorpus();
  try {
    const xId = await corpus.index("other-account", "source-x", SOURCE_X);
    let blocks = 0;
    const growTo = async (count) => {
      for (; blocks < count; blocks += 1) await corpus.index(`block-account-${blocks + 1}`, `block-${blocks + 1}`, headBlockDocument(blocks + 1));
      await corpus.mature();
      return evaluate(corpus);
    };
    const expectedPositions = sortedUnique([...HEAD_BLOCK_POSITIONS, ...PASSAGE_POSITIONS]);

    const nine = await growTo(9);
    assert.equal(nine.unified.unifiedScore, 42, "250 of 600 words");
    assert.deepEqual(nine.unified.matchedPositions, expectedPositions);

    // The tenth block document used to be the tenth verified source: X, the
    // eleventh, was never read and the score fell to 22 %.
    const ten = await growTo(10);
    assert.ok(entryFor(ten.matches, xId), "the source is still verified");
    assert.equal(ten.unified.unifiedScore, 42);
    assert.deepEqual(ten.unified.matchedPositions, expectedPositions, "no verified position is lost");
    assert.deepEqual(relationshipCounts(ten.matches), { PRIOR_SUBMISSION: 11 });
    assert.equal(ten.diagnostics.verifiedScoringSources, 11);
    assert.equal(ten.diagnostics.stopReason, "CANDIDATES_EXHAUSTED");
    assert.notEqual(ten.result.partial, true);

    const thirty = await growTo(30);
    assert.equal(thirty.unified.unifiedScore, 42);
    assert.deepEqual(thirty.unified.matchedPositions, expectedPositions);
    assert.equal(thirty.diagnostics.verifiedScoringSources, 31);
    assertNoDoubleCount(thirty.unified, "31 overlapping sources");
    assert.notEqual(thirty.result.partial, true, "an exhausted pass is complete, however many sources verified");
  } finally { corpus.close(); }
});

test("a verified source covering positions already matched leaves the score unchanged; one covering new positions raises it", async () => {
  const corpus = await freshCorpus();
  try {
    await corpus.index("other-account", "source-x", SOURCE_X);
    await corpus.mature();
    const base = await evaluate(corpus);
    assert.equal(base.unified.unifiedScore, 20);

    // A second account's document holding the SAME passage: old positions.
    await corpus.index("second-account", "second-source", `${words(300, 41)} ${PASSAGE} ${words(300, 42)}`);
    await corpus.mature();
    const samePositions = await evaluate(corpus);
    assert.deepEqual(relationshipCounts(samePositions.matches), { PRIOR_SUBMISSION: 2 });
    assert.equal(samePositions.unified.unifiedScore, 20, "two sources of one passage are one passage, not two");
    assert.deepEqual(samePositions.unified.matchedPositions, PASSAGE_POSITIONS);
    assertNoDoubleCount(samePositions.unified, "two sources, same passage");

    // A third account's document holding a different block: new positions.
    await corpus.index("third-account", "third-source", headBlockDocument(1));
    await corpus.mature();
    const newPositions = await evaluate(corpus);
    assert.equal(newPositions.unified.unifiedScore, 42);
    assert.deepEqual(newPositions.unified.matchedPositions, sortedUnique([...HEAD_BLOCK_POSITIONS, ...PASSAGE_POSITIONS]));
    assertNoDoubleCount(newPositions.unified, "three sources");
    for (const position of base.unified.matchedPositions) assert.ok(newPositions.unified.matchedPositions.includes(position), "every earlier position is still credited");
  } finally { corpus.close(); }
});

test("more than ten verified sources all reach the union, in whatever order they were added", async () => {
  // Thirteen sources: X holds the passage, twelve documents each hold a
  // different 40-word slice of the rest. Together they cover every word.
  async function build(order) {
    const corpus = await freshCorpus();
    for (const step of order) {
      if (step === "x") await corpus.index("other-account", "source-x", SOURCE_X);
      else await corpus.index(`slice-account-${step}`, `slice-${step}`, sliceDocument(step));
    }
    await corpus.mature();
    return corpus;
  }
  const slices = Array.from({ length: SLICE_COUNT }, (_, k) => k);
  const forward = await build(["x", ...slices]);
  const reversed = await build([...slices].reverse().concat("x"));
  try {
    const a = await evaluate(forward);
    assert.deepEqual(relationshipCounts(a.matches), { PRIOR_SUBMISSION: 13 });
    assert.equal(a.diagnostics.verifiedScoringSources, 13);
    assert.equal(a.unified.unifiedScore, 100, "ten sources would have covered 480 of 600 words");
    assert.deepEqual(a.unified.matchedPositions, ALL_POSITIONS);
    assertNoDoubleCount(a.unified, "13 sources");
    assert.equal(a.diagnostics.stopReason, "CANDIDATES_EXHAUSTED");
    assert.notEqual(a.result.partial, true);

    // The twelve slice documents tie on shared shingles, and representation
    // ids are random — so the two corpora rank them differently.
    const b = await evaluate(reversed);
    assert.equal(b.unified.unifiedScore, a.unified.unifiedScore);
    assert.deepEqual(b.unified.matchedPositions, a.unified.matchedPositions, "insertion and tie order cannot change a complete score");
    assert.equal(b.matches.length, a.matches.length);
  } finally { forward.close(); reversed.close(); }
});

test("a display limit is applied after scoring: the stored snapshot holds every verified source and the headline comes from all of them", async () => {
  const corpus = await freshCorpus();
  try {
    await corpus.index("other-account", "source-x", SOURCE_X);
    for (let k = 0; k < SLICE_COUNT; k += 1) await corpus.index(`slice-account-${k}`, `slice-${k}`, sliceDocument(k));
    await corpus.mature();
    await corpus.saveReport("device-display", "report-display");
    const snapshot = await getOrComputeHistoricalMatchSnapshot(corpus.client, { reportDeviceKey: "device-display", reportId: "report-display", accountId: SUBMITTER, rawText: SUBMISSION, excludeAccountId: SUBMITTER });
    assert.equal(snapshot.status, "MATCHED");
    assert.equal(snapshot.matches.length, 13, "nothing is cut before the snapshot is stored");
    assert.notEqual(snapshot.partial, true);

    const headline = computeUnifiedSimilarity({ wordCount: WORD_COUNT, historicalSubmissionMatch: snapshot });
    assert.equal(headline.unifiedScore, 100);
    assert.deepEqual(headline.matchedPositions, ALL_POSITIONS);

    // What the admin report view lists (components/report/similarity-report-papers.tsx:
    // `matches.slice(0, 5)`) is a slice of this result. Scoring that slice instead
    // would lose evidence — which is exactly why the slice is never a scoring input.
    const listed = { ...snapshot, matches: snapshot.matches.slice(0, 5) };
    assert.ok(computeUnifiedSimilarity({ wordCount: WORD_COUNT, historicalSubmissionMatch: listed }).unifiedScore < 100);
  } finally { corpus.close(); }
});

test("candidates that are never reportable (no real ownership) ranked above the source do not lower the score", async () => {
  const corpus = await freshCorpus();
  try {
    const xId = await corpus.index("other-account", "source-x", SOURCE_X);
    await corpus.mature();
    const before = await evaluate(corpus);
    for (let k = 1; k <= 15; k += 1) await corpus.legacy(ownDraft(100 + k));
    await corpus.mature();
    const after = await evaluate(corpus);
    assertPassageScored(after, xId, "after 15 unowned representations");
    assert.deepEqual(after.unified.matchedPositions, before.unified.matchedPositions);
    assert.deepEqual(relationshipCounts(after.matches), { PRIOR_SUBMISSION: 1 });
    assert.equal(after.diagnostics.rawCandidatesConsidered, 16);
    assert.equal(after.diagnostics.candidatesVerified, 1, "an unowned representation is never loaded");
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
    assert.deepEqual(first.matches.map((m) => m.matchedRepresentationId), [...ids].sort(), "all fourteen verify and are reported, in id order among the tie");
  } finally { corpus.close(); }
});

// ---------------------------------------------------------------------------
// Device SELF: decided after the matcher, so it must see every scoring source
// ---------------------------------------------------------------------------

test("device SELF: every same-device scoring source is excluded, however many verify, and an independent source still scores", async () => {
  const corpus = await freshCorpus();
  const originalFlag = process.env.DEVICE_PASSPORT_SELF_ENABLED;
  process.env.DEVICE_PASSPORT_SELF_ENABLED = "true";
  try {
    const PASSPORT = "passport-of-this-report";
    await corpus.index("other-account", "source-x", SOURCE_X);
    // Thirty near-copies of the submission, each admitted to the corpus from
    // the SAME verified device the report is uploaded from: scoring sources for
    // the matcher (TURNITPLUS_CORPUS_SOURCE), effective SELF for the score.
    const sameDeviceIds = [];
    for (let k = 1; k <= 30; k += 1) sameDeviceIds.push(await corpus.promote(`earlier-account-${k}`, ownDraft(200 + k), { passportId: PASSPORT }));
    await corpus.mature();
    await corpus.saveReport("device-self", "report-self", { text: SUBMISSION, wordCount: WORD_COUNT }, PASSPORT);

    const resolution = await resolvePrimarySimilaritySummary(corpus.client, {
      reportDeviceKey: "device-self", reportId: "report-self", accountId: SUBMITTER, rawText: SUBMISSION, wordCount: WORD_COUNT, archiveScore: 0, scoringNormalizationVersion: 1,
    });
    assert.equal(resolution.historicalSubmissionMatch.matches.length, 31, "all thirty verify as corpus sources, plus the independent one");
    assert.deepEqual([...resolution.effectiveDeviceSelfRepresentationIds].sort(), [...sameDeviceIds].sort(), "every one of the thirty is classified — there is no ceiling past which a same-device source is scored unchecked");
    assert.equal(resolution.unifiedSimilarity.unifiedScore, 20, "only the independent cross-account source scores");
    assert.deepEqual(resolution.unifiedSimilarity.matchedPositions, PASSAGE_POSITIONS);
    assert.ok(resolution.unifiedSimilarity.deviceSelfExcludedWords > 0);
  } finally {
    if (originalFlag === undefined) delete process.env.DEVICE_PASSPORT_SELF_ENABLED;
    else process.env.DEVICE_PASSPORT_SELF_ENABLED = originalFlag;
    corpus.close();
  }
});

// ---------------------------------------------------------------------------
// Matcher version: what the v1 -> v2 bump does to stored snapshots and reports
// ---------------------------------------------------------------------------

test("matcher version: a snapshot written by the v1 matcher is never reused — a plain read shows it as stored, a write-capable resolution recomputes and retags it", async () => {
  // The tag the v1 matcher actually wrote on every v1-normalization snapshot
  // row (read off origin/main 10e57bf and 25211b7). The matcher label sits
  // inside the digested thresholds object too, so the bump moves both the
  // label segment and the cfg digest.
  const V1_TAG = "user-submission-match-v1+pos.raw-token-v1+cfg.f371a81a8c59";
  // ...and the tag the v2 matcher (91b67ee, f046e24) wrote.
  const V2_TAG = "user-submission-match-v2+pos.raw-token-v1+cfg.bfa3e3fa3030";
  assert.equal(USER_SUBMISSION_MATCHER_VERSION, "user-submission-match-v3");
  assert.match(SNAPSHOT_MATCHER_VERSION, /^user-submission-match-v3\+pos\.raw-token-v1\+cfg\.[0-9a-f]{12}$/);
  assert.notEqual(SNAPSHOT_MATCHER_VERSION, V1_TAG);
  assert.notEqual(SNAPSHOT_MATCHER_VERSION, V2_TAG);

  const corpus = await freshCorpus();
  const { client } = corpus;
  try {
    const xId = await corpus.index("other-account", "source-x", SOURCE_X);
    for (let k = 1; k <= 10; k += 1) await corpus.index(`block-account-${k}`, `block-${k}`, headBlockDocument(k));
    await corpus.mature();

    // What the v1 matcher stored for this report: the ten block documents, with
    // the source cut off as the eleventh verified one — 22 %.
    const complete = await evaluate(corpus);
    const v1Matches = complete.matches
      .filter((m) => m.matchedRepresentationId !== xId)
      .map((m) => ({
        relationshipType: m.relationshipType,
        matchedRepresentationId: m.matchedRepresentationId,
        matchType: m.matchType,
        containment: m.containment,
        matchedWordCount: m.matchedWordCount,
        passageCount: m.passageCount,
        longestMatchWords: m.longestMatchWords,
        passages: m.passages.map((p) => ({ submittedText: p.submittedText, submittedWordStart: p.submittedWordStart, submittedWordEnd: p.submittedWordEnd, matchedWordCount: p.matchedWordCount })),
        historicalSubmissionCount: m.historicalSubmissionCount,
      }));
    assert.equal(v1Matches.length, 10);
    const v1Unified = computeUnifiedSimilarity({ wordCount: WORD_COUNT, historicalSubmissionMatch: { status: "MATCHED", matches: v1Matches } });
    assert.equal(v1Unified.unifiedScore, 22);

    const report = { reportDeviceKey: "device-v1", reportId: "report-v1" };
    const generation = await getCurrentCorpusMatchGeneration(client);
    await corpus.saveReport(report.reportDeviceKey, report.reportId, {
      title: "Fixture Report",
      text: SUBMISSION,
      wordCount: WORD_COUNT,
      score: 0,
      archiveScore: 0,
      archiveMatchedPositions: [],
      unifiedSimilarity: v1Unified,
      unifiedSimilarityGeneration: generation,
      corpusSourceMatchingEnabledAtComputation: true,
      aiAnalysis: { marker: "not owned by a similarity refresh" },
    });
    const storedComputedAt = new Date(Date.now() - 60_000).toISOString();
    await client.execute({
      sql: `INSERT INTO report_historical_match_snapshots
              (report_device_key, report_id, status, matcher_version, fingerprint_version, canonicalization_version, result_json, candidate_count, processing_duration_ms, error_message, computed_at, is_partial, corpus_generation, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
      args: [report.reportDeviceKey, report.reportId, "MATCHED", V1_TAG, CORPUS_FINGERPRINT_VERSION, CANONICALIZATION_VERSION, JSON.stringify(v1Matches), v1Matches.length, 7, null, storedComputedAt, 0, generation],
    });

    const snapshotRow = async () => (await client.execute({
      sql: "SELECT matcher_version, computed_at, result_json FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?",
      args: [report.reportDeviceKey, report.reportId],
    })).rows[0];
    const payload = async () => JSON.parse(String((await client.execute({
      sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?",
      args: [report.reportDeviceKey, report.reportId],
    })).rows[0].payload_json));
    const persistedDisplay = async () => {
      const current = await payload();
      return resolvePersistedSimilarityDisplay(client, {
        ...report,
        archiveScore: 0,
        unifiedScore: current.unifiedSimilarity?.unifiedScore ?? null,
        hasUnifiedSimilarity: Boolean(current.unifiedSimilarity),
        corpusSourceMatchingEnabledAtComputation: current.corpusSourceMatchingEnabledAtComputation ?? null,
        unifiedSimilarityFailed: current.unifiedSimilarityFailed ?? false,
        hasPositionEvidence: current.unifiedSimilarity?.matchedPositions !== undefined,
      });
    };

    // 1. The row is current in every respect but the matcher label: same
    //    corpus generation, complete, nothing matured since — and not current.
    assert.equal(await isHistoricalMatchSnapshotCurrent(client, report), false, "a v1-tagged snapshot fails the matcher-version identity");
    assert.deepEqual(await persistedDisplay(), { status: "stale" });

    // 2. A plain reopen never recomputes. The read-only path returns the v1
    //    row exactly as stored, and nothing is written.
    const reopened = await getPersistedHistoricalMatchSnapshot(client, report);
    assert.equal(reopened.matcherVersion, V1_TAG);
    assert.equal(reopened.matches.length, 10);
    assert.equal((await snapshotRow()).computed_at, storedComputedAt);
    assert.equal((await payload()).unifiedSimilarity.unifiedScore, 22, "the saved report still shows what was saved");

    // 3. A write-capable resolution — in production every POST /api/reports
    //    save of this report; here the same resolver through the exported
    //    self-heal — does not trust the v1 row. It recomputes, retags, and
    //    rewrites the similarity-owned keys of the report, nothing else.
    const healed = await selfHealUnifiedSimilarity(client, { ...report, accountId: SUBMITTER });
    assert.equal(healed.attempted, true);
    assert.equal(healed.outcome, "resolved");
    assert.equal(healed.unifiedSimilarity.unifiedScore, 42, "the source the v1 cap dropped is back in the union");
    const healedRow = await snapshotRow();
    assert.equal(healedRow.matcher_version, SNAPSHOT_MATCHER_VERSION, "the recomputed snapshot is tagged with the new matcher version");
    assert.notEqual(healedRow.computed_at, storedComputedAt);
    const healedMatches = JSON.parse(String(healedRow.result_json));
    assert.equal(healedMatches.length, 11);
    assert.ok(healedMatches.some((m) => m.matchedRepresentationId === xId));
    const healedPayload = await payload();
    assert.equal(healedPayload.unifiedSimilarity.unifiedScore, 42);
    assert.equal(healedPayload.text, SUBMISSION, "the report's own text is not rewritten");
    assert.equal(healedPayload.title, "Fixture Report");
    assert.deepEqual(healedPayload.aiAnalysis, { marker: "not owned by a similarity refresh" });

    // 4. The new row is current and is reused — recomputed once, not on every read.
    assert.equal(await isHistoricalMatchSnapshotCurrent(client, report), true);
    assert.deepEqual(await persistedDisplay(), { status: "resolved", primaryScore: 42, isUnified: true });
    const again = await getOrComputeHistoricalMatchSnapshot(client, { ...report, accountId: SUBMITTER, rawText: SUBMISSION, excludeAccountId: SUBMITTER });
    assert.equal(again.matcherVersion, SNAPSHOT_MATCHER_VERSION);
    assert.equal(again.computedAt, String(healedRow.computed_at), "a version-current snapshot is a cache hit");

    // 5. A row the v2 matcher wrote fails the identity the same way and is recomputed under v3.
    await client.execute({
      sql: "UPDATE report_historical_match_snapshots SET matcher_version = ?, computed_at = ? WHERE report_device_key = ? AND report_id = ?",
      args: [V2_TAG, storedComputedAt, report.reportDeviceKey, report.reportId],
    });
    assert.equal(await isHistoricalMatchSnapshotCurrent(client, report), false, "a v2-tagged snapshot fails the matcher-version identity");
    const fromV2 = await getOrComputeHistoricalMatchSnapshot(client, { ...report, accountId: SUBMITTER, rawText: SUBMISSION, excludeAccountId: SUBMITTER });
    assert.equal(fromV2.matcherVersion, SNAPSHOT_MATCHER_VERSION);
    assert.notEqual(fromV2.computedAt, storedComputedAt, "recomputed, not reused");
    assert.equal((await snapshotRow()).matcher_version, SNAPSHOT_MATCHER_VERSION);
  } finally { corpus.close(); }
});

test("a partial snapshot is stored as partial and is never treated as current", async () => {
  const corpus = await freshCorpus();
  const { client } = corpus;
  try {
    const xId = await corpus.index("other-account", "source-x", SOURCE_X);
    const oversizedId = await corpus.index("second-account", "second-source", `${words(300, 41)} ${PASSAGE} ${words(300, 42)}`);
    await corpus.mature();
    await client.execute({ sql: "UPDATE corpus_document_representations SET word_count = 999999 WHERE id = ?", args: [oversizedId] });

    const report = { reportDeviceKey: "device-partial", reportId: "report-partial" };
    await corpus.saveReport(report.reportDeviceKey, report.reportId);
    const params = { ...report, accountId: SUBMITTER, rawText: SUBMISSION, excludeAccountId: SUBMITTER };
    const first = await getOrComputeHistoricalMatchSnapshot(client, params);
    assert.equal(first.status, "MATCHED");
    assert.equal(first.partial, true, "the matcher's partial flag reaches the report-level result");
    assert.ok(entryFor(first.matches, xId));
    const row = (await client.execute({ sql: "SELECT is_partial FROM report_historical_match_snapshots WHERE report_device_key = ? AND report_id = ?", args: [report.reportDeviceKey, report.reportId] })).rows[0];
    assert.equal(Number(row.is_partial), 1, "and is stored on the snapshot row");
    assert.equal(await isHistoricalMatchSnapshotCurrent(client, report), false, "a partial snapshot is never a settled answer");
    assert.equal((await getPersistedHistoricalMatchSnapshot(client, report)).partial, true, "a read-only reopen still carries the flag");

    // Once the candidate can be verified, the next resolution completes it.
    await client.execute({ sql: "UPDATE corpus_document_representations SET word_count = 720 WHERE id = ?", args: [oversizedId] });
    const second = await getOrComputeHistoricalMatchSnapshot(client, params);
    assert.notEqual(second.partial, true);
    assert.equal(second.matches.length, 2);
    assert.equal(await isHistoricalMatchSnapshotCurrent(client, report), true);
  } finally { corpus.close(); }
});
