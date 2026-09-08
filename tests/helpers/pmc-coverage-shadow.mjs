import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../../lib/ingest.js";
import { tokens } from "../../lib/similarity-core.ts";
import { canonicalizeText } from "../../lib/canonical-text.ts";
import { computeUnifiedSimilarity } from "../../lib/unified-similarity.ts";
import { seedPmcCoverageDocument, seedPmcCoverageCorpus } from "../../lib/pmc-coverage/seed.ts";
import { buildPmcDfBandTable } from "../../lib/pmc-coverage/df-bands.ts";
import {
  runPmcCoverageShadowEvaluation,
  PMC_COVERAGE_SHADOW_STATUS,
} from "../../lib/pmc-coverage-shadow.ts";
import { PMC_COVERAGE_SHADOW_EVALUATOR_VERSION } from "../../lib/pmc-coverage/constants.ts";

/**
 * Shared fixtures for the PMC OA scholarly-coverage SHADOW slice tests.
 */

export const EVALUATOR_VERSION = PMC_COVERAGE_SHADOW_EVALUATOR_VERSION;
export const STATUS = PMC_COVERAGE_SHADOW_STATUS;

/** Enable the flag for the whole test process (the flag-OFF test clears it locally). */
export function enableFlag() {
  process.env.PMC_COVERAGE_SHADOW_ENABLED = "true";
}
export function disableFlag() {
  delete process.env.PMC_COVERAGE_SHADOW_ENABLED;
}

const repoRoot = path.resolve(".");

export async function freshDb(name) {
  const dbFile = path.join(repoRoot, `test_pmc_coverage_${name}.db`);
  for (const s of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ }
  }
  const client = createClient({ url: `file:${dbFile}` });
  await client.execute("PRAGMA foreign_keys = ON");
  await applyMigrationsLibsql(client, path.join(repoRoot, "drizzle"));
  const cleanup = () => {
    client.close();
    for (const s of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ }
    }
  };
  return { client, cleanup };
}

// ── deterministic content-word generator ───────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = (
  "neuronal cortical stimulus reconstruction accuracy hierarchies naturalistic listening " +
  "regression predictor encoding channel spectral temporal envelope attention modulation " +
  "participant recording electrode montage artefact rejection filtering baseline correction " +
  "hemodynamic response function convolution deconvolution estimator regularisation penalty " +
  "cross validation partition training holdout evaluation metric correlation coefficient " +
  "distribution posterior likelihood inference algorithm iteration convergence tolerance " +
  "biomarker phenotype cohort longitudinal prospective incidence prevalence confounder " +
  "randomised controlled allocation blinding outcome adherence attrition sensitivity " +
  "molecular pathway signalling transcription expression regulation chromatin methylation " +
  "immune cytokine inflammation macrophage differentiation proliferation apoptosis lineage"
).split(/\s+/);

/** N deterministic content words (each length >= 4, none a COMMON_WORD) from `seed`. */
export function makeWords(seed, n) {
  const rnd = mulberry32(typeof seed === "string" ? [...seed].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) : seed);
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(VOCAB[Math.floor(rnd() * VOCAB.length)]);
  return out;
}

export function makeText(seed, n) {
  return makeWords(seed, n).join(" ");
}

/** A ~46-word run of only <=3-letter words — every 5-gram is non-informative,
 *  so scoreAgainstArchive's informativeGram filter blocks it entirely even
 *  though winnowing will still select a fingerprint from it. */
export const NONINFORMATIVE_RUN = [
  "the","cat","sat","on","a","mat","and","a","dog","ran","to","the","bin","but","a","fox",
  "hid","in","a","den","so","an","owl","few","up","to","a","jay","who","ate","a","bug",
  "the","bee","met","a","ant","by","the","oak","elm","fir","pin","oak","elm","fir",
].join(" ");

/** Build a submission: host filler with `passage` spliced into the middle. */
export function spliceSubmission({ hostSeed = "host", hostWords = 400, passage }) {
  const host = makeWords(hostSeed, hostWords);
  const mid = Math.floor(host.length / 2);
  return [...host.slice(0, mid), ...passage.split(" "), ...host.slice(mid)].join(" ");
}

// ── seeding ────────────────────────────────────────────────────────────────

export async function seedPmcDoc(client, { pmcId, text, isRetracted = false, doi = null, title = null, license = "CC BY", version = 1 }) {
  return seedPmcCoverageDocument(client, {
    pmcId,
    doi,
    pmid: null,
    title: title ?? `Fixture ${pmcId}`,
    license,
    citation: null,
    canonicalText: text,
    version,
    isRetracted,
    oaSnapshotDate: "2026-08-26",
  });
}

export async function buildDf(client, pmcIds) {
  return buildPmcDfBandTable(client, pmcIds);
}

export async function seedCorpus(client, docs) {
  return seedPmcCoverageCorpus(
    client,
    docs.map((d) => ({
      pmcId: d.pmcId,
      doi: d.doi ?? null,
      pmid: null,
      title: d.title ?? `Fixture ${d.pmcId}`,
      license: d.license ?? "CC BY",
      citation: null,
      canonicalText: d.text,
      version: d.version ?? 1,
      isRetracted: d.isRetracted ?? false,
      oaSnapshotDate: "2026-08-26",
    })),
  );
}

// ── report / production result fixtures ────────────────────────────────────

let userSeq = 0;
export async function ensureUser(client, accountId) {
  if (!accountId) return;
  userSeq += 1;
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, `${accountId}-${userSeq}@ex.test`, `${accountId}${userSeq}`, "not-a-real-hash"],
  });
}

export async function seedReport(client, { deviceKey, reportId, accountId = null, text, unifiedSimilarity = null }) {
  await ensureUser(client, accountId);
  const wordCount = tokens(canonicalizeText(text)).length;
  const payload = {
    version: 11, id: 1, submissionId: "sub", title: "t", author: "", assignment: "", created: new Date().toISOString(),
    score: 0, archiveScore: 0, wordCount, scoreBand: "Low", matchedWordCount: 0, sources: [], repeats: [], text,
    ...(unifiedSimilarity ? { unifiedSimilarity } : {}),
  };
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, "sub", "t", new Date().toISOString(), wordCount, 0, "Low", JSON.stringify(payload), accountId],
  });
  return payload;
}

export function matchedResult(matches, overrides = {}) {
  return {
    status: "MATCHED", matches, computedAt: new Date().toISOString(),
    matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x", ...overrides,
  };
}
export function noHistoricalMatch(overrides = {}) {
  return {
    status: "NO_HISTORICAL_MATCH", computedAt: new Date().toISOString(),
    matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x", ...overrides,
  };
}

export function authoritativeFor({ wordCount, archiveMatchedPositions = null, externalAcademicEvidence = null, historicalSubmissionMatch = null, effectiveDeviceSelfRepresentationIds = [] }) {
  return computeUnifiedSimilarity({ wordCount, archiveMatchedPositions, externalAcademicEvidence, historicalSubmissionMatch, effectiveDeviceSelfRepresentationIds });
}

export async function runEval(client, params) {
  return runPmcCoverageShadowEvaluation(client, {
    accountId: null,
    productionResult: noHistoricalMatch(),
    effectiveDeviceSelfRepresentationIds: [],
    authoritativeArchiveMatchedPositions: null,
    authoritativeExternalAcademicEvidence: null,
    ...params,
  });
}

export async function readRow(client, reportId) {
  const r = await client.execute({
    sql: `SELECT * FROM pmc_coverage_shadow_evaluations WHERE report_id = ? AND evaluator_version = ?`,
    args: [reportId, EVALUATOR_VERSION],
  });
  return r.rows[0] ? { ...r.rows[0] } : null;
}

export async function countRows(client, reportId) {
  const r = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM pmc_coverage_shadow_evaluations WHERE report_id = ?`,
    args: [reportId],
  });
  return Number(r.rows[0].n);
}
