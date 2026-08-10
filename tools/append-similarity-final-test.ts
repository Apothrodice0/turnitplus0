import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  sourceFormat?: "doc" | "docx";
  extractionContract?: string;
};

type ExistingManifestEntry = { id: string; roles?: string[]; textPath?: string; title?: string | null };

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const round = (value: number) => Number(value.toFixed(4));
function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function gramContainment(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  small.forEach((gram) => { if (large.has(gram)) shared += 1; });
  return shared / small.size;
}

async function extractOriginalText(path: string, extension: string) {
  const bytes = readFileSync(path);
  if (extension === ".docx") {
    return {
      text: (await mammoth.extractRawText({ buffer: bytes })).value,
      contract: "mammoth-raw-text-v1",
    };
  }
  if (extension !== ".doc") throw new Error(`Unsupported original format: ${extension}`);
  const temporary = mkdtempSync(join(tmpdir(), "turnitplus-doc-conversion-"));
  try {
    execFileSync("soffice", ["--headless", "--convert-to", "docx", "--outdir", temporary, path], {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const converted = join(temporary, `${basename(path, extension)}.docx`);
    if (!existsSync(converted)) throw new Error("LibreOffice did not produce the expected DOCX.");
    return {
      text: (await mammoth.extractRawText({ buffer: readFileSync(converted) })).value,
      contract: "libreoffice-doc-to-docx-plus-mammoth-v1",
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const input = argument("--input");
const sourceName = argument("--source-name") ?? "6.zip";
const retrievedAt = argument("--retrieved-at") ?? new Date().toISOString().slice(0, 10);
if (!input) throw new Error("Usage: npm run append:similarity-final-test -- --input <extracted-directory>");

const project = resolve(".");
const inputDirectory = resolve(input);
const destination = join(project, "corpus", "similarity-final-test");
const textDirectory = join(destination, "text");
const priorManifestPath = join(destination, "manifest.json");
const priorAuditPath = join(destination, "intake-audit.json");
const priorRows = JSON.parse(readFileSync(priorManifestPath, "utf8")) as IntakeRow[];
const priorAudit = JSON.parse(readFileSync(priorAuditPath, "utf8")) as Record<string, unknown> & {
  evaluationOpened: boolean;
  acceptedPairs: number;
  documents: IntakeRow[];
};
if (priorAudit.evaluationOpened) throw new Error("The final cohort has already been opened; replacements are forbidden.");
const sealedRows = priorRows.filter((row) => row.status === "accepted-sealed");
if (sealedRows.length < 1 || sealedRows.length >= 60 || priorAudit.acceptedPairs !== sealedRows.length) {
  throw new Error(`Expected an unopened partial sealed cohort below 60 documents; found ${sealedRows.length}.`);
}
const replacementsRequired = 60 - sealedRows.length;
mkdirSync(textDirectory, { recursive: true });

const files = readdirSync(inputDirectory).filter((name) => !name.startsWith(".")).sort();
const originals = files.filter((name) => [".doc", ".docx"].includes(extname(name).toLowerCase()));
const reports = files.filter((name) => extname(name).toLowerCase() === ".pdf");
if (originals.length !== replacementsRequired || reports.length !== replacementsRequired) {
  throw new Error(`Replacement intake requires exactly ${replacementsRequired} originals and ${replacementsRequired} reports; received ${originals.length} and ${reports.length}.`);
}
const reportsByName = new Map<string, string[]>();
reports.forEach((name) => reportsByName.set(normalizedPairName(name), [...(reportsByName.get(normalizedPairName(name)) ?? []), name]));

const corpusManifest = JSON.parse(readFileSync(join(project, "corpus", "manifest.json"), "utf8")) as ExistingManifestEntry[];
const archiveTexts = corpusManifest.flatMap((entry) => {
  if (!entry.textPath || !entry.roles?.some((role) => role === "index-source" || role === "similarity-calibration")) return [];
  const path = join(project, "corpus", entry.textPath);
  if (!existsSync(path)) return [];
  return [{ id: entry.id, title: entry.title ?? entry.id, grams: uniqueFiveGrams(readFileSync(path, "utf8")) }];
});
const sealedTexts = sealedRows.map((row) => {
  if (!row.textPath) throw new Error(`${row.id}: accepted sealed row has no text path.`);
  const path = join(destination, row.textPath);
  const bytes = readFileSync(path);
  if (sha256(bytes) !== row.textSha256) throw new Error(`${row.id}: sealed text hash mismatch.`);
  return { row, grams: uniqueFiveGrams(bytes.toString("utf8")) };
});

const newRows: IntakeRow[] = [];
const extractedTexts = new Map<string, string>();
const extractedGrams = new Map<string, Set<string>>();
for (const originalFile of originals) {
  const originalPath = join(inputDirectory, originalFile);
  const extension = extname(originalFile).toLowerCase();
  const originalBytes = readFileSync(originalPath);
  const reasons: string[] = [];
  let rawText = "";
  let extractionContract = extension === ".doc" ? "libreoffice-doc-to-docx-plus-mammoth-v1" : "mammoth-raw-text-v1";
  try {
    const extraction = await extractOriginalText(originalPath, extension);
    rawText = extraction.text;
    extractionContract = extraction.contract;
  } catch {
    reasons.push("original-document-unreadable");
  }
  const text = sha256ReadyText(rawText);
  const textDigest = sha256(text);
  const title = basename(originalFile, extension).replace(/\s*\(\d+\)\s*$/u, "").trim();
  const id = `sealed-${slug(title)}-${textDigest.slice(0, 12)}`;
  const candidates = reportsByName.get(normalizedPairName(originalFile)) ?? [];
  if (candidates.length === 0) reasons.push("matching-turnitin-report-missing");
  if (candidates.length > 1) reasons.push("multiple-reports-match-original-name");
  const reportFile = candidates.length === 1 ? candidates[0] : null;
  let reportSha256: string | null = null;
  let reportText = "";
  let evidence = parseTurnitinReportText("");
  let reportPairContainment: number | null = null;
  if (reportFile) {
    const reportPath = join(inputDirectory, reportFile);
    const reportBytes = readFileSync(reportPath);
    reportSha256 = sha256(reportBytes);
    try {
      reportText = execFileSync("pdftotext", ["-layout", reportPath, "-"], {
        encoding: "utf8", timeout: 120_000, maxBuffer: 100 * 1024 * 1024,
      });
    } catch {
      reasons.push("turnitin-report-unreadable");
    }
    evidence = parseTurnitinReportText(reportText);
    if (!evidence.isSimilarityReport) reasons.push("not-a-complete-turnitin-similarity-report");
    reportPairContainment = rawText ? originalCoverageInReport(rawText, reportText) : null;
    if (evidence.isSimilarityReport && (reportPairContainment ?? 0) < REPORT_PAIR_MINIMUM_CONTAINMENT) {
      reasons.push("report-content-does-not-match-original");
    }
  }
  const languageEvidence = englishLanguageEvidence(rawText);
  const eligibleWordCount = rawText ? tokens(rawText).length : 0;
  if (languageEvidence.classification !== "English") reasons.push("original-is-not-english");
  if (eligibleWordCount < FINAL_TEST_MINIMUM_WORDS) reasons.push("fewer-than-300-eligible-words");

  const grams = uniqueFiveGrams(rawText);
  let closestArchiveDocument: IntakeRow["closestArchiveDocument"] = null;
  for (const entry of archiveTexts) {
    const score = gramContainment(grams, entry.grams);
    if (!closestArchiveDocument || score > closestArchiveDocument.containment) {
      closestArchiveDocument = { id: entry.id, title: entry.title, containment: score };
    }
  }
  if ((closestArchiveDocument?.containment ?? 0) >= ARCHIVE_LEAKAGE_CONTAINMENT) {
    reasons.push("original-already-present-or-near-duplicate-in-archive");
  }
  const closestSealed = sealedTexts
    .map((entry) => ({ id: entry.row.id, score: gramContainment(grams, entry.grams) }))
    .sort((left, right) => right.score - left.score)[0];
  if ((closestSealed?.score ?? 0) >= REVISION_CONTAINMENT) {
    reasons.push("original-duplicates-existing-sealed-document");
  }
  extractedTexts.set(id, text);
  extractedGrams.set(id, grams);
  newRows.push({
    id, title, originalFile, reportFile,
    originalSha256: sha256(originalBytes), reportSha256, textSha256: textDigest, textPath: null,
    language: languageEvidence.classification, languageEvidence, eligibleWordCount,
    turnitinScore: evidence.score, submissionId: evidence.submissionId, submissionDate: evidence.submissionDate,
    submittedWordCount: evidence.submittedWordCount, submittedFileName: evidence.submittedFileName,
    reportPairContainment: reportPairContainment === null ? null : round(reportPairContainment),
    closestArchiveDocument: closestArchiveDocument
      ? { ...closestArchiveDocument, containment: round(closestArchiveDocument.containment) }
      : null,
    revisionGroupId: `sealed-revision-${textDigest.slice(0, 12)}`, independent: true,
    status: reasons.length ? "quarantined" : "accepted-sealed", reasons: [...new Set(reasons)],
    sourceFormat: extension.slice(1) as "doc" | "docx", extractionContract,
  });
}

const allSubmissionIds = new Map<string, IntakeRow[]>();
[...sealedRows, ...newRows].forEach((row) => {
  if (!row.submissionId) return;
  allSubmissionIds.set(row.submissionId, [...(allSubmissionIds.get(row.submissionId) ?? []), row]);
});
allSubmissionIds.forEach((rows) => {
  if (rows.length < 2) return;
  rows.filter((row) => newRows.includes(row)).forEach((row) => {
    row.reasons.push("submission-id-already-used-in-sealed-cohort");
    row.status = "quarantined";
  });
});
for (let left = 0; left < newRows.length; left += 1) {
  for (let right = left + 1; right < newRows.length; right += 1) {
    const score = gramContainment(extractedGrams.get(newRows[left].id)!, extractedGrams.get(newRows[right].id)!);
    if (score < REVISION_CONTAINMENT) continue;
    newRows[left].reasons.push("replacement-documents-are-near-duplicate-revisions");
    newRows[right].reasons.push("replacement-documents-are-near-duplicate-revisions");
    newRows[left].status = "quarantined";
    newRows[right].status = "quarantined";
  }
}

newRows.forEach((row) => {
  row.reasons = [...new Set(row.reasons)];
  if (row.status !== "accepted-sealed") return;
  const path = join(textDirectory, `${row.id}.txt`);
  writeFileSync(path, extractedTexts.get(row.id)!, "utf8");
  row.textPath = relative(destination, path).replaceAll("\\", "/");
});
const acceptedReplacements = newRows.filter((row) => row.status === "accepted-sealed");
const finalRows = [...sealedRows, ...acceptedReplacements];
const complete = finalRows.length === 60 && acceptedReplacements.length === replacementsRequired;
const priorQuarantined = priorRows.filter((row) => row.status === "quarantined");
const previousSources = Array.isArray(priorAudit.source) ? priorAudit.source : [priorAudit.source];
const previousReplacementIntakes = Array.isArray(priorAudit.replacementIntakes)
  ? priorAudit.replacementIntakes
  : priorAudit.replacementIntake
    ? [priorAudit.replacementIntake]
    : [];
const previousInvalidDocuments = Array.isArray(priorAudit.replacedInvalidDocuments)
  ? priorAudit.replacedInvalidDocuments
  : [];
const currentReplacementIntake = {
  source: sourceName,
  receivedOriginals: originals.length,
  receivedReports: reports.length,
  accepted: acceptedReplacements.length,
  quarantined: newRows.length - acceptedReplacements.length,
  documents: newRows,
};
const audit = {
  ...priorAudit,
  version: 2,
  source: [...previousSources, sourceName],
  retrievedAt,
  cohortStatus: complete ? "complete-ready-to-open" : "sealed-awaiting-valid-pairs",
  evaluationOpened: false,
  filesReceived: Number(priorAudit.filesReceived ?? 0) + files.length,
  originalsReceived: finalRows.length,
  reportsReceived: finalRows.length,
  acceptedPairs: finalRows.length,
  independentAcceptedPairs: finalRows.length,
  quarantinedPairs: newRows.length - acceptedReplacements.length,
  remainingPairsRequired: Math.max(0, 60 - finalRows.length),
  scoreDistribution: {
    count: finalRows.length,
    minimum: finalRows.length ? Math.min(...finalRows.map((row) => row.turnitinScore!)) : null,
    maximum: finalRows.length ? Math.max(...finalRows.map((row) => row.turnitinScore!)) : null,
    below5: finalRows.filter((row) => row.turnitinScore! < 5).length,
    from5To14: finalRows.filter((row) => row.turnitinScore! >= 5 && row.turnitinScore! < 15).length,
    atLeast15: finalRows.filter((row) => row.turnitinScore! >= 15).length,
  },
  replacementIntake: currentReplacementIntake,
  replacementIntakes: [...previousReplacementIntakes, currentReplacementIntake],
  replacedInvalidDocuments: [...previousInvalidDocuments, ...priorQuarantined],
  documents: finalRows,
};
writeFileSync(priorManifestPath, `${JSON.stringify(finalRows, null, 2)}\n`, "utf8");
writeFileSync(priorAuditPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  cohortStatus: audit.cohortStatus,
  acceptedBefore: sealedRows.length,
  acceptedReplacements: acceptedReplacements.length,
  finalIndependentPairs: finalRows.length,
  remainingPairsRequired: audit.remainingPairsRequired,
  evaluationOpened: audit.evaluationOpened,
  quarantined: newRows.filter((row) => row.status === "quarantined").map((row) => ({
    originalFile: row.originalFile, reportFile: row.reportFile, reasons: row.reasons,
  })),
}, null, 2));
