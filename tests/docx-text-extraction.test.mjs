import assert from "node:assert/strict";
import test from "node:test";
import mammoth from "mammoth";
import JSZip from "jszip";
import { extractDocxTextDocument } from "../lib/docx-text-extraction.ts";

/**
 * "Investigate two production issues" ISSUE 2 — regression coverage for
 * the DOCX footnote/endnote loss. See lib/docx-text-extraction.ts's own
 * header comment for the full root-cause account (mammoth.extractRawText()
 * never walks Document.notes; mammoth.convertToHtml() does, via its own
 * writeNotes()).
 *
 * JSZip is used only here, to build a minimal-but-real .docx fixture byte
 * for byte (a plain zip of the required OOXML parts) — it is already a
 * direct dependency of mammoth itself (mammoth reads .docx files by
 * unzipping them), not a new dependency introduced for this test. No
 * DOCX-authoring library is added to package.json; this constructs the
 * OOXML parts directly, which is the same thing mammoth itself expects to
 * unzip.
 */

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
</Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
</Relationships>`;

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function documentXml(bodyParagraphText, footnoteId) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS}>
  <w:body>
    <w:p><w:r><w:t>${bodyParagraphText}</w:t></w:r><w:r><w:footnoteReference w:id="${footnoteId}"/></w:r></w:p>
  </w:body>
</w:document>`;
}

function footnotesXml(footnoteId, footnoteText) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes ${W_NS}>
  <w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
  <w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>
  <w:footnote w:id="${footnoteId}"><w:p><w:r><w:t>${footnoteText}</w:t></w:r></w:p></w:footnote>
</w:footnotes>`;
}

async function buildMinimalDocxWithFootnote(bodyParagraphText, footnoteText) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
  zip.file("_rels/.rels", ROOT_RELS_XML);
  zip.file("word/document.xml", documentXml(bodyParagraphText, 2));
  zip.file("word/_rels/document.xml.rels", DOCUMENT_RELS_XML);
  zip.file("word/footnotes.xml", footnotesXml(2, footnoteText));
  return zip.generateAsync({ type: "nodebuffer" });
}

// --- Unit-level: extractDocxTextDocument with a fake convertToHtml (dependency-injected, no real mammoth/zip involved) ---

test("UNIT: includes both the body content and a trailing notes list from convertToHtml's own output", async () => {
  const fakeConvertToHtml = async () => ({
    value: "<p>Distinctive body paragraph.</p><ol><li>Distinctive footnote citation text.</li></ol>",
  });
  const text = await extractDocxTextDocument(fakeConvertToHtml, { buffer: Buffer.from("") });
  assert.match(text, /Distinctive body paragraph\./);
  assert.match(text, /Distinctive footnote citation text\./);
});

test("UNIT: passes the input through to convertToHtml unchanged", async () => {
  let received = null;
  const fakeConvertToHtml = async (input) => {
    received = input;
    return { value: "<p>ok</p>" };
  };
  const input = { buffer: Buffer.from("fake-docx-bytes") };
  await extractDocxTextDocument(fakeConvertToHtml, input);
  assert.equal(received, input);
});

// --- Integration-level: a REAL, minimal .docx with a REAL OOXML footnote, read by the REAL mammoth ---

test("REAL MAMMOTH: a genuine .docx footnote is included via convertToHtml — the exact fix for the confirmed extractRawText() gap", async () => {
  const buffer = await buildMinimalDocxWithFootnote(
    "The zynthorak framework improves calibration accuracy.",
    "See Author, A. B. Journal of Frameworks, Vol. 3, 2020, p. 45.",
  );

  const text = await extractDocxTextDocument(mammoth.convertToHtml, { buffer });
  assert.match(text, /zynthorak framework improves calibration accuracy/, "real body text must survive");
  assert.match(text, /Author, A\. B\. Journal of Frameworks, Vol\. 3, 2020, p\. 45\./, "the real OOXML footnote's own text must be included — this is exactly what extractRawText() silently drops");
});

test("REGRESSION: confirms mammoth.extractRawText() really does drop the same real footnote — the bug this fix replaces", async () => {
  const buffer = await buildMinimalDocxWithFootnote(
    "The zynthorak framework improves calibration accuracy.",
    "See Author, A. B. Journal of Frameworks, Vol. 3, 2020, p. 45.",
  );
  const { value: rawText } = await mammoth.extractRawText({ buffer });
  assert.match(rawText, /zynthorak framework improves calibration accuracy/, "sanity: the body text is present either way");
  assert.doesNotMatch(rawText, /Journal of Frameworks/, "documents the real bug: extractRawText() alone never includes footnote content");
});
