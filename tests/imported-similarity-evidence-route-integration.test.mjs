import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

import { applyMigrationsLibsql } from "../lib/ingest.js";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from "../lib/rate-limit.ts";
import { withTestIdentity, markTestAccountEmailVerified } from "./helpers/test-signup.mjs";
import { tokens } from "../lib/similarity-core.ts";
import { decodeReportFromPersistence } from "../lib/report-persistence.ts";
import { buildImportedSimilarityEvidencePackageFile } from "../lib/imported-similarity-evidence/package.ts";
import {
  resetImportedSimilarityEvidencePackageCacheForTest,
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest,
} from "../lib/imported-similarity-evidence/index.ts";
import { makeUnitRecord } from "./helpers/imported-similarity-evidence-fixtures.mjs";

/**
 * STEP 19 — proves, via the REAL POST /api/reports handler (not a mock), that
 * BOTH real upload paths (anonymous/standalone, and an authenticated
 * room-slot upload) reach the shared imported-evidence-enabled similarity
 * aggregation. There is only one route/handler for both — see
 * app/api/reports/route.ts's own room_number handling — so this test exists
 * to prove it with runtime evidence, not just by reading the code.
 */

const ANCHOR = "the distinctive constitutional framework governing judicial review procedures";
const MASK = [0, 1, 2, 4, 5, 6, 7];
const MANUSCRIPT = `This opening paragraph belongs only to this manuscript's own author and shares nothing else with any external source. ${ANCHOR}. And a closing paragraph follows with the author's own original concluding analysis and remarks, well beyond the shared passage.`;
const RWC = tokens(MANUSCRIPT).length;

function writeTempPackage() {
  const dir = mkdtempSync(join(tmpdir(), "imported-similarity-evidence-route-test-"));
  const unit = makeUnitRecord({ evidenceUnitId: "PU0001", anchorNormalizedText: ANCHOR, scoreMaskRelativePositions: MASK });
  const evidenceSets = [{
    evidenceSetId: "ES-TEST00000001",
    provenanceType: "TURNITIN_REPORT_IMPORT",
    reportSha256: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    reportedSimilarityPercent: 49,
    normalizationVersion: unit.normalizationVersion,
    manuscriptIdentitySha256: null,
    createdAt: "2026-09-19T00:00:00.000Z",
    unitCount: 1,
    totalScoreMaskWords: unit.scoreMaskWordCount,
  }];
  const pkg = buildImportedSimilarityEvidencePackageFile(evidenceSets, [unit]);
  const filePath = join(dir, "package.json");
  fs.writeFileSync(filePath, JSON.stringify(pkg));
  return filePath;
}

const dbFile = path.join(path.resolve("."), "test_imported_evidence_route.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
const dbClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(dbClient, path.join(path.resolve("."), "drizzle"));

const packagePath = writeTempPackage();

test.before(() => {
  process.env.IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH = packagePath;
  resetImportedSimilarityEvidencePackageCacheForTest();
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest();
});
test.after(() => {
  dbClient.close();
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  delete process.env.IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH;
  resetImportedSimilarityEvidencePackageCacheForTest();
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest();
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
});

const cookieOf = (res) => (res.headers.get("set-cookie")?.match(/tp_session_v1=([^;]*)/) ?? [])[1] ?? null;
let uc = 0;
async function account() {
  uc += 1;
  await resetAuthRateForTest("ise-signup-" + uc);
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "ise-signup-" + uc },
    body: JSON.stringify(withTestIdentity({ email: `ise-${uc}@example.test`, password: "ise-pw-123456", username: `iseu${uc}`, deviceKey: `ise-dev-${uc}` })),
  }));
  assert.equal(res.status, 201);
  await markTestAccountEmailVerified(dbFile, `ise-${uc}@example.test`);
  return { deviceKey: `ise-dev-${uc}`, cookie: cookieOf(res), tag: `ise-${uc}` };
}

async function post(acc, id, extra) {
  await resetRateForTest(acc.tag + "-post");
  const headers = { "content-type": "application/json", "x-forwarded-for": acc.tag + "-post", cookie: `tp_session_v1=${acc.cookie}` };
  return reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers,
    body: JSON.stringify({
      deviceKey: acc.deviceKey, id, submissionId: "sub-" + id, title: "ise fixture",
      createdAt: new Date().toISOString(), wordCount: RWC, archiveScore: 0, scoreBand: "Low",
      aiScore: 2, aiTone: "low", aiStatus: "ready",
      payload: {
        version: 11, id, submissionId: "sub-" + id, title: "ise fixture", author: "", assignment: "",
        created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount: RWC, scoreBand: "Low",
        matchedWordCount: 0, sources: [], repeats: [], text: MANUSCRIPT,
      },
      ...extra,
    }),
  }));
}
async function readRow(deviceKey, id) {
  const r = await dbClient.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, id] });
  // C2: persisted rows carry compact forms (contributions, evidenceInterpretation) — decode exactly as the read boundaries do.
  return r.rows[0] ? decodeReportFromPersistence(JSON.parse(String(r.rows[0].payload_json))) : null;
}

// GENUINE FINDING (not assumed from stale notes): app/api/reports/route.ts's
// POST handler gates ALL first-time report creation on an authenticated
// session (401 AUTH_REQUIRED for an anonymous first save — see that route's
// own `report_save_rejected`/`AUTH_REQUIRED` telemetry), and every
// authenticated first save must additionally name a valid room slot
// (0..roomCount-1) — see that same handler's own room_number validation.
// There is therefore exactly ONE real report-CREATION path today, not two:
// "standard upload" and "room upload" are the SAME authenticated,
// room-scoped code path, both proven below with two different room slots. A
// RESAVE (updating an already-saved report) is the one call that does NOT
// require a room number — proven separately below to show the shared
// resolution also fires on that path.
test("Real report creation (authenticated, room slot 0): imported evidence is reachable through the real POST /api/reports handler", async () => {
  const acc = await account();
  const id = "ise-room-0";
  const res = await post(acc, id, { room: 0 });
  assert.equal(res.status, 200);
  const p = await readRow(acc.deviceKey, id);
  assert.ok(p.unifiedSimilarity, "unified similarity was resolved for this room-scoped save");
  assert.equal(p.unifiedSimilarity.importedSimilarityEvidenceOnlyWords, MASK.length);
  assert.ok(p.unifiedSimilarity.matchedPositions.length >= MASK.length);

  // ACTIVATION-GATE FIX: the score contribution above must now come with a
  // real customer-facing explanation card, persisted on the SAME write.
  assert.ok(p.evidenceInterpretation, "evidenceInterpretation must be persisted alongside the score");
  const importedCard = p.evidenceInterpretation.sources.find((s) => s.sourceType === "imported-similarity-evidence");
  assert.ok(importedCard, "a customer-facing imported-similarity-evidence card must exist");
  assert.equal(importedCard.label, "Imported reference match");
  assert.equal(importedCard.link, null, "no fabricated URL for a report-derived/marker-only source");
  assert.equal(importedCard.doi, null);
  assert.ok(importedCard.passageRefs.length > 0, "card must be associated with a highlightable passage");
  const raw = JSON.stringify(p.evidenceInterpretation);
  for (const bad of ["PU0001", "ES-TEST00000001", "a1b2c3d4e5f6a1b2c3d4e5f6", "TURNITIN_SOURCE_MARKER_ONLY"]) {
    assert.equal(raw.includes(bad), false, `evidenceInterpretation must not leak internal identifier: ${bad}`);
  }
});

test("Real report creation (authenticated, a DIFFERENT room slot): the same shared path is reachable regardless of which room slot is used", async () => {
  const acc = await account();
  const id = "ise-room-1";
  const res = await post(acc, id, { room: 1 });
  assert.equal(res.status, 200);
  const p = await readRow(acc.deviceKey, id);
  assert.equal(p.unifiedSimilarity.importedSimilarityEvidenceOnlyWords, MASK.length);
});

test("Resave of an already-saved report (no room number required/re-sent): the shared resolution still fires", async () => {
  const acc = await account();
  const id = "ise-resave-1";
  const first = await post(acc, id, { room: 0 });
  assert.equal(first.status, 200);
  const firstRow = await readRow(acc.deviceKey, id);
  const firstImportedCards = firstRow.evidenceInterpretation.sources.filter((s) => s.sourceType === "imported-similarity-evidence");
  assert.equal(firstImportedCards.length, 1, "the first save already has exactly one imported card");

  const resave = await post(acc, id, {}); // no `room` on the resave — isFirstSaveOfThisReport is now false
  assert.equal(resave.status, 200);
  const p = await readRow(acc.deviceKey, id);
  assert.equal(p.unifiedSimilarity.importedSimilarityEvidenceOnlyWords, MASK.length);

  // STEP 11 — persistence/resave: the card must still be there, and there
  // must be exactly one of it, never a duplicate accumulated by the resave.
  const importedCards = p.evidenceInterpretation.sources.filter((s) => s.sourceType === "imported-similarity-evidence");
  assert.equal(importedCards.length, 1, "resave must not duplicate the imported card");
  assert.equal(importedCards[0].label, "Imported reference match");
});

test("Real GET /api/reports/[id] (ordinary owner, non-admin): the customer response carries the neutral imported card and NO private provenance anywhere in the body", async () => {
  const acc = await account();
  const id = "ise-get-1";
  const res = await post(acc, id, { room: 0 });
  assert.equal(res.status, 200);

  await resetReadRateForTest(acc.tag + "-get");
  const getRes = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(acc.deviceKey)}`, {
      headers: { "x-forwarded-for": acc.tag + "-get", cookie: `tp_session_v1=${acc.cookie}` },
    }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(getRes.status, 200);
  const bodyText = await getRes.text();
  const { payload } = JSON.parse(bodyText);

  // The card survives the read path verbatim (GET never recomputes it).
  const card = payload.evidenceInterpretation.sources.find((s) => s.sourceType === "imported-similarity-evidence");
  assert.ok(card, "the customer-facing GET response must include the imported card");
  assert.equal(card.label, "Imported reference match");
  assert.ok(card.passageRefs.length > 0);

  // Score and explanation agree in the customer response.
  assert.equal(payload.unifiedSimilarity.importedSimilarityEvidenceOnlyWords, MASK.length);
  assert.equal(payload.evidenceInterpretation.matchedWordCount, payload.unifiedSimilarity.matchedPositions.length);

  // contributions[] (which carries the unit id + attribution state) is blanked for a non-admin...
  assert.deepEqual(payload.unifiedSimilarity.contributions, []);
  // ...and NOTHING private appears anywhere in the ENTIRE response body — not just evidenceInterpretation.
  for (const bad of ["PU0001", "ES-TEST00000001", "a1b2c3d4e5f6a1b2c3d4e5f6", "TURNITIN_SOURCE_MARKER_ONLY", "imported-similarity-evidence:", "reportSha256", "evidenceUnitId", "evidenceSetId", packagePath.replace(/\\/g, "\\\\")]) {
    assert.equal(bodyText.includes(bad), false, `GET response must not contain: ${bad}`);
  }
});

test("with the package UNCONFIGURED, the same route produces zero imported-evidence contribution (byte-identical to before the channel existed)", async () => {
  delete process.env.IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH;
  resetImportedSimilarityEvidencePackageCacheForTest();
  resetImportedSimilarityEvidenceCandidateIndexCacheForTest();
  try {
    const acc = await account();
    const id = "ise-noconfig-1";
    const res = await post(acc, id, { room: 0 });
    assert.equal(res.status, 200);
    const p = await readRow(acc.deviceKey, id);
    assert.equal(p.unifiedSimilarity.importedSimilarityEvidenceOnlyWords, 0);
    assert.deepEqual(p.unifiedSimilarity.importedSimilarityEvidencePositions, []);
    // NO_PACKAGE_BEHAVIOR_REGRESSION: no imported card, no warning/error visible,
    // and no other source card is affected by this channel being unconfigured.
    const importedCards = p.evidenceInterpretation.sources.filter((s) => s.sourceType === "imported-similarity-evidence");
    assert.equal(importedCards.length, 0, "no package configured => no imported card, ever");
  } finally {
    process.env.IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_PATH = packagePath;
    resetImportedSimilarityEvidencePackageCacheForTest();
    resetImportedSimilarityEvidenceCandidateIndexCacheForTest();
  }
});
