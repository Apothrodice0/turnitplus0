import assert from "node:assert/strict";
import test from "node:test";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { tokens } from "../lib/similarity-core.ts";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { matchAgainstUserSubmissionCorpus, USER_SUBMISSION_MATCH_THRESHOLDS } from "../lib/user-submission-matching.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { priorSubmissionBranchState } from "../lib/report-evidence-interpretation.ts";
import { resolveReportCompletion, unknownExtractionDiagnostic } from "../lib/evidence-interpretation/index.ts";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";

/**
 * maxDF growth stability.
 *
 * Candidate discovery drops any query shingle that more than
 * maxCandidateShingleDocumentFrequency (50) eligible documents hold. A
 * 130-word block held by 50 documents was found and credited; the 51st holder
 * pushed every one of its shingles over the ceiling, no holder shared a
 * searched shingle any more, and the block vanished from the score:
 * source + 50 holders 42 %, + 51 -> 20 %.
 *
 * Now a long, distinctive block whose shingles were pruned is resolved from
 * its own posting lists until a holder that verifies covers it. Generic
 * boilerplate and blocks too short or too fragmented to be a distinctive
 * passage stay pruned, and everything found that way still has to pass the
 * normal verifier.
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
const MAX_DF = USER_SUBMISSION_MATCH_THRESHOLDS.maxCandidateShingleDocumentFrequency;
const SUBMITTER = "submitter";

async function freshCorpus() {
  const client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  await applyMigrationsLibsql(client, drizzleDir);
  const users = new Set();
  return {
    client,
    async index(accountId, rawText) {
      if (!users.has(accountId)) {
        users.add(accountId);
        await client.execute({ sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)", args: [accountId, `${accountId}@example.test`, accountId, "x"] });
      }
      const identity = await createDocumentIdentity(client, { accountId, title: "t", author: null, rawText });
      await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
      const row = await client.execute({ sql: "SELECT representation_id FROM corpus_submission_references WHERE document_identity_id = ?", args: [identity.id] });
      return String(row.rows[0].representation_id);
    },
    close() { client.close(); },
  };
}

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

async function evaluate(corpus, overrides = {}) {
  await matureCorpusBackings(corpus.client);
  const diagnostics = {};
  const result = await matchAgainstUserSubmissionCorpus(corpus.client, {
    accountId: SUBMITTER, canonicalText: SUBMISSION, excludeAccountId: SUBMITTER, diagnostics, ...overrides,
  });
  const matches = result.status === "MATCHED" ? result.matches : [];
  const unified = computeUnifiedSimilarity({ wordCount: WORD_COUNT, historicalSubmissionMatch: { status: result.status, matches } });
  return { result, matches, unified, diagnostics };
}
async function addHolders(corpus, from, to, accountPrefix = "holder") {
  for (let k = from; k <= to; k += 1) await corpus.index(`${accountPrefix}-${k}`, blockHolder(k));
}
function assertNoDoubleCount(unified, label) {
  assert.equal(new Set(unified.matchedPositions).size, unified.matchedPositions.length, `${label}: no position listed twice`);
  assert.equal(unified.uniqueMatchedWords, unified.matchedPositions.length, `${label}: matched words = distinct positions`);
}

// ---------------------------------------------------------------------------

test("1: holder 50 -> 51 does not retract the copied block", async () => {
  assert.equal(MAX_DF, 50);
  const corpus = await freshCorpus();
  try {
    await corpus.index("other-account", SOURCE_X);
    await addHolders(corpus, 1, 50);
    const fifty = await evaluate(corpus);
    assert.equal(fifty.diagnostics.highDfPrunedShingles, 0, "test setup sanity: at 50 holders nothing is pruned");
    assert.equal(fifty.unified.unifiedScore, 42);
    assert.deepEqual(fifty.unified.matchedPositions, BLOCK_AND_PASSAGE);

    await addHolders(corpus, 51, 51);
    const fiftyOne = await evaluate(corpus);
    assert.ok(fiftyOne.diagnostics.highDfPrunedShingles >= 120, "test setup sanity: at 51 holders the block's shingles are pruned");
    assert.equal(fiftyOne.diagnostics.commonBlockRuns, 1);
    assert.equal(fiftyOne.diagnostics.commonBlockRunsRecovered, 1);
    assert.equal(fiftyOne.unified.unifiedScore, 42, "the block is still credited");
    assert.deepEqual(fiftyOne.unified.matchedPositions, fifty.unified.matchedPositions, "no position lost across the DF boundary");
    assert.notEqual(fiftyOne.result.partial, true);
    assert.equal(fiftyOne.diagnostics.stopReason, "CANDIDATES_EXHAUSTED");
  } finally { corpus.close(); }
});

test("2: holder 51 -> 100 stays non-decreasing on a complete run, every position counted once", async () => {
  const corpus = await freshCorpus();
  try {
    await corpus.index("other-account", SOURCE_X);
    await addHolders(corpus, 1, 51);
    const fiftyOne = await evaluate(corpus);
    await addHolders(corpus, 52, 100);
    const hundred = await evaluate(corpus);
    for (const p of fiftyOne.unified.matchedPositions) assert.ok(hundred.unified.matchedPositions.includes(p), `position ${p} kept`);
    assert.equal(hundred.unified.unifiedScore, 42);
    assert.deepEqual(hundred.unified.matchedPositions, BLOCK_AND_PASSAGE);
    assertNoDoubleCount(hundred.unified, "100 holders + X");
    assert.notEqual(hundred.result.partial, true, "a complete run, not a budget stop");
    assert.ok(hundred.diagnostics.commonBlockPostingRowsExamined <= 256, `one bounded posting page (${hundred.diagnostics.commonBlockPostingRowsExamined} rows)`);
  } finally { corpus.close(); }
});

test("3: generic academic boilerplate held by many documents does not become evidence", async () => {
  // Built from lib/document-correspondence.ts's GENERIC_ACADEMIC_REGISTER_WORDS — the existing boilerplate test.
  const STOCK = [
    "the present study results and findings analysis discussion section",
    "further research using the standard procedure and appropriate treatment",
    "the general topic scope and broader consideration of related work",
    "prior observations reported throughout the paper and additional material",
    "the following section presents the document review and course assignment",
    "these terms taken together describe the process and the described method",
    "consistent results were noted following the standard analysis procedure",
  ].join(". ") + ".";
  const common = `${STOCK} ${STOCK}`;
  const submission = `${words(250, 901)} ${common} ${words(250, 902)}`;
  const corpus = await freshCorpus();
  try {
    for (let k = 1; k <= 60; k += 1) await corpus.index(`stock-holder-${k}`, `${words(220, 903 + k)} ${common} ${words(220, 1903 + k)}`);
    await matureCorpusBackings(corpus.client);
    const diagnostics = {};
    const result = await matchAgainstUserSubmissionCorpus(corpus.client, { accountId: SUBMITTER, canonicalText: submission, excludeAccountId: SUBMITTER, diagnostics });
    assert.ok(diagnostics.highDfPrunedShingles > 0, "test setup sanity: the boilerplate is pruned");
    assert.equal(diagnostics.commonBlockRuns, 0, "a generic-register block is never resolved — it stays pruned");
    assert.equal(diagnostics.commonBlockPostingRowsExamined, 0);
    assert.equal(result.status, "NO_HISTORICAL_MATCH");
    assert.notEqual(result.partial, true);
  } finally { corpus.close(); }
});

test("4: a genuine high-document-frequency overlap is verified like any other source", async () => {
  const corpus = await freshCorpus();
  try {
    const holderIds = [];
    for (let k = 1; k <= 60; k += 1) holderIds.push(await corpus.index(`holder-${k}`, blockHolder(k)));
    const { matches, unified, diagnostics } = await evaluate(corpus);
    assert.equal(diagnostics.commonBlockSourcesVerified, 1, "one verified holder is enough to cover the block");
    assert.equal(matches.length, 1);
    assert.equal(matches[0].relationshipType, "PRIOR_SUBMISSION");
    assert.ok(holderIds.includes(matches[0].matchedRepresentationId));
    assert.ok(matches[0].longestMatchWords >= 130, "accepted through the normal distinctive-passage rule");
    assert.deepEqual(unified.matchedPositions, BLOCK_POSITIONS);
  } finally { corpus.close(); }
});

test("5: sharing high-frequency shingles alone earns nothing — every document found that way still has to verify", async () => {
  const corpus = await freshCorpus();
  try {
    // Twenty documents holding only the first 12 words of the block inside
    // unrelated text, indexed FIRST so the posting walk meets them before any
    // real holder. They share pruned shingles; they are not copies of the block.
    const anchorOnlyIds = [];
    const firstWords = BLOCK.split(" ").slice(0, 12).join(" ");
    for (let k = 1; k <= 20; k += 1) anchorOnlyIds.push(await corpus.index(`anchor-only-${k}`, `${words(300, 5000 + k)} ${firstWords} ${words(300, 6000 + k)}`));
    await addHolders(corpus, 1, 55);
    const { matches, unified, diagnostics } = await evaluate(corpus);
    assert.ok(diagnostics.candidatesVerified > diagnostics.commonBlockSourcesVerified, "documents met in the walk were compared and rejected");
    assert.equal(matches.filter((m) => anchorOnlyIds.includes(m.matchedRepresentationId)).length, 0, "none of them is a match");
    assert.deepEqual(unified.matchedPositions, BLOCK_POSITIONS, "the block is credited from a real holder");
  } finally { corpus.close(); }
});

test("5b: a common block split by unverifiable words (a citation) is never walked", async () => {
  const CITATIONS = ["Smith J and Jones K 2019 Methods for the analysis of complex systems Journal of Applied Research 12 3 45 67", "Brown A Lee M and Patel R 2020 A review of measurement practice Annual Review of Science 8 101 119"].join(" . ");
  const submission = `${words(250, 7101)} ${CITATIONS} ${words(250, 7102)}`;
  const corpus = await freshCorpus();
  try {
    for (let k = 1; k <= 60; k += 1) await corpus.index(`citing-${k}`, `${words(220, 7200 + k)} ${CITATIONS} ${words(220, 8200 + k)}`);
    await matureCorpusBackings(corpus.client);
    const diagnostics = {};
    const result = await matchAgainstUserSubmissionCorpus(corpus.client, { accountId: SUBMITTER, canonicalText: submission, excludeAccountId: SUBMITTER, diagnostics });
    assert.ok(diagnostics.highDfPrunedShingles > 0, "test setup sanity: the citations are pruned");
    assert.equal(diagnostics.commonBlockRuns, 0, "the verifier would split it into two passages under 30 words — so it is not walked");
    assert.equal(result.status, "NO_HISTORICAL_MATCH");
  } finally { corpus.close(); }
});

test("6: the submitter's own copies of a common block never cover it — SELF stays excluded", async () => {
  const corpus = await freshCorpus();
  try {
    // Own drafts holding the block are indexed first, so the posting walk meets them first.
    for (let k = 1; k <= 20; k += 1) await corpus.index(SUBMITTER, `${blockHolder(900 + k)} ${words(30, 9900 + k)}`);
    await addHolders(corpus, 1, 55);
    const { matches, unified } = await evaluate(corpus);
    const scoring = matches.filter((m) => m.relationshipType !== "SELF");
    assert.equal(scoring.length, 1, "the block is covered by another account's document");
    assert.equal(scoring[0].relationshipType, "PRIOR_SUBMISSION");
    assert.deepEqual(unified.matchedPositions, BLOCK_POSITIONS);

    // With no other holder at all, the own drafts alone credit nothing.
    const ownOnly = await freshCorpus();
    try {
      for (let k = 1; k <= 60; k += 1) await ownOnly.index(SUBMITTER, `${blockHolder(900 + k)} ${words(30, 9900 + k)}`);
      const own = await evaluate(ownOnly);
      assert.equal(own.unified.unifiedScore, 0);
      assert.ok(own.matches.every((m) => m.relationshipType === "SELF"));
    } finally { ownOnly.close(); }
  } finally { corpus.close(); }
});

test("8: insertion order does not change the complete score", async () => {
  const forward = await freshCorpus();
  const reverse = await freshCorpus();
  try {
    await forward.index("other-account", SOURCE_X);
    await addHolders(forward, 1, 60);
    for (let k = 60; k >= 1; k -= 1) await reverse.index(`holder-${k}`, blockHolder(k));
    await reverse.index("other-account", SOURCE_X);
    const a = await evaluate(forward);
    const b = await evaluate(reverse);
    assert.equal(a.unified.unifiedScore, 42);
    assert.equal(b.unified.unifiedScore, a.unified.unifiedScore);
    assert.deepEqual(b.unified.matchedPositions, a.unified.matchedPositions);
  } finally { forward.close(); reverse.close(); }
});

const POSTING_PAGE_SQL = /WHERE shingle_hash = \?\s+AND fingerprint_version = \?\s+AND id > \?/;
function withPostingPages(client, onPostingPage) {
  return {
    execute: async (stmt) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      if (POSTING_PAGE_SQL.test(sql)) await onPostingPage();
      return client.execute(stmt);
    },
    batch: (...args) => client.batch(...args),
    transaction: (...args) => client.transaction(...args),
    close: () => {},
  };
}
function assertPartialThroughToCompletion(result, diagnostics) {
  assert.equal(result.partial, true);
  assert.equal(diagnostics.commonBlockRuns, 1, "the pass reached common-block resolution");
  assert.equal(diagnostics.commonBlockRunsRecovered, 0);
  const matches = result.status === "MATCHED" ? result.matches : [];
  assert.deepEqual(computeUnifiedSimilarity({ wordCount: WORD_COUNT, historicalSubmissionMatch: { status: result.status, matches } }).matchedPositions, PASSAGE_POSITIONS, "what was verified is kept");
  const reportMatch = { status: result.status, matches, computedAt: "x", matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x", partial: true };
  assert.equal(priorSubmissionBranchState(reportMatch), "PARTIAL");
  assert.equal(resolveReportCompletion({ priorSubmission: priorSubmissionBranchState(reportMatch), extraction: unknownExtractionDiagnostic() }).state, "PARTIAL");
}

test("9: a posting walk slower than the pass budget is cut at the budget and is PARTIAL, through to the report completion", async () => {
  const corpus = await freshCorpus();
  try {
    await corpus.index("other-account", SOURCE_X);
    await addHolders(corpus, 1, 55);
    await matureCorpusBackings(corpus.client);
    let slowQueryAnswered = false;
    const slow = withPostingPages(corpus.client, async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      slowQueryAnswered = true;
    });
    // Earlier tests can leave seconds of cleanup on the event loop; let it
    // finish so the budget below is spent by this pass alone.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const diagnostics = {};
    const result = await matchAgainstUserSubmissionCorpus(slow, {
      accountId: SUBMITTER, canonicalText: SUBMISSION, excludeAccountId: SUBMITTER, diagnostics, config: { matchTimeBudgetMs: 800 },
    });
    assert.equal(slowQueryAnswered, false, "the pass returned without waiting for the slow query");
    assert.equal(diagnostics.stopReason, "QUERY_FAILED", "the wait is abandoned at the pass budget, as a further candidate page's is");
    assertPartialThroughToCompletion(result, diagnostics);
  } finally { corpus.close(); }
});

test("10: a holder left unreached on one block's posting page can still cover the next block", async () => {
  // G holds block A only and is indexed first, so A's walk verifies G and
  // stops. H1..H55 hold A and B: B can only be covered by one of them.
  const BLOCK_B = TAIL.split(" ").slice(150).join(" ");
  const BLOCK_B_POSITIONS = range(470, 130);
  assert.equal(BLOCK_B.split(" ").length, 130);
  const bothBlocks = (k) => `${words(200, k * 13)} ${BLOCK} ${words(100, k * 19)} ${BLOCK_B} ${words(100, k * 17)}`;
  const corpus = await freshCorpus();
  try {
    await corpus.index("g-account", blockHolder(999));
    await corpus.index("other-account", SOURCE_X);
    for (let k = 1; k <= 40; k += 1) await corpus.index(`both-${k}`, bothBlocks(k));
    const below = await evaluate(corpus);
    assert.equal(below.diagnostics.highDfPrunedShingles, 0, "test setup sanity: nothing is pruned at 41 holders");
    const expected = [...BLOCK_POSITIONS, ...PASSAGE_POSITIONS, ...BLOCK_B_POSITIONS];
    assert.deepEqual(below.unified.matchedPositions, expected);

    for (let k = 41; k <= 55; k += 1) await corpus.index(`both-${k}`, bothBlocks(k));
    const above = await evaluate(corpus);
    assert.equal(above.diagnostics.commonBlockRuns, 2);
    assert.equal(above.diagnostics.commonBlockRunsRecovered, 2);
    assert.deepEqual(above.unified.matchedPositions, expected, "block B is not lost behind block A's walk");
    assertNoDoubleCount(above.unified, "two blocks");
    assert.notEqual(above.result.partial, true);
  } finally { corpus.close(); }
});

test("11: a failing posting query keeps what was verified and is PARTIAL, never a thrown error", async () => {
  const corpus = await freshCorpus();
  try {
    await corpus.index("other-account", SOURCE_X);
    await addHolders(corpus, 1, 55);
    await matureCorpusBackings(corpus.client);
    const failing = withPostingPages(corpus.client, () => { throw new Error("posting query failed"); });
    const diagnostics = {};
    const result = await matchAgainstUserSubmissionCorpus(failing, {
      accountId: SUBMITTER, canonicalText: SUBMISSION, excludeAccountId: SUBMITTER, diagnostics,
    });
    assert.equal(diagnostics.stopReason, "QUERY_FAILED");
    assertPartialThroughToCompletion(result, diagnostics);
  } finally { corpus.close(); }
});
