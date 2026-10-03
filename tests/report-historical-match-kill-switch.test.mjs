import assert from "node:assert/strict";
import test from "node:test";
import path from "path";
import crypto from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { tokens } from "../lib/similarity-core.ts";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus, createReusableDocumentRepresentation, recordCorpusShingles } from "../lib/user-submission-corpus.ts";
import { buildReportAdmissionSourceRef } from "../lib/corpus-admission-source-ref.ts";
import {
  SNAPSHOT_MATCHER_VERSION,
  snapshotMatcherVersion,
  snapshotScoringNormalizationVersion,
  isHistoricalMatchSnapshotCurrent,
  getPersistedHistoricalMatchSnapshot,
} from "../lib/report-historical-match.ts";
import { resolvePrimarySimilaritySummary, resolvePersistedSimilarityDisplay } from "../lib/report-primary-similarity.ts";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";

/**
 * CORPUS_SOURCE_MATCHING_ENABLED (the corpus-source kill switch) vs the
 * prior-submission snapshot.
 *
 * The flag decides which candidates can be scoring evidence, and so which
 * holder settles a common block. A snapshot computed with it ON was still
 * reused once it was turned OFF: its corpus sources were stripped at read
 * time, a block one of them had settled was left with no holder, and the
 * eligible submission holding the same block was never looked for (52 % ->
 * 20 % instead of 42 %). Reused the other way, an OFF snapshot never had the
 * corpus sources (42 % instead of 52 %). The state is now part of the
 * snapshot's identity: a row computed under the other state is not current.
 * Every corpus here is synthetic and in memory.
 */

const priorFlag = process.env.CORPUS_SOURCE_MATCHING_ENABLED;
const setFlag = (on) => { if (on) process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true"; else delete process.env.CORPUS_SOURCE_MATCHING_ENABLED; };
test.after(() => {
  if (priorFlag === undefined) delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  else process.env.CORPUS_SOURCE_MATCHING_ENABLED = priorFlag;
});

const drizzleDir = path.join(path.resolve("."), "drizzle");
const SYLLABLES = ["ka", "lo", "mi", "tre", "vun", "sor", "bel", "dra", "phi", "quen", "zor", "tal", "mer", "nix", "ost", "ula", "rin", "vek", "dom", "sha", "gri", "pol", "wex", "yun"];
function words(count, seed) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length] + SYLLABLES[next() % SYLLABLES.length]);
  return out.join(" ");
}
const HEAD = words(200, 11), PASSAGE = words(120, 777), TAIL = words(280, 22);
const SUBMISSION = `${HEAD} ${PASSAGE} ${TAIL}`;
const WORD_COUNT = tokens(SUBMISSION).length;
const BLOCK = HEAD.split(" ").slice(0, 130).join(" ");
const CHUNK = TAIL.split(" ").slice(0, 60).join(" ");
const SOURCE_X = `${words(250, 31)} ${PASSAGE} ${words(250, 32)}`;
const blockHolder = (k) => `${words(200, k * 13)} ${BLOCK} ${words(200, k * 17)}`;
const range = (from, count) => Array.from({ length: count }, (_, i) => from + i);
const BLOCK_POSITIONS = range(0, 130);
const PASSAGE_POSITIONS = range(200, 120);
const CHUNK_POSITIONS = range(320, 60);
const ON_POSITIONS = [...BLOCK_POSITIONS, ...PASSAGE_POSITIONS, ...CHUNK_POSITIONS];
const OFF_POSITIONS = [...BLOCK_POSITIONS, ...PASSAGE_POSITIONS];

/**
 * A: a promoted corpus source holding the block, first in every posting list
 * of it. C: a corpus source holding CHUNK only. X: a prior submission holding
 * PASSAGE. E1..E55: prior submissions holding the block. 56 holders: the
 * block's shingles are pruned and it is resolved from its posting list.
 */
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
  const index = async (account, rawText) => {
    await ensureUser(account);
    const identity = await createDocumentIdentity(client, { accountId: account, title: "t", author: null, rawText });
    await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  };
  const corpusSource = async (rawText, account) => {
    await ensureUser(account);
    const canonicalText = canonicalizeText(rawText);
    const rep = await createReusableDocumentRepresentation(client, { canonicalText });
    await recordCorpusShingles(client, rep.id, canonicalText);
    const decisionId = crypto.randomUUID();
    await client.execute({ sql: "INSERT INTO corpus_admission_decisions (id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes, dry_run) VALUES (?,?,?,?,?,?,?,?)", args: [decisionId, buildReportAdmissionSourceRef({ accountId: account, deviceKey: `d-${crypto.randomUUID()}`, reportId: `r-${crypto.randomUUID()}` }), "v1", "ACCEPT", "[]", 1, "[]", 0] });
    const acceptedId = crypto.randomUUID();
    await client.execute({ sql: "INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version) VALUES (?,?,?,?,?)", args: [acceptedId, decisionId, crypto.randomBytes(32).toString("hex"), 50, "corpus-shingle-v1"] });
    await client.execute({ sql: "INSERT INTO corpus_admission_promotions (id, decision_id, accepted_representation_id, representation_id, link_type, fingerprint_version, status, attempt_count) VALUES (?,?,?,?,?,?,'indexed',1)", args: [crypto.randomUUID(), decisionId, acceptedId, rep.id, "NEW_CONTENT_REPRESENTATION", "corpus-shingle-v1"] });
    return rep.id;
  };
  const A = await corpusSource(blockHolder(1000), "corpus-account-a");
  const C = await corpusSource(`${words(150, 41)} ${CHUNK} ${words(150, 42)}`, "corpus-account-c");
  await index("other-account", SOURCE_X);
  for (let k = 1; k <= 55; k += 1) await index(`holder-${k}`, blockHolder(k));
  await ensureUser("submitter");
  await matureCorpusBackings(client);
  let reports = 0;
  return {
    client, A, C,
    async report() {
      const id = `report-${++reports}`;
      const payload = JSON.stringify({ version: 11, id, submissionId: `s-${id}`, title: "t.pdf", text: SUBMISSION, wordCount: WORD_COUNT, score: 0, archiveScore: 0, sources: [], repeats: [] });
      await client.execute({ sql: "INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id) VALUES (?,?,?,?,?,?,?,?,?,?)", args: [id, "dk", `s-${id}`, "t.pdf", new Date().toISOString(), WORD_COUNT, 0, "Low", payload, "submitter"] });
      return id;
    },
    /** The write-capable resolution (POST save / resave / admin trace / finalizer all run this). */
    async resolve(reportId, flag) {
      setFlag(flag);
      return resolvePrimarySimilaritySummary(client, { reportDeviceKey: "dk", reportId, accountId: "submitter", rawText: SUBMISSION, wordCount: WORD_COUNT, archiveScore: 0, scoringNormalizationVersion: 1 });
    },
    async row(reportId) {
      const r = await client.execute({ sql: "SELECT matcher_version, computed_at, status FROM report_historical_match_snapshots WHERE report_device_key = 'dk' AND report_id = ?", args: [reportId] });
      return r.rows[0] ? { tag: String(r.rows[0].matcher_version), computedAt: String(r.rows[0].computed_at), status: String(r.rows[0].status) } : null;
    },
    readOnlyCurrent(reportId, flag) {
      setFlag(flag);
      return isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: "dk", reportId });
    },
    close() { client.close(); },
  };
}
const ids = (resolution) => (resolution.historicalSubmissionMatch.matches ?? []).map((m) => m.matchedRepresentationId);
const OFF_TAG = snapshotMatcherVersion(1, false);

// ---------------------------------------------------------------------------

test("tags: ON keeps the existing tag byte-for-byte; OFF adds csm.off; the contract segment still parses", () => {
  assert.equal(snapshotMatcherVersion(1, true), SNAPSHOT_MATCHER_VERSION);
  assert.match(SNAPSHOT_MATCHER_VERSION, /^user-submission-match-v5\+pos\.raw-token-v1\+cfg\.[0-9a-f]{12}$/);
  assert.equal(OFF_TAG, SNAPSHOT_MATCHER_VERSION.replace("+cfg.", "+csm.off+cfg."));
  assert.equal(snapshotMatcherVersion(2, false), snapshotMatcherVersion(2, true).replace("+cfg.", "+csm.off+cfg."));
  assert.equal(snapshotScoringNormalizationVersion(snapshotMatcherVersion(2, false)), 2);
  assert.equal(snapshotScoringNormalizationVersion(OFF_TAG), 1);
});

test("ON -> ON and OFF -> OFF: the snapshot is current and reused, never recomputed", async () => {
  const corpus = await freshCorpus();
  try {
    const on = await corpus.report();
    const first = await corpus.resolve(on, true);
    const stored = await corpus.row(on);
    assert.equal(stored.tag, SNAPSHOT_MATCHER_VERSION, "ON rows keep the tag every existing ON row already has");
    assert.equal(await corpus.readOnlyCurrent(on, true), true);
    const again = await corpus.resolve(on, true);
    assert.equal((await corpus.row(on)).computedAt, stored.computedAt, "ON -> ON: cache hit");
    assert.deepEqual(again.unifiedSimilarity.matchedPositions, first.unifiedSimilarity.matchedPositions);

    const off = await corpus.report();
    await corpus.resolve(off, false);
    const storedOff = await corpus.row(off);
    assert.equal(storedOff.tag, OFF_TAG);
    assert.equal(storedOff.status, "MATCHED");
    assert.equal(await corpus.readOnlyCurrent(off, false), true);
    await corpus.resolve(off, false);
    assert.equal((await corpus.row(off)).computedAt, storedOff.computedAt, "OFF -> OFF: cache hit");
  } finally { corpus.close(); }
});

test("ON behaviour is unchanged: corpus sources count, the block is settled by the first holder", async () => {
  const corpus = await freshCorpus();
  try {
    const r = await corpus.resolve(await corpus.report(), true);
    assert.deepEqual(r.unifiedSimilarity.matchedPositions, ON_POSITIONS);
    assert.equal(r.unifiedSimilarity.unifiedScore, 52);
    assert.ok(ids(r).includes(corpus.A) && ids(r).includes(corpus.C));
    assert.notEqual(r.historicalSubmissionMatch.partial, true);
  } finally { corpus.close(); }
});

test("ON -> OFF: not current (read-only or write-capable); the recompute excludes corpus sources and finds the eligible holder behind A", async () => {
  const corpus = await freshCorpus();
  try {
    const reportId = await corpus.report();
    await corpus.resolve(reportId, true);
    const onRow = await corpus.row(reportId);

    assert.equal(await corpus.readOnlyCurrent(reportId, false), false, "a read-only check does not call the ON row current under OFF");
    const off = await corpus.resolve(reportId, false);
    const offRow = await corpus.row(reportId);
    assert.notEqual(offRow.computedAt, onRow.computedAt, "write-capable: recomputed");
    assert.equal(offRow.tag, OFF_TAG, "and stored under the OFF contract");
    assert.equal(off.corpusSourceMatchingEnabled, false);
    assert.ok(!ids(off).includes(corpus.A) && !ids(off).includes(corpus.C), "no corpus-source evidence while OFF");
    assert.ok(off.historicalSubmissionMatch.matches.every((m) => m.relationshipType !== "TURNITPLUS_CORPUS_SOURCE"));
    assert.deepEqual(off.unifiedSimilarity.matchedPositions, OFF_POSITIONS, "the block, through an eligible submission — was 20 % (passage only)");
    assert.equal(off.unifiedSimilarity.unifiedScore, 42);
    assert.notEqual(off.historicalSubmissionMatch.partial, true, "a flag transition is a recompute, never PARTIAL");

    // Identical to an OFF computation that never saw the ON snapshot.
    const fresh = await corpus.resolve(await corpus.report(), false);
    assert.deepEqual(off.unifiedSimilarity.matchedPositions, fresh.unifiedSimilarity.matchedPositions);
    // Self-healed: the next OFF resolution reuses it.
    assert.equal(await corpus.readOnlyCurrent(reportId, false), true);
    await corpus.resolve(reportId, false);
    assert.equal((await corpus.row(reportId)).computedAt, offRow.computedAt);
  } finally { corpus.close(); }
});

test("OFF -> ON: not current; the recompute brings the corpus sources back", async () => {
  const corpus = await freshCorpus();
  try {
    const reportId = await corpus.report();
    const off = await corpus.resolve(reportId, false);
    assert.deepEqual(off.unifiedSimilarity.matchedPositions, OFF_POSITIONS);
    const offRow = await corpus.row(reportId);

    assert.equal(await corpus.readOnlyCurrent(reportId, true), false);
    const on = await corpus.resolve(reportId, true);
    const onRow = await corpus.row(reportId);
    assert.notEqual(onRow.computedAt, offRow.computedAt);
    assert.equal(onRow.tag, SNAPSHOT_MATCHER_VERSION);
    assert.deepEqual(on.unifiedSimilarity.matchedPositions, ON_POSITIONS, "CHUNK (corpus source C only) — was missing when the OFF row was reused");
    assert.ok(ids(on).includes(corpus.C));
  } finally { corpus.close(); }
});

test("read-only paths never call an opposite-state snapshot current, and never write", async () => {
  const corpus = await freshCorpus();
  try {
    const reportId = await corpus.report();
    const onResolution = await corpus.resolve(reportId, true);
    const onRow = await corpus.row(reportId);
    setFlag(false);

    // The admin GET's read-only twin: the row as stored, corpus sources hidden
    // by the live flag, its own (ON) tag — nothing recomputed, nothing written.
    const persisted = await getPersistedHistoricalMatchSnapshot(corpus.client, { reportDeviceKey: "dk", reportId });
    assert.equal(persisted.matcherVersion, SNAPSHOT_MATCHER_VERSION);
    assert.ok(persisted.matches.every((m) => m.relationshipType !== "TURNITPLUS_CORPUS_SOURCE"));
    assert.equal((await corpus.row(reportId)).computedAt, onRow.computedAt);

    const display = (corpusSourceMatchingEnabledAtComputation) => resolvePersistedSimilarityDisplay(corpus.client, {
      reportDeviceKey: "dk", reportId, archiveScore: 7, unifiedScore: onResolution.unifiedSimilarity.unifiedScore,
      hasUnifiedSimilarity: true, corpusSourceMatchingEnabledAtComputation, unifiedSimilarityFailed: false, hasPositionEvidence: true,
    });
    // The report's own marker says ON, live is OFF: the existing rollback rule (archive-only), unchanged.
    assert.deepEqual(await display(true), { status: "resolved", primaryScore: 7, isUnified: false });
    // A marker that says OFF beside a snapshot computed ON: the snapshot is not current -> stale, not "resolved 52".
    assert.deepEqual(await display(false), { status: "stale" });
    assert.equal((await corpus.row(reportId)).computedAt, onRow.computedAt, "still nothing written");
  } finally { corpus.close(); }
});
