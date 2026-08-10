import assert from "node:assert/strict";
import test from "node:test";
import {
  englishLanguageEvidence,
  normalizedPairName,
  originalCoverageInReport,
  parseTurnitinReportText,
} from "../tools/similarity-final-test-core.ts";

test("classifies the dominant article language despite foreign-language metadata", () => {
  const englishBody = "the study is based on the evidence and the results which are discussed in this article ".repeat(80);
  const frenchMetadata = "résumé les résultats de cette étude sont présentés dans le contexte juridique ".repeat(3);
  const arabicAbstract = "ملخص الدراسة والنتائج في السياق القانوني ".repeat(3);
  const evidence = englishLanguageEvidence(`${frenchMetadata}\n${arabicAbstract}\n${englishBody}`);
  assert.equal(evidence.classification, "English");
  assert.ok(evidence.englishSignalShare > 0.9);
});

test("does not relabel a French article as English", () => {
  const evidence = englishLanguageEvidence(
    "les résultats de cette étude sont présentés dans le cadre de la recherche et sont analysés avec les données ".repeat(80),
  );
  assert.equal(evidence.classification, "French");
});

test("pairs originals with common Turnitin report spelling variants", () => {
  const original = normalizedPairName("A Study of Law (1).docx");
  assert.equal(normalizedPairName("A Study of Law Turnitin.pdf"), original);
  assert.equal(normalizedPairName("A Study of Law Turnitiin.pdf"), original);
  assert.equal(normalizedPairName("A Study of Law Turinitn.pdf"), original);
});

test("parses modern Turnitin score and submission identity", () => {
  const evidence = parseTurnitinReportText(`
    Submission ID trn:oid:::3117:571594526
    6% Overall Similarity
    Submission Date
    Apr 12, 2026, 12:17 PM GMT+1
    4,393 Words
    File Name
    Article.docx
  `);
  assert.equal(evidence.isSimilarityReport, true);
  assert.equal(evidence.score, 6);
  assert.equal(evidence.submissionId, "trn:oid:::3117:571594526");
  assert.equal(evidence.submittedWordCount, 4393);
});

test("rejects a receipt or article PDF without a similarity score", () => {
  const evidence = parseTurnitinReportText("This receipt confirms that Turnitin received your submission. Submission ID trn:oid:::3117:1");
  assert.equal(evidence.isSimilarityReport, false);
  assert.equal(evidence.score, null);
});

test("content coverage exposes a report belonging to another article", () => {
  const original = "digital voting integrity accountability public institutions ".repeat(40);
  const matchingReport = `6% Overall Similarity trn:oid:::3117:12 ${original}`;
  const wrongReport = `6% Overall Similarity trn:oid:::3117:13 ${"hospital safety infection prevention nursing care ".repeat(40)}`;
  assert.ok(originalCoverageInReport(original, matchingReport) > 0.95);
  assert.equal(originalCoverageInReport(original, wrongReport), 0);
});
