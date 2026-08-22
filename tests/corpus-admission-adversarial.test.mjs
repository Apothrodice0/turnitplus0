import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import os from "os";
import path from "path";
import { createClient } from "@libsql/client";
import JSZip from "jszip";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { evaluateCorpusAdmissionCandidate } from "../lib/corpus-admission-gate.ts";
import { DEFAULT_CORPUS_ADMISSION_LIMITS } from "../lib/corpus-admission-types.ts";
import { resolveWithinRoot, rejectIfSymlink } from "../tools/corpus-admission-dry-run.ts";
import { buildMinimalEncryptedPdf } from "./helpers/pdf-fixtures.mjs";

/**
 * End-to-end adversarial coverage (requirement 8): confirms the WHOLE
 * pipeline fails closed for hostile inputs, re-exercising the individual
 * module tests (corpus-file-validation, corpus-docx-validation,
 * corpus-text-extraction) through evaluateCorpusAdmissionCandidate rather
 * than re-deriving new fixtures for each one.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_adversarial.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const client = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

const RESOLVED_PROVENANCE = {
  kind: "BULK_IMPORT_PROVENANCE",
  provenance: { sourceUrl: "https://example.test/adversarial", acquisitionMethod: "BULK_IMPORT_DOWNLOAD", licenseOrPermission: "CC-BY-4.0", retentionBasis: "LICENSED_REUSE", retentionRightsResolved: true, notes: null },
};

async function evaluate(sourceRef, filename, bytes, limits) {
  return evaluateCorpusAdmissionCandidate(client, { sourceRef, filename, bytes, consent: RESOLVED_PROVENANCE, dryRun: true, limits });
}

const BASE_DOCX_PARTS = {
  contentTypes: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  rootRels: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  documentXml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>`,
};

function baseDocxZip() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", BASE_DOCX_PARTS.contentTypes);
  zip.file("_rels/.rels", BASE_DOCX_PARTS.rootRels);
  zip.file("word/document.xml", BASE_DOCX_PARTS.documentXml);
  return zip;
}

test("ZIP BOMB: a docx with a pathologically compressible entry is REJECTed end-to-end, never reaching quality scoring", async () => {
  const zip = baseDocxZip();
  zip.file("word/media/padding.bin", "A".repeat(500_000));
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
  const decision = await evaluate("adv-zip-bomb", "bomb.docx", bytes);
  assert.equal(decision.decision, "REJECT");
  assert.ok(decision.hardGateFailureCodes.includes("DOCX_ZIP_BOMB_SUSPECTED"));
  assert.equal(decision.qualityScore, null, "a zip-bomb candidate must never reach quality scoring");
});

test("PATH TRAVERSAL (docx entry): a '..'-attempting entry path is neutralized by JSZip's own parser (verified empirically — see lib/corpus-docx-validation.ts's own comment) before the pipeline ever evaluates it, so this never crashes and never escapes the archive; the docx is otherwise still evaluated normally", async () => {
  const zip = baseDocxZip();
  zip.file("../../etc/evil.xml", "x");
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  const decision = await evaluate("adv-traversal-entry", "evil.docx", bytes);
  assert.ok(["ACCEPT", "REVIEW", "REJECT"].includes(decision.decision));
  assert.ok(!decision.hardGateFailureCodes.includes("DOCX_PATH_TRAVERSAL_ENTRY"), "JSZip already neutralizes the traversal attempt, so this reason code cannot fire via this parsing path");
});

test("PATH TRAVERSAL (CLI manifest): resolveWithinRoot refuses a candidate path outside the approved import root", () => {
  const root = path.join(os.tmpdir(), "corpus-admission-adversarial-root");
  assert.throws(() => resolveWithinRoot(root, path.join(root, "..", "outside.pdf")), /outside the approved import root/);
  assert.doesNotThrow(() => resolveWithinRoot(root, path.join(root, "inside.pdf")));
});

test("SYMLINK: rejectIfSymlink refuses a symlinked candidate without following it", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-admission-symlink-test-"));
  const target = path.join(dir, "real.txt");
  const link = path.join(dir, "link.txt");
  fs.writeFileSync(target, "real content");
  try {
    fs.symlinkSync(target, link);
  } catch (err) {
    t.skip(`symlink creation not permitted in this environment: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  try {
    assert.throws(() => rejectIfSymlink(link), /symlinked/);
    assert.doesNotThrow(() => rejectIfSymlink(target));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DISGUISED ZIP: a valid zip missing required OOXML parts is REJECTed as DOCX_STRUCTURE_INVALID, not silently treated as a valid docx", async () => {
  const zip = new JSZip();
  zip.file("some-file.txt", "this is a real, valid zip archive, just not a docx");
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  const decision = await evaluate("adv-disguised-zip", "disguised.docx", bytes);
  assert.equal(decision.decision, "REJECT");
  assert.ok(decision.hardGateFailureCodes.includes("DOCX_STRUCTURE_INVALID"));
});

test("ENCRYPTED PDF: a password-protected PDF is REJECTed end-to-end via EXTRACTION_FAILED, never crashing the pipeline", async () => {
  const bytes = buildMinimalEncryptedPdf();
  const decision = await evaluate("adv-encrypted-pdf", "secret.pdf", bytes);
  assert.equal(decision.decision, "REJECT");
  assert.ok(decision.hardGateFailureCodes.includes("EXTRACTION_FAILED"));
});

test("MACRO DOCUMENT: a docx containing vbaProject.bin is REJECTed end-to-end", async () => {
  const zip = baseDocxZip();
  zip.file("word/vbaProject.bin", Buffer.from([1, 2, 3, 4]));
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  const decision = await evaluate("adv-macro-docx", "macro.docx", bytes);
  assert.equal(decision.decision, "REJECT");
  assert.ok(decision.hardGateFailureCodes.includes("DOCX_MACRO_DETECTED"));
});

test("OVERSIZED FILE: a file exceeding maxFileBytes is REJECTed before any parsing is attempted", async () => {
  const tinyLimits = { ...DEFAULT_CORPUS_ADMISSION_LIMITS, maxFileBytes: { value: 100, status: "ENGINEERING_DEFAULT", rationale: "test" } };
  const bytes = Buffer.from("x".repeat(1000), "utf8");
  const decision = await evaluate("adv-oversized", "huge.txt", bytes, tinyLimits);
  assert.equal(decision.decision, "REJECT");
  assert.ok(decision.hardGateFailureCodes.includes("FILE_TOO_LARGE"));
});

test("MALFORMED ENCODING: invalid UTF-8 bytes in a txt candidate never crash the pipeline — a well-formed decision is always returned", async () => {
  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81, ...Buffer.from(" ".repeat(20), "utf8")]);
  const decision = await evaluate("adv-malformed-encoding", "bad-encoding.txt", invalidUtf8);
  assert.ok(["ACCEPT", "REVIEW", "REJECT"].includes(decision.decision));
});

test("EXTRACTION TIMEOUT: a real PDF under an aggressively short timeout is REJECTed via EXTRACTION_TIMEOUT, and the pipeline as a whole stays bounded", async () => {
  const tinyTimeoutLimits = { ...DEFAULT_CORPUS_ADMISSION_LIMITS, extractionTimeoutMs: { value: 1, status: "ENGINEERING_DEFAULT", rationale: "test" } };
  const bytes = fs.readFileSync(path.join(repoRoot, "tests/fixtures/attention-is-all-you-need.pdf"));
  const startedAt = Date.now();
  const decision = await evaluate("adv-timeout", "slow.pdf", bytes, tinyTimeoutLimits);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(decision.decision, "REJECT");
  assert.ok(decision.hardGateFailureCodes.includes("EXTRACTION_TIMEOUT"));
  assert.ok(elapsedMs < 5000, `pipeline took ${elapsedMs}ms under a 1ms extraction timeout, expected well under 5000ms`);
});

test("DANGEROUS EMBEDDED OBJECT: a docx with an embedded executable is REJECTed end-to-end", async () => {
  const zip = baseDocxZip();
  zip.file("word/embeddings/payload.exe", Buffer.from([1, 2, 3]));
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  const decision = await evaluate("adv-embedded-exe", "payload.docx", bytes);
  assert.equal(decision.decision, "REJECT");
  assert.ok(decision.hardGateFailureCodes.includes("DOCX_DANGEROUS_EMBEDDED_OBJECT"));
});

test("SPOOFED EXECUTABLE: a Windows PE binary renamed to .pdf is REJECTed end-to-end at the file-validation layer, before any extraction is attempted", async () => {
  const exeBytes = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, ...Buffer.from("padding".repeat(20))]);
  const decision = await evaluate("adv-spoofed-exe", "totally-a-pdf.pdf", exeBytes);
  assert.equal(decision.decision, "REJECT");
  assert.ok(decision.hardGateFailureCodes.includes("DANGEROUS_FILE_SIGNATURE"));
});
