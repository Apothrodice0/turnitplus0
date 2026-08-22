import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import JSZip from "jszip";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { evaluateCorpusAdmissionCandidate } from "../lib/corpus-admission-gate.ts";

/**
 * VERIFICATION-ONLY: end-to-end (through the real gate + real corpus
 * tables, not the pure resolver in isolation) coverage for renamed files,
 * whitespace/formatting-only changes, PDF vs DOCX versions of the same
 * underlying text, minor edits, and substantial edits. Adds coverage only
 * — no product code changed. Every fixture here is synthetic; no part of
 * the real 770-article set or the 180-sample blinded evaluation set is
 * used or referenced.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_duplicate_scenarios.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

let userCounter = 0;
async function ensureUser() {
  userCounter += 1;
  const accountId = `dup-scenario-account-${userCounter}`;
  await client.execute({ sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)", args: [accountId, `${accountId}@example.test`, accountId, "x"] });
  return accountId;
}

/** Seeds the REAL corpus tables (corpus_document_representations/corpus_document_shingles/corpus_submission_references) with `text`, exactly the way a consenting live upload — or a future real (non-dry-run) admission indexing step — would, so family resolution has something real to find. */
async function seedRealCorpusRepresentation(text) {
  const accountId = await ensureUser();
  const identity = await createDocumentIdentity(client, { accountId, title: "seed", author: null, rawText: text });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText: text });
}

const WORD_BANK = [
  "research", "analysis", "population", "sample", "variable", "hypothesis", "method", "outcome", "region",
  "temperature", "pressure", "reaction", "material", "structure", "process", "signal", "pattern", "network",
  "sediment", "species", "habitat", "climate", "growth", "measurement", "instrument", "observation", "protocol",
];
function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 0xffffffff; };
}
function plausibleArticleText(seed, targetWords = 3300) {
  const rng = seededRandom(seed);
  const paragraphs = [];
  let wordCount = 0;
  while (wordCount < targetWords) {
    const sentence = `The ${Array.from({ length: 10 + Math.floor(rng() * 18) }, () => WORD_BANK[Math.floor(rng() * WORD_BANK.length)]).join(" ")}.`;
    const paragraph = Array.from({ length: 5 + Math.floor(rng() * 4) }, () => sentence).join(" ");
    paragraphs.push(paragraph);
    wordCount += paragraph.split(/\s+/).length;
  }
  return paragraphs.join("\n\n");
}

const RESOLVED_PROVENANCE = (sourceUrl) => ({
  kind: "BULK_IMPORT_PROVENANCE",
  provenance: { sourceUrl, acquisitionMethod: "BULK_IMPORT_DOWNLOAD", licenseOrPermission: "CC-BY-4.0", retentionBasis: "LICENSED_REUSE", retentionRightsResolved: true, notes: null },
});

async function evaluate(sourceRef, filename, bytes) {
  return evaluateCorpusAdmissionCandidate(client, { sourceRef, filename, bytes, consent: RESOLVED_PROVENANCE(`https://example.test/${sourceRef}`), dryRun: true });
}

// --- RENAMED FILE ------------------------------------------------------------

test("RENAMED FILE: identical content under a completely different filename/sourceRef still resolves EXACT_DUPLICATE — filename plays no role in family resolution", async () => {
  const text = plausibleArticleText(101);
  await seedRealCorpusRepresentation(text);
  // .txt extension deliberately, matching the actual plain-text byte
  // content — a claimed .pdf extension on non-PDF bytes would fail
  // FILE_SIGNATURE_MISMATCH before family resolution ever runs, which
  // would test the file-validation layer, not the renamed-file scenario.
  const decision = await evaluate("renamed-candidate", "totally-different-name-xyz-2026.txt", Buffer.from(text, "utf8"));
  assert.equal(decision.decision, "REJECT");
  assert.equal(decision.familyRelation, "EXACT_DUPLICATE");
  assert.ok(decision.reasonCodes.includes("DUPLICATE_ALREADY_REPRESENTED"));
});

// --- WHITESPACE / FORMATTING-ONLY CHANGE --------------------------------------

test("WHITESPACE/FORMATTING: extra blank lines, trailing spaces, and CRLF line endings resolve EXACT_DUPLICATE via canonicalization, not EDITED_VERSION", async () => {
  const text = plausibleArticleText(102);
  await seedRealCorpusRepresentation(text);

  const reformatted = text
    .split("\n").map((line) => line + "   ").join("\r\n") // trailing spaces + CRLF
    .replace(/\n\n/g, "\n\n\n\n"); // extra blank lines
  const decision = await evaluate("whitespace-candidate", "reformatted.txt", Buffer.from(reformatted, "utf8"));
  assert.equal(decision.decision, "REJECT");
  assert.equal(decision.familyRelation, "EXACT_DUPLICATE", "formatting-only differences must canonicalize to the identical hash, not merely a high-containment near-duplicate");
});

// --- PDF vs DOCX, SAME UNDERLYING TEXT ----------------------------------------

function xmlEscape(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function buildDocxContaining(text) {
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
  const paragraphs = text.split("\n\n").map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

test("PDF vs DOCX: text extracted from a real PDF, then re-submitted inside a real DOCX containing the SAME extracted text, resolves as a family match (exact or near-duplicate) — format alone never creates or hides a duplicate", async () => {
  const { extractCorpusCandidateText } = await import("../lib/corpus-text-extraction.ts");
  const pdfBytes = fs.readFileSync(path.join(repoRoot, "tests/fixtures/attention-is-all-you-need.pdf"));
  const pdfExtraction = await extractCorpusCandidateText("pdf", pdfBytes);
  assert.equal(pdfExtraction.ok, true, "sanity: the real PDF fixture must extract successfully");

  await seedRealCorpusRepresentation(pdfExtraction.rawText);

  const docxBytes = await buildDocxContaining(pdfExtraction.rawText);
  const decision = await evaluate("pdf-then-docx-same-text", "attention-reformatted.docx", docxBytes);

  console.log(`[FINDING] PDF-vs-DOCX same-text family relation: ${decision.familyRelation}, decision: ${decision.decision}`);
  assert.equal(decision.decision, "REJECT", "the same underlying text re-submitted as a DOCX must not be treated as a fresh, independent candidate");
  assert.ok(["EXACT_DUPLICATE", "EDITED_VERSION"].includes(decision.familyRelation), `expected a family match, got ${decision.familyRelation}`);
});

// --- MINOR EDIT (end-to-end, through the real gate + real corpus) ------------

test("MINOR EDIT (end-to-end): a lightly-edited re-submission (base text + one appended paragraph) resolves EDITED_VERSION through the real gate against a real seeded representation", async () => {
  const base = plausibleArticleText(103);
  await seedRealCorpusRepresentation(base);

  const lightlyEdited = base + "\n\n" + "A brief supplementary paragraph appended by way of minor revision only, changing very little of the substantive content overall.".repeat(3);
  const decision = await evaluate("minor-edit-candidate", "minor-edit.txt", Buffer.from(lightlyEdited, "utf8"));
  console.log(`[FINDING] minor-edit family relation: ${decision.familyRelation}, containment=${decision.familyContainment}`);
  assert.equal(decision.decision, "REJECT");
  assert.equal(decision.familyRelation, "EDITED_VERSION");
});

// --- SUBSTANTIAL EDIT / GENUINELY DIFFERENT (end-to-end) ----------------------

test("SUBSTANTIAL EDIT (end-to-end): a genuinely different article (disjoint vocabulary/seed) is evaluated independently, no false-positive family match against an unrelated seeded representation", async () => {
  const seeded = plausibleArticleText(104);
  await seedRealCorpusRepresentation(seeded);

  const different = plausibleArticleText(999104); // different seed -> different word sequence
  const decision = await evaluate("substantial-edit-candidate", "different-article.txt", Buffer.from(different, "utf8"));
  console.log(`[FINDING] substantial-edit family relation: ${decision.familyRelation}, decision: ${decision.decision}`);
  assert.equal(decision.familyRelation, "NONE", "a genuinely different article must not be treated as a family match of the seeded one");
  assert.ok(!decision.reasonCodes.includes("DUPLICATE_ALREADY_REPRESENTED"), "a genuinely different article must never be flagged as a duplicate");
  assert.ok(!decision.reasonCodes.includes("EDITED_VERSION_ALREADY_REPRESENTED"), "a genuinely different article must never be flagged as an edited version of the seeded one");
});
