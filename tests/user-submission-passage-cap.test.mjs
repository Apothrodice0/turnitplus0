import assert from "node:assert/strict";
import test from "node:test";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { tokens } from "../lib/similarity-core.ts";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { matchScoringRanges, USER_SUBMISSION_MATCH_THRESHOLDS } from "../lib/user-submission-matching.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { resolvePrimarySimilaritySummary } from "../lib/report-primary-similarity.ts";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";

/**
 * Prior-submission per-source passage cap.
 *
 * The verifier keeps the longest maxPassages (10) verified passages of a source
 * as `passages`, a display bound. The union read only those, so a source with
 * eleven or more separate copied passages lost the positions of the shortest
 * ones from the score — which ones depended on the display ranking. Every
 * verified passage now reaches the union (passages + additionalPassageRanges);
 * at most ten are still kept for display. Every corpus here is synthetic and
 * in memory.
 */

const priorCorpusSourceFlag = process.env.CORPUS_SOURCE_MATCHING_ENABLED;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
test.after(() => {
  if (priorCorpusSourceFlag === undefined) delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  else process.env.CORPUS_SOURCE_MATCHING_ENABLED = priorCorpusSourceFlag;
});

const drizzleDir = path.join(path.resolve("."), "drizzle");
const MAX_PASSAGES = USER_SUBMISSION_MATCH_THRESHOLDS.correspondence.maxPassages;
const SUBMITTER = "submitter";

const SYLLABLES = ["ka", "lo", "mi", "tre", "vun", "sor", "bel", "dra", "phi", "quen", "zor", "tal", "mer", "nix", "ost", "ula", "rin", "vek", "dom", "sha", "gri", "pol", "wex", "yun"];
function words(count, seed) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length]);
  return out.join(" ");
}

const FILLER = 12;
// Strictly decreasing, so the ten "longest" — the displayed ones — are P0..P9.
const LENGTHS = [40, 38, 36, 34, 32, 30, 28, 26, 24, 22, 20, 18];
const range = (from, count) => Array.from({ length: count }, (_, i) => from + i);

/**
 * A submission of `lengths.length` separate passages between distinct filler,
 * and the ranges they occupy. Passage i's text depends only on (i, length).
 */
function submissionOf(lengths) {
  const parts = [];
  const ranges = [];
  let at = 0;
  lengths.forEach((length, i) => {
    parts.push(words(FILLER, 100 + i)); at += FILLER;
    parts.push(words(length, 9000 + i * 97 + length)); ranges.push([at, at + length - 1]); at += length;
  });
  parts.push(words(FILLER, 199)); at += FILLER;
  return { text: parts.join(" "), ranges, wordCount: at };
}
/** A source holding the submission's passages `indices`, in that order, between its own filler. */
function sourceOf(lengths, indices, seed = 500) {
  const parts = [];
  indices.forEach((i, k) => {
    parts.push(words(FILLER + 3, seed + k));
    parts.push(words(lengths[i], 9000 + i * 97 + lengths[i]));
  });
  parts.push(words(FILLER + 3, seed + 99));
  return parts.join(" ");
}
const positionsOf = (ranges) => ranges.flatMap(([start, end]) => range(start, end - start + 1)).sort((a, b) => a - b);

async function freshCorpus() {
  const client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  await applyMigrationsLibsql(client, drizzleDir);
  const users = new Set();
  const ensureUser = async (id) => {
    if (users.has(id)) return;
    users.add(id);
    await client.execute({ sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)", args: [id, `${id}@example.test`, id, "x"] });
  };
  let reports = 0;
  return {
    client,
    async index(accountId, rawText) {
      await ensureUser(accountId);
      const identity = await createDocumentIdentity(client, { accountId, title: "t", author: null, rawText });
      await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
    },
    /** The real write-capable resolution: matcher -> snapshot -> union. */
    async resolve(submission) {
      await ensureUser(SUBMITTER);
      const reportId = `report-${++reports}`;
      const payload = JSON.stringify({ version: 11, id: reportId, submissionId: `s-${reportId}`, title: "t.pdf", text: submission.text, wordCount: submission.wordCount, score: 0, archiveScore: 0, sources: [], repeats: [] });
      await client.execute({
        sql: "INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
        args: [reportId, "device-key", `s-${reportId}`, "t.pdf", new Date().toISOString(), submission.wordCount, 0, "Low", payload, SUBMITTER],
      });
      await matureCorpusBackings(client);
      const resolution = await resolvePrimarySimilaritySummary(client, {
        reportDeviceKey: "device-key", reportId, accountId: SUBMITTER, rawText: submission.text,
        wordCount: submission.wordCount, archiveScore: 0, scoringNormalizationVersion: 1,
      });
      const row = await client.execute({ sql: "SELECT result_json FROM report_historical_match_snapshots WHERE report_device_key = 'device-key' AND report_id = ?", args: [reportId] });
      return { resolution, unified: resolution.unifiedSimilarity, matches: resolution.historicalSubmissionMatch.matches ?? [], snapshotMatches: JSON.parse(String(row.rows[0].result_json)) };
    },
    close() { client.close(); },
  };
}

/** One source holding every passage of a submission with `lengths`. */
async function scoreOneSource(lengths) {
  const submission = submissionOf(lengths);
  const corpus = await freshCorpus();
  try {
    await corpus.index("source-account", sourceOf(lengths, lengths.map((_, i) => i)));
    return { submission, ...(await corpus.resolve(submission)) };
  } finally { corpus.close(); }
}
function assertNoDoubleCount(unified, label) {
  assert.equal(new Set(unified.matchedPositions).size, unified.matchedPositions.length, `${label}: no position listed twice`);
  assert.equal(unified.uniqueMatchedWords, unified.matchedPositions.length, `${label}: matched words = distinct positions`);
}

// ---------------------------------------------------------------------------

test("1, 10, 11, 12 passages: every verified passage scores; no cliff at 10 -> 11", async () => {
  const results = new Map();
  for (const n of [1, 10, 11, 12]) {
    const lengths = LENGTHS.slice(0, n);
    const r = await scoreOneSource(lengths);
    const expected = positionsOf(r.submission.ranges);
    assert.equal(r.matches.length, 1, `${n}: one source`);
    assert.equal(r.matches[0].matchedWordCount, expected.length, `${n}: the verifier accepted every passage`);
    assert.deepEqual(r.unified.matchedPositions, expected, `${n}: every verified position is in the union`);
    assert.equal(r.unified.unifiedScore, Math.round((expected.length / r.submission.wordCount) * 100));
    assertNoDoubleCount(r.unified, `${n} passages`);
    results.set(n, r);
  }
  // Adding an 11th passage adds exactly its words to the union — it never takes words away.
  const ten = results.get(10).unified.matchedPositions;
  const eleven = results.get(11).unified.matchedPositions;
  assert.deepEqual(eleven, [...ten, ...positionsOf([results.get(11).submission.ranges[10]])].sort((a, b) => a - b));
  assert.equal(results.get(10).unified.unifiedScore, 70);
  assert.equal(results.get(11).unified.unifiedScore, 70, "was 65 % when the 11th passage was dropped");
  assert.equal(results.get(12).unified.unifiedScore, 69, "was 62 %");
});

test("12 passages: at most ten are kept for display; the other two are scored as ranges", async () => {
  const r = await scoreOneSource(LENGTHS);
  const [match] = r.matches;
  assert.equal(match.passages.length, MAX_PASSAGES, "display stays bounded");
  assert.equal(match.passageCount, MAX_PASSAGES);
  assert.deepEqual(match.passages.map((p) => [p.submittedWordStart, p.submittedWordEnd]), r.submission.ranges.slice(0, 10), "the ten longest, longest first");
  assert.deepEqual(match.additionalPassageRanges, r.submission.ranges.slice(10), "the rest, as ranges, in order");
  // Persisted the same way (raw-token positions, no excerpt text for the extra two).
  assert.deepEqual(r.snapshotMatches[0].additionalPassageRanges, r.submission.ranges.slice(10));
  assert.equal(r.snapshotMatches[0].passages.length, MAX_PASSAGES);
  // Every verified range has an attribution entry, and it covers the union exactly.
  const contributed = r.unified.contributions.filter((c) => c.sourceType === "previous_upload");
  assert.equal(contributed.length, 12);
  assert.deepEqual(positionsOf(contributed.map((c) => [c.submittedWordStart, c.submittedWordEnd])), r.unified.matchedPositions);
});

test("a source with at most ten passages stores exactly what it did before", async () => {
  const r = await scoreOneSource(LENGTHS.slice(0, 10));
  assert.equal("additionalPassageRanges" in r.matches[0], false);
  assert.equal("additionalPassageRanges" in r.snapshotMatches[0], false);
});

test("reordering passage lengths changes the display ranking, never the union", async () => {
  // The 12th passage made the longest: it now displaces P8/P9 from the top ten.
  const reordered = [...LENGTHS.slice(0, 11), 60];
  const r = await scoreOneSource(reordered);
  const expected = positionsOf(r.submission.ranges);
  assert.ok(r.matches[0].passages.some((p) => p.submittedWordStart === r.submission.ranges[11][0]), "the new longest passage is displayed");
  assert.deepEqual(r.unified.matchedPositions, expected, "and every passage, displayed or not, is scored");

  // The source dropping its longest passage: only P0's words leave the union.
  const submission = submissionOf(LENGTHS);
  const corpus = await freshCorpus();
  try {
    await corpus.index("source-account", sourceOf(LENGTHS, range(1, 11)));
    const without = await corpus.resolve(submission);
    assert.deepEqual(without.unified.matchedPositions, positionsOf(submission.ranges.slice(1)));
  } finally { corpus.close(); }
});

test("overlapping sources count each position once, in either insertion order", async () => {
  const submission = submissionOf(LENGTHS);
  const runWith = async (order) => {
    const corpus = await freshCorpus();
    try {
      for (const [account, indices, seed] of order) await corpus.index(account, sourceOf(LENGTHS, indices, seed));
      return await corpus.resolve(submission);
    } finally { corpus.close(); }
  };
  const all = ["account-a", range(0, 12), 500];
  const tail = ["account-b", range(4, 8), 700];
  const ab = await runWith([all, tail]);
  const ba = await runWith([tail, all]);
  assert.equal(ab.matches.length, 2);
  assert.deepEqual(ab.unified.matchedPositions, positionsOf(submission.ranges));
  assertNoDoubleCount(ab.unified, "A then B");
  assert.deepEqual(ba.unified.matchedPositions, ab.unified.matchedPositions);
  assert.equal(ba.unified.unifiedScore, ab.unified.unifiedScore);
});

test("the union reads passages + additionalPassageRanges; a snapshot without the field reads exactly as before", () => {
  const passages = [{ submittedText: "x", submittedWordStart: 10, submittedWordEnd: 19, matchedWordCount: 10 }];
  const entry = { relationshipType: "PRIOR_SUBMISSION", matchedRepresentationId: "rep", matchType: "STRONG_TEXT_MATCH", containment: 0.5, matchedWordCount: 20, passageCount: 1, longestMatchWords: 10, passages, historicalSubmissionCount: 1 };
  const legacy = computeUnifiedSimilarity({ wordCount: 100, historicalSubmissionMatch: { status: "MATCHED", matches: [entry] } });
  assert.deepEqual(legacy.matchedPositions, range(10, 10));
  const full = computeUnifiedSimilarity({ wordCount: 100, historicalSubmissionMatch: { status: "MATCHED", matches: [{ ...entry, additionalPassageRanges: [[40, 49], [15, 24]] }] } });
  assert.deepEqual(full.matchedPositions, [...range(10, 15), ...range(40, 10)], "overlap with a displayed passage counted once");
  // An exact canonical match without passages still covers the whole submission.
  assert.deepEqual(matchScoringRanges({ matchType: "EXACT_CANONICAL_MATCH", passages: [] }, 50), [[0, 49]]);
  assert.deepEqual(matchScoringRanges({ matchType: "STRONG_TEXT_MATCH", passages, additionalPassageRanges: [[40, 49]] }, 100), [[10, 19], [40, 49]]);
});
