import assert from "node:assert/strict";
import test from "node:test";
import mammoth from "mammoth";
import JSZip from "jszip";
import { extractDocxTextDocument } from "../lib/docx-text-extraction.ts";
import { normalizeExtractedText } from "../lib/extracted-text-normalization.ts";
import {
  findAppendedNotesStart,
  findReferenceSectionStart,
  stripReferenceSection,
  stripReferenceSectionKeepingNotes,
} from "../lib/reference-section.ts";
import {
  comparisonText,
  normalize,
  scoringNormalizationEvidence,
  tokenSpans,
  tokens,
  tokensForScoringNormalization,
} from "../lib/similarity-core.ts";
import { scoreAgainstArchive } from "../lib/archive-similarity-scoring.ts";
import { ARCHIVE_SHINGLE_SIZE, archiveShingleHashes } from "../lib/archive-fingerprint.ts";

/**
 * GOLD GAP — BODY / FOOTNOTE-ENDNOTE / BIBLIOGRAPHY regions. A DOCX's notes
 * reach the text after the body (mammoth appends them), so a paper ending in
 * "Bibliography:" used to lose every note with its bibliography. The
 * bibliography stays excluded; legitimate notes are analysed; running headers
 * stay out; every earlier word index still names the same word.
 * Real mammoth over minimal real OOXML; synthetic content only.
 */

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const para = (text, refs = []) =>
  `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>${refs.map(([kind, id]) => `<w:r><w:${kind}Reference w:id="${id}"/></w:r>`).join("")}</w:p>`;
const note = (kind, id, paragraphs) => `<w:${kind} w:id="${id}">${paragraphs.map((p) => para(p)).join("")}</w:${kind}>`;

/** body: [text, refs][]; footnotes/endnotes: string[][] (paragraphs per note, ids from 2); header: running header text. */
async function buildDocx({ body, footnotes = [], endnotes = [], header = null }) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
  <Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
</Relationships>`);
  const sectPr = header ? `<w:sectPr><w:headerReference w:type="default" r:id="rId3" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></w:sectPr>` : "";
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS}><w:body>${body.map(([text, refs]) => para(text, refs)).join("")}${sectPr}</w:body></w:document>`);
  zip.file("word/footnotes.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes ${W_NS}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${footnotes.map((paragraphs, i) => note("footnote", i + 2, paragraphs)).join("")}</w:footnotes>`);
  zip.file("word/endnotes.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:endnotes ${W_NS}><w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote><w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>${endnotes.map((paragraphs, i) => note("endnote", i + 2, paragraphs)).join("")}</w:endnotes>`);
  zip.file("word/header1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${W_NS}>${header ? para(header) : ""}</w:hdr>`);
  return zip.generateAsync({ type: "nodebuffer" });
}
/** The text an upload of this DOCX is analysed as (app/page.tsx: extraction, then normalizeExtractedText). */
const uploadedText = async (spec) => normalizeExtractedText(await extractDocxTextDocument(mammoth.convertToHtml, { buffer: await buildDocx(spec) }));

// ── shared content ──────────────────────────────────────────────────────
// Distinct paragraphs (a near-identical template would itself look like repeated page furniture).
const BANK = (
  "custodial interrogation safeguards evolved procedural courts weighed counsel access investigative urgency " +
  "prosecutors supervise detention registers record arrival departure medical examination family notification " +
  "magistrates review extensions written reasons appeal chambers annul statements obtained unlawfully coercion " +
  "legislature amended ordinance juveniles legal representative presumption innocence fairness equality arms " +
  "gendarmerie police officers inform suspects rights language understand interpreter assistance silence " +
  "constitution guarantees liberty dignity inviolability private life correspondence search seizure warrant " +
  "investigating judge chamber accusation indictment trial verdict sentence mitigation probation parole release"
).split(" ");
const BODY = Array.from({ length: 14 }, (_, i) => {
  const words = Array.from({ length: 24 }, (_, k) => BANK[(i * 5 + k * 3) % BANK.length]);
  return `${words.join(" ")}.`;
});
const BIBLIOGRAPHY = [
  "Bibliography:",
  "A. Books",
  "Abdelaziz Saad, Analytical Studies on Criminal Procedure, Dar Houma, Algeria; 2009.",
  "Hamza Abdelwahab, The Legal Framework of Pretrial Detention, Dar Houma, Algeria; 2006.",
  "B. Journal Articles",
  "Shahira Boulahia, The Accused's Right of Defence, Legal Forum Journal, No. 5; 2010.",
];
const NOTE_PROSE =
  "The detention register must record the exact hour at which the suspect was informed of the right to contact a lawyer and the hour at which that lawyer actually visited";
const CITATION_NOTE = "Fodil Laiche, op. cit., pp. 146-147.";
const RUNNING_HEADER = "The Right of a Person in Police Custody to Legal Counsel";

function bodyWithRefs(noteKinds) {
  // note references sprinkled through the body, in document order
  return BODY.map((text, i) => [text, noteKinds[i] ? [noteKinds[i]] : []]);
}
const wordsOf = (s) => normalize(s).split(" ").filter(Boolean);
const containsRun = (haystack, needle) => {
  for (let i = 0; i + needle.length <= haystack.length; i += 1) if (needle.every((w, k) => haystack[i + k] === w)) return true;
  return false;
};
const assertOffsetsProve = (text) => {
  const toks = tokens(text);
  const spans = tokenSpans(text);
  assert.equal(spans.length, toks.length, "every analysed word has a character range");
  spans.forEach((span, i) => assert.equal(normalize(text.slice(span.start, span.end)), toks[i], `word ${i}`));
};

// ── B: body -> bibliography -> extraction-appended footnotes (the Gold shape) ─
test("B (Gold shape): footnotes appended after the bibliography stay analysed; the bibliography does not", async () => {
  const text = await uploadedText({
    body: [...bodyWithRefs({ 1: ["footnote", 2], 4: ["footnote", 3], 9: ["footnote", 4] }), ...BIBLIOGRAPHY.map((t) => [t, []])],
    footnotes: [[NOTE_PROSE], [CITATION_NOTE], ["A second substantive note explains that the prosecutor may extend custody only once, by written and reasoned decision."]],
  });
  const referenceStart = findReferenceSectionStart(text);
  const notesStart = findAppendedNotesStart(text);
  assert.ok(referenceStart > 0 && notesStart > referenceStart, "the bibliography heading comes first, the notes after it");
  assert.match(text.slice(referenceStart, notesStart), /^Bibliography:/);
  assert.match(text.slice(notesStart), /^The detention register/);

  const analysed = tokens(text);
  assert.ok(containsRun(analysed, wordsOf(NOTE_PROSE)), "substantive footnote prose is analysed");
  assert.ok(containsRun(analysed, wordsOf("prosecutor may extend custody only once")), "every note is analysed, not only the first");
  assert.ok(!containsRun(analysed, wordsOf("Analytical Studies on Criminal Procedure")), "the bibliography stays excluded");
  assert.ok(!containsRun(analysed, wordsOf("Legal Forum Journal")), "the bibliography stays excluded");

  // before this fix the same text lost the notes with the bibliography
  assert.ok(!containsRun(normalize(stripReferenceSection(text)).split(" "), wordsOf(NOTE_PROSE)));
});

test("B: every word index computed before the fix names the same word; character offsets still point into the uploaded text", async () => {
  const text = await uploadedText({
    body: [...bodyWithRefs({ 2: ["footnote", 2], 6: ["footnote", 3] }), ...BIBLIOGRAPHY.map((t) => [t, []])],
    footnotes: [[NOTE_PROSE], [CITATION_NOTE]],
  });
  const before = normalize(stripReferenceSection(text)).split(" ").filter(Boolean);
  const after = tokens(text);
  assert.ok(after.length > before.length);
  assert.deepEqual(after.slice(0, before.length), before, "the previous word sequence is a prefix of the new one");
  const analysed = comparisonText(text);
  assert.equal(analysed.length, text.length, "the bibliography is blanked, not cut: offsets are unchanged");
  assert.equal(analysed.slice(0, findReferenceSectionStart(text)), text.slice(0, findReferenceSectionStart(text)));
  assertOffsetsProve(text);
});

// ── A: body -> footnotes -> bibliography (PDF page-bottom footnotes) ────────
test("A: footnotes placed before the bibliography (PDF page order) are analysed exactly as before", () => {
  const pages = [
    `${BODY.slice(0, 7).join(" ")} 1 ${NOTE_PROSE}.`,
    `${BODY.slice(7).join(" ")} 2 ${CITATION_NOTE}`,
    BIBLIOGRAPHY.join(" "),
  ];
  const text = normalizeExtractedText(pages.join("\n\n"));
  assert.equal(findAppendedNotesStart(text), -1);
  assert.equal(comparisonText(text), stripReferenceSection(text), "nothing changes when no note block follows the bibliography");
  assert.ok(containsRun(tokens(text), wordsOf(NOTE_PROSE)));
  assert.ok(!containsRun(tokens(text), wordsOf("Analytical Studies on Criminal Procedure")));
});

// ── C: body -> bibliography only ────────────────────────────────────────────
test("C: a DOCX with a bibliography and no notes is cut exactly as before", async () => {
  const text = await uploadedText({ body: [...bodyWithRefs({}), ...BIBLIOGRAPHY.map((t) => [t, []])] });
  assert.equal(findAppendedNotesStart(text), -1);
  assert.equal(comparisonText(text), stripReferenceSection(text));
  assert.ok(findReferenceSectionStart(text) > 0);
  assert.ok(!containsRun(tokens(text), wordsOf("Legal Forum Journal")));
});

// ── D: the word "references" in prose, no reference section ────────────────
test("D: ordinary prose mentioning references — with notes — is analysed in full", async () => {
  const text = await uploadedText({
    body: [
      ...bodyWithRefs({ 3: ["footnote", 2] }),
      ["The references to earlier case law in this chapter are discussed further in the conclusion, which follows the same structure as the analysis above.", []],
    ],
    footnotes: [[NOTE_PROSE]],
  });
  assert.equal(findReferenceSectionStart(text), -1);
  assert.equal(comparisonText(text), text);
  assert.ok(containsRun(tokens(text), wordsOf("references to earlier case law")));
  assert.ok(containsRun(tokens(text), wordsOf(NOTE_PROSE)));
});

// ── E: endnotes with substantive copied prose are matched, and highlighted in place ─
test("E: copied prose inside an endnote is matched against the Archive and its positions map onto the endnote's own characters", async () => {
  const COPIED =
    "Comparative studies of the European Convention system show that the right of access to a lawyer from the first police interview is now treated as a structural guarantee whose absence taints every statement later relied on at trial, unless compelling reasons justified the restriction in the individual case and the overall fairness of the proceedings was preserved";
  const text = await uploadedText({
    body: [...bodyWithRefs({ 5: ["endnote", 2] }), ...BIBLIOGRAPHY.map((t) => [t, []])],
    endnotes: [[`As one survey puts it: ${COPIED}.`]],
  });
  // padded so the source is not a near-duplicate of the submission (the scorer's self-exclusion)
  const padding = Array.from({ length: 300 }, (_, i) => `zqpad${i.toString(36)}v`).join(" ");
  const source = `Introductory remarks on procedure differ by jurisdiction. ${COPIED}. Closing remarks follow on remedies. ${padding}`;
  const hashes = archiveShingleHashes(source, ARCHIVE_SHINGLE_SIZE);
  const index = {
    shingleSize: ARCHIVE_SHINGLE_SIZE,
    documentCount: 50,
    maximumDocumentFrequency: 12,
    articles: [{ title: "Survey of custodial counsel", sourceType: "Publication", uniqueShingleCount: hashes.size }],
    getPostings: (hash) => (hashes.has(hash) ? [0] : []),
  };
  const result = scoreAgainstArchive(text, index, { minimumMatchedWords: 5, minimumSourceContribution: 0.5, maximumContributingSources: 10 });
  const copiedWords = wordsOf(COPIED);
  assert.ok(result.matchedWordCount >= copiedWords.length - 2, `the endnote's copied prose is matched (${result.matchedWordCount})`);
  assert.equal(scoreAgainstArchive(stripReferenceSection(text), index, { minimumMatchedWords: 5 }).matchedWordCount, 0, "before: the endnote was outside the analysed text");

  const spans = tokenSpans(text);
  const notesStart = findAppendedNotesStart(text);
  const highlighted = result.archiveMatchedPositions.map((p) => spans[p]);
  assert.ok(highlighted.every((s) => s && s.start >= notesStart), "every matched word sits in the endnote");
  assert.match(text.slice(highlighted[0].start, highlighted[highlighted.length - 1].end), /^Comparative studies of the European Convention/);
});

// ── F: citation-only footnotes ─────────────────────────────────────────────
test("F: citation-only footnotes are analysed like any other note — no citation-exclusion policy is added", async () => {
  const text = await uploadedText({
    body: [...bodyWithRefs({ 1: ["footnote", 2], 2: ["footnote", 3], 3: ["footnote", 4] }), ...BIBLIOGRAPHY.map((t) => [t, []])],
    footnotes: [[CITATION_NOTE], ["Ibid., p. 61."], ["Law No. 15/12 of 15 July 2015 on child protection, Official Gazette, No. 39."]],
  });
  assert.ok(findAppendedNotesStart(text) > findReferenceSectionStart(text));
  const analysed = tokens(text);
  assert.ok(containsRun(analysed, wordsOf(CITATION_NOTE)));
  assert.ok(containsRun(analysed, wordsOf("Official Gazette, No. 39")));
  assertOffsetsProve(text);
});

// ── G: repeated running title/header ───────────────────────────────────────
test("G: a DOCX running header never reaches the text, notes or not", async () => {
  const text = await uploadedText({
    body: [...bodyWithRefs({ 1: ["footnote", 2] }), ...BIBLIOGRAPHY.map((t) => [t, []])],
    footnotes: [[NOTE_PROSE]],
    header: RUNNING_HEADER,
  });
  assert.doesNotMatch(text, /Police Custody to Legal Counsel/);
  assert.ok(containsRun(tokens(text), wordsOf(NOTE_PROSE)));
});

test("G: a PDF running title repeated on every page is still stripped, and the bibliography still excluded", () => {
  const pages = BODY.slice(0, 12).map((paragraph, i) => `${RUNNING_HEADER} ${i + 2} ${paragraph}`);
  pages.push(`${RUNNING_HEADER} 14 ${BIBLIOGRAPHY.join(" ")}`);
  const text = normalizeExtractedText(pages.join("\n\n"));
  assert.doesNotMatch(text, /Police Custody to Legal Counsel/, "the running title is page furniture");
  assert.equal(comparisonText(text), stripReferenceSection(text));
  assert.ok(!containsRun(tokens(text), wordsOf("Legal Forum Journal")));
});

// ── structure guards ───────────────────────────────────────────────────────
test("the note block is read from extraction structure only: a trailing arrow alone, or notes without anchors, change nothing", () => {
  const body = BODY.join("\n");
  const bib = BIBLIOGRAPHY.join("\n");
  const withAnchors = `${body} [1]\n${bib}\n${NOTE_PROSE} ↑`;
  assert.ok(findAppendedNotesStart(withAnchors) > findReferenceSectionStart(withAnchors));
  const noAnchor = `${body}\n${bib}\n${NOTE_PROSE} ↑`;
  assert.equal(findAppendedNotesStart(noAnchor), -1, "no [1] anchor in the body: not a mammoth note block");
  assert.equal(comparisonText(noAnchor), stripReferenceSection(noAnchor));
  const noArrowAtEnd = `${body} [1]\n${bib}\n${NOTE_PROSE} ↑\n\nA closing line with no back-link.`;
  assert.equal(findAppendedNotesStart(noArrowAtEnd), -1, "the text must end with a note");
  // a note block that starts BEFORE the detected bibliography heading leaves the old cut alone
  const notesBeforeHeading = `${body} [1]\n${NOTE_PROSE} ↑\n\nBibliography: A. Books Saad, Studies, Dar Houma, Algeria; 2009. ↑`;
  assert.equal(stripReferenceSectionKeepingNotes(notesBeforeHeading), stripReferenceSection(notesBeforeHeading));
});

test("a report counted before notes were analysed keeps its scoring-normalization evidence (saved wordCount / previous bundle)", () => {
  // a zero-width non-joiner splits one body word under v1 only, so the two contracts differ
  const text = `${BODY.join("\n").replace("custodial", "custo‌dial")} [1]\n${BIBLIOGRAPHY.join("\n")}\n${NOTE_PROSE} ↑`;
  const legacy = stripReferenceSection(text);
  const legacyV1 = normalize(legacy).split(" ").filter(Boolean).length; // normalize() follows the active contract (v2)
  const v1Now = tokensForScoringNormalization(text, 1).length;
  const v2Now = tokensForScoringNormalization(text, 2).length;
  assert.notEqual(v1Now, v2Now);
  assert.equal(scoringNormalizationEvidence(text, v2Now), 2);
  assert.equal(scoringNormalizationEvidence(text, v1Now), 1);
  assert.equal(scoringNormalizationEvidence(text, legacyV1), 2, "the pre-notes v2 count is still recognised as v2");
  assert.equal(scoringNormalizationEvidence(text, legacyV1 + 1), 1, "the pre-notes v1 count is still recognised as v1");
  assert.equal(scoringNormalizationEvidence(text, 3), null);
});
