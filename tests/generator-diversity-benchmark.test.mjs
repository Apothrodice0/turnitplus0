import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync("corpus/ai-generator-benchmark/manifest.json", "utf8"));

test("Claude diversity batch stays isolated until provenance is completed", () => {
  assert.equal(manifest.schema, "turnitplus-generator-diversity-benchmark");
  assert.equal(manifest.version, 3);
  assert.equal(manifest.entries.length, 18);
  assert.equal(manifest.quarantined.length, 2);
  assert.equal(new Set(manifest.entries.map((entry) => entry.generationEvidence.evaluationGroupId)).size, 1);
  for (const entry of manifest.entries) {
    assert.equal(entry.generationEvidence.providerUserDeclared, "Anthropic");
    assert.equal(entry.generationEvidence.productUserDeclared, "Claude");
    assert.equal(entry.generationEvidence.modelUserDeclared, "Opus 5 high");
    assert.equal(entry.generationEvidence.prompt, null);
    assert.equal(entry.generationEvidence.generatedAt, "2026-08-09");
    assert.equal(entry.generationEvidence.promptTemplateSha256, manifest.generationContexts[entry.generationEvidence.evaluationGroupId].promptTemplateSha256);
    assert.equal(entry.generationEvidence.topicPlacementUserDeclared, "The topic was included with the prompt, not supplied afterward.");
    assert.equal(entry.generationEvidence.sessionBoundaryStatus, "user-declared-separate-chats");
    assert.match(entry.generationEvidence.generationSessionId, /^claude-session-[a-f0-9]{12}$/);
    assert.deepEqual(entry.missingRequiredFields, [
      "complete per-document prompt including topic",
    ]);
    assert.equal(entry.trainingEligible, false);
    assert.equal(entry.calibrationEligible, false);
  }
  assert.equal(new Set(manifest.entries.map((entry) => entry.generationEvidence.generationSessionId)).size, 18);
  assert.deepEqual(
    manifest.quarantined.map((entry) => entry.reason),
    ["zero-byte-source-file", "zero-byte-source-file"],
  );
});
