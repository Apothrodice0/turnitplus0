import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import {
  SCORING_IGNORABLE_FORMAT_RANGES,
  hasScoringIgnorableFormatCharacter,
  normalizeScoringV1,
  normalizeScoringV2,
  tokensForScoringNormalization,
} from "../lib/similarity-core.ts";
import { runWithScoringNormalization } from "../lib/scoring-normalization-scope.ts";
import {
  artifactNormalizationCompatibility,
  scoringContractsAgreeOnText,
  ArtifactNormalizationIncompatibleError,
  SCORING_IGNORABLE_TEXT_GLOB,
} from "../lib/scoring-normalization-artifacts.ts";
import { seedArchiveDocument } from "../lib/archive-corpus-seed.ts";
import { rebuildArchiveScalableIndex } from "../lib/archive-index-build.ts";
import { matchAgainstArchiveCorpus, archiveIndexNormalizationIdentity } from "../lib/archive-corpus-matching.ts";
import {
  createReusableDocumentRepresentation,
  recordCorpusShingles,
  findContractDependentCorpusRepresentations,
} from "../lib/user-submission-corpus.ts";
import { matchAgainstUserSubmissionCorpus } from "../lib/user-submission-matching.ts";
import { SELECTIVE_CORPUS_NORMALIZATION_IDENTITY, SELECTIVE_CORPUS_EXPECTED_DIGEST, SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST } from "../lib/selective-corpus/constants.ts";
import { runSelectiveCorpusShadow } from "../lib/selective-corpus/shadow.ts";

/**
 * Discovery / index artifacts and the scoring-normalization contract
 * (lib/scoring-normalization-artifacts.ts): a report stamped with contract C
 * reads an artifact only when its identity is BUILT_UNDER C or proven
 * CONTRACT_INDEPENDENT; anything else is refused or reported partial, never a
 * completed result. Synthetic fixtures only.
 */

const syn = (ns, n) => [...Array(n).keys()].map((i) => `zq${ns}x${i.toString(36)}v`);
const SHY = "­"; // soft hyphen: v1 splits the word, v2 joins it
const WJ = "⁠"; // word joiner
// Every 6th word carries a soft hyphen inside it: v1 and v2 tokenize differently.
const softHyphenated = (words) => words.map((word, i) => (i % 6 === 0 ? `${word.slice(0, 4)}${SHY}${word.slice(4)}` : word));

// ══ the policy itself ══════════════════════════════════════════════════════
test("compatibility matrix: same contract / independent allowed; other contract / unknown refused", () => {
  const v1 = { kind: "BUILT_UNDER", version: 1, proof: "t" };
  const v2 = { kind: "BUILT_UNDER", version: 2, proof: "t" };
  const independent = { kind: "CONTRACT_INDEPENDENT", proof: "t" };
  const unknown = { kind: "UNKNOWN", reason: "no record" };
  assert.deepEqual(artifactNormalizationCompatibility(1, v1), { compatible: true, basis: "SAME_CONTRACT" }, "A");
  assert.deepEqual(artifactNormalizationCompatibility(2, v2), { compatible: true, basis: "SAME_CONTRACT" }, "B");
  assert.equal(artifactNormalizationCompatibility(1, v2).compatible, false, "C");
  assert.equal(artifactNormalizationCompatibility(1, v2).reason, "CONTRACT_MISMATCH");
  assert.equal(artifactNormalizationCompatibility(2, v1).compatible, false, "D");
  assert.deepEqual(artifactNormalizationCompatibility(1, independent), { compatible: true, basis: "CONTRACT_INDEPENDENT" }, "E");
  assert.deepEqual(artifactNormalizationCompatibility(2, independent), { compatible: true, basis: "CONTRACT_INDEPENDENT" }, "E");
  for (const version of [1, 2]) assert.equal(artifactNormalizationCompatibility(version, unknown).reason, "UNKNOWN_CONTRACT");
});

test("proof basis: no code point outside the ignorable set decomposes or case-maps into one, so a text without one normalizes identically under v1 and v2", () => {
  const ignorable = (cp) => SCORING_IGNORABLE_FORMAT_RANGES.some(([first, last]) => cp >= first && cp <= last);
  const offenders = [];
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (ignorable(cp)) continue;
    const ch = String.fromCodePoint(cp);
    if (hasScoringIgnorableFormatCharacter(ch.normalize("NFKD").toLowerCase())) offenders.push(cp);
    else if (normalizeScoringV1(ch) !== normalizeScoringV2(ch)) offenders.push(cp);
  }
  assert.deepEqual(offenders, []);
});

test("token-stream proof: a mark at a word boundary agrees, one inside a word does not", () => {
  assert.equal(scoringContractsAgreeOnText("plain text with no format characters"), true);
  assert.equal(scoringContractsAgreeOnText(`alpha ${WJ}beta gamma`), true);
  assert.equal(scoringContractsAgreeOnText(`inter${SHY}national law`), false);
  assert.notDeepEqual(tokensForScoringNormalization(`inter${SHY}national`, 1), tokensForScoringNormalization(`inter${SHY}national`, 2));
});

test("the SQL GLOB narrowing selects exactly the texts hasScoringIgnorableFormatCharacter selects, astral ranges included", async () => {
  const client = createClient({ url: ":memory:" });
  try {
    await client.execute("CREATE TABLE t (cp INTEGER, txt TEXT)");
    const rows = [];
    for (const [first, last] of SCORING_IGNORABLE_FORMAT_RANGES) {
      for (let cp = first - 1; cp <= last + 1; cp += 1) rows.push([cp, `abc${String.fromCodePoint(cp)}def`]);
    }
    await client.batch(rows.map(([cp, txt]) => ({ sql: "INSERT INTO t VALUES (?, ?)", args: [cp, txt] })), "write");
    const hit = new Set((await client.execute({ sql: "SELECT cp FROM t WHERE txt GLOB ?", args: [SCORING_IGNORABLE_TEXT_GLOB] })).rows.map((row) => Number(row.cp)));
    for (const [cp, txt] of rows) assert.equal(hit.has(cp), hasScoringIgnorableFormatCharacter(txt), `U+${cp.toString(16)}`);
  } finally {
    client.close();
  }
});

// ══ fixture databases (all built before the first DB test is registered) ══
const dbFiles = [];
async function freshDb(name) {
  const dbFile = path.join(process.cwd(), `test_scoring_normalization_artifacts_${name}.db`);
  for (const suffix of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + suffix); } catch {} }
  dbFiles.push(dbFile);
  const client = createClient({ url: `file:${dbFile}` });
  await client.execute("PRAGMA foreign_keys = ON");
  await applyMigrationsLibsql(client, path.join(process.cwd(), "drizzle"));
  return client;
}
test.after(() => {
  for (const dbFile of dbFiles) for (const suffix of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(dbFile + suffix); } catch {} }
});

// ── Archive ────────────────────────────────────────────────────────────────
const PASSAGE = syn(100, 120);
const ARCHIVE_PARAMS = { minimumMatchedWords: 5, maximumDocumentFrequency: 6, minimumSourceContribution: 0.5, maximumContributingSources: 10, sourceWeighting: "raw" };
const ARCHIVE_SUBMISSION = [...syn(900, 200), ...PASSAGE, ...syn(901, 200)].join(" ");
async function buildArchive(name, docs) {
  const client = await freshDb(name);
  for (const [order, doc] of docs.entries()) {
    const seeded = await seedArchiveDocument(client, { archiveArticleId: doc.id, title: doc.id, originalSimilarity: null, text: doc.body, archiveOrder: order }, {
      corpusVersion: "test-scoring-normalization-artifacts-v1",
      firstSeenAt: "2020-01-01 00:00:00",
    });
    assert.equal(seeded.status, "SEEDED");
  }
  await rebuildArchiveScalableIndex(client);
  return client;
}
const archiveRun = (client, version) => runWithScoringNormalization(version, async () => {
  try {
    return await matchAgainstArchiveCorpus(client, ARCHIVE_SUBMISSION, { maximumDocumentFrequency: 12, matchingParameters: ARCHIVE_PARAMS });
  } catch (error) {
    return error;
  }
});
const SOURCE = { id: "source", body: [...syn(300, 200), ...PASSAGE, ...syn(301, 200)].join(" ") };
// clean archive: every text tokenizes identically under both contracts
const cleanArchive = await buildArchive("archive-clean", [SOURCE, { id: "other", body: syn(400, 500).join(" ") }]);
const CLEAN = {
  identity: await archiveIndexNormalizationIdentity(cleanArchive),
  v1: await archiveRun(cleanArchive, 1),
  v2: await archiveRun(cleanArchive, 2),
};
cleanArchive.close();
// a format mark at word boundaries only: the text holds one, the tokens do not change
const boundaryArchive = await buildArchive("archive-boundary", [SOURCE, { id: "marked", body: syn(401, 500).join(` ${WJ}`) }]);
const BOUNDARY = { identity: await archiveIndexNormalizationIdentity(boundaryArchive), v1: await archiveRun(boundaryArchive, 1) };
boundaryArchive.close();
// one document tokenizes differently and the index records no build contract
const dependentArchive = await buildArchive("archive-dependent", [SOURCE, { id: "hyphenated", body: softHyphenated(syn(402, 500)).join(" ") }]);
const DEPENDENT = {
  identity: await archiveIndexNormalizationIdentity(dependentArchive),
  v1: await archiveRun(dependentArchive, 1),
  v2: await archiveRun(dependentArchive, 2),
};
dependentArchive.close();

test("Archive A/B/F: an index whose every document tokenizes identically is CONTRACT_INDEPENDENT and serves v1 and v2 identically", () => {
  assert.equal(CLEAN.identity.kind, "CONTRACT_INDEPENDENT");
  assert.ok(!(CLEAN.v1 instanceof Error) && !(CLEAN.v2 instanceof Error));
  assert.ok(CLEAN.v2.matchedWordCount >= PASSAGE.length, "the copied passage is found");
  assert.deepEqual(CLEAN.v1.archiveMatchedPositions, CLEAN.v2.archiveMatchedPositions);
  assert.equal(CLEAN.v1.score, CLEAN.v2.score);
});

test("Archive E: a format mark that changes no token keeps the index CONTRACT_INDEPENDENT (proven, not assumed)", () => {
  assert.equal(BOUNDARY.identity.kind, "CONTRACT_INDEPENDENT");
  assert.match(BOUNDARY.identity.proof, /^1 archive document/);
  assert.deepEqual(BOUNDARY.v1.archiveMatchedPositions, CLEAN.v1.archiveMatchedPositions);
});

test("Archive C/D: an index with a contract-dependent document and no recorded build contract is refused under v1 and v2 — never a zero-match result", () => {
  assert.equal(DEPENDENT.identity.kind, "UNKNOWN");
  for (const [version, result] of [[1, DEPENDENT.v1], [2, DEPENDENT.v2]]) {
    assert.ok(result instanceof ArtifactNormalizationIncompatibleError, `v${version} is refused`);
    assert.equal(result.code, "ARTIFACT_NORMALIZATION_INCOMPATIBLE");
    assert.equal(result.reportVersion, version);
    assert.equal(result.compatibility.reason, "UNKNOWN_CONTRACT");
  }
});

// ── prior submissions (corpus_document_shingles) ───────────────────────────
const PRIOR_PASSAGE = softHyphenated(syn(500, 160));
const PRIOR_SUBMISSION = [...syn(910, 150), ...PRIOR_PASSAGE, ...syn(911, 150)].join(" ");
const MATURE = "2020-01-01 00:00:00";
/** An eligible representation whose shingles were written while `buildVersion` was the active contract. */
async function indexUnder(client, canonicalText, buildVersion) {
  const representation = await createReusableDocumentRepresentation(client, { canonicalText, extractorVersion: "test", firstSeenAt: MATURE });
  await runWithScoringNormalization(buildVersion, () => recordCorpusShingles(client, representation.id, canonicalText));
  return representation.id;
}
const priorRun = (client, version) => runWithScoringNormalization(version, async () => {
  const diagnostics = {};
  const result = await matchAgainstUserSubmissionCorpus(client, { accountId: null, canonicalText: PRIOR_SUBMISSION, diagnostics });
  return { result, diagnostics };
});
const priorClient = await freshDb("prior");
const cleanId = await indexUnder(priorClient, [...syn(600, 300)].join(" "), 2);
const PRIOR_CLEAN = { dependent: await findContractDependentCorpusRepresentations(priorClient), v1: await priorRun(priorClient, 1), v2: await priorRun(priorClient, 2) };
const builtV1 = await indexUnder(priorClient, [...syn(601, 100), ...PRIOR_PASSAGE, ...syn(602, 100)].join(" "), 1);
const PRIOR_V1_BUILT = { dependent: await findContractDependentCorpusRepresentations(priorClient), v1: await priorRun(priorClient, 1), v2: await priorRun(priorClient, 2) };
const builtV2 = await indexUnder(priorClient, [...syn(603, 100), ...PRIOR_PASSAGE, ...syn(604, 100)].join(" "), 2);
const PRIOR_BOTH = { dependent: await findContractDependentCorpusRepresentations(priorClient), v1: await priorRun(priorClient, 1), v2: await priorRun(priorClient, 2) };
priorClient.close();

test("prior H: a corpus of representations that tokenize identically is read under v1 and v2 with no incompatibility", () => {
  assert.ok(cleanId);
  assert.deepEqual(PRIOR_CLEAN.dependent, []);
  for (const run of [PRIOR_CLEAN.v1, PRIOR_CLEAN.v2]) {
    assert.equal(run.diagnostics.indexNormalizationIncompatibleRepresentations, 0);
    assert.equal(run.result.partial, undefined);
    assert.equal(run.result.indexNormalizationIncompatible, undefined);
  }
});

test("prior: the build contract of a contract-dependent representation is proven from its stored rows", () => {
  assert.deepEqual(PRIOR_V1_BUILT.dependent.map((rep) => [rep.representationId, rep.identity.kind, rep.identity.version]), [[builtV1, "BUILT_UNDER", 1]]);
  const byId = new Map(PRIOR_BOTH.dependent.map((rep) => [rep.representationId, rep.identity]));
  assert.equal(byId.get(builtV1).version, 1);
  assert.equal(byId.get(builtV2).version, 2);
  assert.equal(byId.size, 2, "the clean representation is not contract-dependent");
});

test("prior A/C/D/G: v1 rows read under v1 stay complete; read under v2 — or v2 rows under v1 — the pass is partial and flagged, never a complete result", () => {
  assert.equal(PRIOR_V1_BUILT.v1.diagnostics.indexNormalizationIncompatibleRepresentations, 0, "A: v1 report + v1 rows");
  assert.equal(PRIOR_V1_BUILT.v1.result.partial, undefined);
  assert.equal(PRIOR_V1_BUILT.v2.diagnostics.indexNormalizationIncompatibleRepresentations, 1, "D: v2 report + v1 rows");
  assert.equal(PRIOR_V1_BUILT.v2.result.partial, true);
  assert.equal(PRIOR_V1_BUILT.v2.result.indexNormalizationIncompatible, true);
  for (const version of [1, 2]) {
    const run = PRIOR_BOTH[`v${version}`];
    assert.equal(run.diagnostics.indexNormalizationIncompatibleRepresentations, 1, `v${version}: exactly the other contract's representation`);
    assert.equal(run.result.partial, true, "C / G: no silent upgrade, no complete result");
    assert.equal(run.result.indexNormalizationIncompatible, true);
    assert.notEqual(run.diagnostics.stopReason, undefined);
  }
});

// ── Selective Corpus ───────────────────────────────────────────────────────
test("Selective: the pinned production artifact is declared CONTRACT_INDEPENDENT, the v1-built dev artifact BUILT_UNDER v1", () => {
  assert.equal(SELECTIVE_CORPUS_NORMALIZATION_IDENTITY[SELECTIVE_CORPUS_EXPECTED_DIGEST].kind, "CONTRACT_INDEPENDENT");
  assert.deepEqual(
    [SELECTIVE_CORPUS_NORMALIZATION_IDENTITY[SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST].kind, SELECTIVE_CORPUS_NORMALIZATION_IDENTITY[SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST].version],
    ["BUILT_UNDER", 1],
  );
});

test("Selective C/D: an artifact read under an incompatible contract — or one with no declaration — is ARTIFACT_UNAVAILABLE, never COMPLETED", async () => {
  const previous = process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
  process.env.SELECTIVE_CORPUS_SHADOW_ENABLED = "true";
  try {
    const stub = (corpusDigest) => ({ corpusDigest, corpusVersion: "selective-corpus-v1", documentCount: 1, docs: [], docByOrdinal: [], stopHashes: new Set() });
    const run = (version, corpusDigest) => runWithScoringNormalization(version, () =>
      runSelectiveCorpusShadow({ canonicalSubmissionText: "word ".repeat(400), authoritative: null, artifactOverride: stub(corpusDigest) }));
    for (const [version, digest] of [[2, SELECTIVE_CORPUS_DEV_REGRESSION_DIGEST], [1, "f".repeat(64)], [2, "f".repeat(64)]]) {
      const result = await run(version, digest);
      assert.equal(result.state, "ARTIFACT_UNAVAILABLE", `v${version} / ${digest.slice(0, 8)}`);
      assert.equal(result.failureCode, "NORMALIZATION_INCOMPATIBLE");
    }
  } finally {
    if (previous === undefined) delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED; else process.env.SELECTIVE_CORPUS_SHADOW_ENABLED = previous;
  }
});
