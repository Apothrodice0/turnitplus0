import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus, createReusableDocumentRepresentation, recordCorpusShingles } from "../lib/user-submission-corpus.ts";
import { matchAgainstUserSubmissionCorpus, USER_SUBMISSION_MATCH_THRESHOLDS } from "../lib/user-submission-matching.ts";
import { computeDocumentCorrespondence } from "../lib/document-correspondence.ts";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { tokens } from "../lib/similarity-core.ts";
import {
  BASE_DOCUMENT,
  PARTIAL_COPY_DOCUMENT,
  CALIBRATION_FIXTURES,
} from "../lib/e8j-calibration-fixtures.ts";

/**
 * Phase E8J: calibration tests for the user-submission historical matcher.
 * Entirely local/disposable — nothing here ever touches production or the
 * 230-document evaluation archive. This suite documents CURRENT matcher
 * behavior against the E8J fixture family; it does not assert that behavior
 * "should" be different anywhere, and it never imports or mutates
 * USER_SUBMISSION_MATCH_THRESHOLDS (only reads it, for threshold-curve
 * comparisons via explicit override objects passed to
 * computeDocumentCorrespondence — a pure function).
 */

const repoRoot = path.resolve(".");
const dbFile = path.join(repoRoot, "test_e8j_calibration.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(repoRoot, "drizzle"));

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

const ACCOUNT_A = "e8j-test-account-a";
const ACCOUNT_B = "e8j-test-account-b";
const knownUsers = new Set();
async function ensureUser(accountId) {
  if (accountId === null || knownUsers.has(accountId)) return;
  knownUsers.add(accountId);
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"],
  });
}
async function indexSubmission(accountId, title, rawText) {
  await ensureUser(accountId);
  const identity = await createDocumentIdentity(client, { accountId, title, author: null, rawText });
  const indexResult = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  return { identity, indexResult };
}
async function match(accountId, canonicalText) {
  return matchAgainstUserSubmissionCorpus(client, { accountId, canonicalText });
}

// Index the base document once, under Account A — every test below queries against it.
await indexSubmission(ACCOUNT_A, "Aurelia Pilot Evaluation Report", BASE_DOCUMENT);

function fixture(category) {
  return CALIBRATION_FIXTURES.find((f) => f.category === category);
}

// --- A: exact copy -----------------------------------------------------------

test("A: EXACT_COPY -> MATCHED, EXACT_CANONICAL_MATCH, containment 1.0, cross-account PRIOR_SUBMISSION", async () => {
  const result = await match(ACCOUNT_B, fixture("EXACT_COPY").text);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].matchType, "EXACT_CANONICAL_MATCH");
  assert.equal(result.matches[0].containment, 1);
  assert.equal(result.matches[0].relationshipType, "PRIOR_SUBMISSION");
});

// --- B: formatting-only --------------------------------------------------------

test("B: FORMATTING_ONLY -> same canonical hash as base, EXACT_CANONICAL_MATCH", async () => {
  const f = fixture("FORMATTING_ONLY");
  assert.equal(canonicalizeText(f.text), canonicalizeText(BASE_DOCUMENT), "canonicalization must collapse the formatting differences to the identical text");
  const result = await match(ACCOUNT_B, f.text);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].matchType, "EXACT_CANONICAL_MATCH");
  assert.equal(result.matches[0].containment, 1);
});

// --- C: light edit --------------------------------------------------------------

test("C: LIGHT_EDIT (~7% modified) -> MATCHED, STRONG_TEXT_MATCH, high containment", async () => {
  const f = fixture("LIGHT_EDIT");
  assert.ok(f.actualModifiedPercent >= 0.05 && f.actualModifiedPercent <= 0.10, `fixture composition must be in the 5-10% band, measured ${f.actualModifiedPercent}`);
  const result = await match(ACCOUNT_B, f.text);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].matchType, "STRONG_TEXT_MATCH");
  assert.ok(result.matches[0].containment >= USER_SUBMISSION_MATCH_THRESHOLDS.correspondence.strongContainmentThreshold);
  assert.ok(result.matches[0].containment > 0.8, "a 7%-modified document should retain very high containment");
});

// --- D: moderate edit -------------------------------------------------------------

test("D: MODERATE_EDIT (~24% modified) -> MATCHED, STRONG_TEXT_MATCH", async () => {
  const f = fixture("MODERATE_EDIT");
  assert.ok(f.actualModifiedPercent >= 0.20 && f.actualModifiedPercent <= 0.30, `fixture composition must be in the 20-30% band, measured ${f.actualModifiedPercent}`);
  const result = await match(ACCOUNT_B, f.text);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].matchType, "STRONG_TEXT_MATCH");
  assert.ok(result.matches[0].containment >= USER_SUBMISSION_MATCH_THRESHOLDS.correspondence.strongContainmentThreshold);
});

// --- E: heavy edit -----------------------------------------------------------------

test("E: HEAVY_EDIT (~44% modified) -> still MATCHED under current thresholds, but close to the boundary", async () => {
  const f = fixture("HEAVY_EDIT");
  assert.ok(f.actualModifiedPercent >= 0.40 && f.actualModifiedPercent <= 0.60, `fixture composition must be in the 40-60% band, measured ${f.actualModifiedPercent}`);
  const result = await match(ACCOUNT_B, f.text);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].matchType, "STRONG_TEXT_MATCH");
  const threshold = USER_SUBMISSION_MATCH_THRESHOLDS.correspondence.strongContainmentThreshold;
  assert.ok(result.matches[0].containment >= threshold, "documents this heavily edited are expected to be near the threshold, not comfortably above it");
  assert.ok(result.matches[0].containment < threshold + 0.15, `containment ${result.matches[0].containment} is surprisingly far above threshold ${threshold} for a 44%-modified document — recheck fixture composition if this fails`);
});

// --- F: partial copy ----------------------------------------------------------------

test("F: PARTIAL_COPY (~36% verbatim-copied, rest new) -> MATCHED via distinctivePassageMatch (Phase 6.6 PART 2 fix; formerly a documented NO_HISTORICAL_MATCH limitation)", async () => {
  const f = fixture("PARTIAL_COPY");
  // f.actualModifiedPercent holds PARTIAL_COPY_PERCENT_COPIED (the COPIED
  // fraction) for this fixture specifically — see lib/e8j-calibration-fixtures.ts.
  assert.ok(f.actualModifiedPercent >= 0.30 && f.actualModifiedPercent <= 0.40, `expected 30-40% verbatim-copied by construction, measured ${f.actualModifiedPercent}`);

  const result = await match(ACCOUNT_B, f.text);
  assert.equal(result.status, "MATCHED", "Phase 6.6 PART 2: a substantial (400+ word) contiguous verbatim passage is now detected via distinctivePassageMatch even though whole-document containment dilution still keeps it below strongCorrespondence — see lib/document-correspondence.ts's own comment");
  assert.equal(result.matches[0].matchType, "STRONG_TEXT_MATCH");

  // Diagnostic: confirms WHICH gate accepted it — computeDocumentCorrespondence
  // is a pure function, so calling it directly here does not touch the real
  // thresholds constant or any production code path.
  const diag = computeDocumentCorrespondence(f.text, BASE_DOCUMENT, USER_SUBMISSION_MATCH_THRESHOLDS.correspondence);
  assert.ok(diag.containment > 0.30 && diag.containment < 0.40, `expected whole-document containment in (0.30, 0.40), got ${diag.containment}`);
  assert.equal(diag.strongCorrespondence, false, "confirms containment still falls below the unchanged 0.5 whole-document threshold — strongCorrespondence itself is untouched by this fix");
  assert.equal(diag.distinctivePassageMatch, true, "confirms it is distinctivePassageMatch, not strongCorrespondence, that now accepts this case");

  // J: passage correctness — the one diagnostic passage must fall entirely
  // within the known-copied zone (the first 4 paragraphs of the fixture),
  // never inside the deliberately-unrelated filler content appended after it.
  const copiedZoneText = PARTIAL_COPY_DOCUMENT.split("\n\n").slice(0, 4).join("\n\n");
  const copiedZoneWordCount = tokens(copiedZoneText).length;
  assert.ok(diag.passages.length >= 1, "the copied passage must be found and localized");
  for (const p of diag.passages) {
    assert.ok(p.submittedWordEnd < copiedZoneWordCount, `passage [${p.submittedWordStart}-${p.submittedWordEnd}] must fall within the copied zone (0-${copiedZoneWordCount - 1}) — a passage outside it would mean generic/unrelated text was incorrectly selected`);
  }
});

// --- G: common-phrase only -----------------------------------------------------------

test("G: COMMON_PHRASE_ONLY -> NO_HISTORICAL_MATCH (no false positive from generic boilerplate)", async () => {
  const result = await match(ACCOUNT_B, fixture("COMMON_PHRASE_ONLY").text);
  assert.equal(result.status, "NO_HISTORICAL_MATCH");
});

// --- H: same-topic, different wording --------------------------------------------------

test("H: SAME_TOPIC_DIFFERENT_WORDING -> NO_HISTORICAL_MATCH (topic similarity alone must never manufacture a match)", async () => {
  const result = await match(ACCOUNT_B, fixture("SAME_TOPIC_DIFFERENT_WORDING").text);
  assert.equal(result.status, "NO_HISTORICAL_MATCH");
});

// --- I: deterministic ordering -----------------------------------------------------------

test("I: deterministic ordering — repeated calls against the same state return byte-identical results", async () => {
  const first = await match(ACCOUNT_B, fixture("LIGHT_EDIT").text);
  const second = await match(ACCOUNT_B, fixture("LIGHT_EDIT").text);
  assert.deepEqual(first, second, "the matcher must be deterministic — no ordering flakiness across repeated calls against unchanged corpus state");
});

// --- K: account classification -----------------------------------------------------------

test("K: SELF for the same account, PRIOR_SUBMISSION for a different account, UNKNOWN_RELATIONSHIP for anonymous", async () => {
  const selfResult = await match(ACCOUNT_A, BASE_DOCUMENT);
  assert.equal(selfResult.status, "MATCHED");
  assert.equal(selfResult.matches[0].relationshipType, "SELF");

  const priorResult = await match(ACCOUNT_B, BASE_DOCUMENT);
  assert.equal(priorResult.status, "MATCHED");
  assert.equal(priorResult.matches[0].relationshipType, "PRIOR_SUBMISSION");

  const anonResult = await match(null, BASE_DOCUMENT);
  assert.equal(anonResult.status, "MATCHED");
  assert.equal(anonResult.matches[0].relationshipType, "UNKNOWN_RELATIONSHIP");
});

// --- L: no identity leakage -----------------------------------------------------------

test("L: no identity leakage — a cross-account match result never contains the other account's id or any authorship claim", async () => {
  const result = await match(ACCOUNT_B, BASE_DOCUMENT);
  assert.equal(result.status, "MATCHED");
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(ACCOUNT_A), "the historical submitter's account id must never appear in the result");
  assert.ok(!serialized.toLowerCase().includes("author"), "the result must not contain any field implying authorship");
});

// --- M: score invariance -----------------------------------------------------------

test("M (structural): lib/user-submission-matching.ts never references a scoring field", () => {
  const source = fs.readFileSync(path.join(repoRoot, "lib/user-submission-matching.ts"), "utf8");
  assert.doesNotMatch(source, /\b(archiveScore|aiScore|verifiedSimilarity|report\.score)\b/);
});

test("M (behavioral): matchAgainstUserSubmissionCorpus issues only SELECT statements — proven with a read-only-guard client — and never touches saved_reports", async () => {
  const guarded = {
    execute: async (stmt) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      assert.match(sql.trim(), /^SELECT\b/i, `matcher issued a non-SELECT statement: ${sql}`);
      assert.doesNotMatch(sql, /saved_reports/i, "matcher must never touch saved_reports (scores live there)");
      return client.execute(stmt);
    },
  };
  const result = await matchAgainstUserSubmissionCorpus(guarded, { accountId: ACCOUNT_B, canonicalText: fixture("MODERATE_EDIT").text });
  assert.equal(result.status, "MATCHED");
});

// --- N: performance -----------------------------------------------------------

test("N: candidate generation stays fast and index-backed against a 300-representation synthetic corpus", async () => {
  const NOISE_VOCAB = ["orbital", "sediment", "logistics", "polymer", "cartography", "ferment", "acoustic", "irrigation", "telemetry", "pigment"];
  function noiseText(i) {
    const words = [];
    for (let w = 0; w < 150; w += 1) words.push(NOISE_VOCAB[(i * 7 + w * 13) % NOISE_VOCAB.length] + i);
    return `Synthetic noise document ${i}. ${words.join(" ")}.`;
  }
  for (let i = 0; i < 300; i += 1) {
    const canonicalText = canonicalizeText(noiseText(i));
    const representation = await createReusableDocumentRepresentation(client, { canonicalText });
    await recordCorpusShingles(client, representation.id, canonicalText);
  }

  const plan = await client.execute(
    "EXPLAIN QUERY PLAN SELECT s.representation_id FROM corpus_document_shingles s JOIN corpus_document_representations r ON r.id = s.representation_id WHERE s.fingerprint_version = 'corpus-shingle-v1' AND s.shingle_hash IN ('a','b','c') GROUP BY s.representation_id HAVING COUNT(*) >= 3 ORDER BY 1 LIMIT 10",
  );
  const planText = plan.rows.map((r) => JSON.stringify(r)).join(" ");
  assert.match(planText, /idx_corpus_document_shingles_hash/i, "candidate generation must use the shingle-hash index, never a full table scan");

  const start = performance.now();
  const result = await match(ACCOUNT_B, fixture("LIGHT_EDIT").text);
  const runtimeMs = performance.now() - start;
  assert.equal(result.status, "MATCHED", "the real match must still be found correctly amid 300 unrelated noise representations");
  assert.ok(runtimeMs < 1000, `match against a 300-representation corpus took ${runtimeMs}ms — expected well under 1000ms for indexed candidate generation`);
});
