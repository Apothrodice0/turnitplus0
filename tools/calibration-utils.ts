import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";

export type Role = "index-source" | "similarity-calibration" | "ai-negative" | "ai-benchmark" | "ai-positive" | "ai-hybrid";
export type WriterPopulation = "L2-algerian" | "native-english";
export type CorpusLanguage = "English" | "French" | "Arabic" | "Mixed";
export type AiEvaluationSplit = "train" | "validation" | "test";

export type AiGenerationEvidence = {
  class: "machine" | "hybrid";
  sourceHumanId: string;
  generatorProvider: string;
  generatorModel: string;
  generatedAt: string;
  promptSha256: string;
  evaluationSplit: AiEvaluationSplit;
  machineWordFraction: number;
  assemblyMethod?: string | null;
};

export type CorpusManifestEntry = {
  id: string;
  roles: Role[];
  textPath: string;
  title: string | null;
  language: CorpusLanguage | null;
  publishedYear: number | null;
  turnitinScore: number | null;
  writerPopulation: WriterPopulation | null;
  writerPopulationBasis?: string | null;
  benchmarkStatus?: "human-reference-proxy" | null;
  referenceStatus?: "unverified-population-proxy" | "date-ineligible" | null;
  referenceGroup?: string | null;
  benchmarkAssumption?: string | null;
  benchmarkExclusionReasons?: string[] | null;
  aiGeneration?: AiGenerationEvidence | null;
  genre: string | null;
  discipline: string | null;
  revisionGroupId?: string | null;
  revisionOrdinal?: number | null;
  calibrationIndependent?: boolean;
  provenance: {
    source: string | null;
    url: string | null;
    journal: string | null;
    retrievedAt: string | null;
    sha256: string | null;
    [key: string]: unknown;
  };
};

export type CorpusDocument = CorpusManifestEntry & { text: string };

const ROLES = new Set<Role>(["index-source", "similarity-calibration", "ai-negative", "ai-benchmark", "ai-positive", "ai-hybrid"]);
const POPULATIONS = new Set<WriterPopulation>(["L2-algerian", "native-english"]);
const AI_EVALUATION_ROLES = new Set<Role>(["ai-negative", "ai-benchmark", "ai-positive", "ai-hybrid"]);
const EVALUATION_SPLITS = new Set<AiEvaluationSplit>(["train", "validation", "test"]);

function fail(id: string, message: string): never {
  throw new Error(`Corpus entry ${id || "<missing-id>"}: ${message}`);
}

export function loadManifest(root = "corpus") {
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`Missing ${manifestPath}.`);
  const value = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  if (!Array.isArray(value)) throw new Error(`${manifestPath} must contain a JSON array.`);
  return value as CorpusManifestEntry[];
}

export function loadCorpus(role: Role, root = "corpus", options: { allowEmpty?: boolean } = {}): CorpusDocument[] {
  if (!ROLES.has(role)) throw new Error(`Unknown corpus role: ${role}`);
  const rootPath = resolve(root);
  const seen = new Set<string>();
  const documents: CorpusDocument[] = [];

  const manifest = loadManifest(root);
  const entriesById = new Map(manifest.map((entry) => [entry.id, entry]));
  for (const entry of manifest) {
    if (!entry || typeof entry !== "object") throw new Error("Every corpus manifest entry must be an object.");
    if (typeof entry.id !== "string" || !entry.id.trim()) fail(entry.id, "id must be a non-empty string");
    if (seen.has(entry.id)) fail(entry.id, "duplicate id");
    seen.add(entry.id);
    if (!Array.isArray(entry.roles) || entry.roles.length === 0) fail(entry.id, "roles must be a non-empty array");
    if (new Set(entry.roles).size !== entry.roles.length || entry.roles.some((candidate) => !ROLES.has(candidate))) {
      fail(entry.id, "roles contain a duplicate or unsupported value");
    }
    const isolatedAiRoles = entry.roles.filter((candidate) => AI_EVALUATION_ROLES.has(candidate));
    if (isolatedAiRoles.length && entry.roles.length !== 1) {
      fail(entry.id, "AI evaluation samples and similarity/index samples must remain separate and role-isolated");
    }
    if (typeof entry.textPath !== "string" || !entry.textPath) fail(entry.id, "textPath is required");
    const textPath = resolve(rootPath, entry.textPath);
    if (isAbsolute(entry.textPath) || relative(rootPath, textPath).startsWith("..")) fail(entry.id, "textPath escapes corpus root");
    if (!existsSync(textPath)) fail(entry.id, `missing text file ${normalize(entry.textPath)}`);
    const bytes = readFileSync(textPath);
    const text = bytes.toString("utf8");
    if (!text.trim()) fail(entry.id, "text file is empty");
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (!entry.provenance || typeof entry.provenance !== "object") fail(entry.id, "provenance object is required");
    if (typeof entry.provenance.sha256 !== "string" || entry.provenance.sha256 !== actualHash) {
      fail(entry.id, `sha256 mismatch (stored ${entry.provenance.sha256 ?? "null"}, actual ${actualHash})`);
    }

    if (entry.roles.includes("similarity-calibration")) {
      if (!Number.isFinite(entry.turnitinScore) || Number(entry.turnitinScore) < 0 || Number(entry.turnitinScore) > 100) {
        fail(entry.id, "similarity-calibration requires turnitinScore in 0..100");
      }
      if (typeof entry.revisionGroupId !== "string" || !entry.revisionGroupId.trim()) {
        fail(entry.id, "similarity-calibration requires revisionGroupId");
      }
      if (entry.calibrationIndependent !== true && entry.calibrationIndependent !== false) {
        fail(entry.id, "similarity-calibration requires calibrationIndependent boolean");
      }
    }
    if (entry.roles.includes("ai-negative")) {
      if (!Number.isInteger(entry.publishedYear) || Number(entry.publishedYear) >= 2022) {
        fail(entry.id, "ai-negative requires publishedYear before 2022");
      }
      if (entry.language !== "English") fail(entry.id, "ai-negative requires language English");
      if (!entry.writerPopulation || !POPULATIONS.has(entry.writerPopulation)) {
        fail(entry.id, "ai-negative requires a supported writerPopulation");
      }
      if (typeof entry.writerPopulationBasis !== "string" || !entry.writerPopulationBasis.trim()) {
        fail(entry.id, "ai-negative requires a documented writerPopulationBasis");
      }
      if (entry.turnitinScore !== null) fail(entry.id, "ai-negative turnitinScore must be null");
      if (typeof entry.provenance.url !== "string" || !entry.provenance.url.trim()) {
        fail(entry.id, "ai-negative requires provenance.url");
      }
    }
    if (entry.roles.includes("ai-benchmark")) {
      if (entry.turnitinScore !== null) fail(entry.id, "ai-benchmark turnitinScore must be null");
      if (entry.benchmarkStatus !== "human-reference-proxy") {
        fail(entry.id, "ai-benchmark requires benchmarkStatus human-reference-proxy");
      }
      if (typeof entry.benchmarkAssumption !== "string" || !entry.benchmarkAssumption.trim()) {
        fail(entry.id, "ai-benchmark requires a documented benchmarkAssumption");
      }
      if (!Array.isArray(entry.benchmarkExclusionReasons) || entry.benchmarkExclusionReasons.length === 0
        || entry.benchmarkExclusionReasons.some((reason) => typeof reason !== "string" || !reason.trim())) {
        fail(entry.id, "ai-benchmark requires non-empty benchmarkExclusionReasons");
      }
      if (typeof entry.provenance.url !== "string" || !entry.provenance.url.trim()) {
        fail(entry.id, "ai-benchmark requires provenance.url");
      }
      if (entry.referenceGroup !== undefined && entry.referenceGroup !== null) {
        if (typeof entry.referenceGroup !== "string" || !entry.referenceGroup.trim()) {
          fail(entry.id, "referenceGroup must be a non-empty string when present");
        }
        if (entry.referenceStatus !== "unverified-population-proxy" && entry.referenceStatus !== "date-ineligible") {
          fail(entry.id, "an English reference group requires an explicit referenceStatus");
        }
        if (entry.language !== "English") fail(entry.id, "an English reference group requires language English");
        if (!Number.isInteger(entry.publishedYear)) fail(entry.id, "an English reference group requires a verified publication year");
        const dateValue = entry.provenance.publicationDateValue;
        const dateEvidence = entry.provenance.publicationDateEvidence;
        if (typeof dateValue !== "string" || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(dateValue)) {
          fail(entry.id, "an English reference group requires provenance.publicationDateValue");
        }
        if (typeof dateEvidence !== "string" || !dateEvidence.trim()) {
          fail(entry.id, "an English reference group requires provenance.publicationDateEvidence");
        }
        const comparisonEligible = entry.referenceStatus === "unverified-population-proxy";
        const dateEligible = Number(entry.publishedYear) < 2022
          || (Number(entry.publishedYear) === 2022 && /^2022-(?:0[1-9]|10)(?:-\d{2})?$/.test(dateValue));
        if (comparisonEligible && !dateEligible) {
          fail(entry.id, "comparison-eligible English references must be dated before November 2022");
        }
        if (!comparisonEligible && dateEligible) {
          fail(entry.id, "date-ineligible English references must be dated November 2022 or later");
        }
        if (comparisonEligible && entry.writerPopulation !== null && entry.referenceGroup !== "legacy-pre-2022-11-english-reference") {
          fail(entry.id, "English reference publication must not infer native-speaker population");
        }
      }
    }
    if (entry.roles.includes("ai-positive") || entry.roles.includes("ai-hybrid")) {
      const expectedClass = entry.roles.includes("ai-positive") ? "machine" : "hybrid";
      if (entry.turnitinScore !== null) fail(entry.id, `${entry.roles[0]} turnitinScore must be null`);
      if (entry.language !== "English") fail(entry.id, `${entry.roles[0]} requires language English`);
      if (!entry.aiGeneration || typeof entry.aiGeneration !== "object") {
        fail(entry.id, `${entry.roles[0]} requires aiGeneration evidence`);
      }
      const evidence = entry.aiGeneration;
      if (evidence.class !== expectedClass) fail(entry.id, `aiGeneration.class must be ${expectedClass}`);
      if (typeof evidence.sourceHumanId !== "string" || !evidence.sourceHumanId.trim()) {
        fail(entry.id, "aiGeneration.sourceHumanId is required");
      }
      const source = entriesById.get(evidence.sourceHumanId);
      if (!source || !source.roles.some((candidate) => candidate === "ai-negative" || candidate === "ai-benchmark")) {
        fail(entry.id, "aiGeneration.sourceHumanId must reference an AI-negative or AI-benchmark document");
      }
      for (const [field, value] of Object.entries({
        generatorProvider: evidence.generatorProvider,
        generatorModel: evidence.generatorModel,
        generatedAt: evidence.generatedAt,
      })) {
        if (typeof value !== "string" || !value.trim()) fail(entry.id, `aiGeneration.${field} is required`);
      }
      if (!/^[a-f0-9]{64}$/i.test(evidence.promptSha256)) fail(entry.id, "aiGeneration.promptSha256 must be a SHA-256 hex digest");
      if (!EVALUATION_SPLITS.has(evidence.evaluationSplit)) fail(entry.id, "aiGeneration.evaluationSplit must be train, validation, or test");
      if (!Number.isFinite(evidence.machineWordFraction)) fail(entry.id, "aiGeneration.machineWordFraction must be finite");
      if (expectedClass === "machine" && evidence.machineWordFraction !== 1) {
        fail(entry.id, "ai-positive requires machineWordFraction 1");
      }
      if (expectedClass === "hybrid") {
        if (evidence.machineWordFraction <= 0 || evidence.machineWordFraction >= 1) {
          fail(entry.id, "ai-hybrid requires machineWordFraction strictly between 0 and 1");
        }
        if (typeof evidence.assemblyMethod !== "string" || !evidence.assemblyMethod.trim()) {
          fail(entry.id, "ai-hybrid requires aiGeneration.assemblyMethod");
        }
      }
    }
    if (entry.roles.includes(role)) documents.push({ ...entry, text });
  }
  if (documents.length === 0 && !options.allowEmpty) throw new Error(`No corpus documents have role ${role}.`);
  return documents;
}

export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - spread) / denominator), Math.min(1, (centre + spread) / denominator)];
}

export function rocAuc(rows: Array<{ score: number; positive: boolean }>) {
  const positives = rows.filter((row) => row.positive);
  const negatives = rows.filter((row) => !row.positive);
  if (!positives.length || !negatives.length) return 0;
  let wins = 0;
  for (const positive of positives) for (const negative of negatives) {
    wins += positive.score > negative.score ? 1 : positive.score === negative.score ? 0.5 : 0;
  }
  return wins / (positives.length * negatives.length);
}

export function bootstrapAuc(rows: Array<{ score: number; positive: boolean }>, rounds = 2000) {
  let state = 0x74506c75;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
  const values: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const sample = Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]);
    if (sample.some((row) => row.positive) && sample.some((row) => !row.positive)) values.push(rocAuc(sample));
  }
  values.sort((a, b) => a - b);
  return [values[Math.floor(values.length * 0.025)] ?? 0, values[Math.floor(values.length * 0.975)] ?? 1] as const;
}

export function bootstrapAucByGroup<T extends { score: number; positive: boolean; group: string }>(
  rows: T[],
  rounds = 2000,
) {
  let state = 0x74506c75;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
  const grouped = new Map<string, T[]>();
  for (const row of rows) grouped.set(row.group, [...(grouped.get(row.group) ?? []), row]);
  const groups = [...grouped.values()];
  const values: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const sample = Array.from({ length: groups.length }, () => groups[Math.floor(random() * groups.length)]).flat();
    if (sample.some((row) => row.positive) && sample.some((row) => !row.positive)) values.push(rocAuc(sample));
  }
  values.sort((left, right) => left - right);
  return [values[Math.floor(values.length * 0.025)] ?? 0, values[Math.floor(values.length * 0.975)] ?? 1] as const;
}
