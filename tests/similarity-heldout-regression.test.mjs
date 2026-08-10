import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import manifest from "../corpus/similarity-regression/manifest.json" with { type: "json" };
import evaluation from "../corpus/audit/similarity-heldout-regression.json" with { type: "json" };
import corpusManifest from "../corpus/manifest.json" with { type: "json" };

test("held-out similarity originals remain isolated and hash verified", () => {
  assert.equal(manifest.schema, "turnitplus-similarity-heldout-regression");
  assert.equal(manifest.documents.length, 8);
  const ids = new Set(manifest.documents.map((document) => document.id));
  assert.equal(ids.size, 8);
  const corpusIds = new Set(corpusManifest.map((entry) => entry.id));
  for (const document of manifest.documents) {
    const bytes = readFileSync(new URL(`../corpus/similarity-regression/${document.textPath}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), document.textSha256);
    assert.equal(corpusIds.has(document.id), false);
  }
});

test("held-out evaluation is reproducible and explicitly isolated from fitting", () => {
  assert.match(evaluation.selectionIsolation, /locked.*284 independent calibration rows/i);
  assert.equal(evaluation.perDocument.length, 8);
  const recompute = (field) => {
    const errors = evaluation.perDocument.map((row) => row[field] - row.turnitinScore);
    return Number((errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length).toFixed(4));
  };
  assert.equal(evaluation.v99ExactOriginalBaseline.mae, recompute("v99ExactOriginalScore"));
  assert.equal(evaluation.selectedHeldout.mae, recompute("selectedScore"));
});
