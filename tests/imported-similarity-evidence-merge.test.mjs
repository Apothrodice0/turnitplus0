import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeUnitRecord, makePackageFile } from "./helpers/imported-similarity-evidence-fixtures.mjs";
import { mergeImportedSimilarityEvidencePackageFiles } from "../lib/imported-similarity-evidence/merge.ts";
import {
  buildImportedSimilarityEvidenceCandidateIndex,
  matchImportedSimilarityEvidence,
  validateImportedSimilarityEvidencePackage,
} from "../lib/imported-similarity-evidence/index.ts";

/**
 * Adding a newly imported Turnitin report to the deployed imported-evidence
 * package. Every report build numbers its units PU0001…, so sets are
 * namespaced — idempotently: a deployed unit keeps its id however many times
 * the package is extended (the scratch merge used before re-prefixed the
 * already-namespaced set: "ES-X:ES-X:PU0001").
 */

const ANCHORS = {
  a1: "foreign direct investment inflows respond strongly to exchange rate volatility in emerging markets",
  a2: "the central bank intervenes in the currency market whenever speculative pressure becomes persistent",
  b1: "environmental investment incentives encourage renewable energy projects across the southern provinces",
  b2: "the legislator grants customs exemptions to projects that protect natural resources and biodiversity",
  c1: "managed floating regimes combine market determination with discretionary official intervention policies",
  d1: "cointegration tests reveal a durable equilibrium between investment flows and currency depreciation",
};
const set = (id, createdAt, units) => makePackageFile(
  units.map(([uid, key, mask]) => makeUnitRecord({ evidenceUnitId: uid, evidenceSetId: id, anchorNormalizedText: ANCHORS[key], scoreMaskRelativePositions: mask, overrides: { createdAt } })),
  { evidenceSetId: id, overrides: { createdAt } },
);
const DEPLOYED = set("ES-AAAA", "2026-09-19T00:00:00.000Z", [["PU0001", "a1"], ["PU0002", "a2"]]);
const REPORT_B = set("ES-BBBB", "2026-10-09T00:00:00.000Z", [["PU0001", "b1"], ["PU0002", "b2"]]);
const REPORT_C = set("ES-CCCC", "2026-10-10T00:00:00.000Z", [["PU0001", "c1"]]);
const ids = (file) => file.units.map((u) => u.evidenceUnitId);
const loads = (file) => {
  const v = validateImportedSimilarityEvidencePackage(JSON.parse(JSON.stringify(file)));
  assert.ok(v.ok, v.reason);
  assert.equal(v.rejectedUnits.length, 0, "the loader rejects no unit");
  return v.package;
};

test("two reports with colliding PU ids merge: the deployed set keeps its ids, the new set is namespaced, the loader loads every unit", () => {
  const { file, perSet } = mergeImportedSimilarityEvidencePackageFiles([DEPLOYED, REPORT_B]);
  assert.deepEqual(ids(file), ["PU0001", "PU0002", "ES-BBBB:PU0001", "ES-BBBB:PU0002"]);
  assert.equal(loads(file).units.length, 4);
  assert.deepEqual(perSet.map((s) => [s.evidenceSetId, s.kept, s.renamed]), [["ES-AAAA", 2, 0], ["ES-BBBB", 2, 2]]);
});

test("REGRESSION: extending an already-merged package keeps every existing unit id byte-for-byte (no double namespacing)", () => {
  const step1 = mergeImportedSimilarityEvidencePackageFiles([DEPLOYED, REPORT_B]).file;
  const step2 = mergeImportedSimilarityEvidencePackageFiles([step1, REPORT_C]).file;
  for (const id of ids(step1)) assert.ok(ids(step2).includes(id), `${id} kept`);
  assert.deepEqual(ids(step2), ["PU0001", "PU0002", "ES-BBBB:PU0001", "ES-BBBB:PU0002", "ES-CCCC:PU0001"]);
  assert.ok(!ids(step2).some((id) => /^(ES-[A-Z]+:){2}/.test(id)), "no id is prefixed twice");
  // and merging the result with nothing new is a no-op on ids and content
  const again = mergeImportedSimilarityEvidencePackageFiles([step2]).file;
  assert.equal(again.metadata.contentSha256, step2.metadata.contentSha256);
});

test("the deployed (first) input keeps its bare ids even when the new report carries an earlier createdAt", () => {
  const early = set("ES-EARLY", "2026-01-01T00:00:00.000Z", [["PU0001", "c1"]]);
  const { file } = mergeImportedSimilarityEvidencePackageFiles([DEPLOYED, early]);
  assert.ok(ids(file).includes("PU0001") && ids(file).includes("PU0002"), "deployed ids unchanged");
  assert.ok(ids(file).includes("ES-EARLY:PU0001"), "the new set is namespaced");
  loads(file);
});

test("an exact duplicate anchor (same score mask) keeps its first occurrence; the same anchor with a different mask fails the merge", () => {
  const dup = set("ES-DDDD", "2026-10-09T00:00:00.000Z", [["PU0001", "a1"], ["PU0002", "b1"]]);
  const { file, perSet } = mergeImportedSimilarityEvidencePackageFiles([DEPLOYED, dup]);
  assert.deepEqual(ids(file), ["PU0001", "PU0002", "ES-DDDD:PU0002"]);
  assert.equal(perSet.find((s) => s.evidenceSetId === "ES-DDDD").droppedExactDuplicates, 1);
  assert.equal(file.evidenceSets.find((s) => s.evidenceSetId === "ES-DDDD").unitCount, 1, "set counts are recounted");
  const conflicting = set("ES-EEEE", "2026-10-09T00:00:00.000Z", [["PU0001", "a1", [0, 1, 2, 3, 4, 5]]]);
  assert.throws(() => mergeImportedSimilarityEvidencePackageFiles([DEPLOYED, conflicting]), /conflicting score masks/);
});

test("deterministic: the order of the new reports does not change the merged package", () => {
  const one = mergeImportedSimilarityEvidencePackageFiles([DEPLOYED, REPORT_B, REPORT_C]).file;
  const two = mergeImportedSimilarityEvidencePackageFiles([DEPLOYED, REPORT_C, REPORT_B]).file;
  assert.equal(JSON.stringify(one), JSON.stringify(two));
  assert.equal(one.metadata.createdAt, "2026-10-10T00:00:00.000Z", "createdAt is the latest set createdAt, not the clock");
});

test("each evidence set keeps its own manuscript identity", () => {
  const b = set("ES-BBBB", "2026-10-09T00:00:00.000Z", [["PU0001", "b1"]]);
  b.evidenceSets[0].manuscriptIdentitySha256 = "b".repeat(64);
  const rebuilt = makePackageFile(b.units, { evidenceSetId: "ES-BBBB", overrides: { createdAt: "2026-10-09T00:00:00.000Z", manuscriptIdentitySha256: "b".repeat(64) } });
  const deployed = makePackageFile(DEPLOYED.units, { evidenceSetId: "ES-AAAA", overrides: { createdAt: "2026-09-19T00:00:00.000Z", manuscriptIdentitySha256: "a".repeat(64) } });
  const { file } = mergeImportedSimilarityEvidencePackageFiles([deployed, rebuilt]);
  assert.deepEqual(file.evidenceSets.map((s) => [s.evidenceSetId, s.manuscriptIdentitySha256]), [["ES-AAAA", "a".repeat(64)], ["ES-BBBB", "b".repeat(64)]]);
});

test("matching on the merged package credits exactly what each report's package credits on its own", () => {
  const submission = `Introduction. ${ANCHORS.a1}. A middle paragraph unrelated to any source. ${ANCHORS.b2}. Conclusion text.`;
  const positions = (file) => {
    const index = buildImportedSimilarityEvidenceCandidateIndex(loads(file));
    return new Set(matchImportedSimilarityEvidence(submission, index).flatMap((m) => m.matchedPassages.flatMap((p) => Array.from({ length: p.matchedWordCount }, (_, k) => p.submittedWordStart + k))));
  };
  const merged = positions(mergeImportedSimilarityEvidencePackageFiles([DEPLOYED, REPORT_B]).file);
  const union = new Set([...positions(DEPLOYED), ...positions(REPORT_B)]);
  assert.ok(union.size > 0, "precondition: both reports match");
  assert.deepEqual([...merged].sort((a, b) => a - b), [...union].sort((a, b) => a - b));
});

test("tools/import-similarity-evidence.ts --base-package adds a report to a deployed package without changing deployed ids", () => {
  const dir = path.join(process.cwd(), "test_imported_evidence_merge_tmp");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  try {
    const base = path.join(dir, "deployed.json");
    fs.writeFileSync(base, JSON.stringify(mergeImportedSimilarityEvidencePackageFiles([DEPLOYED, REPORT_B]).file, null, 2));
    const input = path.join(dir, "units.jsonl");
    fs.writeFileSync(input, ["c1", "d1"].map((key, i) => JSON.stringify({
      EVIDENCE_SET_ID: "ES-NEWREPORT", EVIDENCE_UNIT_ID: `PU000${i + 1}`, PROVENANCE_TYPE: "TURNITIN_REPORT_IMPORT", REPORT_SHA256: "f".repeat(64),
      REPORTED_SIMILARITY_PERCENT: 12, SOURCE_ATTRIBUTION_STATE: "TURNITIN_SOURCE_MARKER_ONLY", SOURCE_MARKER_NUMBERS: [1], SOURCE_NAMES: [],
      ANCHOR_NORMALIZED_TEXT: ANCHORS[key], SCORE_MASK_RELATIVE_POSITIONS: [0, 1, 2, 3, 4, 5], GOLD_SPAN_IDS: [], ORIGINAL_MANUSCRIPT_TOKEN_POSITIONS: [],
      ORIGINAL_REPORT_PAGE: 3, CONFIDENCE: "HIGH", CREATED_AT: "2026-10-11T00:00:00.000Z",
    })).join("\n"));
    const run = (extra) => spawnSync(process.execPath, ["--import", "tsx", "tools/import-similarity-evidence.ts", "--input", input, ...extra], { encoding: "utf8" });
    const merged = run(["--output", path.join(dir, "merged"), "--base-package", base]);
    assert.equal(merged.status, 0, merged.stderr);
    const out = JSON.parse(fs.readFileSync(path.join(dir, "merged", "imported-similarity-evidence-package.json"), "utf8"));
    const deployedIds = JSON.parse(fs.readFileSync(base, "utf8")).units.map((u) => u.evidenceUnitId);
    for (const id of deployedIds) assert.ok(ids(out).includes(id), `deployed ${id} kept`);
    assert.ok(ids(out).includes("ES-NEWREPORT:PU0001") && ids(out).includes("ES-NEWREPORT:PU0002"), "new report namespaced");
    assert.equal(loads(out).units.length, deployedIds.length + 2);
    // without --base-package the tool still writes the new report alone, as before
    const alone = run(["--output", path.join(dir, "alone")]);
    assert.equal(alone.status, 0, alone.stderr);
    const aloneFile = JSON.parse(fs.readFileSync(path.join(dir, "alone", "imported-similarity-evidence-package.json"), "utf8"));
    assert.deepEqual(ids(aloneFile), ["PU0001", "PU0002"]);
    assert.equal("merge" in JSON.parse(fs.readFileSync(path.join(dir, "alone", "import-summary.json"), "utf8")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
