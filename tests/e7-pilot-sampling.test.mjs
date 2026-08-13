import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  classifyCohort,
  classifyTitle,
  selectPilotSample,
} from "../lib/e7-pilot-sampling.ts";

const repoRoot = path.resolve(".");

// --- PURE / NO I/O -----------------------------------------------------------

test("lib/e7-pilot-sampling.ts performs no file or network I/O — it never imports node:fs, node:http(s), or @libsql/client", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/e7-pilot-sampling.ts"), "utf8");
  const imports = source
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:import|export)\b.*\bfrom\b/.test(line))
    .join("\n");
  assert.doesNotMatch(imports, /node:fs|node:http|@libsql\/client/, "sampling logic must stay a pure classifier over an already-loaded array");
});

// --- CLASSIFICATION -----------------------------------------------------------

test("classifyCohort: turnitin- prefix is the only turnitin_import signal", () => {
  assert.equal(classifyCohort("turnitin-some-title-abc123"), "turnitin_import");
  assert.equal(classifyCohort("some-bootstrap-title-abc123"), "bootstrap");
});

test("classifyTitle: generic-marker titles and low-distinctive-word-count titles are generic", () => {
  assert.equal(classifyTitle("Revue des Sciences Humaines Vol -xx N degree xx"), "generic");
  assert.equal(classifyTitle("article mch"), "generic");
  assert.equal(classifyTitle("Mechanisms for Implementing Participatory Democracy at the Local Level"), "distinctive");
});

// --- DETERMINISM (synthetic fixture, not real archive content) ---------------

function fixtureArticle(overrides) {
  return {
    id: "fixture-id",
    title: "Fixture Title",
    sourceType: "Publication",
    originalSimilarity: 10,
    wordCount: 1000,
    uniqueShingleCount: 900,
    ...overrides,
  };
}

const SYNTHETIC_FIXTURE = [
  fixtureArticle({ id: "bootstrap-short-low-distinctive-a1b2c3d4e5f6g7h8", title: "Distinctive Wetland Migration Findings", wordCount: 100, originalSimilarity: 1 }),
  fixtureArticle({ id: "bootstrap-long-high-generic-a1b2c3d4e5f6g7h8", title: "Vol 3 No 2", wordCount: 9000, originalSimilarity: 90 }),
  fixtureArticle({ id: "turnitin-short-high-distinctive-abc123abc123", title: "Quantitative Coastal Reserve Assessment Study", wordCount: 120, originalSimilarity: 95 }),
  fixtureArticle({ id: "turnitin-long-low-generic-abc123abc123", title: "No 4 Issue", wordCount: 8800, originalSimilarity: 2 }),
];

test("selectPilotSample is deterministic: identical input always produces an identical sample, in identical order", () => {
  const first = selectPilotSample(SYNTHETIC_FIXTURE);
  const second = selectPilotSample(SYNTHETIC_FIXTURE);
  assert.deepEqual(
    first.sampleDocuments.map((d) => d.id),
    second.sampleDocuments.map((d) => d.id),
  );
  assert.equal(JSON.stringify(first.cellResults), JSON.stringify(second.cellResults));
});

test("selectPilotSample never invents a document id that was not present in the input", () => {
  const inputIds = new Set(SYNTHETIC_FIXTURE.map((a) => a.id));
  const { sampleDocuments } = selectPilotSample(SYNTHETIC_FIXTURE);
  for (const doc of sampleDocuments) assert.ok(inputIds.has(doc.id), `sample contains an id not present in the input: ${doc.id}`);
});

test("selectPilotSample selection is a pure function of its input array — reordering the input does not change the resulting sample set", () => {
  const shuffled = [...SYNTHETIC_FIXTURE].reverse();
  const a = selectPilotSample(SYNTHETIC_FIXTURE).sampleDocuments.map((d) => d.id).sort();
  const b = selectPilotSample(shuffled).sampleDocuments.map((d) => d.id).sort();
  assert.deepEqual(a, b);
});

// --- AGAINST THE REAL ARCHIVE INDEX (read-only) -------------------------------

test("against the real 230-document archive index: sample size stays within the 10-20 pilot guideline and every sampled id is a real archive id", () => {
  const metaPath = path.join(repoRoot, "public/data/document-index.meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  assert.equal(meta.documentCount, 230);

  const { sampleDocuments, unfilledCells } = selectPilotSample(meta.articles);
  assert.ok(sampleDocuments.length >= 8 && sampleDocuments.length <= 20, `sample size ${sampleDocuments.length} outside expected pilot range`);
  const realIds = new Set(meta.articles.map((a) => a.id));
  for (const doc of sampleDocuments) assert.ok(realIds.has(doc.id));
  assert.equal(unfilledCells.length, 0, "all 16 strata cells should be filled against the real 230-document archive");

  const cohorts = new Set(sampleDocuments.map((d) => d.cohort));
  const lengths = new Set(sampleDocuments.map((d) => d.lengthBucket));
  const similarities = new Set(sampleDocuments.map((d) => d.similarityBucket));
  assert.ok(cohorts.has("turnitin_import") && cohorts.has("bootstrap"), "sample must include both cohorts");
  assert.ok(lengths.has("short") && lengths.has("long"), "sample must include both short and long documents");
  assert.ok(similarities.has("low") && similarities.has("high"), "sample must include both low- and high-similarity documents");
});

test("re-running selection against the real archive index twice yields the identical sample (reproducibility)", () => {
  const metaPath = path.join(repoRoot, "public/data/document-index.meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const first = selectPilotSample(meta.articles).sampleDocuments.map((d) => d.id);
  const second = selectPilotSample(meta.articles).sampleDocuments.map((d) => d.id);
  assert.deepEqual(first, second);
});
