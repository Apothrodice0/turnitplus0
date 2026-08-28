import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus, corpusShingleHashes, CORPUS_SHINGLE_WRITE_BATCH_ROWS } from "../lib/user-submission-corpus.ts";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { evaluateCorpusAdmissionCandidate, reEvaluateCorpusAdmissionCandidate } from "../lib/corpus-admission-gate.ts";
import { _getActiveExtractionWorkerCountForTesting } from "../lib/corpus-text-extraction.ts";
import { DEFAULT_CORPUS_ADMISSION_LIMITS } from "../lib/corpus-admission-types.ts";

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_gate.db");
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

async function ensureUser(accountId) {
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"],
  });
}

// --- A rich, quality-passing English article generator ---------------------
// Distinct word bank + a seeded PRNG so each call with a different seed
// produces genuinely different (non-near-duplicate) text, while every
// document individually has enough vocabulary variety, sentence-length
// diversity, and paragraph structure to clear the quality-model's ACCEPT
// floor (~70) under the default ENGINEERING_DEFAULT weights.
const WORD_BANK = [
  "research", "analysis", "population", "sample", "variable", "hypothesis", "method", "outcome", "region",
  "temperature", "pressure", "reaction", "material", "structure", "process", "signal", "pattern", "network",
  "sediment", "species", "habitat", "climate", "growth", "measurement", "instrument", "observation", "protocol",
  "significant", "distinct", "gradual", "consistent", "notable", "substantial", "minor", "extensive", "localized",
  "documented", "identified", "recorded", "analyzed", "examined", "compared", "measured", "observed", "reported",
  "across", "within", "during", "following", "throughout", "regarding", "alongside", "despite", "beyond",
  "seasonal", "annual", "recent", "historical", "regional", "coastal", "montane", "urban", "rural",
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

function buildSentence(rng) {
  const length = 10 + Math.floor(rng() * 18);
  const words = Array.from({ length }, () => WORD_BANK[Math.floor(rng() * WORD_BANK.length)]);
  return `The ${words.join(" ")}.`;
}

function plausibleArticleText(seed, targetWords = 3300) {
  const rng = seededRandom(seed);
  const paragraphs = [];
  let wordCount = 0;
  while (wordCount < targetWords) {
    const sentences = Array.from({ length: 5 + Math.floor(rng() * 4) }, () => buildSentence(rng));
    const paragraph = sentences.join(" ");
    paragraphs.push(paragraph);
    wordCount += paragraph.split(/\s+/).length;
  }
  return paragraphs.join("\n\n");
}

const RESOLVED_PROVENANCE = (sourceUrl) => ({
  kind: "BULK_IMPORT_PROVENANCE",
  provenance: { sourceUrl, acquisitionMethod: "BULK_IMPORT_DOWNLOAD", licenseOrPermission: "CC-BY-4.0", retentionBasis: "LICENSED_REUSE", retentionRightsResolved: true, notes: null },
});
const UNRESOLVED_PROVENANCE = (sourceUrl) => ({
  kind: "BULK_IMPORT_PROVENANCE",
  provenance: { sourceUrl, acquisitionMethod: "BULK_IMPORT_DOWNLOAD", licenseOrPermission: null, retentionBasis: "UNRESOLVED", retentionRightsResolved: false, notes: null },
});

async function corpusTableCounts() {
  const [reps, refs, shingles] = await Promise.all([
    client.execute("SELECT COUNT(*) AS c FROM corpus_document_representations"),
    client.execute("SELECT COUNT(*) AS c FROM corpus_submission_references"),
    client.execute("SELECT COUNT(*) AS c FROM corpus_document_shingles"),
  ]);
  return { reps: Number(reps.rows[0].c), refs: Number(refs.rows[0].c), shingles: Number(shingles.rows[0].c) };
}

// --- near-duplicate detection against the REAL corpus -----------------------

test("a candidate exactly matching content already indexed in the real corpus resolves EXACT_DUPLICATE and REJECTs — 'first accepted sample wins'", async () => {
  const text = plausibleArticleText(101);
  const accountId = "gate-seed-account-1";
  await ensureUser(accountId);
  const identity = await createDocumentIdentity(client, { accountId, title: "T", author: null, rawText: text });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText: text });

  const decision = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "candidate-exact-dup",
    filename: "candidate.txt",
    bytes: Buffer.from(text, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/dup"),
    dryRun: true,
  });

  assert.equal(decision.decision, "REJECT");
  assert.ok(decision.reasonCodes.includes("DUPLICATE_ALREADY_REPRESENTED"));
  assert.equal(decision.familyRelation, "EXACT_DUPLICATE");
});

// --- content-store separation (requirement 2 & 4) ---------------------------

test("a dry-run ACCEPT never writes to corpus_admission_content_store", async () => {
  const text = plausibleArticleText(201);
  const decision = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "candidate-dryrun-accept",
    filename: "candidate.txt",
    bytes: Buffer.from(text, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/a"),
    dryRun: true,
  });

  assert.equal(decision.decision, "ACCEPT", `expected ACCEPT, got ${decision.decision} (${decision.reasonCodes.join(",")})`);
  assert.equal(decision.contentStoreId, null);
  const rows = await client.execute({ sql: "SELECT COUNT(*) AS c FROM corpus_admission_content_store WHERE decision_id = ?", args: [decision.id] });
  assert.equal(Number(rows.rows[0].c), 0);
});

test("a real (non-dry-run) ACCEPT with resolved retention writes exactly one content-store row", async () => {
  const text = plausibleArticleText(202);
  const decision = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "candidate-real-accept",
    filename: "candidate.txt",
    bytes: Buffer.from(text, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/b"),
    dryRun: false,
    openConnection,
  });

  assert.equal(decision.decision, "ACCEPT");
  assert.ok(decision.contentStoreId);
  const rows = await client.execute({ sql: "SELECT canonical_sha256, canonical_text FROM corpus_admission_content_store WHERE id = ?", args: [decision.contentStoreId] });
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].canonical_sha256, decision.canonicalSha256);
});

test("large ACCEPT: the accepted-representation shingle set is written completely in bounded batches (CORPUS_SHINGLE_WRITE_BATCH_ROWS), never one oversized batch()", async () => {
  // ~25k words of quality-passing English -> well over CORPUS_SHINGLE_WRITE_BATCH_ROWS
  // informative 5-grams, so the accepted-shingle write in
  // acceptWithAtomicDedupCriticalSection spans several tx.batch() calls.
  const text = plausibleArticleText(20250828, 25_000);
  const decision = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "candidate-large-accept",
    filename: "candidate-large.txt",
    bytes: Buffer.from(text, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/large"),
    dryRun: false,
    openConnection,
  });
  assert.equal(decision.decision, "ACCEPT", `expected ACCEPT, got ${decision.decision} (${decision.reasonCodes.join(",")})`);

  const acceptedRep = await client.execute({
    sql: "SELECT id FROM corpus_admission_accepted_representations WHERE decision_id = ?",
    args: [decision.id],
  });
  assert.equal(acceptedRep.rows.length, 1);
  const acceptedRepId = acceptedRep.rows[0].id;

  // The gate shingles canonicalizeText(extraction.rawText); for a .txt that is the decoded text.
  const expected = corpusShingleHashes(canonicalizeText(text));
  assert.ok(expected.size > CORPUS_SHINGLE_WRITE_BATCH_ROWS, `precondition: ${expected.size} informative shingles spans multiple write batches`);
  const persisted = await client.execute({
    sql: "SELECT COUNT(*) AS c FROM corpus_admission_accepted_shingles WHERE accepted_representation_id = ?",
    args: [acceptedRepId],
  });
  assert.equal(Number(persisted.rows[0].c), expected.size,
    "every informative shingle of the accepted representation must be persisted exactly once across the bounded batches");

  const distinct = await client.execute({
    sql: "SELECT COUNT(*) AS c FROM (SELECT DISTINCT shingle_hash FROM corpus_admission_accepted_shingles WHERE accepted_representation_id = ?)",
    args: [acceptedRepId],
  });
  assert.equal(Number(distinct.rows[0].c), expected.size, "no duplicate shingle rows");
});

test("unresolved retention rights prevent both admission AND full-text persistence, even for real (non-dry-run) evaluation", async () => {
  const text = plausibleArticleText(203);
  const decision = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "candidate-unresolved-retention",
    filename: "candidate.txt",
    bytes: Buffer.from(text, "utf8"),
    consent: UNRESOLVED_PROVENANCE("https://example.test/c"),
    dryRun: false,
    openConnection,
  });

  assert.equal(decision.decision, "REJECT");
  assert.ok(decision.reasonCodes.includes("RETENTION_REQUIREMENT_UNMET"));
  assert.equal(decision.contentStoreId, null);
  const rows = await client.execute({ sql: "SELECT COUNT(*) AS c FROM corpus_admission_content_store WHERE decision_id = ?", args: [decision.id] });
  assert.equal(Number(rows.rows[0].c), 0, "no text may ever be persisted for a candidate that failed the retention gate");
});

// --- re-evaluation without re-extraction (requirement 4 / spec section 5) ---

test("reEvaluateCorpusAdmissionCandidate re-applies the policy from retained text without accepting any file bytes, and reuses the same content-store row rather than duplicating it", async () => {
  const text = plausibleArticleText(204);
  const original = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "candidate-for-reeval",
    filename: "candidate.txt",
    bytes: Buffer.from(text, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/d"),
    dryRun: false,
    openConnection,
  });
  assert.equal(original.decision, "ACCEPT");
  assert.ok(original.contentStoreId);

  // Note: this call accepts no `bytes`/`filename` at all — structurally
  // incapable of re-extracting, only reading retained text by decisionId.
  const reEvaluated = await reEvaluateCorpusAdmissionCandidate(client, { decisionId: original.id, openConnection });

  assert.notEqual(reEvaluated.id, original.id, "re-evaluation must produce a NEW decision row");
  assert.equal(reEvaluated.canonicalSha256, original.canonicalSha256);
  assert.equal(reEvaluated.contentStoreId, original.contentStoreId, "the SAME retained content-store row must be reused, not duplicated");

  const rows = await client.execute({ sql: "SELECT COUNT(*) AS c FROM corpus_admission_content_store WHERE canonical_sha256 = ?", args: [original.canonicalSha256] });
  assert.equal(Number(rows.rows[0].c), 1, "exactly one content-store row must exist even after re-evaluating the same content");
});

test("reEvaluateCorpusAdmissionCandidate throws for a decision with no retained content (e.g. a dry-run or rejected candidate) rather than silently falling back to anything", async () => {
  const text = plausibleArticleText(205);
  const dryRunDecision = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "candidate-no-retained-content",
    filename: "candidate.txt",
    bytes: Buffer.from(text, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/e"),
    dryRun: true,
  });
  await assert.rejects(() => reEvaluateCorpusAdmissionCandidate(client, { decisionId: dryRunDecision.id, openConnection }));
});

// --- REVIEW/REJECT candidates never touch the real corpus tables -----------

test("REJECT (too-short) and REVIEW candidates leave the real corpus tables at zero row-count delta", async () => {
  const before = await corpusTableCounts();

  const shortText = "This is far too short to ever pass the corpus admission word-count hard gate.";
  const rejectDecision = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "candidate-too-short",
    filename: "candidate.txt",
    bytes: Buffer.from(shortText, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/f"),
    dryRun: true,
  });
  assert.equal(rejectDecision.decision, "REJECT");
  assert.ok(rejectDecision.reasonCodes.includes("WORD_COUNT_BELOW_MINIMUM"));

  const uncertainLanguageText = plausibleArticleText(206) + "\n\n" + "بعض الكلمات العربية هنا لجعل اللغة غير مؤكدة إلى حد ما مقارنة بالنص الإنجليزي الأساسي أعلاه تماما";
  const reviewDecision = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "candidate-mixed-language",
    filename: "candidate.txt",
    bytes: Buffer.from(uncertainLanguageText, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/g"),
    dryRun: true,
  });
  assert.notEqual(reviewDecision.decision, "REJECT");

  const after = await corpusTableCounts();
  assert.deepEqual(after, before, "no REJECT/REVIEW candidate may ever create a row in the real corpus tables");
});

// --- mixed-language misclassification regression (bug reproduction) --------
// A real document ("...Maghrebi Family Firm") is predominantly English with
// a short Spanish-translated abstract on page 1-2. The old whole-document,
// presence-only detector counted the Spanish abstract's la/le/les as French
// stopword evidence and misclassified the whole document "French" at
// confidence 0.5, capping it to REVIEW via LANGUAGE_UNCERTAIN. The new
// windowed, weighted, dominant-language detector must not repeat this.

const SPANISH_WORDS = [
  "el", "estudio", "examina", "la", "filantropia", "y", "la", "riqueza",
  "en", "las", "empresas", "familiares", "con", "una", "metodologia",
  "para", "estos", "resultados", "muestran", "que", "es", "un", "factor",
  "determinante", "del", "comportamiento", "al", "comprender", "este",
  "fenomeno", "tambien", "desde", "hacia",
];

function repeatSpanishWords(count) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(SPANISH_WORDS[i % SPANISH_WORDS.length]);
  return out.join(" ");
}

const REAL_SPANISH_ABSTRACT =
  "Resumen: Este articulo examina la filantropia y la riqueza socioemocional en las empresas familiares del Magreb. " +
  "El estudio analiza como la cultura influye en las decisiones filantropicas de estas empresas. Los resultados " +
  "muestran que la incrustacion cultural es un factor determinante para entender el comportamiento filantropico de " +
  "las familias empresarias en la region.";

test("bug reproduction: an English article with a short Spanish abstract is ACCEPTed as CONFIDENT_ENGLISH, never capped to REVIEW via LANGUAGE_UNCERTAIN", async () => {
  const text = `${REAL_SPANISH_ABSTRACT}\n\n${plausibleArticleText(301)}`;

  const decision = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "candidate-english-with-spanish-abstract",
    filename: "candidate.txt",
    bytes: Buffer.from(text, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/spanish-abstract"),
    dryRun: true,
  });

  assert.equal(decision.decision, "ACCEPT", `expected ACCEPT, got ${decision.decision} (${decision.reasonCodes.join(",")})`);
  assert.ok(!decision.reasonCodes.includes("LANGUAGE_UNCERTAIN"), `must not be capped to REVIEW by language uncertainty: ${decision.reasonCodes.join(",")}`);
});

test("a genuinely balanced English/Spanish document (not a short embedded abstract) is capped to REVIEW via LANGUAGE_UNCERTAIN, not silently ACCEPTed as English", async () => {
  const englishText = plausibleArticleText(302);
  const spanishText = repeatSpanishWords(englishText.split(/\s+/).length);
  const text = `${englishText}\n\n${spanishText}`;

  const decision = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "candidate-balanced-bilingual",
    filename: "candidate.txt",
    bytes: Buffer.from(text, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/balanced-bilingual"),
    dryRun: true,
  });

  assert.ok(decision.reasonCodes.includes("LANGUAGE_UNCERTAIN"), `expected LANGUAGE_UNCERTAIN, got ${decision.reasonCodes.join(",")}`);
  assert.notEqual(decision.decision, "ACCEPT");
});

// --- openConnection: mandatory for every non-dry admission, fail fast -------

test("openConnection is required whenever dryRun is not true, and the failure happens before any extraction or write is attempted — but a dry run never requires it at all", async () => {
  const before = await corpusTableCounts();
  const decisionRowsBefore = Number((await client.execute("SELECT COUNT(*) AS c FROM corpus_admission_decisions")).rows[0].c);

  const text = plausibleArticleText(9999);
  await assert.rejects(
    () =>
      evaluateCorpusAdmissionCandidate(client, {
        sourceRef: "missing-connection-factory",
        filename: "candidate.txt",
        bytes: Buffer.from(text, "utf8"),
        consent: RESOLVED_PROVENANCE("https://example.test/missing-openConnection"),
        dryRun: false,
        // openConnection deliberately omitted.
      }),
    /openConnection is required/,
    "a non-dry-run call with no openConnection must reject with the fail-fast configuration error, not an internal DB error",
  );

  assert.equal(
    Number((await client.execute("SELECT COUNT(*) AS c FROM corpus_admission_decisions")).rows[0].c),
    decisionRowsBefore,
    "the missing-openConnection failure must happen before any decision row is written",
  );
  assert.deepEqual(await corpusTableCounts(), before, "the missing-openConnection failure must happen before any real corpus table is touched");

  // Dry runs remain entirely unaffected — never call openConnection, never require it.
  const dryDecision = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "dry-run-needs-no-connection-factory",
    filename: "candidate.txt",
    bytes: Buffer.from(text, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/dry-run-no-factory"),
    dryRun: true,
    // openConnection still omitted — must not throw.
  });
  assert.equal(dryDecision.decision, "ACCEPT", `sanity: a dry run must still succeed normally without openConnection, got ${dryDecision.decision} (${dryDecision.reasonCodes.join(",")})`);

  // reEvaluateCorpusAdmissionCandidate always runs non-dry internally, so
  // openConnection is unconditionally required there too.
  const accepted = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "candidate-for-reeval-fail-fast-check",
    filename: "candidate.txt",
    bytes: Buffer.from(plausibleArticleText(9998), "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/reeval-fail-fast"),
    dryRun: false,
    openConnection,
  });
  assert.equal(accepted.decision, "ACCEPT");
  await assert.rejects(
    () => reEvaluateCorpusAdmissionCandidate(client, { decisionId: accepted.id /* openConnection omitted */ }),
    /openConnection is required/,
  );
});

// ============================================================================
// Release-hardening audit finding WORKER-01: lib/corpus-extraction-worker.ts
// cannot load in a deployed Vercel serverless function (confirmed live in
// Preview runtime logs — Next.js copies the file into the build as a raw,
// untranspiled asset, unparseable by a bare Node runtime with no tsx
// loader). Every format shares that one worker script, so every corpus-
// admission extraction attempt failed identically in production, reported
// as EXTRACTION_WORKER_TERMINATED — including the trivially-safe txt case
// (bytes.toString('utf8'), no third-party parser). Fix: extractCorpusCandidateText
// now decodes a VALIDATED txt candidate inline, never touching the worker.
// These tests exercise the full evaluateCorpusAdmissionCandidate pipeline —
// file validation, extraction, hard gates, quality/hashing — end to end,
// proving the bypass is gated on the validator's own classification (never
// a raw claimed filename) and that PDF/DOCX still require the worker.
// ============================================================================

test("WORKER-01: a validated txt candidate produces a complete decision (word count, language, hash, quality) without ever spawning a worker", async () => {
  assert.equal(_getActiveExtractionWorkerCountForTesting(), 0, "sanity: no worker active before this test runs");
  const text = plausibleArticleText(31001);
  const decision = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "worker01-valid-txt",
    filename: "live-submission.txt",
    bytes: Buffer.from(text, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/worker01-valid-txt"),
    dryRun: true,
  });

  assert.equal(decision.detectedFormat, "txt");
  assert.equal(decision.extractorVersion, "plain-text-decode-v1");
  assert.ok(decision.hardGatePassed, `expected hard gates to pass, got failure codes: ${decision.hardGateFailureCodes.join(",")}`);
  assert.ok(Number.isInteger(decision.extractedWordCount) && decision.extractedWordCount > 0, `expected a real word count, got ${decision.extractedWordCount}`);
  assert.equal(typeof decision.detectedLanguage, "string");
  assert.ok(decision.detectedLanguage.length > 0);
  assert.equal(typeof decision.canonicalSha256, "string");
  assert.equal(decision.canonicalSha256.length, 64, "a real sha256 hex digest");
  assert.equal(typeof decision.qualityScore, "number");
  assert.notEqual(decision.decision, undefined);
  assert.notDeepEqual(decision.reasonCodes, ["EXTRACTION_WORKER_TERMINATED"]);
  assert.ok(!decision.reasonCodes.includes("EXTRACTION_WORKER_TERMINATED"), "the exact production bug this fix closes must never reappear");

  assert.equal(_getActiveExtractionWorkerCountForTesting(), 0, "no worker slot should ever have been acquired for this txt candidate");
});

test("WORKER-01: a dangerous Windows PE executable claiming a .txt filename is rejected by file validation — never reaches the txt bypass, never produces a decision claiming real content", async () => {
  const peBytes = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.from("this is not really text, it is a renamed executable payload", "utf8")]);
  const decision = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "worker01-dangerous-pe-as-txt",
    filename: "malware.txt",
    bytes: peBytes,
    consent: RESOLVED_PROVENANCE("https://example.test/worker01-dangerous-pe"),
    dryRun: true,
  });

  assert.equal(decision.decision, "REJECT");
  assert.equal(decision.hardGatePassed, false);
  assert.ok(decision.hardGateFailureCodes.includes("DANGEROUS_FILE_SIGNATURE"), `expected DANGEROUS_FILE_SIGNATURE, got ${decision.hardGateFailureCodes.join(",")}`);
  assert.equal(decision.extractedWordCount, null, "a rejected-at-validation candidate must never report a word count as if real text had been decoded");
  assert.equal(decision.canonicalSha256, null);
});

test("WORKER-01: a ZIP archive (e.g. a mislabeled DOCX) claiming a .txt filename is rejected by file validation, not silently decoded as garbage text", async () => {
  const zipBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("fake zip local file header content here", "utf8")]);
  const decision = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "worker01-zip-as-txt",
    filename: "disguised.txt",
    bytes: zipBytes,
    consent: RESOLVED_PROVENANCE("https://example.test/worker01-zip-as-txt"),
    dryRun: true,
  });

  assert.equal(decision.decision, "REJECT");
  assert.ok(decision.hardGateFailureCodes.includes("DANGEROUS_FILE_SIGNATURE"), `expected DANGEROUS_FILE_SIGNATURE, got ${decision.hardGateFailureCodes.join(",")}`);
});

test("WORKER-01: empty and oversized txt candidates still fail with the existing reason codes end-to-end through the full gate, not just the raw extraction function", async () => {
  const emptyDecision = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "worker01-empty-txt",
    filename: "empty.txt",
    bytes: Buffer.from("   \n\n  ", "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/worker01-empty-txt"),
    dryRun: true,
  });
  assert.equal(emptyDecision.decision, "REJECT");
  assert.ok(emptyDecision.hardGateFailureCodes.includes("EXTRACTION_EMPTY_RESULT"), `expected EXTRACTION_EMPTY_RESULT, got ${emptyDecision.hardGateFailureCodes.join(",")}`);

  const oversizedText = "x ".repeat(50_000);
  const oversizedDecision = await evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "worker01-oversized-txt",
    filename: "oversized.txt",
    bytes: Buffer.from(oversizedText, "utf8"),
    consent: RESOLVED_PROVENANCE("https://example.test/worker01-oversized-txt"),
    limits: { ...DEFAULT_CORPUS_ADMISSION_LIMITS, maxExtractedChars: { value: 100, status: "ENGINEERING_DEFAULT", rationale: "test" } },
    dryRun: true,
  });
  assert.equal(oversizedDecision.decision, "REJECT");
  assert.ok(oversizedDecision.hardGateFailureCodes.includes("EXTRACTED_CONTENT_TOO_LARGE"), `expected EXTRACTED_CONTENT_TOO_LARGE, got ${oversizedDecision.hardGateFailureCodes.join(",")}`);
});

test("WORKER-01: PDF and DOCX candidates still route through the real isolated worker, unaffected by the txt bypass", async () => {
  const pdfBytes = fs.readFileSync(path.join(repoRoot, "tests/fixtures/attention-is-all-you-need.pdf"));
  const pdfPromise = evaluateCorpusAdmissionCandidate(client, {
    sourceRef: "worker01-pdf-still-uses-worker",
    filename: "real.pdf",
    bytes: pdfBytes,
    consent: RESOLVED_PROVENANCE("https://example.test/worker01-pdf"),
    dryRun: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const observedDuringPdf = _getActiveExtractionWorkerCountForTesting();
  const pdfDecision = await pdfPromise;
  assert.equal(pdfDecision.detectedFormat, "pdf");
  assert.ok(observedDuringPdf >= 1, `PDF must still acquire a real worker slot — observed ${observedDuringPdf}`);
});
