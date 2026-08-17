import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * "start the two fixes now" TASK 1/5: app/page.tsx's generateReport() is a
 * long client-side function inside a single giant "use client" component —
 * this codebase has no React component-test harness (see
 * tests/archive-overlap-claim.test.mjs's own identical convention), so the
 * one honest way to prove the SAVE/SHOW ordering contract holds is to read
 * the real source and assert on it structurally, the same way that file
 * already proves copy/branding claims. This is deliberately NOT a
 * substitute for the orchestrator/integration tests (which prove the
 * academic-search subsystem's own behavior); it proves the ONE thing only
 * the caller's own source can prove: that generateReport() never shows or
 * saves a report before academic evidence has been incorporated into it.
 */

test("PIPELINE ORDERING: academic + Wikipedia checks are awaited before unified similarity is computed, which happens before the report is saved", async () => {
  const page = await readFile("app/page.tsx", "utf8");

  const waitIndex = page.indexOf("const [webCheck, academicResult] = await Promise.all([wikipediaPromise, academicEvidencePromise]);");
  const unifiedIndex = page.indexOf("report = attachUnifiedSimilarity(report);");
  const saveIndex = page.indexOf("await saveReport(report);");

  assert.ok(waitIndex > -1, "generateReport must await both the academic and Wikipedia checks together before proceeding");
  assert.ok(unifiedIndex > -1, "generateReport must compute the unified similarity result");
  assert.ok(saveIndex > -1, "generateReport must save the report");
  assert.ok(waitIndex < unifiedIndex, "unified similarity must be computed AFTER the academic/Wikipedia checks resolve, not before");
  assert.ok(unifiedIndex < saveIndex, "the report must be saved AFTER unified similarity is computed, never before");
});

test("PIPELINE ORDERING: the enrichment call sites (Wikipedia, academic evidence) both occur between the wait and the save", async () => {
  const page = await readFile("app/page.tsx", "utf8");

  const waitIndex = page.indexOf("const [webCheck, academicResult] = await Promise.all([wikipediaPromise, academicEvidencePromise]);");
  const wikipediaEnrichIndex = page.indexOf("report = enrichReportWithWikipedia(report, webCheck);");
  const academicEnrichIndex = page.indexOf("report = enrichReportWithAcademicEvidence(report, academicResult);");
  const saveIndex = page.indexOf("await saveReport(report);");

  assert.ok(wikipediaEnrichIndex > waitIndex, "Wikipedia evidence must be merged after the wait, not before");
  assert.ok(academicEnrichIndex > waitIndex, "academic evidence must be merged after the wait, not before");
  assert.ok(wikipediaEnrichIndex < saveIndex && academicEnrichIndex < saveIndex, "both merges must happen before the save");
});

test("NO PROVISIONAL SCORE: saveReport(report) — the call that persists and displays the similarity result — occurs exactly once in generateReport's flow", async () => {
  const page = await readFile("app/page.tsx", "utf8");

  const occurrences = page.split("await saveReport(report);").length - 1;
  assert.equal(occurrences, 1, "a report must be saved exactly once for its similarity result — a second occurrence would mean a provisional score is shown and later silently replaced");
});

test("NO PROVISIONAL SCORE: the AI-writing merge uses storeReport/saveReportRemote directly, never a second saveReport(report) call, keeping the similarity axis untouched after its one save", async () => {
  const page = await readFile("app/page.tsx", "utf8");

  const aiMergeBlockStart = page.indexOf("void aiAnalysisPromise.then(async (aiResult) => {");
  assert.ok(aiMergeBlockStart > -1, "expected the decoupled AI-writing merge block to exist");
  const aiMergeBlockEnd = page.indexOf("});", aiMergeBlockStart);
  const aiMergeBlock = page.slice(aiMergeBlockStart, aiMergeBlockEnd);

  assert.match(aiMergeBlock, /storeReport\(enriched\)/);
  assert.match(aiMergeBlock, /saveReportRemote\(enriched/);
  assert.doesNotMatch(aiMergeBlock, /\bsaveReport\(/, "the AI merge must never call saveReport() again — that would re-run the similarity/academic/unified-score save path for an axis that has nothing to do with it");
});

test("AI DECOUPLING: the AI-writing analysis promise is created before the academic/Wikipedia wait, but is not itself awaited before the report is saved and shown", async () => {
  const page = await readFile("app/page.tsx", "utf8");

  const aiPromiseIndex = page.indexOf("const aiAnalysisPromise = analyzeAiText(");
  const waitIndex = page.indexOf("const [webCheck, academicResult] = await Promise.all([wikipediaPromise, academicEvidencePromise]);");
  const saveIndex = page.indexOf("await saveReport(report);");
  const navigateAfterSaveIndex = page.indexOf('navigate("reports");', saveIndex);

  assert.ok(aiPromiseIndex > -1, "expected the AI-writing analysis to be kicked off");
  assert.ok(aiPromiseIndex < waitIndex, "AI analysis should start before the blocking academic/Wikipedia wait, so its model download overlaps with it rather than adding to it");
  assert.doesNotMatch(
    page.slice(saveIndex - 400, saveIndex),
    /await aiAnalysisPromise/,
    "the AI-writing promise must not be awaited before the similarity report is saved — it is optional and independent",
  );
  assert.ok(navigateAfterSaveIndex > -1 && navigateAfterSaveIndex < page.indexOf("void aiAnalysisPromise.then"), "the report is navigated to/shown before the AI result is ever merged in");
});
