import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  assertPdfjsContractVersion,
  extractPdfTextDocument,
  extractPdfTextDocumentWithCompleteness,
  inspectPdfLineBreakRepair,
  isPdfjsContractVersionError,
  PDF_EXTRACTOR_PDFJS_VERSION,
  PDF_EXTRACTOR_VERSION,
  PdfjsContractVersionError,
} from "../lib/pdf-text-extraction.ts";
import {
  extractionDiagnosticFromCounts,
  sanitizeExtractionDiagnostic,
} from "../lib/evidence-interpretation/extraction.ts";
import { normalizeExtractedText } from "../lib/extracted-text-normalization.ts";
import { DOCUMENT_CORRESPONDENCE_THRESHOLDS_VERSION } from "../lib/document-correspondence.ts";
import { canonicalSha256 } from "../lib/document-identity.ts";
import {
  suppliedReferenceCacheKey,
  USER_SUPPLIED_REFERENCE_MATCHER_VERSION,
  USER_SUPPLIED_REFERENCE_NORMALIZER_VERSION,
} from "../lib/user-supplied-references.ts";
import { comparisonText, tokensForScoringNormalization, tokenSpans } from "../lib/similarity-core.ts";
import { compareWithReference, v1PageText } from "./fixtures/pdf-line-break/conformance.mjs";

/**
 * pdf-text-extraction-v2 — the VERSION CONTRACT around the extractor:
 *
 *   - the extractor tag and the one pdf.js release it is defined against;
 *   - that release pinned exactly, everywhere it is declared;
 *   - the browser path refusing any other pdf.js build before it parses a byte;
 *   - where the tag is recorded, and the score-neutral diagnostics beside it;
 *   - every consumer going through the one shared extractor;
 *   - a stored report never being re-extracted.
 *
 * The rule itself is pinned by tests/pdf-line-break-conformance.test.mjs and
 * tests/pdf-line-break-hyphenation.test.mjs.
 */

const repoFile = (relativePath) => new URL(`../${relativePath}`, import.meta.url);
const readRepoFile = (relativePath) => readFile(repoFile(relativePath), "utf8");

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

async function listSourceFiles(roots) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(path.join(process.cwd(), dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) await walk(rel);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) files.push(rel);
    }
  }
  for (const root of roots) await walk(root);
  return files.sort();
}

// =============================================================================
// The version constants
// =============================================================================

test("the extractor tag is pdf-text-extraction-v2 and it is defined against pdf.js 6.2.108", () => {
  assert.equal(PDF_EXTRACTOR_VERSION, "pdf-text-extraction-v2");
  assert.equal(PDF_EXTRACTOR_PDFJS_VERSION, "6.2.108");
});

test("the extractor version is not a scoring-normalization version: lib/pdf-text-extraction.ts depends on nothing, and scoring code never reads the tag", async () => {
  const extractor = stripComments(await readRepoFile("lib/pdf-text-extraction.ts"));
  assert.doesNotMatch(extractor, /\bimport\b/, "the extractor has no imports at all — no normalization, no scoring");
  for (const file of ["lib/similarity-core.ts", "lib/extracted-text-normalization.ts", "lib/reference-section.ts"]) {
    assert.doesNotMatch(stripComments(await readRepoFile(file)), /PDF_EXTRACTOR|pdf-text-extraction/, `${file} must not depend on the extractor version`);
  }
});

// =============================================================================
// The exact pin
// =============================================================================

test("pdfjs-dist is pinned EXACTLY to the contract version in package.json, in the lockfile, and in the Windows package manifest", async () => {
  const rootPackage = JSON.parse(await readRepoFile("package.json"));
  assert.equal(rootPackage.dependencies["pdfjs-dist"], PDF_EXTRACTOR_PDFJS_VERSION, "root package.json: an exact version, no range");

  const lock = JSON.parse(await readRepoFile("package-lock.json"));
  assert.equal(lock.packages[""].dependencies["pdfjs-dist"], PDF_EXTRACTOR_PDFJS_VERSION, "lockfile root requirement");
  assert.equal(lock.packages["node_modules/pdfjs-dist"].version, PDF_EXTRACTOR_PDFJS_VERSION, "lockfile resolved version");
  assert.equal(lock.packages["node_modules/pdfjs-dist"].resolved, `https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-${PDF_EXTRACTOR_PDFJS_VERSION}.tgz`);

  // windows/package.json becomes the package.json of the Windows bundle
  // (scripts/package-windows.sh), which resolves its own lockfile from it at
  // packaging time and runs the same lib/*.ts — so it must name the same build.
  const windowsPackage = JSON.parse(await readRepoFile("windows/package.json"));
  assert.equal(windowsPackage.dependencies["pdfjs-dist"], PDF_EXTRACTOR_PDFJS_VERSION, "windows/package.json: an exact version, no range");
});

test("the installed pdf.js IS the contract build: package version, the legacy API the server paths import, and the worker the browser fetches", async () => {
  const installed = JSON.parse(await readRepoFile("node_modules/pdfjs-dist/package.json"));
  assert.equal(installed.version, PDF_EXTRACTOR_PDFJS_VERSION);

  const legacy = await import("pdfjs-dist/legacy/build/pdf.mjs");
  assert.equal(legacy.version, PDF_EXTRACTOR_PDFJS_VERSION);
  assert.doesNotThrow(() => assertPdfjsContractVersion(legacy.version));

  // build/pdf.worker.min.mjs is the file the browser loads from
  // unpkg.com/pdfjs-dist@<version>/build/. This digest is the one the contract
  // audit measured for both the npm package and the unpkg copy of 6.2.108.
  const worker = await readFile(repoFile("node_modules/pdfjs-dist/build/pdf.worker.min.mjs"));
  assert.equal(createHash("sha256").update(worker).digest("hex"), "0613f41490dd6aaceed7a93fbbd38c85e6d6aa60474b6588c6e7709cfbe18cb3");
});

test("pdf.js itself refuses a worker of another version: the worker compares the API version it is handed with its own", async () => {
  const worker = await readRepoFile("node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
  assert.match(worker, /apiVersion:(\w+)\}=\w+,(\w+)="6\.2\.108";if\(\1!==\2\)throw new Error\(`The API version "\$\{\1\}" does not match the Worker version "\$\{\2\}"\.`\)/);
});

// =============================================================================
// The version guard
// =============================================================================

test("version guard: exactly 6.2.108 passes; anything else throws a clear extraction error", () => {
  assert.doesNotThrow(() => assertPdfjsContractVersion("6.2.108"));
  for (const other of ["6.2.109", "6.2.107", "6.3.0", "6.1.200", "7.0.0", "6.2.108-beta", " 6.2.108", "6.2.108 ", "v6.2.108", "", undefined, null, 6.2108, ["6.2.108"], { version: "6.2.108" }]) {
    assert.throws(
      () => assertPdfjsContractVersion(other),
      (error) => {
        assert.ok(error instanceof PdfjsContractVersionError);
        assert.ok(error instanceof Error);
        assert.equal(error.name, "PdfjsContractVersionError");
        assert.ok(isPdfjsContractVersionError(error));
        assert.match(error.message, /^PDF text extraction pdf-text-extraction-v2 requires pdf\.js 6\.2\.108, but pdf\.js .+ was loaded\. The document was not read\.$/);
        return true;
      },
      `pdf.js version ${JSON.stringify(other)} must be refused`,
    );
  }
  assert.match(new PdfjsContractVersionError("6.3.0").message, /but pdf\.js 6\.3\.0 was loaded/);
  assert.match(new PdfjsContractVersionError(undefined).message, /but pdf\.js an unknown version was loaded/);
  assert.equal(isPdfjsContractVersionError(new Error("PdfjsContractVersionError")), false);
  assert.equal(isPdfjsContractVersionError("PdfjsContractVersionError"), false);
});

test("browser path: both PDF branches assert the pdf.js version first — before the worker URL is set and before the file is parsed", async () => {
  const source = stripComments(await readRepoFile("lib/document-check-pipeline.ts"));
  const branches = source.split('await import("pdfjs-dist")').slice(1);
  assert.equal(branches.length, 2, "extractFileText and extractFileTextWithDiagnostics");
  for (const branch of branches) {
    assert.match(branch, /^;\s*assertPdfjsContractVersion\(pdfjs\.version\);\s*pdfjs\.GlobalWorkerOptions\.workerSrc = /, "the guard is the first statement after the import");
    const guard = branch.indexOf("assertPdfjsContractVersion(pdfjs.version)");
    const worker = branch.indexOf("GlobalWorkerOptions.workerSrc");
    const parse = branch.search(/getDocument\(|loadPdfDocument\(/);
    assert.ok(guard >= 0 && guard < worker && worker < parse);
  }
  assert.equal(source.match(/assertPdfjsContractVersion\(/g).length, 2);
});

test("browser path: the worker comes from unpkg at the version the guard just proved — no second worker source, no fallback", async () => {
  // raw source for the URL itself: stripComments() would cut it at "//"
  const assignments = (await readRepoFile("lib/document-check-pipeline.ts")).match(/GlobalWorkerOptions\.workerSrc = .*;/g);
  const source = stripComments(await readRepoFile("lib/document-check-pipeline.ts"));
  assert.deepEqual(assignments, [
    "GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;",
    "GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;",
  ]);
  assert.doesNotMatch(source, /workerPort|disableWorker|fetch\([^)]*pdf\.worker/, "no alternative worker wiring and no run-time fetch/hash of the worker");
  // the guard throws; nothing here catches it to retry with another version
  assert.doesNotMatch(source, /isPdfjsContractVersionError|PdfjsContractVersionError/);
});

// =============================================================================
// Where the version is recorded
// =============================================================================

test("the tag reaches every existing version home through the one constant", async () => {
  // report.extractionDiagnostic.extractor (browser upload)
  const pipeline = stripComments(await readRepoFile("lib/document-check-pipeline.ts"));
  assert.match(pipeline, /extractionDiagnosticFromCounts\(\{\s*extractor: PDF_EXTRACTOR_VERSION,/);
  // source_retrievals.extractor_version (scholarly PDF retrieval)
  assert.match(stripComments(await readRepoFile("lib/http-content-retriever.ts")), /extractorVersion = PDF_EXTRACTOR_VERSION;/);
  // corpus admission content store extractor_version (server corpus worker)
  assert.match(stripComments(await readRepoFile("lib/corpus-extraction-worker.ts")), /extractorVersion = PDF_EXTRACTOR_VERSION;/);
  // user-supplied reference cache identity
  assert.match(stripComments(await readRepoFile("lib/user-supplied-references.ts")), /input\.fileType === "pdf" \? PDF_EXTRACTOR_VERSION/);

  // no production file spells a PDF extractor tag by hand
  const offenders = [];
  for (const file of await listSourceFiles(["lib", "app", "components"])) {
    if (file === "lib/pdf-text-extraction.ts") continue;
    if (/pdf-text-extraction-v\d/.test(stripComments(await readRepoFile(file)))) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test("user-supplied reference cache identity: a PDF reference extracted by v2 never shares a key with the same text under another extractor", () => {
  const input = { manuscriptText: "manuscript text", referenceText: "reference text" };
  const pdf = suppliedReferenceCacheKey({ ...input, fileType: "pdf" });
  assert.match(pdf, /^[0-9a-f]{64}$/);
  assert.notEqual(pdf, suppliedReferenceCacheKey({ ...input, fileType: "docx" }));
  assert.notEqual(pdf, suppliedReferenceCacheKey({ ...input, fileType: "txt" }));

  // the key is a digest over a list that names the extractor: rebuilt here for
  // v2 (what the function returns now) and for v1 (which it no longer returns)
  const keyFor = (extractor) => canonicalSha256([
    "user-supplied-reference-cache-v1",
    `manuscript:${canonicalSha256(input.manuscriptText)}`,
    `reference:${canonicalSha256(input.referenceText)}`,
    `extractor:${extractor}`,
    `normalizer:${USER_SUPPLIED_REFERENCE_NORMALIZER_VERSION}`,
    `matcher:${DOCUMENT_CORRESPONDENCE_THRESHOLDS_VERSION}`,
    `channel:${USER_SUPPLIED_REFERENCE_MATCHER_VERSION}`,
  ].join("\n"));
  assert.equal(pdf, keyFor("pdf-text-extraction-v2"));
  assert.notEqual(pdf, keyFor("pdf-text-extraction-v1"));
});

// =============================================================================
// Diagnostics
// =============================================================================

test("extraction diagnostic: a PDF upload records the extractor tag, the pdf.js version and the number of joins — counts only", async () => {
  const diagnostic = extractionDiagnosticFromCounts({
    extractor: PDF_EXTRACTOR_VERSION, unit: "pages", total: 12, read: 12, analyzableWordCount: 5400,
    engineVersion: PDF_EXTRACTOR_PDFJS_VERSION, lineBreakJoins: 37,
  });
  assert.deepEqual(diagnostic, {
    completeness: "COMPLETE",
    analyzableWordCount: 5400,
    skipped: { unit: "pages", total: 12, read: 12 },
    extractor: "pdf-text-extraction-v2",
    engineVersion: "6.2.108",
    lineBreakJoins: 37,
  });
  assert.deepEqual(sanitizeExtractionDiagnostic(diagnostic), diagnostic, "the server keeps exactly these fields");

  const pipeline = stripComments(await readRepoFile("lib/document-check-pipeline.ts"));
  assert.match(pipeline, /engineVersion: pdfjs\.version,\s*lineBreakJoins: result\.lineBreakJoins,/);
});

test("extraction diagnostic: callers that do not pass the new fields, and every stored diagnostic that predates them, keep their exact shape", () => {
  assert.deepEqual(
    extractionDiagnosticFromCounts({ extractor: "pdf-text-extraction-v1", unit: "pages", total: 12, read: 10 }),
    { completeness: "PARTIAL", analyzableWordCount: null, skipped: { unit: "pages", total: 12, read: 10 }, extractor: "pdf-text-extraction-v1" },
  );
  const stored = { completeness: "COMPLETE", analyzableWordCount: 900, skipped: { unit: "pages", total: 8, read: 8 }, extractor: "pdf-text-extraction-v1" };
  const sanitized = sanitizeExtractionDiagnostic(stored);
  assert.deepEqual(sanitized, stored);
  assert.deepEqual(Object.keys(sanitized), ["completeness", "analyzableWordCount", "skipped", "extractor"], "no new key appears on a v1 diagnostic");
  assert.deepEqual(Object.keys(sanitizeExtractionDiagnostic({ completeness: "COMPLETE", extractor: "plain-text" })), ["completeness", "analyzableWordCount", "skipped", "extractor"]);
});

test("extraction diagnostic: the server sanitiser bounds the new fields and never lets text through", () => {
  const base = { completeness: "COMPLETE", analyzableWordCount: 10, skipped: null, extractor: "pdf-text-extraction-v2" };
  const keep = (extra) => sanitizeExtractionDiagnostic({ ...base, ...extra });

  assert.equal(keep({ engineVersion: "6.2.108" }).engineVersion, "6.2.108");
  assert.equal(keep({ engineVersion: "6.2.108-rc.1+build5" }).engineVersion, "6.2.108-rc.1+build5");
  for (const bad of ["", " 6.2.108", "6.2.108 beta", "<script>", "6.2.108\n", "x".repeat(33), 6, null, ["6.2.108"], { v: 1 }]) {
    assert.equal("engineVersion" in keep({ engineVersion: bad }), false, `engineVersion ${JSON.stringify(bad)} must be dropped`);
  }

  assert.equal(keep({ lineBreakJoins: 0 }).lineBreakJoins, 0);
  assert.equal(keep({ lineBreakJoins: 412 }).lineBreakJoins, 412);
  assert.equal(keep({ lineBreakJoins: 12.9 }).lineBreakJoins, 12);
  assert.equal(keep({ lineBreakJoins: 10 ** 12 }).lineBreakJoins, 100_000, "capped like every other count");
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "37", null, [37]]) {
    assert.equal("lineBreakJoins" in keep({ lineBreakJoins: bad }), false, `lineBreakJoins ${JSON.stringify(bad)} must be dropped`);
  }

  // nothing that could carry document text survives
  const hostile = keep({ engineVersion: "6.2.108", lineBreakJoins: 3, joinedWords: ["example"], sites: [{ leftFragment: "exam", rightFragment: "ple" }], text: "secret" });
  assert.deepEqual(Object.keys(hostile), ["completeness", "analyzableWordCount", "skipped", "extractor", "engineVersion", "lineBreakJoins"]);
});

test("the join count is a diagnostic only: nothing that scores, matches or completes a report reads it", async () => {
  const readers = [];
  for (const file of await listSourceFiles(["lib", "app", "components"])) {
    if (/\blineBreakJoins\b|\bengineVersion\b/.test(stripComments(await readRepoFile(file)))) readers.push(file);
  }
  assert.deepEqual(readers, ["lib/document-check-pipeline.ts", "lib/evidence-interpretation/extraction.ts", "lib/pdf-text-extraction.ts"]);
});

// =============================================================================
// One shared extractor
// =============================================================================

test("every PDF consumer goes through the one shared extractor: nobody else reads pdf.js text content", async () => {
  const importers = [];
  const textContentReaders = [];
  for (const file of await listSourceFiles(["lib", "app", "components"])) {
    const source = stripComments(await readRepoFile(file));
    if (/from\s+["'](?:@\/lib\/|\.\.?\/(?:lib\/)?)pdf-text-extraction["']/.test(source)) importers.push(file);
    if (/\.getTextContent\(/.test(source)) textContentReaders.push(file);
  }
  assert.deepEqual(textContentReaders, ["lib/pdf-text-extraction.ts"], "getTextContent() is called in exactly one place");
  assert.deepEqual(importers, [
    "lib/corpus-extraction-worker.ts", // server corpus worker / admission
    "lib/document-check-pipeline.ts", // manuscript upload + user-supplied PDF references (browser)
    "lib/e7-asjp-client.ts", // ASJP pilot client
    "lib/http-content-retriever.ts", // scholarly PDF retrieval
    "lib/user-supplied-references.ts", // cache identity only (the version constant)
  ]);

  // developer tools: the ones that extract PDFs do it with the shared extractor too
  const tools = [];
  for (const file of await listSourceFiles(["tools"])) {
    const source = stripComments(await readRepoFile(file));
    if (/pdfjs-dist/.test(source) && /getDocument\(/.test(source)) tools.push([file, /pdf-text-extraction["']/.test(source) && /extractPdfTextDocument\(/.test(source)]);
  }
  assert.ok(tools.length >= 3);
  assert.deepEqual(tools.filter(([, shared]) => !shared), [], "a tool that opens PDFs with pdf.js must extract with the shared extractor");
});

test("a user-supplied PDF reference is extracted by the same function as the manuscript", async () => {
  const pipeline = stripComments(await readRepoFile("lib/document-check-pipeline.ts"));
  assert.match(pipeline, /export async function extractReferenceInputs\([\s\S]*?=> Promise<\{ text: string; extraction: ReportExtractionDiagnostic \}> = extractFileTextWithDiagnostics,/);
});

// =============================================================================
// Stored reports are never re-extracted
// =============================================================================

test("historical reports: only the two upload flows can reach the extractor — no report read, reopen, list or hydration path does", async () => {
  const callers = [];
  for (const file of await listSourceFiles(["lib", "app", "components"])) {
    if (file === "lib/document-check-pipeline.ts") continue;
    if (/\b(extractFileTextWithDiagnostics|extractFileText|extractReferenceInputs)\b/.test(stripComments(await readRepoFile(file)))) callers.push(file);
  }
  assert.deepEqual(callers, ["app/page.tsx", "app/reports/rooms/[room]/room-page-shell.tsx"]);
  for (const file of callers) {
    const source = stripComments(await readRepoFile(file));
    assert.equal(source.match(/extractFileTextWithDiagnostics\(/g).length, 1, `${file}: one extraction call, on the file the user just chose`);
    assert.match(source, /await extractFileTextWithDiagnostics\(\s*(submittedFile|file)\b/);
  }

  // the server never sees PDF bytes of a report: no API route imports the extractor or pdf.js
  const routes = (await listSourceFiles(["app/api"])).filter((file) => /route\.ts$/.test(file));
  assert.ok(routes.length > 20);
  for (const file of routes) {
    assert.doesNotMatch(stripComments(await readRepoFile(file)), /pdf-text-extraction|pdfjs-dist|document-check-pipeline/, `${file} must not reach the PDF extractor`);
  }
  // nor do the report store / hydration modules
  for (const file of ["lib/reports-remote.ts", "lib/report-store.ts", "lib/report-types.ts", "lib/report-evidence-interpretation.ts"]) {
    assert.doesNotMatch(stripComments(await readRepoFile(file)), /pdf-text-extraction|pdfjs-dist/, `${file} must not reach the PDF extractor`);
  }
});

// =============================================================================
// End to end on a real PDF, through the pinned pdf.js
// =============================================================================

let attention = null;
async function attentionPaper() {
  if (attention) return attention;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = await readFile(repoFile("tests/fixtures/attention-is-all-you-need.pdf"));
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, isEvalSupported: false }).promise;
  const pages = [];
  for (let n = 1; n <= document.numPages; n += 1) pages.push((await (await document.getPage(n)).getTextContent()).items);
  attention = { document, pages };
  return attention;
}

test("real PDF: pdf.js 6.2.108 hands the extractor the item stream the rule was measured on", async () => {
  const { pages } = await attentionPaper();
  assert.equal(pages.length, 15);
  const items = pages.flat();
  assert.equal(items.length, 2696);
  for (const entry of items) {
    assert.equal(typeof entry.str, "string");
    assert.equal(typeof entry.hasEOL, "boolean");
    assert.equal(typeof entry.dir, "string");
    assert.equal(typeof entry.width, "number");
    assert.ok(Array.isArray(entry.transform) && entry.transform.length === 6);
  }
  assert.equal(items.filter((entry) => entry.hasEOL).length, 824);
  const stream = pages.map((page) => page.map((entry) => [entry.str, entry.dir, entry.width, entry.height, entry.transform, entry.hasEOL]));
  assert.equal(
    createHash("sha256").update(JSON.stringify(stream)).digest("hex"),
    "0aa2a71903daee23bc20e6df02400d5cf821a8090c8b2e6a131514cb62c14e8c",
    "a different item stream for the same file means a different pdf.js — and a different extractor",
  );
});

test("real PDF: four line breaks are repaired, exactly as the frozen reference decides, and nothing else in the text moves", async () => {
  const { document, pages } = await attentionPaper();
  const { actual, differences } = compareWithReference(pages, inspectPdfLineBreakRepair);
  assert.deepEqual(differences, []);
  assert.equal(actual.sites.length, 16);
  assert.deepEqual(actual.sites.filter((site) => site.join).map((site) => `${site.leftFragment}+${site.rightFragment}`), [
    "transduc+tion", "transfor+mation", "convolu+tional", "Convolu+tional",
  ]);

  const text = await extractPdfTextDocument(document);
  const result = await extractPdfTextDocumentWithCompleteness(document);
  assert.equal(result.text, text);
  assert.equal(result.lineBreakJoins, 4);
  assert.equal(result.completeness, "COMPLETE");
  assert.equal(text, `${actual.pages.join("\n\n")}\n\n`);

  // v1 -> v2: each join removes its hyphen and the one space after it; every
  // other character is where it was
  const v1 = `${pages.map(v1PageText).join("\n\n")}\n\n`;
  assert.equal(v1.length - text.length, 8);
  let rebuilt = v1;
  for (const broken of ["transduc- tion", "transfor- mation", "convolu- tional", "Convolu- tional"]) {
    assert.equal(rebuilt.split(broken).length, 2, `v1 holds "${broken}" exactly once`);
    rebuilt = rebuilt.replace(broken, broken.replace("- ", ""));
  }
  assert.equal(text, rebuilt);
});

test("real PDF: the repaired text is the single text scoring sees — tokens and their character spans line up under both normalization contracts", async () => {
  const { document } = await attentionPaper();
  const text = normalizeExtractedText(await extractPdfTextDocument(document));
  const compared = comparisonText(text);
  for (const version of [1, 2]) {
    const words = tokensForScoringNormalization(text, version);
    const spans = tokenSpans(text, version);
    assert.equal(spans.length, words.length, `contract v${version}: every scored word has a character range`);
    let previousEnd = 0;
    for (const span of spans) {
      assert.ok(span.start >= previousEnd && span.end > span.start);
      assert.equal(compared.slice(span.start, span.end), span.word);
      previousEnd = span.end;
    }
    for (const word of ["transduction", "transformation", "convolutional"]) {
      const index = words.indexOf(word);
      assert.ok(index >= 0);
      assert.equal(spans[index].word.toLowerCase(), word, "a repaired word is one token with one contiguous range");
    }
    assert.equal(words.includes("transduc"), false, "the fragments are gone from the scored words");
  }
});
