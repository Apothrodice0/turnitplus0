import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { validateDocxStructure } from "../lib/corpus-docx-validation.ts";
import { DEFAULT_CORPUS_ADMISSION_LIMITS } from "../lib/corpus-admission-types.ts";

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const MACRO_CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/>
</Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello world</w:t></w:r></w:p></w:body></w:document>`;

function baseZip({ contentTypes = CONTENT_TYPES_XML } = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", ROOT_RELS_XML);
  zip.file("word/document.xml", DOCUMENT_XML);
  return zip;
}

async function toBuffer(zip, options = {}) {
  return zip.generateAsync({ type: "nodebuffer", ...options });
}

test("a valid minimal docx passes structural validation", async () => {
  const buffer = await toBuffer(baseZip());
  const result = await validateDocxStructure(buffer);
  assert.equal(result.ok, true);
});

test("missing _rels/.rels fails as DOCX_STRUCTURE_INVALID", async () => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
  zip.file("word/document.xml", DOCUMENT_XML);
  const buffer = await toBuffer(zip);
  const result = await validateDocxStructure(buffer);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "DOCX_STRUCTURE_INVALID");
});

test("missing word/document.xml fails as DOCX_STRUCTURE_INVALID", async () => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
  zip.file("_rels/.rels", ROOT_RELS_XML);
  const buffer = await toBuffer(zip);
  const result = await validateDocxStructure(buffer);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "DOCX_STRUCTURE_INVALID");
});

test("a not-really-a-zip buffer fails as DOCX_STRUCTURE_INVALID rather than throwing", async () => {
  const result = await validateDocxStructure(Buffer.from("definitely not a zip archive"));
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "DOCX_STRUCTURE_INVALID");
});

test("a highly-compressible entry exceeding the compression-ratio cap is flagged as a suspected zip bomb (default production limits)", async () => {
  const zip = baseZip();
  zip.file("word/media/padding.bin", "A".repeat(500_000));
  const buffer = await toBuffer(zip, { compression: "DEFLATE", compressionOptions: { level: 9 } });
  const result = await validateDocxStructure(buffer, DEFAULT_CORPUS_ADMISSION_LIMITS);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "DOCX_ZIP_BOMB_SUSPECTED");
});

test("entry count exceeding a configured cap is rejected before any entry is inflated", async () => {
  const zip = baseZip();
  for (let i = 0; i < 10; i += 1) zip.file(`word/media/extra-${i}.xml`, "x");
  const buffer = await toBuffer(zip);
  const tinyLimits = { ...DEFAULT_CORPUS_ADMISSION_LIMITS, maxZipEntries: { value: 3, status: "ENGINEERING_DEFAULT", rationale: "test" } };
  const result = await validateDocxStructure(buffer, tinyLimits);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "DOCX_ZIP_BOMB_SUSPECTED");
});

test("an entry name attempting path traversal is neutralized by JSZip's own parser before validation ever sees it — verified empirically (JSZip's loadAsync fully resolves '..' segments out of every entry name, any depth), so this never crashes and never allows an out-of-archive entry to slip through", async () => {
  const zip = baseZip();
  zip.file("../../../etc/evil.xml", "x");
  const buffer = await toBuffer(zip);
  const reloaded = await JSZip.loadAsync(buffer);
  for (const name of Object.keys(reloaded.files)) {
    assert.doesNotMatch(name, /\.\./, `entry "${name}" must never retain a traversal segment after JSZip parses it`);
  }
  // The resulting archive is otherwise still a valid minimal docx (the
  // traversal attempt just becomes an extra, harmless nested entry) — so
  // validation completes normally rather than throwing.
  const result = await validateDocxStructure(buffer);
  assert.equal(typeof result.ok, "boolean");
});

test("word/vbaProject.bin triggers macro rejection", async () => {
  const zip = baseZip();
  zip.file("word/vbaProject.bin", Buffer.from([1, 2, 3, 4]));
  const buffer = await toBuffer(zip);
  const result = await validateDocxStructure(buffer);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "DOCX_MACRO_DETECTED");
});

test("a macro-enabled content type declaration triggers macro rejection even with no vbaProject.bin entry", async () => {
  const buffer = await toBuffer(baseZip({ contentTypes: MACRO_CONTENT_TYPES_XML }));
  const result = await validateDocxStructure(buffer);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "DOCX_MACRO_DETECTED");
});

test("a dangerous embedded object extension is rejected", async () => {
  const zip = baseZip();
  zip.file("word/embeddings/oleObject1.exe", Buffer.from([1, 2, 3]));
  const buffer = await toBuffer(zip);
  const result = await validateDocxStructure(buffer);
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "DOCX_DANGEROUS_EMBEDDED_OBJECT");
});

test("a legitimate embedded OLE object (.bin) is NOT rejected", async () => {
  const zip = baseZip();
  zip.file("word/embeddings/oleObject1.bin", Buffer.from([1, 2, 3]));
  const buffer = await toBuffer(zip);
  const result = await validateDocxStructure(buffer);
  assert.equal(result.ok, true);
});
