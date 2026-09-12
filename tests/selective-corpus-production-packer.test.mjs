import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  assertNoFixtureContamination,
  dedupBulkDocuments,
  buildPackedIndex,
  computeCorpusIdentityDigest,
  buildCorpusVersionJson,
  runProductionPacker,
} from "../tools/build-selective-corpus-production.ts";
import { tokens } from "../lib/similarity-core.ts";
import { canonicalSha256 } from "../lib/document-identity.ts";
import {
  loadSelectiveCorpusArtifact,
  clearSelectiveCorpusArtifactCache,
  SelectiveCorpusArtifactError,
} from "../lib/selective-corpus/artifact.ts";
import {
  SELECTIVE_CORPUS_EXPECTED_DIGEST,
  SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST,
} from "../lib/selective-corpus/constants.ts";

const PRODUCTION_ARTIFACT = "D:/TurnitPlusTemp/selective-corpus-production-v1/run-20260912-023011";
const productionArtifactPresent = (() => {
  try {
    return statSync(join(PRODUCTION_ARTIFACT, "corpus-version.json")).isFile();
  } catch {
    return false;
  }
})();
const DEV_REGRESSION_ARTIFACT = "D:/TurnitPlusTemp/selective-corpus-bulk-v1/run-20260909-224038";
const devRegressionArtifactPresent = (() => {
  try {
    return statSync(join(DEV_REGRESSION_ARTIFACT, "corpus-version.json")).isFile();
  } catch {
    return false;
  }
})();

/**
 * SELECTIVE CORPUS PRODUCTION PACKER — focused, fully synthetic, fast tests.
 * No real 9,451-doc population is touched here; the real build is exercised
 * separately by actually running the tool. Every test constructs FRESH doc
 * objects (dedup mutates in place) so no test can leak state into another.
 */

function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function makeDoc({ rawId, family = "A_wikipedia", text, workVersionId = null, interpretationLabel = "ORDINARY_REFERENCE" }) {
  const words = tokens(text);
  return {
    rawId,
    family,
    workVersionId,
    interpretationLabel,
    contentHash: sha256Hex(text),
    canonicalTextHash: canonicalSha256(text),
    text,
    words,
    wordCount: words.length,
  };
}

function uniqueText(seed, wordCount) {
  return Array.from({ length: wordCount }, (_, i) => `${seed}term${i}${seed}`).join(" ");
}

const SHARED_PHRASE = Array.from({ length: 60 }, (_, i) => `sharedterm${i}`).join(" ");

function makeSharedDoc(idx) {
  const text = `${SHARED_PHRASE} ${uniqueText(`doc${idx}`, 60)}`;
  return makeDoc({ rawId: `bulk:shared-${idx}`, text });
}

function makeSmallCorpus(n) {
  return Array.from({ length: n }, (_, i) => makeDoc({ rawId: `bulk:doc-${i}`, family: i % 2 === 0 ? "A_wikipedia" : "F_foundational", text: uniqueText(`indep${i}`, 260) }));
}

// ═══════════════════════════════════════════════════════════════════════
// A. fixture input is rejected -- FAIL CLOSED, before any dedup/pack work
// ═══════════════════════════════════════════════════════════════════════

test("A: assertNoFixtureContamination rejects a fixture-shaped rawId", () => {
  assert.throws(() => assertNoFixtureContamination([{ rawId: "fixture:A-wiki-001" }]), /FAIL CLOSED/);
  assert.doesNotThrow(() => assertNoFixtureContamination([{ rawId: "bulk:A-000001" }]));
});

test("A2: dedupBulkDocuments fails closed if a fixture record reaches it", () => {
  const docs = [...makeSmallCorpus(3), makeDoc({ rawId: "fixture:A-wiki-999", text: uniqueText("fx", 260) })];
  assert.throws(() => dedupBulkDocuments(docs), /FAIL CLOSED/);
});

test("A3: buildPackedIndex fails closed if a fixture-shaped doc reaches it", () => {
  const docs = makeSmallCorpus(2);
  const dedup = dedupBulkDocuments(docs);
  const contaminated = [...dedup.kept, makeDoc({ rawId: "fixture:X", text: uniqueText("fx2", 260) })];
  // give the fixture doc a sourceId/fp so it structurally resembles a kept doc, proving
  // the guard checks rawId content, not merely "did dedup already run over it"
  contaminated[contaminated.length - 1].sourceId = "scb-999999";
  assert.throws(() => buildPackedIndex(contaminated), /FAIL CLOSED/);
});

test("A4: runProductionPacker fails closed at the very first step for fixture input", () => {
  const docs = [...makeSmallCorpus(2), makeDoc({ rawId: "fixture:late", text: uniqueText("fx3", 260) })];
  assert.throws(() => runProductionPacker(docs, "test-run", "D:/nonexistent"), /FAIL CLOSED/);
});

// ═══════════════════════════════════════════════════════════════════════
// B. identical bulk input produces deterministic survivor order, stopset,
//    digest, and shard bytes
// ═══════════════════════════════════════════════════════════════════════

test("B: identical input produces byte-identical output across two independent runs", () => {
  const buildFreshInput = () => makeSmallCorpus(20);

  const r1 = runProductionPacker(buildFreshInput(), "run-1", "D:/src");
  const r2 = runProductionPacker(buildFreshInput(), "run-2", "D:/src");

  assert.deepEqual(
    r1.dedup.kept.map((d) => d.rawId),
    r2.dedup.kept.map((d) => d.rawId),
    "identical survivor ordering",
  );
  assert.equal(r1.digest, r2.digest, "identical corpusIdentityDigest");
  assert.equal(r1.packed.docmapText, r2.packed.docmapText, "identical docmap.tsv text");
  assert.ok(r1.packed.stopsetBuffer.equals(r2.packed.stopsetBuffer), "identical stopset.bin bytes");
  assert.equal(r1.packed.shardBuffers.length, 256);
  assert.equal(r2.packed.shardBuffers.length, 256);
  for (let s = 0; s < 256; s++) {
    assert.ok(r1.packed.shardBuffers[s].equals(r2.packed.shardBuffers[s]), `identical shard-${s} bytes`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// C. dedup decisions are freshly recomputed, never inherited/stale
// ═══════════════════════════════════════════════════════════════════════

test("C: mirror dedup drops the lower-wordcount near-duplicate deterministically, recomputed fresh each call", () => {
  const buildPair = () => {
    const base = uniqueText("mirrorcore", 200);
    const longer = makeDoc({ rawId: "bulk:mirror-long", family: "A_wikipedia", text: `${base} extrauniquetail wordsonly` });
    const shorter = makeDoc({ rawId: "bulk:mirror-short", family: "A_wikipedia", text: base });
    return [longer, shorter];
  };

  const run1 = dedupBulkDocuments(buildPair());
  assert.deepEqual(run1.dropped.map((d) => d.rawId), ["bulk:mirror-short"]);
  assert.equal(run1.dropped[0].dupType, "mirror");
  assert.equal(run1.dropped[0].dupOf, "bulk:mirror-long");
  assert.equal(run1.mirrorCount, 1);

  // a completely FRESH set of objects, same shape -- proves the outcome comes
  // from recomputing Jaccard on THIS call's input, not from any external
  // cached/stale dupOf state (this function never reads a prior artifact).
  const run2 = dedupBulkDocuments(buildPair());
  assert.deepEqual(run2.dropped.map((d) => d.rawId), ["bulk:mirror-short"]);
  assert.equal(run2.mirrorCount, 1);
});

// ═══════════════════════════════════════════════════════════════════════
// D. DF/stopset is recomputed from the ACTUAL clean survivor set, not
//    inherited from another artifact's stopset
// ═══════════════════════════════════════════════════════════════════════

test("D: a shared fingerprint below DF threshold is NOT stopped; adding one more document crosses DF>=13 and IS stopped", () => {
  const twelve = Array.from({ length: 12 }, (_, i) => makeSharedDoc(i));
  const dedup12 = dedupBulkDocuments(twelve);
  assert.equal(dedup12.kept.length, 12, "no unintended dedup collapse among the 12 shared-prefix docs");
  const packed12 = buildPackedIndex(dedup12.kept);
  assert.equal(packed12.stopHashes.length, 0, "DF=12 must not cross the DF>=13 stop threshold");

  const thirteen = Array.from({ length: 13 }, (_, i) => makeSharedDoc(i));
  const dedup13 = dedupBulkDocuments(thirteen);
  assert.equal(dedup13.kept.length, 13);
  const packed13 = buildPackedIndex(dedup13.kept);
  assert.ok(packed13.stopHashes.length >= 1, "DF=13 must cross the DF>=13 stop threshold for the shared-phrase hashes");
});

// ═══════════════════════════════════════════════════════════════════════
// E. output structure: 256 shards, valid docmap/raw mapping, zero fixture
//    rows/postings
// ═══════════════════════════════════════════════════════════════════════

test("E: output has exactly 256 shards and a fixture-free docmap", () => {
  const result = runProductionPacker(makeSmallCorpus(15), "run-e", "D:/src");
  assert.equal(result.packed.shardBuffers.length, 256);
  assert.ok(!/fixture/i.test(result.packed.docmapText), "docmap.tsv must never contain a fixture rawId");
  for (const d of result.dedup.kept) {
    assert.ok(d.rawId.startsWith("bulk:"), `kept doc ${d.rawId} must be bulk-only`);
  }
  // docmap row count matches kept count exactly
  const rowCount = result.packed.docmapText.split("\n").filter(Boolean).length;
  assert.equal(rowCount, result.dedup.kept.length);
});

// ═══════════════════════════════════════════════════════════════════════
// F. corpusIdentityDigest follows the exact existing contract
// ═══════════════════════════════════════════════════════════════════════

test("F: corpusIdentityDigest matches sha256(kept sourceId:canonicalTextHash joined by |), independently recomputed", () => {
  const result = runProductionPacker(makeSmallCorpus(10), "run-f", "D:/src");
  const expected = createHash("sha256")
    .update(result.dedup.kept.map((d) => `${d.sourceId}:${d.canonicalTextHash}`).join("|"), "utf8")
    .digest("hex");
  assert.equal(result.digest, expected);
  assert.equal(computeCorpusIdentityDigest(result.dedup.kept), expected);
  assert.match(result.digest, /^[0-9a-f]{64}$/);
});

test("corpus-version.json builder: trackCRegressionFixtures is 0, algorithm fields preserved, documentCount matches kept", () => {
  const result = runProductionPacker(makeSmallCorpus(8), "run-cv", "D:/src");
  const cv = buildCorpusVersionJson(result.dedup.kept, result.digest, "run-cv", "D:/src");
  assert.equal(cv.trackCRegressionFixtures, 0);
  assert.equal(cv.documentCount, result.dedup.kept.length);
  assert.equal(cv.winnowWindow, 15);
  assert.equal(cv.shingleSize, 5);
  assert.equal(cv.stopPolicy, "global DF>=13");
  assert.equal(cv.corpusVersion, "selective-corpus-v1");
});

// ═══════════════════════════════════════════════════════════════════════
// DIGEST ADOPTION — production vs dev/regression trust boundary
// ═══════════════════════════════════════════════════════════════════════

test("digest A: default/production loader accepts the new clean production artifact", { skip: !productionArtifactPresent }, async () => {
  clearSelectiveCorpusArtifactCache();
  const artifact = await loadSelectiveCorpusArtifact(PRODUCTION_ARTIFACT); // no override -- the default production path
  assert.equal(artifact.corpusDigest, SELECTIVE_CORPUS_EXPECTED_DIGEST);
  assert.equal(artifact.documentCount, 9234);
});

test("digest B: default/production loader rejects the OLD fixture-inclusive dev/regression artifact with WRONG_DIGEST", { skip: !devRegressionArtifactPresent }, async () => {
  clearSelectiveCorpusArtifactCache();
  await assert.rejects(
    () => loadSelectiveCorpusArtifact(DEV_REGRESSION_ARTIFACT), // no override -- must fail closed by default
    (e) => e instanceof SelectiveCorpusArtifactError && e.code === "WRONG_DIGEST",
  );
});

test("digest C: an explicit test/regression-only call can still load the OLD fixture-inclusive artifact", { skip: !devRegressionArtifactPresent }, async () => {
  clearSelectiveCorpusArtifactCache();
  const artifact = await loadSelectiveCorpusArtifact(DEV_REGRESSION_ARTIFACT, { expectedDigest: SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST });
  assert.equal(artifact.corpusDigest, SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST);
  assert.notEqual(SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST, SELECTIVE_CORPUS_EXPECTED_DIGEST, "sanity: the two digests really are different constants");
});

test("digest D: an arbitrary wrong digest still fails closed even through the override seam", { skip: !productionArtifactPresent }, async () => {
  clearSelectiveCorpusArtifactCache();
  await assert.rejects(
    () => loadSelectiveCorpusArtifact(PRODUCTION_ARTIFACT, { expectedDigest: "0".repeat(64) }),
    (e) => e instanceof SelectiveCorpusArtifactError && e.code === "WRONG_DIGEST",
  );
});
