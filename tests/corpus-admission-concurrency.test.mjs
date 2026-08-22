import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import JSZip from "jszip";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { evaluateCorpusAdmissionCandidate } from "../lib/corpus-admission-gate.ts";

/**
 * Database-level idempotency and "one accepted canonical sample" proof under
 * concurrent AND sequential repeated admission of identical/near-identical
 * content, calling evaluateCorpusAdmissionCandidate directly (bypassing
 * tools/corpus-admission-dry-run.ts's own in-process, application-level
 * in-batch registry+mutex entirely) — i.e. testing the database/library
 * layer's own guarantees (a per-process UNIQUE constraint on accepted
 * canonical_sha256 plus an in-transaction near-duplicate recheck), not any
 * one caller's bookkeeping. Originally written to PROVE a since-fixed
 * concurrency/idempotency defect (two sequential or 20 concurrent identical
 * admissions could each independently reach ACCEPT and each write their own
 * content-store row); the fix moved the final duplicate check + accepted-
 * content insertion into a single atomic transaction guarded by both a real
 * UNIQUE index and an in-transaction near-duplicate recheck
 * (lib/corpus-admission-gate.ts's acceptWithAtomicDedup). These tests now
 * assert the CORRECT, fixed behavior.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_concurrency.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const dbUrl = `file:${dbFile}`;
const client = createClient({ url: dbUrl });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

function openConnection() {
  return createClient({ url: dbUrl });
}

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

const WORD_BANK = [
  "research", "analysis", "population", "sample", "variable", "hypothesis", "method", "outcome", "region",
  "temperature", "pressure", "reaction", "material", "structure", "process", "signal", "pattern", "network",
  "sediment", "species", "habitat", "climate", "growth", "measurement", "instrument", "observation", "protocol",
  "significant", "distinct", "gradual", "consistent", "notable", "substantial", "minor", "extensive", "localized",
  "documented", "identified", "recorded", "analyzed", "examined", "compared", "measured", "observed", "reported",
];

function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0xffffffff;
  };
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

async function contentStoreCount(canonicalSha256) {
  const result = await client.execute({ sql: "SELECT COUNT(*) AS c FROM corpus_admission_content_store WHERE canonical_sha256 = ?", args: [canonicalSha256] });
  return Number(result.rows[0].c);
}

async function acceptDecisionCount(canonicalSha256) {
  const result = await client.execute({ sql: "SELECT COUNT(*) AS c FROM corpus_admission_decisions WHERE canonical_sha256 = ? AND decision = 'ACCEPT'", args: [canonicalSha256] });
  return Number(result.rows[0].c);
}

/** Every user-defined table in the test database (excludes sqlite's own bookkeeping tables), used to prove "zero writes anywhere", not just in the tables this feature happens to think of first. */
async function allTableNames() {
  const result = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  return result.rows.map((r) => String(r.name));
}

async function rowCountSnapshot(tableNames) {
  const snapshot = new Map();
  for (const name of tableNames) {
    const result = await client.execute(`SELECT COUNT(*) AS c FROM "${name}"`);
    snapshot.set(name, Number(result.rows[0].c));
  }
  return snapshot;
}

function assertNoTableChanged(before, after, label) {
  for (const [table, beforeCount] of before) {
    const afterCount = after.get(table);
    assert.equal(afterCount, beforeCount, `${label}: table "${table}" row count changed (${beforeCount} -> ${afterCount}), expected zero writes anywhere`);
  }
}

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

// --- SEQUENTIAL identical-content idempotency -------------------------------

test("SEQUENTIAL duplicate admission is idempotent: identical content admitted twice, fully awaited in order, yields exactly one ACCEPT and one content-store row", async () => {
  const text = plausibleArticleText(9001);

  const first = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "sequential-dup-1",
    filename: "a.txt",
    bytes: Buffer.from(text, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/seq-1"),
    dryRun: false,
    openConnection,
  });
  const second = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "sequential-dup-2",
    filename: "b.txt", // deliberately a different filename — proves filename plays no role either way
    bytes: Buffer.from(text, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/seq-2"),
    dryRun: false,
    openConnection,
  });

  assert.equal(first.decision, "ACCEPT", `sanity: first admission must ACCEPT to make this a meaningful test (got ${first.decision}: ${first.reasonCodes.join(",")})`);
  assert.equal(second.decision, "REJECT", `a sequential re-admission of already-accepted identical content must be rejected as a duplicate, got ${second.decision} (${second.reasonCodes.join(",")})`);
  assert.ok(second.reasonCodes.includes("DUPLICATE_ALREADY_REPRESENTED"));
  assert.equal(second.contentStoreId, null, "a rejected duplicate must store no content");

  const canonicalHash = first.canonicalSha256;
  assert.equal(await acceptDecisionCount(canonicalHash), 1, "exactly one ACCEPT decision row may exist for one canonical_sha256");
  assert.equal(await contentStoreCount(canonicalHash), 1, "exactly one content_store row may exist for one canonical_sha256");
});

// --- 20 CONCURRENT identical-content admissions -----------------------------

test("20 CONCURRENT identical-content admissions (Promise.all, no in-batch registry supplied) resolve to exactly one ACCEPT and one content-store row", async () => {
  const text = plausibleArticleText(9002);
  const N = 20;

  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      evaluateCorpusAdmissionCandidate(client, {
        sourceRef: `concurrent-dup-${i}`,
        filename: `concurrent-${i}.txt`,
        bytes: Buffer.from(text, "utf8"),
        consent: RESOLVED_PROVENANCE(`https://example.test/concurrent-${i}`),
        dryRun: false,
        openConnection,
      }),
    ),
  );

  const acceptCount = results.filter((r) => r.decision === "ACCEPT").length;
  const rejectCount = results.filter((r) => r.decision === "REJECT").length;
  const canonicalHash = results.find((r) => r.canonicalSha256)?.canonicalSha256;
  const storeCount = canonicalHash ? await contentStoreCount(canonicalHash) : 0;
  const decisionRowsTotal = (await client.execute({ sql: "SELECT COUNT(*) AS c FROM corpus_admission_decisions WHERE canonical_sha256 = ?", args: [canonicalHash] })).rows[0].c;

  console.log(`[RESULT] 20 concurrent identical admissions: ${acceptCount} ACCEPT, ${rejectCount} REJECT, ${Number(decisionRowsTotal)} total decision rows, ${storeCount} content_store rows for the shared canonical_sha256`);

  assert.equal(acceptCount, 1, `exactly one of ${N} concurrent identical-content admissions may independently reach ACCEPT — got ${acceptCount}`);
  assert.equal(rejectCount, N - 1, `every other concurrent identical-content admission must REJECT as a duplicate — got ${rejectCount} of ${N - 1}`);
  assert.equal(storeCount, 1, `exactly one content_store row may exist for one canonical_sha256 — got ${storeCount}`);
  assert.equal(Number(decisionRowsTotal), N, "every attempt still gets its own decision row (duplicate decision records may be non-unique), even though only one is ACCEPT");

  for (const r of results.filter((r) => r.decision === "REJECT")) {
    assert.equal(r.contentStoreId, null, "a rejected duplicate must store no content");
  }
});

// --- CONCURRENT renamed / whitespace variants -------------------------------

test("CONCURRENT renamed + whitespace/formatting variants of the same content resolve to exactly one ACCEPT and one content-store row", async () => {
  const text = plausibleArticleText(9003);
  const reformatted = (seed) =>
    text
      .split("\n").map((line, i) => (i % 3 === (seed % 3) ? line + "   " : line)).join(seed % 2 === 0 ? "\r\n" : "\n")
      .replace(/\n\n/g, "\n\n\n".repeat((seed % 2) + 1));

  const N = 10;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      evaluateCorpusAdmissionCandidate(client, {
        sourceRef: `renamed-whitespace-${i}`,
        filename: `wildly-different-filename-${i}-${Math.random().toString(36).slice(2)}.txt`,
        bytes: Buffer.from(i === 0 ? text : reformatted(i), "utf8"),
        consent: RESOLVED_PROVENANCE(`https://example.test/renamed-whitespace-${i}`),
        dryRun: false,
        openConnection,
      }),
    ),
  );

  const acceptCount = results.filter((r) => r.decision === "ACCEPT").length;
  const canonicalHash = results.find((r) => r.canonicalSha256)?.canonicalSha256;
  console.log(`[RESULT] concurrent renamed/whitespace variants: ${acceptCount} ACCEPT of ${N}`);

  assert.equal(acceptCount, 1, `renaming/reformatting must not create independent duplicates — expected exactly 1 ACCEPT of ${N}, got ${acceptCount}`);
  assert.equal(await contentStoreCount(canonicalHash), 1);
  for (const r of results.filter((r) => r.decision === "REJECT")) {
    assert.equal(r.familyRelation, "EXACT_DUPLICATE", "whitespace/formatting-only differences must canonicalize to the identical hash");
    assert.equal(r.contentStoreId, null);
  }
});

// --- CONCURRENT PDF vs DOCX versions of the same underlying text -----------

test("CONCURRENT PDF and DOCX submissions carrying the SAME underlying text resolve to exactly one ACCEPT and one content-store row", async () => {
  const { extractCorpusCandidateText } = await import("../lib/corpus-text-extraction.ts");
  const pdfBytes = fs.readFileSync(path.join(repoRoot, "tests/fixtures/attention-is-all-you-need.pdf"));
  const pdfExtraction = await extractCorpusCandidateText("pdf", pdfBytes);
  assert.equal(pdfExtraction.ok, true, "sanity: the real PDF fixture must extract successfully");
  const docxBytes = await buildDocxContaining(pdfExtraction.rawText);

  const submissions = [
    { sourceRef: "concurrent-pdf-0", filename: "attention-0.pdf", bytes: pdfBytes },
    { sourceRef: "concurrent-pdf-1", filename: "attention-1.pdf", bytes: pdfBytes },
    { sourceRef: "concurrent-docx-0", filename: "attention-0.docx", bytes: docxBytes },
    { sourceRef: "concurrent-docx-1", filename: "attention-1.docx", bytes: docxBytes },
  ];

  const results = await Promise.all(
    submissions.map((s) =>
      evaluateCorpusAdmissionCandidate(client, {
        sourceRef: s.sourceRef,
        filename: s.filename,
        bytes: s.bytes,
        consent: RESOLVED_PROVENANCE(`https://example.test/${s.sourceRef}`),
        dryRun: false,
        openConnection,
      }),
    ),
  );

  const acceptCount = results.filter((r) => r.decision === "ACCEPT").length;
  const acceptedHash = results.find((r) => r.decision === "ACCEPT")?.canonicalSha256;
  console.log(`[RESULT] concurrent PDF/DOCX same-text: ${acceptCount} ACCEPT of ${submissions.length}, families: ${results.map((r) => r.familyRelation).join(",")}`);

  assert.equal(acceptCount, 1, `format alone must never let the same underlying text be independently accepted twice — expected exactly 1 ACCEPT of ${submissions.length}, got ${acceptCount}`);
  assert.equal(await contentStoreCount(acceptedHash), 1);
  for (const r of results.filter((r) => r.decision === "REJECT")) {
    assert.ok(["EXACT_DUPLICATE", "EDITED_VERSION"].includes(r.familyRelation), `expected a family match, got ${r.familyRelation}`);
    assert.equal(r.contentStoreId, null);
  }
});

// --- CONCURRENT minor edits (near-duplicates, not exact hash matches) ------

test("CONCURRENT minor-edit variants (each a distinct canonical_sha256, mutually near-duplicate) resolve to exactly one ACCEPT and one content-store row", async () => {
  const base = plausibleArticleText(9004);
  const variants = Array.from({ length: 8 }, (_, i) => `${base}\n\nA brief supplementary paragraph appended by way of minor revision number ${i} only, changing very little of the substantive content overall.`.repeat(1));

  const results = await Promise.all(
    variants.map((text, i) =>
      evaluateCorpusAdmissionCandidate(client, {
        sourceRef: `concurrent-minor-edit-${i}`,
        filename: `minor-edit-${i}.txt`,
        bytes: Buffer.from(text, "utf8"),
        consent: RESOLVED_PROVENANCE(`https://example.test/concurrent-minor-edit-${i}`),
        dryRun: false,
        openConnection,
      }),
    ),
  );

  const acceptCount = results.filter((r) => r.decision === "ACCEPT").length;
  const acceptedHash = results.find((r) => r.decision === "ACCEPT")?.canonicalSha256;
  console.log(`[RESULT] concurrent minor edits: ${acceptCount} ACCEPT of ${variants.length}, families: ${results.map((r) => r.familyRelation).join(",")}`);

  assert.equal(acceptCount, 1, `mutually near-duplicate minor-edit variants submitted concurrently must resolve to exactly one ACCEPT — got ${acceptCount} of ${variants.length}`);
  assert.equal(await contentStoreCount(acceptedHash), 1);
  for (const r of results.filter((r) => r.decision === "REJECT")) {
    assert.ok(["EXACT_DUPLICATE", "EDITED_VERSION"].includes(r.familyRelation), `expected a family match, got ${r.familyRelation}`);
    assert.equal(r.contentStoreId, null, "a rejected near-duplicate must store no content");
  }
});

// --- CONCURRENT substantially different documents ---------------------------

test("CONCURRENT submissions of substantially different documents are each independently accepted", async () => {
  const N = 6;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      evaluateCorpusAdmissionCandidate(client, {
        sourceRef: `concurrent-distinct-${i}`,
        filename: `distinct-${i}.txt`,
        bytes: Buffer.from(plausibleArticleText(700000 + i * 97), "utf8"), // disjoint seeds -> disjoint word sequences
        consent: RESOLVED_PROVENANCE(`https://example.test/concurrent-distinct-${i}`),
        dryRun: false,
        openConnection,
      }),
    ),
  );

  const acceptCount = results.filter((r) => r.decision === "ACCEPT").length;
  console.log(`[RESULT] concurrent substantially-different documents: ${acceptCount} ACCEPT of ${N}`);
  assert.equal(acceptCount, N, `genuinely different documents submitted concurrently must all be accepted independently — got ${acceptCount} of ${N}`);

  const hashes = results.map((r) => r.canonicalSha256);
  assert.equal(new Set(hashes).size, N, "every independently-accepted document must have a distinct canonical hash");
  for (const hash of hashes) {
    assert.equal(await contentStoreCount(hash), 1);
  }
});

// --- dry run: zero writes to EVERY table, single and concurrent ------------

test("a SINGLE dry run produces zero row changes in every table in the database", async () => {
  const tables = await allTableNames();
  const before = await rowCountSnapshot(tables);

  const text = plausibleArticleText(9010);
  const decision = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "single-dry-run",
    filename: "single-dry-run.txt",
    bytes: Buffer.from(text, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/single-dry-run"),
    dryRun: true,
  });
  assert.equal(decision.decision, "ACCEPT", `sanity: this candidate must be ACCEPT-quality for the test to meaningfully exercise the would-have-written path (got ${decision.decision}: ${decision.reasonCodes.join(",")})`);
  assert.equal(decision.contentStoreId, null, "dry run must never populate a content-store id");

  const after = await rowCountSnapshot(tables);
  assertNoTableChanged(before, after, "single dry run");
});

test("CONCURRENT dry runs (10x, distinct ACCEPT-quality content) produce zero row changes in every table in the database", async () => {
  const tables = await allTableNames();
  const before = await rowCountSnapshot(tables);

  const N = 10;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      evaluateCorpusAdmissionCandidate(client, {
        sourceRef: `concurrent-dry-run-${i}`,
        filename: `concurrent-dry-run-${i}.txt`,
        bytes: Buffer.from(plausibleArticleText(800000 + i * 131), "utf8"),
        consent: RESOLVED_PROVENANCE(`https://example.test/concurrent-dry-run-${i}`),
        dryRun: true,
      }),
    ),
  );
  for (const r of results) {
    assert.equal(r.decision, "ACCEPT", `sanity: every concurrent dry-run candidate must be ACCEPT-quality (got ${r.decision}: ${r.reasonCodes.join(",")})`);
    assert.equal(r.contentStoreId, null);
  }

  const after = await rowCountSnapshot(tables);
  assertNoTableChanged(before, after, "concurrent dry runs");
});
