import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import mammoth from "mammoth";
import { tokens } from "../lib/similarity-core";
import {
  ARCHIVE_LEAKAGE_CONTAINMENT,
  FINAL_TEST_MINIMUM_WORDS,
  REPORT_PAIR_MINIMUM_CONTAINMENT,
  REVISION_CONTAINMENT,
  englishLanguageEvidence,
  normalizedPairName,
  originalCoverageInReport,
  parseTurnitinReportText,
  sha256ReadyText,
  slug,
  uniqueFiveGrams,
} from "./similarity-final-test-core";

type ExistingManifestEntry = {
  id: string;
  roles?: string[];
  textPath?: string;
  title?: string | null;
};

type IntakeRow = {
  id: string;
  title: string;
  originalFile: string;
  reportFile: string | null;
  originalSha256: string;
  reportSha256: string | null;
  textSha256: string;
  textPath: string | null;
  language: string;
  languageEvidence: ReturnType<typeof englishLanguageEvidence>;
  eligibleWordCount: number;
  turnitinScore: number | null;
  submissionId: string | null;
  submissionDate: string | null;
  submittedWordCount: number | null;
  submittedFileName: string | null;
  reportPairContainment: number | null;
  closestArchiveDocument: { id: string; title: string; containment: number } | null;
  revisionGroupId: string;
  independent: boolean;
  status: "accepted-sealed" | "quarantined";
  reasons: string[];
};

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function round(value: number) {
  return Number(value.toFixed(4));
}

const input = argument("--input");
const sourceName = argument("--source-name") ?? "60 reports with their articles.zip";
const retrievedAt = argument("--retrieved-at") ?? new Date().toISOString().slice(0, 10);
if (!input) throw new Error("Usage: npm run import:similarity-final-test -- --input <extracted-directory>");

const project = resolve(".");
const inputDirectory = resolve(input);
const destination = join(project, "corpus", "similarity-final-test");
const textDirectory = join(destination, "text");
mkdirSync(textDirectory, { recursive: true });

const files = readdirSync(inputDirectory).filter((name) => !name.startsWith("."));
const originals = files.filter((name) => extname(name).toLowerCase() === ".docx").sort();
const reports = files.filter((name) => extname(name).toLowerCase() === ".pdf").sort();
const reportsByName = new Map<string, string[]>();
reports.forEach((name) => {
  const key = normalizedPairName(name);
  reportsByName.set(key, [...(reportsByName.get(key) ?? []), name]);
});

const existingManifest = JSON.parse(
  readFileSync(join(project, "corpus", "manifest.json"), "utf8"),
) as ExistingManifestEntry[];
const existingTexts = existingManifest.flatMap((entry) => {
  if (!entry.textPath || !entry.roles?.some((role) => role === "index-source" || role === "similarity-calibration")) return [];
  const path = join(project, "corpus", entry.textPath);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return [{ id: entry.id, title: entry.title ?? entry.id, grams: uniqueFiveGrams(text) }];
});

const rows: IntakeRow[] = [];
const extractedTexts = new Map<string, string>();
const extractedGrams = new Map<string, Set<string>>();

function gramContainment(left: Set<string>, right: Set<string>) {
  if (left.size === 0 || right.size === 0) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  small.forEach((gram) => {
    if (large.has(gram)) shared += 1;
  });
  return shared / small.size;
}

for (const originalFile of originals) {
  const originalPath = join(inputDirectory, originalFile);
  const originalBytes = readFileSync(originalPath);
  let rawText = "";
  const extractionReasons: string[] = [];
  try {
    rawText = (await mammoth.extractRawText({ buffer: originalBytes })).value;
  } catch {
    extractionReasons.push("original-docx-unreadable");
  }
  const text = sha256ReadyText(rawText);
  const textDigest = sha256(text);
  const title = basename(originalFile, extname(originalFile)).replace(/\s*\(\d+\)\s*$/u, "").trim();
  const id = `sealed-${slug(title)}-${textDigest.slice(0, 12)}`;
  const candidates = reportsByName.get(normalizedPairName(originalFile)) ?? [];
  const reasons = [...extractionReasons];
  if (candidates.length === 0) reasons.push("matching-turnitin-report-missing");
  if (candidates.length > 1) reasons.push("multiple-reports-match-original-name");
  const reportFile = candidates.length === 1 ? candidates[0] : null;
  let reportText = "";
  let reportSha256: string | null = null;
  let evidence = parseTurnitinReportText("");
  let pairContainment: number | null = null;
  if (reportFile) {
    const reportPath = join(inputDirectory, reportFile);
    const reportBytes = readFileSync(reportPath);
    reportSha256 = sha256(reportBytes);
    try {
      reportText = execFileSync("pdftotext", ["-layout", reportPath, "-"], {
        encoding: "utf8",
        maxBuffer: 100 * 1024 * 1024,
        timeout: 120_000,
      });
    } catch {
      reasons.push("turnitin-report-unreadable");
    }
    evidence = parseTurnitinReportText(reportText);
    if (!evidence.isSimilarityReport) reasons.push("not-a-complete-turnitin-similarity-report");
    pairContainment = rawText ? originalCoverageInReport(rawText, reportText) : null;
    if (evidence.isSimilarityReport && (pairContainment ?? 0) < REPORT_PAIR_MINIMUM_CONTAINMENT) {
      reasons.push("report-content-does-not-match-original");
    }
  }
  const languageEvidence = englishLanguageEvidence(rawText);
  const language = languageEvidence.classification;
  const eligibleWordCount = rawText ? tokens(rawText).length : 0;
  if (language !== "English") reasons.push("original-is-not-english");
  if (eligibleWordCount < FINAL_TEST_MINIMUM_WORDS) reasons.push("fewer-than-300-eligible-words");

  let closestArchiveDocument: IntakeRow["closestArchiveDocument"] = null;
  if (rawText) {
    const originalGrams = uniqueFiveGrams(rawText);
    for (const entry of existingTexts) {
      const score = gramContainment(originalGrams, entry.grams);
      if (!closestArchiveDocument || score > closestArchiveDocument.containment) {
        closestArchiveDocument = { id: entry.id, title: entry.title, containment: score };
      }
    }
    if ((closestArchiveDocument?.containment ?? 0) >= ARCHIVE_LEAKAGE_CONTAINMENT) {
      reasons.push("original-already-present-or-near-duplicate-in-archive");
    }
  }

  extractedTexts.set(id, text);
  extractedGrams.set(id, uniqueFiveGrams(text));
  rows.push({
    id,
    title,
    originalFile,
    reportFile,
    originalSha256: sha256(originalBytes),
    reportSha256,
    textSha256: textDigest,
    textPath: null,
    language,
    languageEvidence,
    eligibleWordCount,
    turnitinScore: evidence.score,
    submissionId: evidence.submissionId,
    submissionDate: evidence.submissionDate,
    submittedWordCount: evidence.submittedWordCount,
    submittedFileName: evidence.submittedFileName,
    reportPairContainment: pairContainment === null ? null : round(pairContainment),
    closestArchiveDocument: closestArchiveDocument
      ? { ...closestArchiveDocument, containment: round(closestArchiveDocument.containment) }
      : null,
    revisionGroupId: `sealed-revision-${textDigest.slice(0, 12)}`,
    independent: true,
    status: reasons.length === 0 ? "accepted-sealed" : "quarantined",
    reasons: [...new Set(reasons)],
  });
}

const reportUses = new Map<string, IntakeRow[]>();
rows.forEach((row) => {
  if (!row.submissionId) return;
  reportUses.set(row.submissionId, [...(reportUses.get(row.submissionId) ?? []), row]);
});
reportUses.forEach((members) => {
  if (members.length < 2) return;
  const best = [...members].sort(
    (left, right) => (right.reportPairContainment ?? 0) - (left.reportPairContainment ?? 0),
  )[0];
  members.forEach((row) => {
    if (row === best && (row.reportPairContainment ?? 0) >= REPORT_PAIR_MINIMUM_CONTAINMENT) return;
    row.reasons.push("submission-id-reused-by-another-report-file");
    row.status = "quarantined";
  });
});

for (let left = 0; left < rows.length; left += 1) {
  for (let right = left + 1; right < rows.length; right += 1) {
    const leftGrams = extractedGrams.get(rows[left].id) ?? new Set<string>();
    const rightGrams = extractedGrams.get(rows[right].id) ?? new Set<string>();
    if (leftGrams.size === 0 || rightGrams.size === 0) continue;
    const score = gramContainment(leftGrams, rightGrams);
    if (score < REVISION_CONTAINMENT) continue;
    const group = [rows[left], rows[right]].sort((a, b) => a.id.localeCompare(b.id))[0].revisionGroupId;
    rows[left].revisionGroupId = group;
    rows[right].revisionGroupId = group;
  }
}
const firstByRevision = new Map<string, IntakeRow>();
rows.filter((row) => row.status === "accepted-sealed").sort((a, b) => a.id.localeCompare(b.id)).forEach((row) => {
  const first = firstByRevision.get(row.revisionGroupId);
  if (!first) firstByRevision.set(row.revisionGroupId, row);
  else row.independent = false;
});

rows.forEach((row) => {
  if (row.status !== "accepted-sealed") return;
  const textPath = join(textDirectory, `${row.id}.txt`);
  writeFileSync(textPath, extractedTexts.get(row.id)!, "utf8");
  row.textPath = relative(destination, textPath).replaceAll("\\", "/");
});

const unpairedReports = reports.filter((report) => !rows.some((row) => row.reportFile === report));
const accepted = rows.filter((row) => row.status === "accepted-sealed");
const independent = accepted.filter((row) => row.independent);
const summary = {
  schema: "turnitplus-similarity-final-test-intake",
  version: 1,
  source: sourceName,
  retrievedAt,
  cohortStatus: independent.length >= 60 ? "complete-ready-to-open" : "sealed-awaiting-valid-pairs",
  evaluationOpened: false,
  targetIndependentPairs: 60,
  filesReceived: files.length,
  originalsReceived: originals.length,
  reportsReceived: reports.length,
  acceptedPairs: accepted.length,
  independentAcceptedPairs: independent.length,
  quarantinedPairs: rows.length - accepted.length,
  remainingPairsRequired: Math.max(0, 60 - independent.length),
  unpairedReportFiles: unpairedReports,
  validation: {
    minimumEnglishWords: FINAL_TEST_MINIMUM_WORDS,
    reportPairMinimumContainment: REPORT_PAIR_MINIMUM_CONTAINMENT,
    archiveLeakageContainment: ARCHIVE_LEAKAGE_CONTAINMENT,
    revisionContainment: REVISION_CONTAINMENT,
    reportsRequireScoreAndSubmissionId: true,
    finalTestDocumentsAreNotAddedToCorpusOrIndex: true,
  },
  scoreDistribution: {
    count: accepted.length,
    minimum: accepted.length ? Math.min(...accepted.map((row) => row.turnitinScore!)) : null,
    maximum: accepted.length ? Math.max(...accepted.map((row) => row.turnitinScore!)) : null,
    below5: accepted.filter((row) => row.turnitinScore! < 5).length,
    from5To14: accepted.filter((row) => row.turnitinScore! >= 5 && row.turnitinScore! < 15).length,
    atLeast15: accepted.filter((row) => row.turnitinScore! >= 15).length,
  },
  documents: rows,
};

writeFileSync(join(destination, "manifest.json"), `${JSON.stringify(rows, null, 2)}\n`, "utf8");
writeFileSync(join(destination, "intake-audit.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  cohortStatus: summary.cohortStatus,
  originalsReceived: summary.originalsReceived,
  reportsReceived: summary.reportsReceived,
  acceptedPairs: summary.acceptedPairs,
  independentAcceptedPairs: summary.independentAcceptedPairs,
  quarantinedPairs: summary.quarantinedPairs,
  remainingPairsRequired: summary.remainingPairsRequired,
  quarantined: rows.filter((row) => row.status === "quarantined").map((row) => ({
    originalFile: row.originalFile,
    reportFile: row.reportFile,
    reasons: row.reasons,
  })),
}, null, 2));
