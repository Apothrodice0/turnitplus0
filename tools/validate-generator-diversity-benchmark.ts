import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const root = resolve("corpus/ai-generator-benchmark");
const manifestPath = join(root, "manifest.json");
if (!existsSync(manifestPath)) {
  console.log("Generator-diversity benchmark: 0 documents (not created yet)");
  process.exit(0);
}

type Entry = {
  id?: unknown;
  status?: unknown;
  trainingEligible?: unknown;
  calibrationEligible?: unknown;
  benchmarkIndependent?: unknown;
  duplicateOf?: unknown;
  label?: unknown;
  language?: unknown;
  machineWordFraction?: unknown;
  textPath?: unknown;
  missingRequiredFields?: unknown;
  generationEvidence?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
};
type Quarantine = {
  sourceFileName?: unknown;
  sourceSha256?: unknown;
  reason?: unknown;
  receivedAt?: unknown;
};

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  schema?: unknown;
  version?: unknown;
  decisionUse?: unknown;
  generationContexts?: Record<string, Record<string, unknown>>;
  entries?: Entry[];
  quarantined?: Quarantine[];
};
if (manifest.schema !== "turnitplus-generator-diversity-benchmark" || manifest.version !== 3) throw new Error("Invalid generator-diversity benchmark schema/version.");
if (typeof manifest.decisionUse !== "string" || !manifest.decisionUse.includes("Never used for model fitting")) {
  throw new Error("Generator-diversity decision-use isolation is missing.");
}
if (!Array.isArray(manifest.entries) || !Array.isArray(manifest.quarantined)) throw new Error("Entries and quarantined arrays are required.");

const generationContexts = manifest.generationContexts ?? {};
const ids = new Set<string>();
const sourceHashes = new Set<string>();
const textOwners = new Map<string, string>();
const groupIds = new Set<string>();
const sessionIds = new Set<string>();

for (const entry of manifest.entries) {
  if (typeof entry.id !== "string" || !entry.id) throw new Error("Generator benchmark entry id is required.");
  if (ids.has(entry.id)) throw new Error(`Duplicate generator benchmark id ${entry.id}.`);
  ids.add(entry.id);
  if (entry.status !== "provenance-incomplete-positive-control"
    || entry.trainingEligible !== false
    || entry.calibrationEligible !== false) {
    throw new Error(`${entry.id}: incomplete positives must remain isolated from fitting and calibration.`);
  }
  if (entry.label !== "machine" || entry.language !== "English" || entry.machineWordFraction !== 1) {
    throw new Error(`${entry.id}: machine label, English language, and fraction 1 are required.`);
  }
  const evidence = entry.generationEvidence ?? {};
  if (typeof evidence.providerUserDeclared !== "string" || !evidence.providerUserDeclared.trim()
    || typeof evidence.productUserDeclared !== "string" || !evidence.productUserDeclared.trim()) {
    throw new Error(`${entry.id}: user-declared provider and product provenance are required.`);
  }
  if (typeof evidence.evaluationGroupId !== "string" || !evidence.evaluationGroupId) throw new Error(`${entry.id}: evaluationGroupId is required.`);
  groupIds.add(evidence.evaluationGroupId);
  const context = generationContexts[evidence.evaluationGroupId];
  if (!context) throw new Error(`${entry.id}: generation context is missing for ${evidence.evaluationGroupId}.`);
  if (evidence.providerUserDeclared !== context.providerUserDeclared || evidence.productUserDeclared !== context.productUserDeclared) {
    throw new Error(`${entry.id}: provider/product differs from the batch context.`);
  }
  if (evidence.modelUserDeclared !== context.modelUserDeclared || evidence.generatedAt !== context.generatedAt) {
    throw new Error(`${entry.id}: declared model/date differs from the batch context.`);
  }
  if (evidence.prompt !== null || evidence.promptSha256 !== null) {
    throw new Error(`${entry.id}: incomplete per-document prompt must remain null.`);
  }
  let declaredTemplateHash: string | null = null;
  if (context.promptTemplateUserDeclared !== null) {
    if (typeof context.promptTemplateUserDeclared !== "string" || !context.promptTemplateUserDeclared.trim()) {
      throw new Error(`${entry.id}: invalid prompt template in batch context.`);
    }
    declaredTemplateHash = createHash("sha256").update(context.promptTemplateUserDeclared).digest("hex");
    if (context.promptTemplateSha256 !== declaredTemplateHash) throw new Error(`${entry.id}: prompt-template SHA-256 mismatch.`);
  } else if (context.promptTemplateSha256 !== null) {
    throw new Error(`${entry.id}: prompt-template hash exists without a template.`);
  }
  if (evidence.promptTemplateUserDeclared !== context.promptTemplateUserDeclared
    || evidence.promptTemplateSha256 !== declaredTemplateHash) {
    throw new Error(`${entry.id}: prompt template differs from the batch context.`);
  }
  if (evidence.sessionBoundaryStatus !== context.sessionBoundaryStatus
    || !["unknown-conservative-single-group", "user-declared-separate-chats"].includes(String(evidence.sessionBoundaryStatus))) {
    throw new Error(`${entry.id}: invalid session-boundary status.`);
  }
  if (evidence.sessionBoundaryStatus === "user-declared-separate-chats") {
    if (typeof evidence.generationSessionId !== "string" || !evidence.generationSessionId) {
      throw new Error(`${entry.id}: separate-chat provenance requires a session id.`);
    }
    if (sessionIds.has(evidence.generationSessionId)) throw new Error(`${entry.id}: separate-chat session ids must be unique.`);
    sessionIds.add(evidence.generationSessionId);
    if (typeof evidence.generationSessionBasis !== "string" || !evidence.generationSessionBasis.includes("User-declared separate")) {
      throw new Error(`${entry.id}: separate-chat provenance basis is required.`);
    }
  } else if (evidence.generationSessionId !== null || evidence.generationSessionBasis !== null) {
    throw new Error(`${entry.id}: unknown chat boundaries must not claim a session id.`);
  }
  const requiredMissing = [
    ...(context.modelUserDeclared === null ? ["exact model/version"] : []),
    "complete per-document prompt including topic",
    ...(context.generatedAt === null ? ["generation date"] : []),
    ...(context.sessionBoundaryStatus === "unknown-conservative-single-group" ? ["per-document chat/session boundary"] : []),
  ];
  if (!Array.isArray(entry.missingRequiredFields)
    || entry.missingRequiredFields.length !== requiredMissing.length
    || requiredMissing.some((field) => !(entry.missingRequiredFields as unknown[]).includes(field))) {
    throw new Error(`${entry.id}: missing provenance fields are not fully recorded.`);
  }

  const provenance = entry.provenance ?? {};
  const sourceHash = provenance.sourceSha256;
  const textHash = provenance.textSha256;
  if (typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error(`${entry.id}: source SHA-256 is required.`);
  if (sourceHashes.has(sourceHash)) throw new Error(`${entry.id}: duplicate source SHA-256.`);
  sourceHashes.add(sourceHash);
  if (typeof textHash !== "string" || !/^[a-f0-9]{64}$/.test(textHash)) throw new Error(`${entry.id}: text SHA-256 is required.`);
  if (typeof entry.textPath !== "string" || !entry.textPath || isAbsolute(entry.textPath)) throw new Error(`${entry.id}: invalid text path.`);
  const textPath = resolve(root, entry.textPath);
  if (relative(root, textPath).startsWith("..") || !existsSync(textPath)) throw new Error(`${entry.id}: missing text file.`);
  const textBytes = readFileSync(textPath);
  if (!textBytes.toString("utf8").trim()) throw new Error(`${entry.id}: empty text file.`);
  const actualHash = createHash("sha256").update(textBytes).digest("hex");
  if (actualHash !== textHash) throw new Error(`${entry.id}: text SHA-256 mismatch.`);

  const owner = textOwners.get(textHash);
  if (entry.benchmarkIndependent === true) {
    if (owner) throw new Error(`${entry.id}: duplicate text marked independent.`);
    if (entry.duplicateOf !== null) throw new Error(`${entry.id}: independent text must have duplicateOf null.`);
    textOwners.set(textHash, entry.id);
  } else if (entry.benchmarkIndependent === false) {
    if (!owner || entry.duplicateOf !== owner) throw new Error(`${entry.id}: duplicate text must point to its first owner.`);
  } else {
    throw new Error(`${entry.id}: benchmarkIndependent is required.`);
  }
}

for (const entry of manifest.quarantined) {
  if (typeof entry.sourceFileName !== "string" || !entry.sourceFileName) throw new Error("Quarantined source filename is required.");
  if (typeof entry.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sourceSha256)) throw new Error(`${entry.sourceFileName}: source SHA-256 is required.`);
  if (sourceHashes.has(entry.sourceSha256) && entry.sourceSha256 !== createHash("sha256").update(new Uint8Array()).digest("hex")) {
    throw new Error(`${entry.sourceFileName}: quarantined source also appears as an ingested entry.`);
  }
  if (!["zero-byte-source-file", "unsupported-source-format", "invalid-or-unreadable-docx", "empty-extracted-text"].includes(String(entry.reason))) {
    throw new Error(`${entry.sourceFileName}: unexpected quarantine reason.`);
  }
  if (typeof entry.receivedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.receivedAt)) throw new Error(`${entry.sourceFileName}: quarantine date is required.`);
}

console.log(`Generator-diversity benchmark: ${manifest.entries.length} documents (${textOwners.size} unique), ${manifest.quarantined.length} quarantined, ${groupIds.size} batch, ${sessionIds.size} confirmed separate chats`);
