import assert from "node:assert/strict";
import test from "node:test";
import { validateCorpusCandidateFile } from "../lib/corpus-file-validation.ts";
import { DEFAULT_CORPUS_ADMISSION_LIMITS } from "../lib/corpus-admission-types.ts";

function bytesOf(text) {
  return Buffer.from(text, "utf8");
}

test("pdf/docx/txt are accepted formats (given a matching signature)", () => {
  const pdf = validateCorpusCandidateFile({ filename: "a.pdf", bytes: Buffer.concat([Buffer.from("%PDF-1.7\n"), bytesOf("rest")]) });
  assert.equal(pdf.ok, true);
  assert.equal(pdf.format, "pdf");

  const docx = validateCorpusCandidateFile({ filename: "a.docx", bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]) });
  assert.equal(docx.ok, true);
  assert.equal(docx.format, "docx");

  const txt = validateCorpusCandidateFile({ filename: "a.txt", bytes: bytesOf("plain text content") });
  assert.equal(txt.ok, true);
  assert.equal(txt.format, "txt");
});

test("html and md pass file validation (policy caps them to REVIEW elsewhere, not rejected here)", () => {
  assert.equal(validateCorpusCandidateFile({ filename: "a.html", bytes: bytesOf("<p>hi</p>") }).ok, true);
  assert.equal(validateCorpusCandidateFile({ filename: "a.md", bytes: bytesOf("# hi") }).ok, true);
});

test("csv is rejected outright — v1 excludes it from corpus admission (requirement 7)", () => {
  const result = validateCorpusCandidateFile({ filename: "a.csv", bytes: bytesOf("a,b,c") });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "UNSUPPORTED_FILE_FORMAT");
});

test("any other extension is rejected", () => {
  const result = validateCorpusCandidateFile({ filename: "a.docm", bytes: bytesOf("x") });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "UNSUPPORTED_FILE_FORMAT");
});

test("empty file is rejected", () => {
  const result = validateCorpusCandidateFile({ filename: "a.txt", bytes: Buffer.alloc(0) });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "EMPTY_FILE");
});

test("oversized file is rejected before any parsing", () => {
  const tinyLimits = { ...DEFAULT_CORPUS_ADMISSION_LIMITS, maxFileBytes: { value: 10, status: "ENGINEERING_DEFAULT", rationale: "test" } };
  const result = validateCorpusCandidateFile({ filename: "a.txt", bytes: bytesOf("this is definitely more than ten bytes") }, tinyLimits);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "FILE_TOO_LARGE");
});

test("a renamed Windows executable claiming .pdf is rejected by the dangerous-signature blocklist, not the pdf signature check", () => {
  const exeBytes = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // MZ header
  const result = validateCorpusCandidateFile({ filename: "malware.pdf", bytes: exeBytes });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "DANGEROUS_FILE_SIGNATURE");
});

test("a renamed ELF binary claiming .txt is rejected", () => {
  const elfBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
  const result = validateCorpusCandidateFile({ filename: "notes.txt", bytes: elfBytes });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "DANGEROUS_FILE_SIGNATURE");
});

test("a pdf-extension file with wrong content (no %PDF- prefix, no dangerous signature) is a signature mismatch", () => {
  const result = validateCorpusCandidateFile({ filename: "fake.pdf", bytes: bytesOf("this is not a pdf at all") });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "FILE_SIGNATURE_MISMATCH");
});

test("a docx-extension file that is not actually a zip is a signature mismatch", () => {
  const result = validateCorpusCandidateFile({ filename: "fake.docx", bytes: bytesOf("this is not a zip at all") });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "FILE_SIGNATURE_MISMATCH");
});

test("a disguised zip claiming .txt (not .docx) is rejected as a dangerous signature", () => {
  const result = validateCorpusCandidateFile({ filename: "disguised.txt", bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]) });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "DANGEROUS_FILE_SIGNATURE");
});
