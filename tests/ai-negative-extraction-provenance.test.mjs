import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PDF_EXTRACTOR_PDFJS_VERSION, PDF_EXTRACTOR_VERSION } from "../lib/pdf-text-extraction.ts";
import {
  AI_NEGATIVE_EXTRACTION_METHOD,
  assertExtractionContractReplacementAcknowledged,
  extractionContractsBeingReplaced,
  reextractedProvenance,
  REPLACE_EXTRACTION_CONTRACT_FLAG,
} from "../tools/ai-negative-extraction-provenance.ts";

/**
 * PROVENANCE of tools/reextract-ai-negatives-pdfjs.ts.
 *
 * The tool re-extracts the 88 verified-human AI-negative PDFs with the shared
 * PDF extractor and overwrites their stored text, their manifest provenance
 * and the parity report. Its label used to be the fixed string
 * "shared-pdfjs-text-layer-v3" — the contract the calibrated text really was
 * extracted under — which it would have gone on writing after the extractor
 * became pdf-text-extraction-v2. These tests pin the repair:
 *
 *   - the label is derived from PDF_EXTRACTOR_VERSION, never typed by hand;
 *   - text recorded under another contract is replaced only on an explicit,
 *     exact acknowledgement — otherwise the tool stops before it reads or
 *     writes anything;
 *   - what it writes names the extractor and the pdf.js release, and no
 *     longer carries the old integer contract number.
 *
 * Nothing here reads, regenerates or relabels a calibration artifact.
 */

const HISTORICAL_LABEL = "shared-pdfjs-text-layer-v3";
const readRepoFile = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const entry = (extractionMethod, extra = {}) => ({
  id: "ai-negative-x",
  provenance: { source: "user-supplied Corpus.zip", url: "corpus.zip#paper.pdf", journal: null, retrievedAt: null, sha256: "old-text-hash", ...(extractionMethod === undefined ? {} : { extractionMethod }), ...extra },
});

// =============================================================================
// The label
// =============================================================================

test("the label is derived from the extractor's own version tag", () => {
  assert.equal(AI_NEGATIVE_EXTRACTION_METHOD, `shared-pdfjs-text-layer-${PDF_EXTRACTOR_VERSION}`);
  assert.equal(AI_NEGATIVE_EXTRACTION_METHOD, "shared-pdfjs-text-layer-pdf-text-extraction-v2");
  assert.notEqual(AI_NEGATIVE_EXTRACTION_METHOD, HISTORICAL_LABEL, "text extracted now is never labelled as the calibrated contract");
});

test("DRIFT GUARD: the tool cannot name one extraction contract while running another", async () => {
  const tool = stripComments(await readRepoFile("tools/reextract-ai-negatives-pdfjs.ts"));
  const helper = stripComments(await readRepoFile("tools/ai-negative-extraction-provenance.ts"));

  // one definition, built from the constant of the module that does the extraction
  assert.match(helper, /import \{[^}]*\bPDF_EXTRACTOR_VERSION\b[^}]*\} from "\.\.\/lib\/pdf-text-extraction";/);
  assert.match(helper, /export const AI_NEGATIVE_EXTRACTION_METHOD = `shared-pdfjs-text-layer-\$\{PDF_EXTRACTOR_VERSION\}`;/);

  // the tool extracts with that same module and writes only the derived label
  assert.match(tool, /import \{[^}]*\bextractPdfTextDocument\b[^}]*\} from "\.\.\/lib\/pdf-text-extraction";/);
  assert.match(tool, /await extractPdfTextDocument\(document\)/);
  assert.match(tool, /extractionMethod: AI_NEGATIVE_EXTRACTION_METHOD,/);
  assert.match(tool, /pdfExtractorVersion: PDF_EXTRACTOR_VERSION,/);
  assert.match(tool, /provenance: reextractedProvenance\(entry\.provenance, \{/);

  // no hand-typed label or contract number is left in either file
  for (const [name, source] of [["tool", tool], ["helper", helper]]) {
    assert.doesNotMatch(source, /["'`]shared-pdfjs-text-layer-(?!\$\{)/, `${name}: a literal extraction label`);
    assert.doesNotMatch(source, /pdf-text-extraction-v\d/, `${name}: a literal extractor tag`);
    assert.doesNotMatch(source, /EXTRACTION_CONTRACT_VERSION|textExtractionContractVersion: /, `${name}: the old integer contract`);
  }
});

test("DRIFT GUARD: no generation path anywhere in the repo hand-types a versioned PDF extraction label", async () => {
  const offenders = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(path.join(process.cwd(), dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of entries) {
      const rel = path.posix.join(dir, item.name);
      if (item.isDirectory()) {
        if (rel !== "tools/output") await walk(rel);
      } else if (/\.(ts|tsx|mjs|js|py|sh)$/.test(item.name)) {
        if (rel === "lib/pdf-text-extraction.ts") continue; // the one place the tag is defined
        const source = await readRepoFile(rel);
        const code = /\.(py|sh)$/.test(item.name) ? source.replace(/^\s*#.*$/gm, "") : stripComments(source);
        if (/shared-pdfjs-text-layer-v\d|pdf-text-extraction-v\d/.test(code)) offenders.push(rel);
      }
    }
  }
  for (const root of ["tools", "scripts", "lib", "app", "components", "worker"]) await walk(root);
  assert.deepEqual(offenders, []);
});

test("the tool runs the extractor on the pdf.js release its tag is defined against, and checks before it extracts", async () => {
  const tool = stripComments(await readRepoFile("tools/reextract-ai-negatives-pdfjs.ts"));
  const load = tool.indexOf('await import("pdfjs-dist/legacy/build/pdf.mjs")');
  const guard = tool.indexOf("assertPdfjsContractVersion(pdfjs.version)");
  const parse = tool.indexOf("pdfjs.getDocument(");
  assert.ok(load >= 0 && load < guard && guard < parse);
});

// =============================================================================
// Fail closed
// =============================================================================

test("FAIL CLOSED: text recorded as shared-pdfjs-text-layer-v3 is not replaced unless the new contract is named", () => {
  const negatives = Array.from({ length: 88 }, () => entry(HISTORICAL_LABEL, { textExtractionContractVersion: 3 }));
  assert.deepEqual(extractionContractsBeingReplaced(negatives), { [HISTORICAL_LABEL]: 88 });

  assert.throws(
    () => assertExtractionContractReplacementAcknowledged(negatives, null),
    (error) => {
      assert.match(error.message, /^Refusing to re-extract: 88 of 88 AI-negative documents hold text recorded as shared-pdfjs-text-layer-v3 \(88\)\./);
      assert.match(error.message, /would replace it with shared-pdfjs-text-layer-pdf-text-extraction-v2 text, a different extraction contract/);
      assert.match(error.message, /Nothing was read or written\./);
      assert.match(error.message, /--replace-extraction-contract shared-pdfjs-text-layer-pdf-text-extraction-v2/);
      return true;
    },
  );
  // naming the OLD contract, or anything else, is not an acknowledgement
  for (const wrong of [HISTORICAL_LABEL, "yes", "true", "", "shared-pdfjs-text-layer-pdf-text-extraction-v1", "pdf-text-extraction-v2"]) {
    assert.throws(
      () => assertExtractionContractReplacementAcknowledged(negatives, wrong),
      /does not name the contract this build extracts under \(shared-pdfjs-text-layer-pdf-text-extraction-v2\)\. Nothing was read or written\./,
      `acknowledgement ${JSON.stringify(wrong)}`,
    );
  }
  assert.doesNotThrow(() => assertExtractionContractReplacementAcknowledged(negatives, AI_NEGATIVE_EXTRACTION_METHOD));
  assert.equal(REPLACE_EXTRACTION_CONTRACT_FLAG, "--replace-extraction-contract");
});

test("FAIL CLOSED: an unrecorded or mixed contract also needs the acknowledgement; text already under this contract does not", () => {
  const mixed = [entry(AI_NEGATIVE_EXTRACTION_METHOD), entry(HISTORICAL_LABEL), entry(undefined), entry(""), entry(3)];
  assert.deepEqual(extractionContractsBeingReplaced(mixed), { [HISTORICAL_LABEL]: 1, "(unrecorded)": 3 });
  assert.throws(() => assertExtractionContractReplacementAcknowledged(mixed, null), /4 of 5 AI-negative documents hold text recorded as shared-pdfjs-text-layer-v3 \(1\), \(unrecorded\) \(3\)/);

  const current = [entry(AI_NEGATIVE_EXTRACTION_METHOD), entry(AI_NEGATIVE_EXTRACTION_METHOD)];
  assert.deepEqual(extractionContractsBeingReplaced(current), {});
  assert.doesNotThrow(() => assertExtractionContractReplacementAcknowledged(current, null), "re-extracting under the same contract is a routine, repeatable run");
  assert.doesNotThrow(() => assertExtractionContractReplacementAcknowledged(current, AI_NEGATIVE_EXTRACTION_METHOD));
  assert.throws(() => assertExtractionContractReplacementAcknowledged(current, HISTORICAL_LABEL), /does not name the contract/, "a stale acknowledgement is refused even when nothing would be replaced");
});

test("FAIL CLOSED: the tool asks before it loads pdf.js, opens an archive or writes a file", async () => {
  const tool = stripComments(await readRepoFile("tools/reextract-ai-negatives-pdfjs.ts"));
  const guard = tool.indexOf("assertExtractionContractReplacementAcknowledged(negatives, optionalValue(REPLACE_EXTRACTION_CONTRACT_FLAG))");
  assert.ok(guard >= 0, "the guard is called with the flag's value");
  // (the calls — readArchiveEntry's own definition sits above, like every other helper)
  for (const later of ['await import("pdfjs-dist', "readArchiveEntry(archivePath, fileName)", "writeFileSync(", "pdfjs.getDocument("]) {
    const at = tool.indexOf(later, guard);
    assert.ok(at > guard, `${later} comes after the guard`);
    assert.equal(tool.slice(0, guard).includes(later), false, `${later} never runs before the guard`);
  }
});

// =============================================================================
// What a run records
// =============================================================================

test("a re-extracted document records the label, the extractor tag and the pdf.js release — and drops the replaced contract number", () => {
  const previous = entry(HISTORICAL_LABEL, { textExtractionContractVersion: 3, pdfSha256: "pdf-hash", sourceFileName: "paper.pdf" }).provenance;
  const snapshot = JSON.stringify(previous);
  const next = reextractedProvenance(previous, { textSha256: "new-text-hash", pdfSha256: "pdf-hash", sourceFileName: "paper.pdf", pdfjsVersion: PDF_EXTRACTOR_PDFJS_VERSION });
  assert.deepEqual(next, {
    source: "user-supplied Corpus.zip",
    url: "corpus.zip#paper.pdf",
    journal: null,
    retrievedAt: null,
    sha256: "new-text-hash",
    extractionMethod: "shared-pdfjs-text-layer-pdf-text-extraction-v2",
    pdfSha256: "pdf-hash",
    sourceFileName: "paper.pdf",
    pdfExtractorVersion: "pdf-text-extraction-v2",
    pdfjsVersion: "6.2.108",
  });
  assert.equal("textExtractionContractVersion" in next, false);
  assert.equal(JSON.stringify(previous), snapshot, "the stored provenance object is not modified in place");
});

test("a pdf.js build the extractor tag is not defined against cannot be recorded under that tag", () => {
  for (const other of ["6.2.107", "6.3.0", "", undefined]) {
    assert.throws(
      () => reextractedProvenance(entry(HISTORICAL_LABEL).provenance, { textSha256: "t", pdfSha256: "p", sourceFileName: "f.pdf", pdfjsVersion: other }),
      (error) => error.name === "PdfjsContractVersionError",
    );
  }
});

test("the parity report names the extractor and what was replaced, under a new report version; its readers are unaffected", async () => {
  const tool = stripComments(await readRepoFile("tools/reextract-ai-negatives-pdfjs.ts"));
  const report = tool.slice(tool.indexOf("const report = {"), tool.indexOf("writeFileSync(REPORT_PATH"));
  assert.match(report, /schema: "turnitplus-ai-extraction-parity",/);
  assert.match(report, /version: 3,/);
  assert.match(report, /extractionMethod: AI_NEGATIVE_EXTRACTION_METHOD,\s*pdfExtractorVersion: PDF_EXTRACTOR_VERSION,\s*pdfjsVersion: pdfjs\.version,\s*replacedExtractionContracts: replacedContracts,/);
  assert.doesNotMatch(report, /extractionContractVersion/);

  // tools/measure-ai-fpr.ts reads four fields of the report, none of them the label
  const reader = stripComments(await readRepoFile("tools/measure-ai-fpr.ts"));
  assert.match(reader, /extractionParity\?\.status === "passed"/);
  assert.doesNotMatch(reader, /extractionMethod|extractionContractVersion|pdfExtractorVersion/);
  for (const field of ["status", "coverageDifferencePoints", "finding", "requiredAction"]) assert.match(report, new RegExp(`\\b${field}:`));
});
