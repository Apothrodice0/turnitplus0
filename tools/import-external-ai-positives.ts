import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import mammoth from "mammoth";
import { AI_CONTENT_TOKENS, AI_INPUT_CONTRACT_VERSION, AI_TOKEN_STRIDE } from "../lib/ai-core";

type PassageDiagnostic = {
  logOdds: number;
};

type BenchmarkEntry = {
  id: string;
  benchmarkIndependent?: boolean;
  duplicateOf?: string | null;
  generationEvidence: {
    generationSessionId?: string;
    generationSessionBasis?: string;
    [key: string]: unknown;
  };
  provenance: {
    sourceFileName: string;
    sourceSha256: string;
    textSha256: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type Diagnostic = {
  file: string;
  score: number;
  threshold: number;
  thresholdLogOdds: number;
  passageCount: number;
  flaggedPassages: number;
  top3MeanLogOdds: number;
  logOddsSummary: Record<string, number>;
  passages: PassageDiagnostic[];
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
const model = option("--model");
const generatedAt = option("--generated-at");
const diagnosticsPath = resolve(option("--diagnostics"));
if (!/^\d{4}-\d{2}-\d{2}$/.test(generatedAt)) {
  throw new Error("--generated-at must be an ISO date (YYYY-MM-DD). ");
}

const root = resolve("corpus/ai-positive-benchmark");
const textDir = join(root, "text");
const promptDir = join(root, "prompts");
const manifestPath = join(root, "manifest.json");
const sessionBasis = "User-declared separate ChatGPT chat; local opaque label derived from the source DOCX SHA-256.";
mkdirSync(textDir, { recursive: true });
mkdirSync(promptDir, { recursive: true });

const diagnostics = JSON.parse(readFileSync(diagnosticsPath, "utf8")) as Diagnostic[];
const diagnosticsByFile = new Map(diagnostics.map((row) => [row.file, row]));
const existingManifest = (() => {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as { entries?: BenchmarkEntry[] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
    throw error;
  }
})();
const existingEntries = existingManifest.entries ?? [];
for (const entry of existingEntries) {
  entry.generationEvidence.generationSessionId ??= `chat-session-${entry.provenance.sourceSha256.slice(0, 12)}`;
  entry.generationEvidence.generationSessionBasis ??= sessionBasis;
  entry.benchmarkIndependent ??= true;
  entry.duplicateOf ??= null;
}
const existingBySourceHash = new Map(existingEntries.map((entry) => [entry.provenance.sourceSha256, entry]));
const seenSourceHashes = new Set(existingBySourceHash.keys());
const textOwner = new Map(existingEntries.map((entry) => [entry.provenance.textSha256, entry.id]));
const newEntries: BenchmarkEntry[] = [];
const refreshedEntries: BenchmarkEntry[] = [];

function diagnosticPayload(diagnostic: Diagnostic) {
  return {
    model: "modernbert-raid-mage-onnx-fp32-official-v2",
    inputContractVersion: AI_INPUT_CONTRACT_VERSION,
    chunking: "token-based-overlapping-windows",
    contentWindowTokens: AI_CONTENT_TOKENS,
    tokenStride: AI_TOKEN_STRIDE,
    coveragePercent: diagnostic.score,
    passageThreshold: diagnostic.threshold,
    passageLogOddsThreshold: diagnostic.thresholdLogOdds,
    passageCount: diagnostic.passageCount,
    flaggedPassages: diagnostic.flaggedPassages,
    top3MeanLogOdds: diagnostic.top3MeanLogOdds,
    logOddsSummary: diagnostic.logOddsSummary,
    passageLogOdds: diagnostic.passages.map((passage) => passage.logOdds),
  };
}

for (const input of inputs) {
  const sourceBytes = readFileSync(input);
  const extracted = await mammoth.extractRawText({ buffer: sourceBytes });
  const text = `${extracted.value.trim()}\n`;
  if (!text.trim()) throw new Error(`${input} produced empty text.`);
  const title = text.split(/\n+/).map((value) => value.trim()).find(Boolean);
  if (!title) throw new Error(`${input} has no extractable title.`);

  const sourceFileName = basename(input);
  const diagnostic = diagnosticsByFile.get(sourceFileName);
  if (!diagnostic) throw new Error(`${sourceFileName} has no diagnostic record.`);
  const textSha256 = createHash("sha256").update(text).digest("hex");
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const existing = existingBySourceHash.get(sourceSha256);
  if (existing) {
    if (existing.provenance.textSha256 !== textSha256) {
      throw new Error(`${sourceFileName}: source SHA-256 exists but extracted text SHA-256 changed.`);
    }
    existing.diagnostic = diagnosticPayload(diagnostic);
    refreshedEntries.push(existing);
    continue;
  }
  seenSourceHashes.add(sourceSha256);
  const duplicateOf = textOwner.get(textSha256) ?? null;
  const id = `external-gpt56-${generatedAt.replaceAll("-", "")}-${textSha256.slice(0, 12)}${duplicateOf ? `-${sourceSha256.slice(0, 6)}` : ""}`;
  textOwner.set(textSha256, duplicateOf ?? id);
  const prompt = `write me 2000 words article introduction everything even references.\nabout this topic\n${title}\n`;
  const promptSha256 = createHash("sha256").update(prompt).digest("hex");
  const textPath = `text/${id}.txt`;
  const promptPath = `prompts/${id}.txt`;
  writeFileSync(join(root, textPath), text);
  writeFileSync(join(root, promptPath), prompt);

  newEntries.push({
    id,
    status: "preliminary-external-positive",
    calibrationEligible: false,
    benchmarkIndependent: duplicateOf === null,
    duplicateOf,
    exclusionReason: "Topic-only generation has no paired human source document; excluded from controlled calibration and production thresholds.",
    title,
    language: "English",
    label: "machine",
    machineWordFraction: 1,
    textPath,
    promptPath,
    generationEvidence: {
      provider,
      product,
      modelUserDeclared: model,
      generatedAt,
      promptSha256,
      promptOrigin: "User-declared prompt template with the extracted document title substituted as the topic.",
      sourceHumanId: null,
      generationSessionId: `chat-session-${sourceSha256.slice(0, 12)}`,
      generationSessionBasis: sessionBasis,
    },
    provenance: {
      source: "user-supplied DOCX",
      sourceFileName,
      sourceSha256,
      textSha256,
      receivedAt: "2026-08-07",
    },
    diagnostic: diagnosticPayload(diagnostic),
  });
}

const copyNumber = (entry: BenchmarkEntry) => Number(entry.provenance.sourceFileName.match(/\((\d+)\)/)?.[1] ?? Number.MAX_SAFE_INTEGER);
const entries = [...existingEntries, ...newEntries].sort((a, b) => copyNumber(a) - copyNumber(b));

const output = {
  schema: "turnitplus-external-ai-positive-benchmark",
  version: 2,
  generatedAt: new Date().toISOString(),
  decisionUse: "Diagnostic positive-control evidence only. Never used for threshold fitting, FPR, recall, AUC, or production verdicts.",
  warning: "The documents are user-attested machine generations without paired human source documents. They are not controlled ai-positive corpus rows.",
  entries,
};
writeFileSync(manifestPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({
  importedSessions: newEntries.length,
  refreshedSessions: refreshedEntries.length,
  independentDocumentsAdded: newEntries.filter((entry) => entry.benchmarkIndependent).length,
  duplicateSessionsAdded: newEntries.filter((entry) => !entry.benchmarkIndependent).length,
  totalSessions: entries.length,
  root,
  ids: newEntries.map((entry) => entry.id),
}, null, 2));
