import { basename, extname } from "node:path";
import { grams, normalize } from "../lib/similarity-core";

export const FINAL_TEST_MINIMUM_WORDS = 300;
export const REPORT_PAIR_MINIMUM_CONTAINMENT = 0.2;
export const ARCHIVE_LEAKAGE_CONTAINMENT = 0.5;
export const REVISION_CONTAINMENT = 0.5;

const ENGLISH_FUNCTION_WORDS = new Set(
  "the of and to in is that for with by on this are from which was were has have their its these those can through within into".split(" "),
);
const FRENCH_FUNCTION_WORDS = new Set(
  "le la les de des du et en est que pour dans qui sur au aux ce cette ces sont avec par comme il elle nous vous ils elles".split(" "),
);

const REPORT_NAME_MARKERS = /\b(?:turnitin|turnitiin|turinitn)\b/gi;

export function normalizedPairName(fileName: string) {
  const stem = basename(fileName, extname(fileName))
    .replace(REPORT_NAME_MARKERS, " ")
    .replace(/\s*\(\d+\)\s*$/u, " ");
  return normalize(stem);
}

export function sha256ReadyText(value: string) {
  return `${value.replace(/\x00/g, "").trim()}\n`;
}

export type EnglishLanguageEvidence = {
  classification: "English" | "French" | "Unknown";
  englishSignals: number;
  frenchSignals: number;
  englishSignalShare: number;
  latinLetters: number;
  arabicLetters: number;
};

/**
 * Classifies the dominant article language instead of rejecting an English
 * paper merely because its metadata contains a French or Arabic abstract.
 * The counts are retained in the sealed manifest so every decision is
 * auditable and no language value is silently defaulted.
 */
export function englishLanguageEvidence(value: string): EnglishLanguageEvidence {
  const words = value.toLowerCase().match(/[a-zà-ÿ]+/gu) ?? [];
  let englishSignals = 0;
  let frenchSignals = 0;
  words.forEach((word) => {
    if (ENGLISH_FUNCTION_WORDS.has(word)) englishSignals += 1;
    if (FRENCH_FUNCTION_WORDS.has(word)) frenchSignals += 1;
  });
  const signalCount = englishSignals + frenchSignals;
  const englishSignalShare = signalCount === 0 ? 0 : englishSignals / signalCount;
  const latinLetters = (value.match(/[A-Za-z]/g) ?? []).length;
  const arabicLetters = (value.match(/[\u0600-\u06ff]/g) ?? []).length;
  const predominantlyLatin = latinLetters >= Math.max(1, arabicLetters * 4);
  const classification = signalCount >= 20 && predominantlyLatin && englishSignalShare >= 0.72
    ? "English"
    : signalCount >= 20 && frenchSignals > englishSignals
      ? "French"
      : "Unknown";
  return {
    classification,
    englishSignals,
    frenchSignals,
    englishSignalShare: Number(englishSignalShare.toFixed(4)),
    latinLetters,
    arabicLetters,
  };
}

export function uniqueFiveGrams(value: string) {
  const words = normalize(value).split(" ").filter(Boolean);
  return new Set(grams(words, 5));
}

export function textContainment(left: string, right: string) {
  const leftGrams = uniqueFiveGrams(left);
  const rightGrams = uniqueFiveGrams(right);
  if (leftGrams.size === 0 || rightGrams.size === 0) return 0;
  const [small, large] = leftGrams.size <= rightGrams.size
    ? [leftGrams, rightGrams]
    : [rightGrams, leftGrams];
  let shared = 0;
  small.forEach((gram) => {
    if (large.has(gram)) shared += 1;
  });
  return shared / small.size;
}

export function originalCoverageInReport(original: string, reportText: string) {
  const originalGrams = uniqueFiveGrams(original);
  const reportGrams = uniqueFiveGrams(reportText);
  if (originalGrams.size === 0) return 0;
  let shared = 0;
  originalGrams.forEach((gram) => {
    if (reportGrams.has(gram)) shared += 1;
  });
  return shared / originalGrams.size;
}

export type TurnitinReportEvidence = {
  score: number | null;
  submissionId: string | null;
  submissionDate: string | null;
  submittedWordCount: number | null;
  submittedFileName: string | null;
  isSimilarityReport: boolean;
};

export function parseTurnitinReportText(value: string): TurnitinReportEvidence {
  const scoreMatch = value.match(/(\d{1,3})\s*%\s*Overall Similarity/i)
    ?? value.match(/(\d{1,3})\s*%?[\s\S]*?SIMILARITY INDEX/i);
  const rawScore = scoreMatch ? Number(scoreMatch[1]) : null;
  const score = rawScore !== null && Number.isFinite(rawScore) && rawScore >= 0 && rawScore <= 100
    ? rawScore
    : null;
  const submissionId = value.match(/trn:oid:{3}\d+:\d+/i)?.[0]
    ?? value.match(/Submission ID\s*:?\s*(\d{6,})/i)?.[1]
    ?? null;
  const submissionDate = value.match(/Submission Date\s*\n+\s*([^\n\r]+)/i)?.[1]?.trim() ?? null;
  const submittedWordCount = value.match(/([\d,]+)\s+Words\b/i)?.[1]
    ? Number(value.match(/([\d,]+)\s+Words\b/i)![1].replace(/,/g, ""))
    : null;
  const submittedFileName = value.match(/File Name\s*\n+\s*([^\n\r]+)/i)?.[1]?.trim() ?? null;
  return {
    score,
    submissionId,
    submissionDate,
    submittedWordCount,
    submittedFileName,
    isSimilarityReport: score !== null && submissionId !== null,
  };
}

export function slug(value: string) {
  return normalize(value).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 88) || "document";
}
