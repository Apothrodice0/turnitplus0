import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadCorpus } from "../tools/calibration-utils.ts";

function fixture(name, entries) {
  const root = join(process.cwd(), "tests", `.tmp-corpus-${name}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const manifest = entries.map(({ text, ...entry }) => {
    const textPath = `${entry.id}.txt`;
    const bytes = Buffer.from(text);
    writeFileSync(join(root, textPath), bytes);
    return {
      title: null,
      language: null,
      publishedYear: null,
      turnitinScore: null,
      writerPopulation: null,
      writerPopulationBasis: null,
      genre: null,
      discipline: null,
      ...entry,
      textPath,
      provenance: {
        source: "fixture",
        url: null,
        journal: null,
        retrievedAt: null,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ...entry.provenance,
      },
    };
  });
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  return root;
}

test("loads only documents carrying the requested role", () => {
  const root = fixture("roles", [
    {
      id: "similarity", roles: ["index-source", "similarity-calibration"], turnitinScore: 12,
      revisionGroupId: "revision-fixture", calibrationIndependent: true, text: "valid similarity text",
    },
    {
      id: "human", roles: ["ai-negative"], language: "English", publishedYear: 2020,
      writerPopulation: "L2-algerian", writerPopulationBasis: "Fixture affiliation proxy",
      provenance: { url: "fixture://human" }, text: "verified human text",
    },
  ]);
  assert.deepEqual(loadCorpus("index-source", root).map((document) => document.id), ["similarity"]);
  assert.deepEqual(loadCorpus("ai-negative", root).map((document) => document.id), ["human"]);
  rmSync(root, { recursive: true, force: true });
});

test("rejects role leakage between AI and similarity samples", () => {
  const root = fixture("leakage", [{
    id: "mixed", roles: ["index-source", "ai-negative"], language: "English", publishedYear: 2020,
    writerPopulation: "L2-algerian", provenance: { url: "fixture://mixed" }, text: "mixed role text",
  }]);
  assert.throws(() => loadCorpus("ai-negative", root), /must remain separate/);
  rmSync(root, { recursive: true, force: true });
});

test("rejects silent text edits and missing role evidence", () => {
  const root = fixture("evidence", [{
    id: "calibration", roles: ["similarity-calibration"], text: "calibration text without a score",
  }]);
  assert.throws(() => loadCorpus("similarity-calibration", root), /requires turnitinScore/);
  rmSync(root, { recursive: true, force: true });
});

test("rejects an AI-negative row without population-basis evidence", () => {
  const root = fixture("population-basis", [{
    id: "human", roles: ["ai-negative"], language: "English", publishedYear: 2020,
    writerPopulation: "native-english", provenance: { url: "fixture://human" }, text: "verified human text",
  }]);
  assert.throws(() => loadCorpus("ai-negative", root), /writerPopulationBasis/);
  rmSync(root, { recursive: true, force: true });
});

test("loads AI benchmark samples separately with an explicit proxy assumption", () => {
  const root = fixture("benchmark", [{
    id: "benchmark", roles: ["ai-benchmark"], language: null, publishedYear: 2023,
    turnitinScore: null, writerPopulation: "native-english",
    writerPopulationBasis: "User-supplied native-English publication batch; not independently verified.",
    benchmarkStatus: "human-reference-proxy",
    benchmarkAssumption: "Published academic writing supplied as a human-reference proxy.",
    benchmarkExclusionReasons: ["publication-year-not-before-2022"],
    provenance: { url: "fixture://benchmark" }, text: "Human reference text.",
  }]);
  assert.deepEqual(loadCorpus("ai-benchmark", root).map((document) => document.id), ["benchmark"]);
  assert.throws(() => loadCorpus("ai-negative", root), /No corpus documents/);
  rmSync(root, { recursive: true, force: true });
});

test("rejects AI benchmark samples whose proxy assumption is missing", () => {
  const root = fixture("benchmark-missing-assumption", [{
    id: "benchmark", roles: ["ai-benchmark"], language: "English", publishedYear: 2021,
    turnitinScore: null, writerPopulation: "native-english",
    benchmarkStatus: "human-reference-proxy", benchmarkAssumption: null,
    benchmarkExclusionReasons: ["native-speaker-affiliation-proxy-not-approved"],
    provenance: { url: "fixture://benchmark" }, text: "Human reference text.",
  }]);
  assert.throws(() => loadCorpus("ai-benchmark", root), /benchmarkAssumption/);
  rmSync(root, { recursive: true, force: true });
});

test("loads a dated English reference group without inferring native-speaker status", () => {
  const root = fixture("english-reference", [{
    id: "reference", roles: ["ai-benchmark"], language: "English", publishedYear: 2021,
    turnitinScore: null, writerPopulation: null, referenceGroup: "english-reference",
    referenceStatus: "unverified-population-proxy", benchmarkStatus: "human-reference-proxy",
    benchmarkAssumption: "Pre-cutoff English publication supplied as a human-reference proxy.",
    benchmarkExclusionReasons: ["reference-only: not verified AI-negative ground truth"],
    provenance: {
      url: "fixture://reference", publicationDateValue: "2021",
      publicationDateEvidence: "Journal of Fixture Studies 2021",
    },
    text: "English reference text that remains outside calibration.",
  }]);
  const [document] = loadCorpus("ai-benchmark", root);
  assert.equal(document.referenceGroup, "english-reference");
  assert.equal(document.writerPopulation, null);
  assert.throws(() => loadCorpus("ai-negative", root), /No corpus documents/);
  rmSync(root, { recursive: true, force: true });
});

test("rejects an English reference group that claims native-speaker status", () => {
  const root = fixture("english-reference-population", [{
    id: "reference", roles: ["ai-benchmark"], language: "English", publishedYear: 2021,
    turnitinScore: null, writerPopulation: "native-english", referenceGroup: "english-reference",
    referenceStatus: "unverified-population-proxy", benchmarkStatus: "human-reference-proxy",
    benchmarkAssumption: "Pre-cutoff English publication supplied as a human-reference proxy.",
    benchmarkExclusionReasons: ["reference-only"],
    provenance: {
      url: "fixture://reference", publicationDateValue: "2021",
      publicationDateEvidence: "Journal of Fixture Studies 2021",
    },
    text: "English reference text.",
  }]);
  assert.throws(() => loadCorpus("ai-benchmark", root), /must not infer native-speaker population/);
  rmSync(root, { recursive: true, force: true });
});

test("loads a date-ineligible English benchmark but keeps it outside comparison status", () => {
  const root = fixture("date-ineligible-reference", [{
    id: "late-reference", roles: ["ai-benchmark"], language: "English", publishedYear: 2023,
    turnitinScore: null, writerPopulation: null, referenceGroup: "date-ineligible",
    referenceStatus: "date-ineligible", benchmarkStatus: "human-reference-proxy",
    benchmarkAssumption: "Post-cutoff publication retained for scored diagnostics only.",
    benchmarkExclusionReasons: ["date-ineligible-post-2022-10"],
    provenance: {
      url: "fixture://late-reference", publicationDateValue: "2023",
      publicationDateEvidence: "Journal of Fixture Studies 2023",
    },
    text: "Post-cutoff English text retained outside every reference comparison.",
  }]);
  const [document] = loadCorpus("ai-benchmark", root);
  assert.equal(document.referenceStatus, "date-ineligible");
  rmSync(root, { recursive: true, force: true });
});

test("rejects a post-cutoff benchmark marked comparison-eligible", () => {
  const root = fixture("late-comparison-reference", [{
    id: "late-reference", roles: ["ai-benchmark"], language: "English", publishedYear: 2023,
    turnitinScore: null, writerPopulation: null, referenceGroup: "incorrect-comparison-group",
    referenceStatus: "unverified-population-proxy", benchmarkStatus: "human-reference-proxy",
    benchmarkAssumption: "Incorrect fixture.", benchmarkExclusionReasons: ["fixture"],
    provenance: {
      url: "fixture://late-reference", publicationDateValue: "2023",
      publicationDateEvidence: "Journal of Fixture Studies 2023",
    },
    text: "Post-cutoff text must not enter a human-reference comparison.",
  }]);
  assert.throws(() => loadCorpus("ai-benchmark", root), /must be dated before November 2022/);
  rmSync(root, { recursive: true, force: true });
});

test("rejects a text file whose stored hash no longer matches", () => {
  const root = fixture("hash", [{
    id: "source", roles: ["index-source"], text: "original source text",
  }]);
  writeFileSync(join(root, "source.txt"), "silently edited text");
  assert.throws(() => loadCorpus("index-source", root), /sha256 mismatch/);
  rmSync(root, { recursive: true, force: true });
});

test("loads controlled AI-positive and hybrid rows only with complete generation evidence", () => {
  const promptSha256 = "a".repeat(64);
  const root = fixture("ai-evaluation", [
    {
      id: "human", roles: ["ai-benchmark"], text: "Human source text.",
      benchmarkStatus: "human-reference-proxy", benchmarkAssumption: "Fixture human proxy.",
      benchmarkExclusionReasons: ["fixture"], provenance: { url: "fixture://human" },
    },
    {
      id: "machine", roles: ["ai-positive"], language: "English", text: "Controlled generated text.",
      aiGeneration: {
        class: "machine", sourceHumanId: "human", generatorProvider: "fixture",
        generatorModel: "fixture-v1", generatedAt: "2026-08-07", promptSha256,
        evaluationSplit: "test", machineWordFraction: 1,
      },
    },
    {
      id: "hybrid", roles: ["ai-hybrid"], language: "English", text: "Controlled hybrid text.",
      aiGeneration: {
        class: "hybrid", sourceHumanId: "human", generatorProvider: "fixture",
        generatorModel: "fixture-v1", generatedAt: "2026-08-07", promptSha256,
        evaluationSplit: "test", machineWordFraction: 0.5, assemblyMethod: "Alternating labelled sections.",
      },
    },
  ]);
  assert.deepEqual(loadCorpus("ai-positive", root).map((document) => document.id), ["machine"]);
  assert.deepEqual(loadCorpus("ai-hybrid", root).map((document) => document.id), ["hybrid"]);
  rmSync(root, { recursive: true, force: true });
});

test("rejects a fabricated positive label without generation provenance", () => {
  const root = fixture("ai-positive-missing-evidence", [{
    id: "machine", roles: ["ai-positive"], language: "English", text: "Unproven generated text.",
  }]);
  assert.throws(() => loadCorpus("ai-positive", root), /requires aiGeneration evidence/);
  rmSync(root, { recursive: true, force: true });
});
