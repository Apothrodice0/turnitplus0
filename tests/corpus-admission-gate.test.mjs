import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { evaluateCorpusAdmissionCandidate, reEvaluateCorpusAdmissionCandidate } from "../lib/corpus-admission-gate.ts";

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
