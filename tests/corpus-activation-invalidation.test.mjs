import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus, corpusMaturityCutoff } from "../lib/user-submission-corpus.ts";
import {
  getOrComputeHistoricalMatchSnapshot,
  isHistoricalMatchSnapshotCurrent,
  bumpCorpusMatchGeneration,
  getCurrentCorpusMatchGeneration,
} from "../lib/report-historical-match.ts";
import {
  resolvePrimarySimilaritySummary,
  resolvePersistedSimilarityDisplay,
  persistRefreshedSimilarity,
} from "../lib/report-primary-similarity.ts";
import { findRoomOccupant } from "../lib/reports-repo.ts";

/**
 * Phase A — time-based snapshot invalidation. corpus_match_generation is bumped
 * only by a DB write; a backing simply reaching CORPUS_ACTIVATION_DELAY_DAYS
 * old triggers no write. corpusBackingMaturedInWindow, wired into
 * isSnapshotRowCurrent's shared currentness path, closes that gap: a cached
 * snapshot is stale once any backing crossed maturity in
 * (snapshot.computed_at, asOf]. Every check uses ONE injected `asOf`.
 */

const repoRoot = path.resolve(".");
const dbFile = path.join(repoRoot, "test_corpus_activation_invalidation.db");
for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(repoRoot, "drizzle"));

test.after(() => {
  client.close();
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
});

test.beforeEach(async () => {
  for (const t of [
    "corpus_document_shingles", "corpus_submission_references", "corpus_admission_promotions",
    "corpus_admission_accepted_representations", "corpus_admission_decisions", "corpus_document_representations",
    "document_identities", "report_historical_match_snapshots", "saved_reports",
  ]) {
    await client.execute(`DELETE FROM ${t}`);
  }
});

const DAY = 86_400_000;
const NOW = Date.now();
const asOf = (offsetDays) => new Date(NOW + offsetDays * DAY);
const sqlTs = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString().replace("T", " ").slice(0, 19);

let seq = 0;
function uniqueText() {
  seq += 1;
  return canonicalizeText(
    `Ornithologists mist-netting a migratory stopover woodland recorded stopover duration and refuelling rate for two ` +
    `warbler species across a decade of consistently operated autumn banding sessions. Distinct marker number ${seq} ` +
    `keeps each fixture's canonical fingerprint unambiguous for the maturity invalidation resolver across scenarios.`,
  );
}
async function account(id) {
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id,email,username,password_hash,corpus_reuse_consented_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)",
    args: [id, `${id}@t.test`, id, "h"],
  });
}
/** Index `text` for `accountId`, backdate its submission-reference T0 to `refDaysAgo`. */
async function seedBacking(text, accountId, refDaysAgo) {
  await account(accountId);
  const identity = await createDocumentIdentity(client, { accountId, title: "d", author: null, rawText: text });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText: text });
  await client.execute({
    sql: "UPDATE corpus_submission_references SET created_at = ? WHERE document_identity_id = ?",
    args: [sqlTs(refDaysAgo), identity.id],
  });
}
/** A saved report for `text` owned by `accountId` in `room`. */
async function seedReport(text, accountId, { deviceKey = `dk-${randomUUID()}`, reportId = `rid-${randomUUID()}`, room = 0 } = {}) {
  await account(accountId);
  const identity = await createDocumentIdentity(client, { accountId, title: "d", author: null, rawText: text });
  const payload = JSON.stringify({
    version: 11, id: 1, submissionId: `s-${reportId}`, title: "d.pdf", text, wordCount: 40, score: 0, archiveScore: 0, sources: [], repeats: [],
  });
  await client.execute({
    sql: `INSERT INTO saved_reports (id,device_key,submission_id,title,report_created_at,word_count,archive_score,score_band,payload_json,user_id,document_identity_id,room_number)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, `s-${reportId}`, "d.pdf", new Date(NOW).toISOString(), 40, 0, "Low", payload, accountId, identity.id, room],
  });
  return { deviceKey, reportId, identityId: identity.id };
}
/** Force a snapshot with a specific computed_at (and optional overrides). */
async function stampSnapshot(deviceKey, reportId, { computedDaysAgo, status = "NO_HISTORICAL_MATCH", generation = 0, isPartial = 0 } = {}) {
  await client.execute({
    sql: `INSERT INTO report_historical_match_snapshots
            (report_device_key,report_id,status,matcher_version,fingerprint_version,canonicalization_version,result_json,candidate_count,computed_at,is_partial,corpus_generation,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(report_device_key,report_id) DO UPDATE SET
            status=excluded.status, matcher_version=excluded.matcher_version, fingerprint_version=excluded.fingerprint_version,
            canonicalization_version=excluded.canonicalization_version, result_json=excluded.result_json,
            candidate_count=excluded.candidate_count, computed_at=excluded.computed_at, is_partial=excluded.is_partial,
            corpus_generation=excluded.corpus_generation`,
    args: [
      deviceKey, reportId, status,
      (await import("../lib/report-historical-match.ts")).SNAPSHOT_MATCHER_VERSION,
      "corpus-shingle-v1", "canonical-text-v1",
      status === "MATCHED" ? "[]" : null, status === "MATCHED" ? 0 : null,
      sqlTs(computedDaysAgo), isPartial, generation,
    ],
  });
}

// ---------------------------------------------------------------------------

test("NO_HISTORICAL_MATCH before maturity -> stale after the crossing, with NO generation bump", async () => {
  const text = uniqueText();
  await seedBacking(text, "A", /* refDaysAgo */ 5); // matures at asOf day+2
  const r = await seedReport(text, "B");

  const genBefore = await getCurrentCorpusMatchGeneration(client);
  const s0 = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: r.deviceKey, reportId: r.reportId, accountId: "B", rawText: text, asOf: asOf(1) });
  assert.equal(s0.status, "NO_HISTORICAL_MATCH", "backing is 6 days old at asOf day+1");
  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: r.deviceKey, reportId: r.reportId, asOf: asOf(1) }), true, "current: nothing matured since it was computed");

  // asOf day+3: backing is now 8 days old -> matured at asOf day+2, AFTER the snapshot.
  const genAfter = await getCurrentCorpusMatchGeneration(client);
  assert.equal(String(genBefore), String(genAfter), "no generation bump happened");
  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: r.deviceKey, reportId: r.reportId, asOf: asOf(3) }), false, "stale: a backing crossed maturity in the window");

  const s1 = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: r.deviceKey, reportId: r.reportId, accountId: "B", rawText: text, asOf: asOf(3) });
  assert.equal(s1.status, "MATCHED", "recompute picks up the now-mature source");
  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: r.deviceKey, reportId: r.reportId, asOf: asOf(3) }), true, "the fresh snapshot is current again");
});

test("MATCHED snapshot: a LATER backing crossing maturity stales it even though the representation was already visible (Phase C support)", async () => {
  const text = uniqueText();
  await seedBacking(text, "A", /* refDaysAgo */ 0); // matures at asOf day+7
  await seedBacking(text, "C", /* refDaysAgo */ -4); // T0 = asOf day+4, matures at asOf day+11
  const r = await seedReport(text, "B");

  // asOf day+8: A mature, C not. Representation visible.
  const s0 = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: r.deviceKey, reportId: r.reportId, accountId: "B", rawText: text, asOf: asOf(8) });
  assert.equal(s0.status, "MATCHED");
  const genBefore = await getCurrentCorpusMatchGeneration(client);

  // asOf day+9: nothing new matured since day+8.
  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: r.deviceKey, reportId: r.reportId, asOf: asOf(9) }), true);
  // asOf day+12: C matured at day+11, after the day+8 snapshot -> stale, no generation bump.
  assert.equal(String(genBefore), String(await getCurrentCorpusMatchGeneration(client)));
  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: r.deviceKey, reportId: r.reportId, asOf: asOf(12) }), false, "a later backing maturity stales an already-visible representation's snapshot");
});

test("a backing that matured BEFORE the snapshot's computed_at does not stale it", async () => {
  const text = uniqueText();
  await seedBacking(text, "A", /* refDaysAgo */ 20); // matured 13 days ago
  const r = await seedReport(text, "B");
  await stampSnapshot(r.deviceKey, r.reportId, { computedDaysAgo: 5, status: "MATCHED", generation: await getCurrentCorpusMatchGeneration(client) });
  // A matured 13 days ago; the snapshot was computed 5 days ago -> outside (computed_at - 7d, asOf - 7d].
  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: r.deviceKey, reportId: r.reportId, asOf: asOf(0) }), true);
});

test("exact inclusive maturity boundary invalidates the snapshot", async () => {
  const text = uniqueText();
  // Backing T0 exactly asOf(0) - 7 days: at asOf(0) its maturity moment == asOf, inclusive -> matured.
  await seedBacking(text, "A", /* refDaysAgo */ 7);
  const r = await seedReport(text, "B");
  // Snapshot computed 1 day ago: window lower bound = (1 day ago) - 7d = 8 days ago; upper = asOf - 7d = 7 days ago.
  // Backing T0 = 7 days ago -> in (8 days ago, 7 days ago], inclusive at the upper bound.
  await stampSnapshot(r.deviceKey, r.reportId, { computedDaysAgo: 1, status: "NO_HISTORICAL_MATCH", generation: await getCurrentCorpusMatchGeneration(client) });
  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: r.deviceKey, reportId: r.reportId, asOf: asOf(0) }), false, "T0 + 7 days == asOf -> matured, snapshot stale");
});

test("partial snapshot stays stale regardless of maturity window", async () => {
  const text = uniqueText();
  const r = await seedReport(text, "B");
  await stampSnapshot(r.deviceKey, r.reportId, { computedDaysAgo: 1, status: "NO_HISTORICAL_MATCH", isPartial: 1, generation: await getCurrentCorpusMatchGeneration(client) });
  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: r.deviceKey, reportId: r.reportId, asOf: asOf(0) }), false, "is_partial -> never current, maturity check never reached");
});

test("generation staleness still short-circuits (maturity check does not mask it)", async () => {
  const text = uniqueText();
  const r = await seedReport(text, "B");
  await stampSnapshot(r.deviceKey, r.reportId, { computedDaysAgo: 1, status: "MATCHED", generation: 0 });
  await bumpCorpusMatchGeneration(client); // now generation 1 > stored 0
  assert.equal(await isHistoricalMatchSnapshotCurrent(client, { reportDeviceKey: r.deviceKey, reportId: r.reportId, asOf: asOf(0) }), false, "generation-behind -> stale, independent of maturity");
});

test("persisted-display returns 'stale' (no authoritative primaryScore) after a maturity crossing; a fresh recompute is 'resolved'", async () => {
  const text = uniqueText();
  await seedBacking(text, "A", /* refDaysAgo */ 5); // matures at asOf day+2
  const r = await seedReport(text, "B");

  // finalize at asOf day+1 (no match yet) and persist
  const res0 = await resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: r.deviceKey, reportId: r.reportId, accountId: "B", rawText: text, wordCount: 40, archiveScore: 0, asOf: asOf(1),
  });
  await persistRefreshedSimilarity(client, { reportDeviceKey: r.deviceKey, reportId: r.reportId }, res0);
  const payloadRow = () => client.execute({ sql: "SELECT json_extract(payload_json,'$.unifiedSimilarity.unifiedScore') u, json_extract(payload_json,'$.unifiedSimilarity') IS NOT NULL hu, json_extract(payload_json,'$.corpusSourceMatchingEnabledAtComputation') f, json_extract(payload_json,'$.unifiedSimilarity.matchedPositions') IS NOT NULL hp FROM saved_reports WHERE device_key=? AND id=?", args: [r.deviceKey, r.reportId] });
  let pr = (await payloadRow()).rows[0];

  const displayArgs = (asOfDate) => ({
    reportDeviceKey: r.deviceKey, reportId: r.reportId, archiveScore: 0,
    unifiedScore: pr.u === null ? null : Number(pr.u), hasUnifiedSimilarity: Number(pr.hu) === 1,
    corpusSourceMatchingEnabledAtComputation: pr.f === null ? null : Number(pr.f) === 1,
    unifiedSimilarityFailed: false, hasPositionEvidence: Number(pr.hp) === 1, asOf: asOfDate,
  });

  const d1 = await resolvePersistedSimilarityDisplay(client, displayArgs(asOf(1)));
  assert.equal(d1.status, "resolved", "still authoritative right after finalization");

  const d3 = await resolvePersistedSimilarityDisplay(client, displayArgs(asOf(3)));
  assert.equal(d3.status, "stale", "a backing crossed maturity -> not authoritative");
  assert.ok(!("primaryScore" in d3), "'stale' carries no primaryScore to render by accident");

  // recompute at asOf day+3 and re-persist
  const res1 = await resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: r.deviceKey, reportId: r.reportId, accountId: "B", rawText: text, wordCount: 40, archiveScore: 0, asOf: asOf(3),
  });
  const write = await persistRefreshedSimilarity(client, { reportDeviceKey: r.deviceKey, reportId: r.reportId }, res1);
  assert.ok(write.rowsAffected > 0, "equal-generation write guard still permits the refreshed score");
  pr = (await payloadRow()).rows[0];
  const d3b = await resolvePersistedSimilarityDisplay(client, displayArgs(asOf(3)));
  assert.equal(d3b.status, "resolved", "resolved again after the recompute");
});

test("room-card self-heal converges after a maturity crossing", async () => {
  const text = uniqueText();
  await seedBacking(text, "A", /* refDaysAgo */ 5); // matures at asOf day+2
  const r = await seedReport(text, "B", { room: 3 });

  const res0 = await resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: r.deviceKey, reportId: r.reportId, accountId: "B", rawText: text, wordCount: 40, archiveScore: 0, asOf: asOf(1),
  });
  await persistRefreshedSimilarity(client, { reportDeviceKey: r.deviceKey, reportId: r.reportId }, res0);

  // room card at asOf day+3: display is stale -> findRoomOccupant self-heals -> converges to a real result
  const occ = await findRoomOccupant(client, "B", 3, asOf(3));
  assert.equal(occ.status !== "empty", true);
  const snap = await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: r.deviceKey, reportId: r.reportId, accountId: "B", rawText: text, asOf: asOf(3) });
  assert.equal(snap.status, "MATCHED", "self-heal persisted a fresh MATCHED snapshot");
  // a second room-card read is now the cheap path (no re-heal needed)
  const occ2 = await findRoomOccupant(client, "B", 3, asOf(3));
  assert.equal(occ2.status !== "empty", true);
});

test("concurrent recomputation after a maturity crossing converges to one snapshot row", async () => {
  const text = uniqueText();
  await seedBacking(text, "A", /* refDaysAgo */ 5);
  const r = await seedReport(text, "B");
  await getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: r.deviceKey, reportId: r.reportId, accountId: "B", rawText: text, asOf: asOf(1) });

  const results = await Promise.all([
    getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: r.deviceKey, reportId: r.reportId, accountId: "B", rawText: text, asOf: asOf(3) }),
    getOrComputeHistoricalMatchSnapshot(client, { reportDeviceKey: r.deviceKey, reportId: r.reportId, accountId: "B", rawText: text, asOf: asOf(3) }),
  ]);
  assert.deepEqual(results.map((x) => x.status), ["MATCHED", "MATCHED"]);
  const rows = await client.execute({ sql: "SELECT COUNT(*) c FROM report_historical_match_snapshots WHERE report_device_key=? AND report_id=?", args: [r.deviceKey, r.reportId] });
  assert.equal(Number(rows.rows[0].c), 1, "exactly one upserted snapshot row");
});
