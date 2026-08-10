import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import mammoth from "mammoth";

type BenchmarkEntry = {
  id: string;
  benchmarkIndependent: boolean;
  duplicateOf: string | null;
  provenance: {
    sourceFileName: string;
    sourceSha256: string;
    textSha256: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type QuarantineEntry = {
  sourceFileName: string;
  sourceSha256: string;
  reason: string;
  receivedAt: string;
};

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing required ${name}.`);
  return args[index + 1];
};
const inputIndex = args.indexOf("--inputs");
if (inputIndex < 0) throw new Error("Missing --inputs followed by one or more DOCX paths.");
const nextOption = args.findIndex((value, index) => index > inputIndex && value.startsWith("--"));
const inputEnd = nextOption < 0 ? args.length : nextOption;
const inputs = args.slice(inputIndex + 1, inputEnd).map((path) => resolve(path));
if (!inputs.length) throw new Error("--inputs requires at least one DOCX path.");

const provider = option("--provider");
const product = option("--product");
const productSlug = product.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
if (!productSlug) throw new Error("--product must contain at least one letter or digit.");
const batchId = option("--batch-id");
const receivedAt = option("--received-at");
if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedAt)) {
  throw new Error("--received-at must be an ISO date (YYYY-MM-DD).");
}
if (!/^[a-z0-9][a-z0-9-]+$/.test(batchId)) {
  throw new Error("--batch-id must contain lowercase letters, digits, and hyphens only.");
}

const root = resolve("corpus/ai-generator-benchmark");
const textDir = join(root, "text");
const manifestPath = join(root, "manifest.json");
mkdirSync(textDir, { recursive: true });

const existingManifest = (() => {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as {
      version?: number;
      generationContexts?: Record<string, Record<string, unknown>>;
      entries?: BenchmarkEntry[];
      quarantined?: QuarantineEntry[];
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], quarantined: [] };
    throw error;
  }
})();
const existingEntries = existingManifest.entries ?? [];
const existingQuarantine = existingManifest.quarantined ?? [];
const generationContexts = existingManifest.generationContexts ?? {};
const batchContext = generationContexts[batchId] ?? {
  providerUserDeclared: provider,
  productUserDeclared: product,
  modelUserDeclared: null,
  generatedAt: null,
  promptTemplateUserDeclared: null,
  promptTemplateSha256: null,
  promptCompleteness: "not supplied",
  sessionBoundaryStatus: "unknown-conservative-single-group",
};
if (batchContext.providerUserDeclared !== provider || batchContext.productUserDeclared !== product) {
  throw new Error(`Batch ${batchId} already belongs to a different provider or product.`);
}
generationContexts[batchId] = batchContext;
const existingBySourceHash = new Map(existingEntries.map((entry) => [entry.provenance.sourceSha256, entry]));
const quarantineKey = (sourceFileName: string, sourceSha256: string) => `${sourceFileName}\0${sourceSha256}`;
const quarantineByKey = new Map(existingQuarantine.map((entry) => [quarantineKey(entry.sourceFileName, entry.sourceSha256), entry]));
const textOwner = new Map(existingEntries.map((entry) => [entry.provenance.textSha256, entry.id]));
const newEntries: BenchmarkEntry[] = [];
const newQuarantine: QuarantineEntry[] = [];
let alreadyPresent = 0;

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function quarantine(sourceFileName: string, sourceSha256: string, reason: string) {
  const key = quarantineKey(sourceFileName, sourceSha256);
  if (quarantineByKey.has(key)) {
    alreadyPresent += 1;
    return;
  }
  const entry = { sourceFileName, sourceSha256, reason, receivedAt };
  quarantineByKey.set(key, entry);
  newQuarantine.push(entry);
}

for (const input of inputs) {
  const sourceFileName = basename(input);
  const sourceBytes = readFileSync(input);
  const sourceSha256 = sha256(sourceBytes);
  if (existingBySourceHash.has(sourceSha256) || quarantineByKey.has(quarantineKey(sourceFileName, sourceSha256))) {
    alreadyPresent += 1;
    continue;
  }
  if (sourceBytes.length === 0) {
    quarantine(sourceFileName, sourceSha256, "zero-byte-source-file");
    continue;
  }
  if (extname(sourceFileName).toLowerCase() !== ".docx") {
    quarantine(sourceFileName, sourceSha256, "unsupported-source-format");
    continue;
  }

  let extractedText: string;
  try {
    extractedText = (await mammoth.extractRawText({ buffer: sourceBytes })).value;
  } catch {
    quarantine(sourceFileName, sourceSha256, "invalid-or-unreadable-docx");
    continue;
  }
  const text = `${extractedText.trim()}\n`;
  if (!text.trim()) {
    quarantine(sourceFileName, sourceSha256, "empty-extracted-text");
    continue;
  }

  const title = text.split(/\n+/).map((value) => value.trim()).find(Boolean) ?? null;
  const textSha256 = sha256(text);
  const duplicateOf = textOwner.get(textSha256) ?? null;
  const id = `external-${productSlug}-${textSha256.slice(0, 12)}${duplicateOf ? `-${sourceSha256.slice(0, 6)}` : ""}`;
  textOwner.set(textSha256, duplicateOf ?? id);
  const textPath = `text/${id}.txt`;
  writeFileSync(join(root, textPath), text);

  const entry: BenchmarkEntry = {
    id,
    status: "provenance-incomplete-positive-control",
    trainingEligible: false,
    calibrationEligible: false,
    benchmarkIndependent: duplicateOf === null,
    duplicateOf,
    exclusionReason: "Exact model, prompt, generation date, and per-document chat boundaries were not supplied; excluded from fitting and headline evaluation until provenance is completed.",
    title,
    language: "English",
    label: "machine",
    machineWordFraction: 1,
    textPath,
    generationEvidence: {
      providerUserDeclared: provider,
      productUserDeclared: product,
      modelUserDeclared: batchContext.modelUserDeclared,
      generatedAt: batchContext.generatedAt,
      prompt: null,
      promptSha256: null,
      promptTemplateUserDeclared: batchContext.promptTemplateUserDeclared,
      promptTemplateSha256: batchContext.promptTemplateSha256,
      promptCompleteness: batchContext.promptCompleteness,
      topicPlacementUserDeclared: batchContext.topicPlacementUserDeclared ?? null,
      sessionBoundaryStatus: batchContext.sessionBoundaryStatus,
      generationSessionId: batchContext.sessionBoundaryStatus === "user-declared-separate-chats"
        ? `${productSlug}-session-${sourceSha256.slice(0, 12)}`
        : null,
      generationSessionBasis: batchContext.sessionBoundaryStatus === "user-declared-separate-chats"
        ? `User-declared separate ${product} chat; local opaque label derived from the source DOCX SHA-256.`
        : null,
      evaluationGroupId: batchId,
      evaluationGroupBasis: "All files share one conservative group because per-document Claude chat boundaries were not supplied.",
      userAttestation: `The uploader identified this batch as ${product} output.`,
    },
    missingRequiredFields: [
      ...(batchContext.modelUserDeclared === null ? ["exact model/version"] : []),
      "complete per-document prompt including topic",
      ...(batchContext.generatedAt === null ? ["generation date"] : []),
      ...(batchContext.sessionBoundaryStatus === "unknown-conservative-single-group" ? ["per-document chat/session boundary"] : []),
    ],
    provenance: {
      source: "user-supplied DOCX archive",
      sourceFileName,
      sourceSha256,
      textSha256,
      receivedAt,
    },
  };
  existingBySourceHash.set(sourceSha256, entry);
  newEntries.push(entry);
}

const entries = [...existingEntries, ...newEntries].sort((a, b) => a.id.localeCompare(b.id));
const quarantined = [...existingQuarantine, ...newQuarantine].sort((a, b) => a.sourceFileName.localeCompare(b.sourceFileName));
const output = {
  schema: "turnitplus-generator-diversity-benchmark",
  version: 3,
  generatedAt: new Date().toISOString(),
  decisionUse: "Positive-control diversity evidence only. Never used for model fitting, threshold selection, recall, AUC, or production claims until the missing provenance fields are completed.",
  warning: "Generation context is user-declared per batch. Rows remain excluded whenever complete per-document prompts or genuine chat boundaries are missing.",
  generationContexts,
  entries,
  quarantined,
};
writeFileSync(manifestPath, `${JSON.stringify(output, null, 2)}\n`);

console.log(JSON.stringify({
  receivedFiles: inputs.length,
  importedDocuments: newEntries.length,
  independentDocumentsAdded: newEntries.filter((entry) => entry.benchmarkIndependent).length,
  duplicateDocumentsAdded: newEntries.filter((entry) => !entry.benchmarkIndependent).length,
  quarantinedFiles: newQuarantine.length,
  alreadyPresent,
  totalDocuments: entries.length,
  totalQuarantined: quarantined.length,
  batchId,
}, null, 2));
