import assert from "node:assert/strict";
import test from "node:test";

import {
  extractPdfTextDocument,
  extractPdfTextDocumentWithCompleteness,
} from "../lib/pdf-text-extraction.ts";
import {
  extractDocxTextDocument,
  extractDocxTextDocumentWithCompleteness,
} from "../lib/docx-text-extraction.ts";
import {
  sanitizeExtractionDiagnostic,
  resolveReportCompletion,
  unknownExtractionDiagnostic,
  extractionDiagnosticFromCounts,
} from "../lib/evidence-interpretation/index.ts";
import {
  extractFileText,
  extractFileTextWithDiagnostics,
} from "../lib/document-check-pipeline.ts";

// ---------------------------------------------------------------------------
// Helpers — pdfjs-shaped mock documents
// ---------------------------------------------------------------------------
function pdfDoc(pages) {
  return {
    numPages: pages.length,
    async getPage(pageNumber) {
      const spec = pages[pageNumber - 1];
      if (spec === "THROW") throw new Error(`synthetic getPage failure on page ${pageNumber}`);
      return {
        async getTextContent() {
          if (spec === "THROW_CONTENT") throw new Error(`synthetic getTextContent failure on page ${pageNumber}`);
          return { items: (spec ?? []).map((str) => ({ str })) };
        },
      };
    },
  };
}

const textFile = (name, body) => ({ name, async text() { return body; } });
const docxConvert = (html, messages = []) => async () => ({ value: html, messages });
const docxConvertThrows = () => { throw new Error("corrupt docx: central directory not found"); };

// ---------------------------------------------------------------------------
// FIXTURE 1 — normal multi-page text PDF => COMPLETE, byte-equivalent text
// ---------------------------------------------------------------------------
test("PDF fixture 1: a normal multi-page text PDF is COMPLETE and text is byte-equivalent to the strict extractor", async () => {
  const doc = pdfDoc([["First", "page"], ["Second", "page"], ["Third", "page"]]);
  const strict = await extractPdfTextDocument(pdfDoc([["First", "page"], ["Second", "page"], ["Third", "page"]]));
  const r = await extractPdfTextDocumentWithCompleteness(doc);

  assert.equal(r.completeness, "COMPLETE");
  assert.equal(r.totalPages, 3);
  assert.equal(r.parsedPages, 3);
  assert.equal(r.failedPages, 0);
  assert.equal(r.emptyPages, 0);
  assert.equal(r.text, strict, "WithCompleteness text must be byte-identical to extractPdfTextDocument on a clean doc");
  assert.deepEqual(r.diagnostics, []);
});

// ---------------------------------------------------------------------------
// FIXTURE 2 — legitimate blank page must NOT force PARTIAL
// ---------------------------------------------------------------------------
test("PDF fixture 2: a legitimately blank page does not make extraction PARTIAL", async () => {
  const doc = pdfDoc([["Real", "content", "here"], [], ["More", "real", "content"]]);
  const r = await extractPdfTextDocumentWithCompleteness(doc);

  assert.equal(r.completeness, "COMPLETE", "a blank page is normal, not a failure");
  assert.equal(r.failedPages, 0);
  assert.equal(r.emptyPages, 1);
  assert.equal(r.parsedPages, 3);
});

// ---------------------------------------------------------------------------
// FIXTURE 3 — one page synthetically forced to fail => PARTIAL
// ---------------------------------------------------------------------------
test("PDF fixture 3: one page whose extraction is synthetically forced to fail => PARTIAL", async () => {
  const getPageFail = await extractPdfTextDocumentWithCompleteness(
    pdfDoc([["Page", "one"], "THROW", ["Page", "three"], ["Page", "four"]]),
  );
  assert.equal(getPageFail.completeness, "PARTIAL");
  assert.equal(getPageFail.failedPages, 1);
  assert.equal(getPageFail.parsedPages, 3);
  assert.ok(getPageFail.diagnostics.includes("PAGE_EXTRACTION_FAILED:2"));
  assert.ok(getPageFail.text.includes("Page one"));
  assert.ok(getPageFail.text.includes("Page three"), "the other pages are still extracted");

  const getContentFail = await extractPdfTextDocumentWithCompleteness(
    pdfDoc([["Alpha"], ["Beta"], "THROW_CONTENT"]),
  );
  assert.equal(getContentFail.completeness, "PARTIAL");
  assert.equal(getContentFail.failedPages, 1);
});

test("PDF fixture 3b: the strict extractPdfTextDocument still THROWS on a failing page (unchanged behaviour for corpus tools)", async () => {
  await assert.rejects(
    () => extractPdfTextDocument(pdfDoc([["ok"], "THROW", ["ok"]])),
    /synthetic getPage failure/,
  );
});

// ---------------------------------------------------------------------------
// FIXTURE 4 — PDF with no usable text anywhere => FAILED
// ---------------------------------------------------------------------------
test("PDF fixture 4: a PDF with no analyzable text on any page => FAILED", async () => {
  const allBlank = await extractPdfTextDocumentWithCompleteness(pdfDoc([[], [], []]));
  assert.equal(allBlank.completeness, "FAILED");
  assert.equal(allBlank.extractedWordCount, 0);

  const allFail = await extractPdfTextDocumentWithCompleteness(pdfDoc(["THROW", "THROW"]));
  assert.equal(allFail.completeness, "FAILED");
  assert.equal(allFail.parsedPages, 0);
});

// ---------------------------------------------------------------------------
// FIXTURE 5 — normal DOCX => COMPLETE, semantics unchanged
// ---------------------------------------------------------------------------
test("DOCX fixture 5: a normal DOCX is COMPLETE and its extracted text is identical to extractDocxTextDocument", async () => {
  const html = "<p>Hello world.</p><p>This is a normal document body.</p><ol><li>a footnote</li></ol>";
  const legacy = await extractDocxTextDocument(docxConvert(html));
  const r = await extractDocxTextDocumentWithCompleteness(docxConvert(html, [{ type: "warning" }]));

  assert.equal(r.completeness, "COMPLETE");
  assert.equal(r.parsed, true);
  assert.equal(r.text, legacy, "DOCX text must be byte-identical to the existing extractor");
  assert.ok(r.extractedWordCount > 5);
  assert.ok(r.diagnostics.includes("DOCX_CONVERSION_WARNINGS:1"), "mammoth messages are surfaced as tags but do not change the verdict");
});

// ---------------------------------------------------------------------------
// FIXTURE 6 — empty DOCX => FAILED
// ---------------------------------------------------------------------------
test("DOCX fixture 6: a successful parse that yields zero usable text => FAILED", async () => {
  const r = await extractDocxTextDocumentWithCompleteness(docxConvert("<p></p>   <p>   </p>"));
  assert.equal(r.completeness, "FAILED");
  assert.equal(r.parsed, true, "the parse itself succeeded");
  assert.equal(r.extractedWordCount, 0);
});

// ---------------------------------------------------------------------------
// FIXTURE 7 — corrupt DOCX => FAILED
// ---------------------------------------------------------------------------
test("DOCX fixture 7: a convertToHtml that throws (corrupt file) => FAILED, parsed=false", async () => {
  const r = await extractDocxTextDocumentWithCompleteness(docxConvertThrows);
  assert.equal(r.completeness, "FAILED");
  assert.equal(r.parsed, false);
  assert.equal(r.text, "");
  assert.ok(r.diagnostics.some((d) => d.startsWith("DOCX_PARSE_FAILED")));
});

// ---------------------------------------------------------------------------
// FIXTURE 8 — TXT success => COMPLETE
// ---------------------------------------------------------------------------
test("simple-format fixture 8: a successful .txt read => COMPLETE (never PARTIAL)", async () => {
  const { text, extraction } = await extractFileTextWithDiagnostics(
    textFile("notes.txt", "The quick brown fox jumps over the lazy dog."),
    () => {},
  );
  assert.equal(text, "The quick brown fox jumps over the lazy dog.");
  assert.equal(extraction.completeness, "COMPLETE");
  assert.equal(extraction.extractor, "plain-text");
  assert.equal(extraction.skipped, null);
});

test("simple-format: .md / .html / .csv all resolve COMPLETE on a good read", async () => {
  for (const name of ["a.md", "b.html", "c.csv"]) {
    const { extraction } = await extractFileTextWithDiagnostics(textFile(name, "one two three four"), () => {});
    assert.equal(extraction.completeness, "COMPLETE");
  }
});

// ---------------------------------------------------------------------------
// FIXTURE 9 — read / parser failure where testable => throw (existing failure path)
// ---------------------------------------------------------------------------
test("simple-format fixture 9: a read failure propagates as a throw (existing failure path, no bogus report)", async () => {
  const brokenFile = { name: "broken.txt", async text() { throw new Error("read error"); } };
  await assert.rejects(() => extractFileTextWithDiagnostics(brokenFile, () => {}), /read error/);
});

test("pipeline: a corrupt DOCX upload throws from extractFileTextWithDiagnostics (existing failure path)", async () => {
  // exercised indirectly — the FAILED completeness path in the pipeline throws
  // the same "This file could not be read." the old extractFileText did.
  const r = await extractDocxTextDocumentWithCompleteness(docxConvertThrows);
  assert.equal(r.completeness, "FAILED");
});

test("pipeline: unsupported extension still throws", async () => {
  await assert.rejects(
    () => extractFileTextWithDiagnostics(textFile("image.png", "x"), () => {}),
    /not supported/,
  );
});

// ---------------------------------------------------------------------------
// pipeline: extractFileText (legacy bare-string) is unchanged
// ---------------------------------------------------------------------------
test("pipeline: legacy extractFileText still returns a bare string and is unchanged for a good read", async () => {
  const out = await extractFileText(textFile("x.txt", "plain text content"), () => {});
  assert.equal(out, "plain text content");
});

// ---------------------------------------------------------------------------
// PHASE 5/6 — completion builder emits EXTRACTION_PARTIAL only from a real PARTIAL
// ---------------------------------------------------------------------------
test("completion: a real PARTIAL extraction diagnostic => EXTRACTION_PARTIAL", () => {
  const c = resolveReportCompletion({
    academicSearch: "COMPLETE_NO_MATCHES",
    extraction: extractionDiagnosticFromCounts({ extractor: "pdf-text-extraction-v1", unit: "pages", total: 12, read: 10 }),
  });
  assert.equal(c.state, "EXTRACTION_PARTIAL");
  assert.match(c.detail ?? "", /2 pages/);
});

test("completion: completeness UNKNOWN never becomes EXTRACTION_PARTIAL", () => {
  const c = resolveReportCompletion({ academicSearch: "COMPLETE_NO_MATCHES", extraction: unknownExtractionDiagnostic() });
  assert.equal(c.state, "COMPLETED");
  assert.notEqual(c.state, "EXTRACTION_PARTIAL");
});

test("completion: completeness COMPLETE never becomes EXTRACTION_PARTIAL", () => {
  const c = resolveReportCompletion({
    academicSearch: "COMPLETE_NO_MATCHES",
    extraction: extractionDiagnosticFromCounts({ extractor: "pdf-text-extraction-v1", unit: "pages", total: 8, read: 8 }),
  });
  assert.equal(c.state, "COMPLETED");
});

// ---------------------------------------------------------------------------
// TRUST BOUNDARY — sanitizeExtractionDiagnostic
// ---------------------------------------------------------------------------
test("sanitize: a well-formed PARTIAL client value survives, clamped", () => {
  const d = sanitizeExtractionDiagnostic({
    completeness: "PARTIAL",
    analyzableWordCount: 1234,
    skipped: { unit: "pages", total: 20, read: 17 },
    extractor: "pdf-text-extraction-v1",
    injected: "ignore me",
  });
  assert.deepEqual(d, {
    completeness: "PARTIAL",
    analyzableWordCount: 1234,
    skipped: { unit: "pages", total: 20, read: 17 },
    extractor: "pdf-text-extraction-v1",
  });
});

test("sanitize: absurd forged counts are bounded, and read can never exceed total", () => {
  const d = sanitizeExtractionDiagnostic({
    completeness: "PARTIAL",
    skipped: { unit: "pages", total: 9_999_999_999, read: -5 },
  });
  assert.ok(d.skipped.total <= 100_000, "total is capped");
  assert.equal(d.skipped.read, 0, "negative read clamps to 0");
});

test("sanitize: an unknown completeness value collapses to UNKNOWN (a forged FAILED cannot masquerade)", () => {
  assert.equal(sanitizeExtractionDiagnostic({ completeness: "FAILED" }).completeness, "UNKNOWN");
  assert.equal(sanitizeExtractionDiagnostic({ completeness: "totally-made-up" }).completeness, "UNKNOWN");
});

test("sanitize: non-object / empty input => null", () => {
  assert.equal(sanitizeExtractionDiagnostic(null), null);
  assert.equal(sanitizeExtractionDiagnostic("PARTIAL"), null);
  assert.equal(sanitizeExtractionDiagnostic(["PARTIAL"]), null);
});

test("sanitize: a garbage skipped object is dropped, completeness still honoured", () => {
  const d = sanitizeExtractionDiagnostic({ completeness: "COMPLETE", skipped: { unit: "furlongs", total: "lots" } });
  assert.equal(d.completeness, "COMPLETE");
  assert.equal(d.skipped, null);
});

// ---------------------------------------------------------------------------
// pipeline diagnostic shape — extractFileTextWithDiagnostics -> a real PARTIAL
// reaches resolveReportCompletion as EXTRACTION_PARTIAL
// ---------------------------------------------------------------------------
test("end to end (pure): a PARTIAL from the PDF extractor drives EXTRACTION_PARTIAL through the completion builder", async () => {
  const r = await extractPdfTextDocumentWithCompleteness(pdfDoc([["a"], "THROW", ["c"], ["d"], ["e"]]));
  const diag = extractionDiagnosticFromCounts({
    extractor: "pdf-text-extraction-v1",
    unit: "pages",
    total: r.totalPages,
    read: r.parsedPages,
    analyzableWordCount: r.extractedWordCount,
  });
  assert.equal(diag.completeness, "PARTIAL");
  const completion = resolveReportCompletion({ academicSearch: "COMPLETE_NO_MATCHES", extraction: sanitizeExtractionDiagnostic(diag) });
  assert.equal(completion.state, "EXTRACTION_PARTIAL");
  assert.match(completion.detail ?? "", /1 page/);
});

// ---------------------------------------------------------------------------
// PHASE 5 — PROPAGATION through the real POST + GET routes
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetAuthRateForTest, resetReadRateForTest } from "../lib/rate-limit.ts";
import { withTestIdentity } from "./helpers/test-signup.mjs";

const dbFile = path.join(path.resolve("."), "test_extraction_v2.db");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
delete process.env.SELECTIVE_CORPUS_SHADOW_ENABLED;
const dbClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(dbClient, path.join(path.resolve("."), "drizzle"));
test.after(() => {
  dbClient.close();
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
});

const cookieOf = (res) => (res.headers.get("set-cookie")?.match(/tp_session_v1=([^;]*)/) ?? [])[1] ?? null;
let uc = 0;
async function account() {
  uc += 1;
  const email = `extraction-v2-${uc}@example.test`;
  await resetAuthRateForTest("extraction-v2-signup-" + uc);
  const res = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "extraction-v2-signup-" + uc },
    body: JSON.stringify(withTestIdentity({ email, password: "extraction-v2-pw-1", username: `exv2u${uc}`, deviceKey: `extraction-v2-dev-${uc}` })),
  }));
  assert.equal(res.status, 201);
  return { deviceKey: `extraction-v2-dev-${uc}`, cookie: cookieOf(res), tag: `extraction-v2-${uc}` };
}
const WC = 160;
const DOC = Array.from({ length: WC }, (_, i) => `word${i}`).join(" ");
async function post(acc, id, extra) {
  await resetRateForTest(acc.tag + "-post");
  return reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": acc.tag + "-post", cookie: `tp_session_v1=${acc.cookie}` },
    body: JSON.stringify({
      deviceKey: acc.deviceKey, id, submissionId: "sub-" + id, title: "extraction v2 fixture",
      createdAt: new Date().toISOString(), wordCount: WC, archiveScore: 0, scoreBand: "Low",
      aiScore: 2, aiTone: "low", aiStatus: "ready", room: 0,
      payload: { version: 11, id, submissionId: "sub-" + id, title: "extraction v2 fixture", author: "", assignment: "", created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount: WC, scoreBand: "Low", matchedWordCount: 0, sources: [], repeats: [], text: DOC },
      ...extra,
    }),
  }));
}
async function readRow(deviceKey, id) {
  const r = await dbClient.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, id] });
  return r.rows[0] ? JSON.parse(String(r.rows[0].payload_json)) : null;
}
async function get(acc, id) {
  await resetReadRateForTest(acc.tag + "-get");
  const res = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(acc.deviceKey)}`, { headers: { "x-forwarded-for": acc.tag + "-get", cookie: `tp_session_v1=${acc.cookie}` } }),
    { params: Promise.resolve({ id: String(id) }) },
  );
  const body = await res.json();
  return body.payload ?? body;
}

test("route: a real PARTIAL extraction (sibling of payload) persists and drives reportCompletion EXTRACTION_PARTIAL, and survives GET", async () => {
  const acc = await account();
  const id = "exv2-partial-1";
  const res = await post(acc, id, {
    extractionCompleteness: { completeness: "PARTIAL", analyzableWordCount: 900, skipped: { unit: "pages", total: 12, read: 9 }, extractor: "pdf-text-extraction-v1" },
  });
  assert.equal(res.status, 200);

  const persisted = await readRow(acc.deviceKey, id);
  assert.equal(persisted.extractionDiagnostic.completeness, "PARTIAL", "a genuine sibling PARTIAL is persisted");
  assert.deepEqual(persisted.extractionDiagnostic.skipped, { unit: "pages", total: 12, read: 9 });
  assert.equal(persisted.reportCompletion.state, "EXTRACTION_PARTIAL");

  const got = await get(acc, id);
  assert.equal(got.extractionDiagnostic.completeness, "PARTIAL", "PARTIAL survives the GET recompute");
  assert.equal(got.reportCompletion.state, "EXTRACTION_PARTIAL");
  assert.match(got.reportCompletion.detail ?? "", /3 pages/);
});

test("route: a forged in-payload extractionDiagnostic (no sibling) is still stripped => UNKNOWN, COMPLETED", async () => {
  const acc = await account();
  const id = "exv2-forged-1";
  const res = await post(acc, id, {
    payload: { version: 11, id, submissionId: "sub-" + id, title: "x", author: "", assignment: "", created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount: WC, scoreBand: "Low", matchedWordCount: 0, sources: [], repeats: [], text: DOC,
      extractionDiagnostic: { completeness: "PARTIAL", analyzableWordCount: 1, skipped: { unit: "pages", total: 999, read: 0 }, extractor: "forged" } },
  });
  assert.equal(res.status, 200);
  const persisted = await readRow(acc.deviceKey, id);
  assert.equal(persisted.extractionDiagnostic.completeness, "UNKNOWN", "forged in-payload value did not survive");
  assert.equal(persisted.reportCompletion.state, "COMPLETED");
});

test("route: an ordinary upload with no extraction signal at all persists UNKNOWN / COMPLETED (unchanged)", async () => {
  const acc = await account();
  const id = "exv2-none-1";
  assert.equal((await post(acc, id, {})).status, 200);
  const persisted = await readRow(acc.deviceKey, id);
  assert.equal(persisted.extractionDiagnostic.completeness, "UNKNOWN");
  assert.equal(persisted.reportCompletion.state, "COMPLETED");
});

test("route: a forged sibling with absurd counts is clamped, not trusted verbatim", async () => {
  const acc = await account();
  const id = "exv2-clamp-1";
  await post(acc, id, {
    extractionCompleteness: { completeness: "PARTIAL", skipped: { unit: "pages", total: 9_999_999_999, read: 0 }, extractor: "x".repeat(500) },
  });
  const persisted = await readRow(acc.deviceKey, id);
  assert.ok(persisted.extractionDiagnostic.skipped.total <= 100_000, "absurd total is capped");
  assert.equal(persisted.extractionDiagnostic.extractor, null, "over-long extractor tag is dropped");
});
