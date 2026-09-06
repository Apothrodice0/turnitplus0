import { readFileSync } from "node:fs";
import path from "node:path";
import type { ArchiveScoringMatchingParameters } from "./archive-similarity-scoring";
import type { ArchiveFramingConfig, ArchiveScoreBand } from "./archive-result-framing";

/**
 * 100k-scale architecture, slice 2E — the server side's read of the SAME two
 * shipped static files app/similarity-worker.ts fetches over HTTP in the
 * browser:
 *
 *   - public/data/document-index.meta.json  (scoreBands, corpusVersion,
 *     maximumDocumentFrequency — the archive build's own index cap)
 *   - public/data/risk-calibration.json     (archiveCutoff, targetThreshold,
 *     auc/precision/recall/sampleSize, matchingParameters)
 *
 * Same schema/version guards and the same corpusVersion-consistency check the
 * worker's loadIndex()/loadRiskCalibration() apply. Node-only (readFileSync) —
 * lib/e7-archive-adapter.ts already reads document-index.meta.json server-side
 * the same way. Cached at module scope: these files are immutable build
 * artifacts for the life of a deployment.
 */

type MetaFile = {
  schema: string;
  version: number;
  corpusVersion: string;
  maximumDocumentFrequency: number;
  scoreBands: ArchiveScoreBand[];
};

type RiskFile = {
  schema: string;
  version: number;
  corpusVersion: string;
  sampleSize: number;
  targetThreshold: number;
  archiveCutoff: number;
  auc: number;
  precision: number;
  recall: number;
  matchingParameters?: {
    minimumMatchedWords: number;
    maximumDocumentFrequency: number;
    minimumSourceContribution: number;
    maximumContributingSources: number | null;
    sourceWeighting: "raw" | "containment";
  };
};

export type ArchiveMatchConfig = {
  corpusVersion: string;
  /** The archive build's own index cap — matchAgainstArchiveCorpus requires it. */
  maximumDocumentFrequency: number;
  /** risk-calibration.json's matchingParameters, defaulted exactly as the worker does. */
  matchingParameters: ArchiveScoringMatchingParameters;
  /** Everything lib/archive-result-framing.ts's frameArchiveResult needs. */
  framing: ArchiveFramingConfig;
};

const DATA_DIR = path.join(process.cwd(), "public", "data");

let cached: ArchiveMatchConfig | null = null;

export function loadArchiveMatchConfig(): ArchiveMatchConfig {
  if (cached) return cached;

  const meta = JSON.parse(readFileSync(path.join(DATA_DIR, "document-index.meta.json"), "utf8")) as MetaFile;
  if (meta.schema !== "tplus-packed-search-index" || meta.version !== 1) {
    throw new Error("document-index.meta.json uses an unsupported schema.");
  }

  const risk = JSON.parse(readFileSync(path.join(DATA_DIR, "risk-calibration.json"), "utf8")) as RiskFile;
  if (
    risk.schema !== "turnitplus-risk-calibration"
    || !Number.isInteger(risk.version)
    || risk.version < 1
    || risk.version > 8
  ) {
    throw new Error("risk-calibration.json uses an unsupported schema.");
  }

  // The exact check app/similarity-worker.ts's analyze() makes.
  if (risk.corpusVersion !== meta.corpusVersion) {
    throw new Error("The risk calibration does not match the current archive.");
  }

  cached = {
    corpusVersion: meta.corpusVersion,
    maximumDocumentFrequency: meta.maximumDocumentFrequency,
    matchingParameters: {
      minimumMatchedWords: risk.matchingParameters?.minimumMatchedWords,
      maximumDocumentFrequency: risk.matchingParameters?.maximumDocumentFrequency,
      minimumSourceContribution: risk.matchingParameters?.minimumSourceContribution,
      maximumContributingSources: risk.matchingParameters?.maximumContributingSources,
      sourceWeighting: risk.matchingParameters?.sourceWeighting,
    },
    framing: {
      scoreBands: meta.scoreBands,
      corpusVersion: meta.corpusVersion,
      risk: {
        targetThreshold: risk.targetThreshold,
        archiveCutoff: risk.archiveCutoff,
        auc: risk.auc,
        precision: risk.precision,
        recall: risk.recall,
        sampleSize: risk.sampleSize,
      },
    },
  };
  return cached;
}

/** Test-only: drop the module cache so a test can point DATA_DIR-equivalent
 *  fixtures or re-read after a change. Never called by production code. */
export function __resetArchiveMatchConfigCacheForTests(): void {
  cached = null;
}
