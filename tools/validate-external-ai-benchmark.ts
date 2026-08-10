import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const root = resolve("corpus/ai-positive-benchmark");
const manifestPath = join(root, "manifest.json");
if (!existsSync(manifestPath)) {
  console.log("External AI-positive benchmark: 0 documents (not created yet)");
  process.exit(0);
}

type ExternalBenchmarkEntry = {
  id?: unknown;
  status?: unknown;
  calibrationEligible?: unknown;
  benchmarkIndependent?: unknown;
  duplicateOf?: unknown;
  label?: unknown;
  machineWordFraction?: unknown;
  language?: unknown;
  textPath?: unknown;
  promptPath?: unknown;
  generationEvidence?: {
    provider?: unknown;
    product?: unknown;
    modelUserDeclared?: unknown;
    generatedAt?: unknown;
    promptSha256?: unknown;
    sourceHumanId?: unknown;
    generationSessionId?: unknown;
    generationSessionBasis?: unknown;
  };
  provenance?: { sourceSha256?: unknown; textSha256?: unknown };
  diagnostic?: { passageLogOdds?: unknown; passageCount?: unknown };
};

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  schema?: string;
  decisionUse?: string;
  entries?: ExternalBenchmarkEntry[];
};
if (manifest.schema !== "turnitplus-external-ai-positive-benchmark") throw new Error("Invalid external AI-positive benchmark schema.");
if (!manifest.decisionUse?.includes("Never used for threshold fitting")) throw new Error("Benchmark decision-use isolation is missing.");
if (!Array.isArray(manifest.entries)) throw new Error("Benchmark entries must be an array.");

const seen = new Set<string>();
const seenSessions = new Set<string>();
const textOwners = new Map<string, string>();
for (const entry of manifest.entries) {
  if (typeof entry.id !== "string" || !entry.id) throw new Error("Benchmark entry id is required.");
  if (seen.has(entry.id)) throw new Error(`Duplicate benchmark id ${entry.id}.`);
  seen.add(entry.id);
  if (entry.status !== "preliminary-external-positive" || entry.calibrationEligible !== false) {
    throw new Error(`${entry.id}: external positives must remain preliminary and calibration-ineligible.`);
  }
  if (typeof entry.benchmarkIndependent !== "boolean") throw new Error(`${entry.id}: benchmarkIndependent is required.`);
  if (entry.label !== "machine" || entry.machineWordFraction !== 1 || entry.language !== "English") {
    throw new Error(`${entry.id}: machine label, fraction 1, and English language are required.`);
  }
  if (entry.generationEvidence?.provider !== "OpenAI" || entry.generationEvidence?.product !== "ChatGPT") {
    throw new Error(`${entry.id}: declared OpenAI ChatGPT generation evidence is required.`);
  }
  if (typeof entry.generationEvidence?.modelUserDeclared !== "string" || !entry.generationEvidence.modelUserDeclared.trim()) {
    throw new Error(`${entry.id}: user-declared generator model is required.`);
  }
  if (typeof entry.generationEvidence?.generatedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(entry.generationEvidence.generatedAt)) {
    throw new Error(`${entry.id}: ISO generation date is required.`);
  }
  if (entry.generationEvidence?.sourceHumanId !== null) {
    throw new Error(`${entry.id}: topic-only external positives must not claim a sourceHumanId.`);
  }
  if (typeof entry.generationEvidence?.generationSessionId !== "string" || !entry.generationEvidence.generationSessionId) {
    throw new Error(`${entry.id}: a local generation-session label is required.`);
  }
  if (seenSessions.has(entry.generationEvidence.generationSessionId)) {
    throw new Error(`${entry.id}: generation sessions must be unique because the user declared separate chats.`);
  }
  seenSessions.add(entry.generationEvidence.generationSessionId);
  if (entry.generationEvidence.generationSessionBasis !== "User-declared separate ChatGPT chat; local opaque label derived from the source DOCX SHA-256.") {
    throw new Error(`${entry.id}: generation-session provenance basis is missing or unexpected.`);
  }
  if (typeof entry.provenance?.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.provenance.sourceSha256)) {
    throw new Error(`${entry.id}: source DOCX SHA-256 is required.`);
  }

  const validateFile = (pathValue: unknown, expectedHash: unknown, label: string) => {
    if (typeof pathValue !== "string" || !pathValue || isAbsolute(pathValue)) throw new Error(`${entry.id}: invalid ${label} path.`);
    const path = resolve(root, pathValue);
    if (relative(root, path).startsWith("..") || !existsSync(path)) throw new Error(`${entry.id}: missing ${label}.`);
    const bytes = readFileSync(path);
    if (!bytes.toString("utf8").trim()) throw new Error(`${entry.id}: empty ${label}.`);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expectedHash) throw new Error(`${entry.id}: ${label} SHA-256 mismatch.`);
  };
  validateFile(entry.textPath, entry.provenance?.textSha256, "text");
  validateFile(entry.promptPath, entry.generationEvidence?.promptSha256, "prompt");

  const textHash = entry.provenance?.textSha256;
  if (typeof textHash !== "string") throw new Error(`${entry.id}: text SHA-256 is required.`);
  const existingTextOwner = textOwners.get(textHash);
  if (entry.benchmarkIndependent) {
    if (existingTextOwner) throw new Error(`${entry.id}: duplicate text cannot be marked benchmark-independent.`);
    if (entry.duplicateOf !== null) throw new Error(`${entry.id}: independent entry must have duplicateOf null.`);
    textOwners.set(textHash, entry.id);
  } else {
    if (!existingTextOwner || entry.duplicateOf !== existingTextOwner) {
      throw new Error(`${entry.id}: duplicate session must point to the first independent text owner.`);
    }
  }

  if (!entry.diagnostic || !Array.isArray(entry.diagnostic.passageLogOdds) || entry.diagnostic.passageLogOdds.length !== entry.diagnostic.passageCount) {
    throw new Error(`${entry.id}: complete passage log-odds distribution is required.`);
  }
}

const independent = manifest.entries.filter((entry) => entry.benchmarkIndependent).length;
console.log(`External AI-positive benchmark: ${manifest.entries.length} validated sessions (${independent} unique documents)`);
