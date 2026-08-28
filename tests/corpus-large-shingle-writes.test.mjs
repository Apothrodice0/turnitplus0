import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalSha256, createDocumentIdentity } from "../lib/document-identity.ts";
import { canonicalizeText } from "../lib/canonical-text.ts";
import {
  runCorpusAdmissionPromotionSweep,
  stageAndClaimCorpusAdmissionPromotionForDecision,
  processCorpusAdmissionPromotion,
} from "../lib/corpus-admission-promotion.ts";
import {
  recordCorpusShingles,
  corpusShingleHashes,
  createReusableDocumentRepresentation,
  findCandidateCorpusRepresentations,
  indexDocumentSubmissionIntoCorpus,
  CORPUS_FINGERPRINT_VERSION,
  CORPUS_SHINGLE_WRITE_BATCH_ROWS,
} from "../lib/user-submission-corpus.ts";
import { matchAgainstUserSubmissionCorpus } from "../lib/user-submission-matching.ts";
import { getCurrentCorpusMatchGeneration } from "../lib/report-historical-match.ts";

/**
 * LARGE CORPUS SHINGLE WRITES hardening (write side).
 *
 * recordCorpusShingles (corpus_document_shingles, promotion path) and the
 * accepted-shingle write in lib/corpus-admission-gate.ts both hand
 * client.batch()/tx.batch() an ARRAY of single-row statements — 3 binds each,
 * never a multi-row VALUES — so SQLITE_MAX_VARIABLE_NUMBER (32,766) is
 * unreachable at any size. These tests prove the newly-added bounded
 * batching (CORPUS_SHINGLE_WRITE_BATCH_ROWS) writes a very large shingle set
 * completely, keeps the promotion transaction atomic (a mid-batch failure
 * rolls the whole thing back — no partial matchable representation, promotion
 * not 'indexed', corpus_match_generation not bumped), stays idempotent on
 * retry, and does not change candidate discovery / verification for a
 * genuine copied passage. Every fixture is synthetic.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_large_shingle_writes.db");
for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  const c = `${dbFile}${suffix}`;
  if (fs.existsSync(c)) fs.unlinkSync(c);
}
const dbUrl = `file:${dbFile}`;
const client = createClient({ url: dbUrl });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);
const openConnection = () => createClient({ url: dbUrl });

const priorPromotionFlag = process.env.CORPUS_PROMOTION_ENABLED;
const priorCorpusSourceFlag = process.env.CORPUS_SOURCE_MATCHING_ENABLED;
test.after(() => {
  client.close();
  if (priorPromotionFlag === undefined) delete process.env.CORPUS_PROMOTION_ENABLED;
  else process.env.CORPUS_PROMOTION_ENABLED = priorPromotionFlag;
  if (priorCorpusSourceFlag === undefined) delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  else process.env.CORPUS_SOURCE_MATCHING_ENABLED = priorCorpusSourceFlag;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

// ~46k informative 5-grams => 6 write batches at CORPUS_SHINGLE_WRITE_BATCH_ROWS=8000,
// and well past the 32,766 a hypothetical single multi-row VALUES would bind.
// Distinct tokens so nearly every 5-gram is informative and unique.
function largeDistinctText(prefix, wordCount) {
  const parts = [];
  for (let i = 0; i < wordCount; i += 1) {
    parts.push(`${prefix}word${i.toString(36)}zeta`);
    if (i % 5 === 0) parts.push("between");
  }
  return parts.join(" ");
}

async function insertDecision(overrides) {
  const id = overrides.id ?? randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      id, null, overrides.sourceRef ?? `large-write-test-${randomUUID()}`, "v1", overrides.decision, JSON.stringify([]),
      1, JSON.stringify([]), "txt", overrides.wordCount ?? 50, "English", 0.95,
      overrides.canonicalSha256 ?? randomUUID(), "v1", null, 80, "v1",
      JSON.stringify({}), JSON.stringify({}), "v1", 0.9, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  return id;
}

async function seedAcceptedDecision(text) {
  const hash = canonicalSha256(text);
  const decisionId = await insertDecision({ decision: "ACCEPT", canonicalSha256: hash });
  const acceptedRepresentationId = randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
    args: [acceptedRepresentationId, decisionId, hash, 50, "v1"],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_content_store (id, decision_id, canonical_sha256, canonical_text, extractor_version, retention_basis, stored_at)
          VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, hash, text, "v1", "LICENSED_REUSE"],
  });
  return { decisionId, acceptedRepresentationId, hash };
}

async function count(sql, args = []) {
  return Number((await client.execute({ sql, args })).rows[0].c);
}

// A connection factory whose write transactions fail the Nth tx.batch() call,
// to inject a genuine mid-batch failure inside indexPromotionAtomically.
function faultyOpenConnection(failOnBatchCall) {
  return () => {
    const real = createClient({ url: dbUrl });
    let batchCalls = 0;
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (...txArgs) => {
            const tx = await target.transaction(...txArgs);
            return new Proxy(tx, {
              get(t, p, r) {
                if (p === "batch") {
                  return async (...bArgs) => {
                    batchCalls += 1;
                    if (batchCalls === failOnBatchCall) {
                      throw new Error(`injected mid-batch failure on tx.batch() call #${batchCalls}`);
                    }
                    return t.batch(...bArgs);
                  };
                }
                const v = Reflect.get(t, p, r);
                return typeof v === "function" ? v.bind(t) : v;
              },
            });
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  };
}

// A plain-Client proxy whose Nth client.batch() call throws — to inject a
// mid-run failure into the NON-transactional recordCorpusShingles path used
// by indexDocumentSubmissionIntoCorpus (each batch there is its own implicit
// transaction, so earlier batches stay committed).
function faultyClientNthBatch(realClient, failOnBatchCall) {
  let n = 0;
  return new Proxy(realClient, {
    get(t, p, r) {
      if (p === "batch") {
        return async (...args) => {
          n += 1;
          if (n === failOnBatchCall) throw new Error(`injected failure on client.batch() call #${n}`);
          return t.batch(...args);
        };
      }
      const v = Reflect.get(t, p, r);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

async function ensureUser(accountId) {
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"],
  });
}

test("A: a >32,766-shingle representation is written completely in multiple bounded batches by the promotion path", async () => {
  process.env.CORPUS_PROMOTION_ENABLED = "true";
  const text = largeDistinctText("a", 46_000);
  const shingles = corpusShingleHashes(canonicalizeText(text));
  assert.ok(shingles.size > 32_766, `precondition: ${shingles.size} informative shingles > 32,766`);
  assert.ok(shingles.size > CORPUS_SHINGLE_WRITE_BATCH_ROWS, "precondition: forces more than one write batch");

  const { decisionId } = await seedAcceptedDecision(text);
  const genBefore = await getCurrentCorpusMatchGeneration(client);

  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const outcome = sweep.results.find((r) => r.decisionId === decisionId);
  assert.equal(outcome.outcome, "indexed");

  const rows = await count("SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?", [outcome.representationId]);
  assert.equal(rows, shingles.size, "every informative shingle must be persisted exactly once");

  const genAfter = await getCurrentCorpusMatchGeneration(client);
  assert.equal(genAfter, genBefore + 1, "a complete indexing bumps corpus_match_generation exactly once");
});

test("C/idempotency: re-running the sweep over the already-indexed large representation adds no duplicate shingle rows and no generation bump", async () => {
  process.env.CORPUS_PROMOTION_ENABLED = "true";
  const text = largeDistinctText("c", 30_000);
  const { decisionId } = await seedAcceptedDecision(text);

  const first = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const firstOutcome = first.results.find((r) => r.decisionId === decisionId);
  assert.equal(firstOutcome.outcome, "indexed");
  const rowsAfterFirst = await count("SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?", [firstOutcome.representationId]);
  const genAfterFirst = await getCurrentCorpusMatchGeneration(client);

  const second = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  assert.ok(!second.results.some((r) => r.decisionId === decisionId), "already-indexed promotion is not reclaimed");
  const rowsAfterSecond = await count("SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?", [firstOutcome.representationId]);
  assert.equal(rowsAfterSecond, rowsAfterFirst, "no duplicate shingle rows on a second pass (INSERT OR IGNORE + UNIQUE index)");
  assert.equal(await getCurrentCorpusMatchGeneration(client), genAfterFirst, "no extra generation bump");
});

test("E: a mid-batch failure rolls the whole promotion transaction back — no representation, no shingles, not 'indexed', no generation bump", async () => {
  process.env.CORPUS_PROMOTION_ENABLED = "true";
  const text = largeDistinctText("e", 40_000);
  const shingles = corpusShingleHashes(canonicalizeText(text));
  assert.ok(shingles.size > 2 * CORPUS_SHINGLE_WRITE_BATCH_ROWS, "precondition: at least 3 write batches so the failure is genuinely mid-write");
  const { decisionId, hash } = await seedAcceptedDecision(text);

  const staged = await stageAndClaimCorpusAdmissionPromotionForDecision(openConnection, decisionId);
  assert.ok(staged.staged && staged.claimed);

  const genBefore = await getCurrentCorpusMatchGeneration(client);
  // Fail the 2nd tx.batch() call inside indexPromotionAtomically — after batch 1
  // committed nothing (still in the open tx) but before the write completes.
  const outcome = await processCorpusAdmissionPromotion(client, {
    promotionId: staged.promotionId,
    openConnection: faultyOpenConnection(2),
  });
  assert.equal(outcome.outcome, "failed", "a mid-batch failure surfaces as a retryable 'failed', not an uncaught throw");

  assert.equal(await count("SELECT COUNT(*) AS c FROM corpus_document_representations WHERE canonical_sha256 = ?", [hash]), 0,
    "the representation created inside the rolled-back transaction must not survive");
  assert.equal(await count("SELECT COUNT(*) AS c FROM corpus_document_shingles s JOIN corpus_document_representations r ON r.id = s.representation_id WHERE r.canonical_sha256 = ?", [hash]), 0,
    "no partial shingle set may become matchable");
  const promo = (await client.execute({ sql: "SELECT status, representation_id FROM corpus_admission_promotions WHERE decision_id = ?", args: [decisionId] })).rows[0];
  assert.notEqual(promo.status, "indexed", "promotion must not be marked indexed after a rolled-back attempt");
  assert.equal(promo.representation_id, null);
  assert.equal(await getCurrentCorpusMatchGeneration(client), genBefore, "a rolled-back partial indexing must NOT bump corpus_match_generation");
});

test("F: a clean retry after the fault is removed writes the full shingle set once, marks the promotion indexed, and bumps the generation exactly once", async () => {
  process.env.CORPUS_PROMOTION_ENABLED = "true";
  const text = largeDistinctText("f", 40_000);
  const shingles = corpusShingleHashes(canonicalizeText(text));
  const { decisionId, hash } = await seedAcceptedDecision(text);

  // Attempt 1: injected mid-batch failure.
  const staged = await stageAndClaimCorpusAdmissionPromotionForDecision(openConnection, decisionId);
  const failed = await processCorpusAdmissionPromotion(client, { promotionId: staged.promotionId, openConnection: faultyOpenConnection(2) });
  assert.equal(failed.outcome, "failed");
  const genBefore = await getCurrentCorpusMatchGeneration(client);

  // Attempt 2: no fault — reclaim THIS 'failed' promotion directly (not the
  // broad sweep, which would also pick up other tests' leftover fixtures and
  // make the "exactly once" generation assertion cross-test-fragile).
  const reclaim = await stageAndClaimCorpusAdmissionPromotionForDecision(openConnection, decisionId);
  assert.ok(reclaim.claimed, "a 'failed' row under the attempt cap must be reclaimable");
  const outcome = await processCorpusAdmissionPromotion(client, { promotionId: reclaim.promotionId, openConnection });
  assert.equal(outcome.outcome, "indexed");

  assert.equal(await count("SELECT COUNT(*) AS c FROM corpus_document_representations WHERE canonical_sha256 = ?", [hash]), 1);
  assert.equal(await count("SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?", [outcome.representationId]), shingles.size,
    "the retry writes the complete shingle set exactly once");
  assert.equal(await getCurrentCorpusMatchGeneration(client), genBefore + 1, "the successful retry bumps the generation exactly once");
});

test("G: exact-canonical reuse of a large representation still reuses it (no re-shingling, no duplicate rows) under chunked writes", async () => {
  process.env.CORPUS_PROMOTION_ENABLED = "true";
  const text = largeDistinctText("g", 30_000);
  const first = await seedAcceptedDecision(text);
  const firstSweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const firstOutcome = firstSweep.results.find((r) => r.decisionId === first.decisionId);
  assert.equal(firstOutcome.outcome, "indexed");
  assert.equal(firstOutcome.linkType, "NEW_CONTENT_REPRESENTATION");
  const rowsAfterFirst = await count("SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?", [firstOutcome.representationId]);

  // Second ACCEPT of byte-identical content (first must be revoked to insert a second accepted_representation).
  await client.execute({ sql: "UPDATE corpus_admission_accepted_representations SET revoked_at = CURRENT_TIMESTAMP WHERE decision_id = ?", args: [first.decisionId] });
  const second = await seedAcceptedDecision(text);
  const secondSweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const secondOutcome = secondSweep.results.find((r) => r.decisionId === second.decisionId);
  assert.equal(secondOutcome.outcome, "indexed");
  assert.equal(secondOutcome.representationId, firstOutcome.representationId, "must resolve to the SAME representation");
  assert.equal(secondOutcome.linkType, "EXACT_CANONICAL_DUPLICATE");

  assert.equal(await count("SELECT COUNT(*) AS c FROM corpus_document_representations WHERE canonical_sha256 = ?", [first.hash]), 1);
  assert.equal(await count("SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?", [firstOutcome.representationId]), rowsAfterFirst,
    "EXACT_CANONICAL_DUPLICATE reuse re-runs recordCorpusShingles with INSERT OR IGNORE — no duplicate rows, count unchanged");
});

// A genuinely distinctive ~70-word passage (specific nouns, no generic
// academic register), same style as tests/user-submission-matching-maxdf.test.mjs —
// a verbatim copy of this is an unambiguous distinctive-passage match.
const DISTINCTIVE_PASSAGE = [
  "Excavation of the Late Bronze Age granary at Tel Qashish exposed a sealed storage jar containing carbonized",
  "emmer wheat interleaved with the mandibles of a commensal rodent species not previously attested north of the",
  "Jezreel valley, and residue analysis of the jar interior wall detected a beeswax lining applied in two",
  "distinct coats, a curation technique otherwise known only from contemporaneous sites on the Anatolian plateau.",
].join(" ");

test("matching invariance: a distinctive passage from a large chunked-write representation is still discovered AND verified", async () => {
  process.env.CORPUS_PROMOTION_ENABLED = "true";
  process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
  // Big enough to span several write batches, but under the matcher's own
  // maxCandidateWordCount (20,000) HARD input limit so the verification path
  // actually runs — the point here is shingle-write coverage, not the
  // matcher's unrelated oversized-candidate guard.
  const text = `${largeDistinctText("mi", 10_000)} ${DISTINCTIVE_PASSAGE} ${largeDistinctText("mitail", 3_000)}`;
  const shingles = corpusShingleHashes(canonicalizeText(text));
  assert.ok(shingles.size > CORPUS_SHINGLE_WRITE_BATCH_ROWS, "precondition: the source representation spans more than one write batch");
  const { decisionId } = await seedAcceptedDecision(text);
  const sweep = await runCorpusAdmissionPromotionSweep(client, { openConnection, batchSize: 20 });
  const outcome = sweep.results.find((r) => r.decisionId === decisionId);
  assert.equal(outcome.outcome, "indexed");

  // (1) candidate discovery still finds the large representation via the passage's shingles
  const queryShingles = corpusShingleHashes(canonicalizeText(DISTINCTIVE_PASSAGE));
  const candidates = await findCandidateCorpusRepresentations(client, queryShingles, {
    fingerprintVersion: CORPUS_FINGERPRINT_VERSION, minSharedShingles: 1, limit: 50,
  });
  const discovered = candidates.find((c) => c.representationId === outcome.representationId);
  assert.ok(discovered, "candidate discovery must still find the large representation");
  assert.equal(discovered.sharedShingleCount, queryShingles.size,
    "every shingle of the copied passage must be present in the chunk-written representation");

  // (2) full correspondence still verifies it, with a correct matched-word count
  const match = await matchAgainstUserSubmissionCorpus(client, {
    accountId: null,
    canonicalText: canonicalizeText(`An unrelated introductory sentence about weather and travel plans. ${DISTINCTIVE_PASSAGE} A short unrelated closing remark about lunch.`),
  });
  assert.equal(match.status, "MATCHED", "full correspondence must still verify the copied passage");
  const verified = match.matches.find((m) => m.matchedRepresentationId === outcome.representationId);
  assert.ok(verified, "the verified match must be against the large chunked-write representation");
  assert.ok(verified.matchedWordCount >= 50,
    `matchedWordCount (${verified.matchedWordCount}) must cover the ~70-word copied passage`);
});

test("recordCorpusShingles unit: chunk-boundary sizes all persist the exact informative-shingle count exactly once", async () => {
  for (const wordCount of [1, CORPUS_SHINGLE_WRITE_BATCH_ROWS - 1, CORPUS_SHINGLE_WRITE_BATCH_ROWS + 1, 2 * CORPUS_SHINGLE_WRITE_BATCH_ROWS]) {
    const text = largeDistinctText(`u${wordCount}`, wordCount + 8);
    const rep = await createReusableDocumentRepresentation(client, { canonicalText: canonicalizeText(text) });
    const expected = corpusShingleHashes(rep.canonicalText).size;
    const r1 = await recordCorpusShingles(client, rep.id, rep.canonicalText);
    assert.equal(r1.shingleCount, expected);
    assert.equal(await count("SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?", [rep.id]), expected);
    // second call is a no-op (idempotent)
    await recordCorpusShingles(client, rep.id, rep.canonicalText);
    assert.equal(await count("SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?", [rep.id]), expected, "no duplicate rows on re-run");
  }
});

test("D (direct-index): a mid-chunk failure in indexDocumentSubmissionIntoCorpus self-heals its shingle set on retry, without duplicates", async () => {
  const accountId = "d-direct-index-owner";
  await ensureUser(accountId);
  const rawText = largeDistinctText("dii", 24_000);
  const canonicalText = canonicalizeText(rawText);
  const expected = corpusShingleHashes(canonicalText).size;
  assert.ok(expected > 2 * CORPUS_SHINGLE_WRITE_BATCH_ROWS, `precondition: ${expected} shingles span >2 write batches`);
  const hash = canonicalSha256(rawText);

  const identity = await createDocumentIdentity(client, { accountId, title: "Direct-index large doc", author: null, rawText });
  const genStart = await getCurrentCorpusMatchGeneration(client);

  // (2) inject a failure after batch 2 has committed (3rd client.batch() call
  // inside recordCorpusShingles), on the real-Client path.
  await assert.rejects(
    () => indexDocumentSubmissionIntoCorpus(faultyClientNthBatch(client, 3), { documentIdentityId: identity.id, rawText }),
    /injected failure on client\.batch\(\) call #3/,
  );

  // (3) current behaviour: the representation exists and a PARTIAL shingle set is committed.
  assert.equal(await count("SELECT COUNT(*) AS c FROM corpus_document_representations WHERE canonical_sha256 = ?", [hash]), 1,
    "the representation was created and committed before the shingle write failed");
  const repId = (await client.execute({ sql: "SELECT id FROM corpus_document_representations WHERE canonical_sha256 = ?", args: [hash] })).rows[0].id;
  const partialRows = await count("SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?", [repId]);
  assert.equal(partialRows, 2 * CORPUS_SHINGLE_WRITE_BATCH_ROWS, "exactly the first two committed batches are present");
  assert.ok(partialRows < expected, "the shingle set is genuinely partial after the failure");
  assert.equal(await count("SELECT COUNT(*) AS c FROM corpus_submission_references WHERE document_identity_id = ?", [identity.id]), 0,
    "no submission reference is recorded when the shingle write fails");
  assert.equal(await getCurrentCorpusMatchGeneration(client), genStart, "a failed direct-index attempt does not bump the generation");

  // (4) retry normally.
  const retry = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  assert.equal(retry.status, "INDEXED");
  assert.equal(retry.linkType, "EXACT_CANONICAL_DUPLICATE", "the retry reuses the representation the failed attempt created");
  assert.equal(retry.representationId, repId);

  // (5) full self-heal.
  assert.equal(await count("SELECT COUNT(*) AS c FROM corpus_document_representations WHERE canonical_sha256 = ?", [hash]), 1, "exactly one representation");
  assert.equal(await count("SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?", [repId]), expected,
    "the retry filled the missing batches — the full shingle set is now present");
  assert.equal(await count("SELECT COUNT(*) AS c FROM (SELECT DISTINCT shingle_hash FROM corpus_document_shingles WHERE representation_id = ?)", [repId]), expected,
    "no duplicate shingle rows");
  const ref = (await client.execute({
    sql: "SELECT representation_id, document_identity_id, link_type FROM corpus_submission_references WHERE document_identity_id = ?",
    args: [identity.id],
  })).rows[0];
  assert.equal(ref.representation_id, repId);
  assert.equal(ref.document_identity_id, identity.id);
  assert.equal(ref.link_type, "EXACT_CANONICAL_DUPLICATE");
  assert.equal(await getCurrentCorpusMatchGeneration(client), genStart + 1, "the successful retry bumps the generation exactly once");

  // (6/7) run the operation once more for the SAME identity → short-circuits, row count unchanged.
  const again = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  assert.equal(again.status, "SKIPPED_ALREADY_INDEXED");
  assert.equal(await count("SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?", [repId]), expected, "no change on a SKIPPED_ALREADY_INDEXED replay");
  assert.equal(await getCurrentCorpusMatchGeneration(client), genStart + 1, "no generation bump on a SKIPPED_ALREADY_INDEXED replay");

  // A DIFFERENT identity for the SAME content still runs the reuse re-shingle path —
  // prove that unconditional re-shingle-on-reuse creates no duplicate rows.
  const identity2 = await createDocumentIdentity(client, { accountId, title: "Same content, second identity", author: null, rawText });
  const reuse = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity2.id, rawText });
  assert.equal(reuse.status, "INDEXED");
  assert.equal(reuse.linkType, "EXACT_CANONICAL_DUPLICATE");
  assert.equal(await count("SELECT COUNT(*) AS c FROM corpus_document_shingles WHERE representation_id = ?", [repId]), expected,
    "re-shingling a reused representation adds no rows (INSERT OR IGNORE)");
  assert.equal(await count("SELECT COUNT(*) AS c FROM corpus_document_representations WHERE canonical_sha256 = ?", [hash]), 1, "still exactly one representation");
});
