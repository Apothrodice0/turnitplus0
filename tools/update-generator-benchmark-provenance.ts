import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const manifestPath = resolve("corpus/ai-generator-benchmark/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  schema: string;
  version: number;
  generatedAt: string;
  decisionUse: string;
  warning: string;
  entries: Array<Record<string, any>>;
  quarantined: Array<Record<string, unknown>>;
  declaredGenerationContext?: Record<string, unknown>;
  generationContexts?: Record<string, Record<string, unknown>>;
};
if (manifest.schema !== "turnitplus-generator-diversity-benchmark") {
  throw new Error("Unexpected generator-diversity benchmark schema.");
}

const modelUserDeclared = "Opus 5 high";
const generatedAt = "2026-08-09";
const promptTemplateUserDeclared = [
  "Write me 3000 words essay about this topic intro metho question and everything i want full article even bibliography list dont ask question:",
  "",
  "- Write me 2000 words essay about this topic dont ask question:",
  "    Write me 3000 words essay about this topic intro metho question and everything i want full article even bibliography list dont ask question:",
  "  -",
].join("\n");
const promptTemplateSha256 = createHash("sha256").update(promptTemplateUserDeclared).digest("hex");
const remainingMissing = [
  "complete per-document prompt including topic",
];

manifest.version = 3;
manifest.generatedAt = new Date().toISOString();
manifest.warning = "Provider, product, model, generation date, prompt-template wording, topic placement, and separate-chat boundaries are user-declared. Exact per-document topic wording/prompts remain unknown.";
manifest.generationContexts = {
  ...(manifest.generationContexts ?? {}),
  "claude-upload-20260809": {
  providerUserDeclared: "Anthropic",
  productUserDeclared: "Claude",
  modelUserDeclared,
  generatedAt,
  promptTemplateUserDeclared,
  promptTemplateSha256,
  promptCompleteness: "template-only; individual topic text and exact per-document prompt were not supplied",
  topicPlacementUserDeclared: "The topic was included with the prompt, not supplied afterward.",
  sessionBoundaryStatus: "user-declared-separate-chats",
  },
};
delete manifest.declaredGenerationContext;

for (const entry of manifest.entries) {
  const evidence = entry.generationEvidence;
  if (!evidence || evidence.providerUserDeclared !== "Anthropic" || evidence.productUserDeclared !== "Claude") {
    throw new Error(`${entry.id ?? "unknown entry"}: unexpected provider or product.`);
  }
  evidence.modelUserDeclared = modelUserDeclared;
  evidence.generatedAt = generatedAt;
  evidence.prompt = null;
  evidence.promptSha256 = null;
  evidence.promptTemplateUserDeclared = promptTemplateUserDeclared;
  evidence.promptTemplateSha256 = promptTemplateSha256;
  evidence.promptCompleteness = "template-only; individual topic text and exact per-document prompt were not supplied";
  evidence.topicPlacementUserDeclared = "The topic was included with the prompt, not supplied afterward.";
  evidence.sessionBoundaryStatus = "user-declared-separate-chats";
  evidence.generationSessionId = `claude-session-${entry.provenance.sourceSha256.slice(0, 12)}`;
  evidence.generationSessionBasis = "User-declared separate Claude chat; local opaque label derived from the source DOCX SHA-256.";
  evidence.userAttestation = "The uploader identified this batch as separate-chat Claude Opus 5 high output generated on 2026-08-09, with each topic included with the prompt.";
  entry.missingRequiredFields = remainingMissing;
  entry.exclusionReason = "Complete per-document prompts were not supplied; excluded from fitting and headline evaluation until that provenance is completed.";
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({
  updatedDocuments: manifest.entries.length,
  modelUserDeclared,
  generatedAt,
  promptTemplateSha256,
  remainingMissing,
}, null, 2));
