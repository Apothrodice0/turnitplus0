import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { canonicalSha256 } from "../lib/document-identity.ts";
import {
  corpusShingleHashes,
  createReusableDocumentRepresentation,
  recordCorpusShingles,
  findCandidateCorpusRepresentations,
  findReusableRepresentationByCanonicalHash,
  findAdmissionDedupRepresentationByCanonicalHash,
  findRepresentationOwnersForShingle,
  filterRepresentationIdsByEligibility,
  CORPUS_FINGERPRINT_VERSION,
} from "../lib/user-submission-corpus.ts";
import {
  evaluateCorpusAdmissionCandidate,
  recoverPrunedAdmissionFamily,
  selectAdmissionRecoveryProbeHashes,
  ADMISSION_DEDUP_MAX_SHINGLE_DOCUMENT_FREQUENCY,
  ADMISSION_DEDUP_MIN_DISCRIMINATIVE_SHINGLES,
  ADMISSION_RECOVERY_SELECTED_HASHES,
  ADMISSION_RECOVERY_OWNER_SCAN_CAP,
  ADMISSION_RECOVERY_OWNER_MAX_PAGES,
  ADMISSION_RECOVERY_ELIGIBLE_OWNER_CAP_PER_HASH,
  ADMISSION_RECOVERY_MIN_HASH_AGREEMENT,
  ADMISSION_RECOVERY_CANDIDATE_CAP,
  ADMISSION_RECOVERY_MIN_RUN,
} from "../lib/corpus-admission-gate.ts";
import { DEFAULT_CORPUS_FAMILY_THRESHOLDS } from "../lib/corpus-admission-family.ts";

/**
 * Slice 2H — bounded admission-family maxDF recovery.
 *
 * computeEvaluationCore now applies matching's own query-time maxDF pruning to
 * its ADMISSION_DEDUP family/redundancy discovery (a discovery-COST
 * optimisation at corpus scale). This suite proves the four correctness
 * guards that keep that safe for a large legitimate cohort whose shared
 * passage pruning would otherwise drop:
 *
 *   STEP A  an ELIGIBLE exact canonical-hash guard (revoked-only dups ignored)
 *   STEP C  full UNPRUNED re-verification of every primary candidate
 *   STEP D  bounded, corpus-size-independent recovery of a dropped cohort base
 *           (<= 8 hashes x 4 pages x 256 raw rows = <= 8,192 posting rows)
 *   #2      resolveCorpusArticleFamily over primary + recovery-verified evidence
 *
 * Every fixture is synthetic. No family threshold, minSharedShingles, maturity
 * rule, SELF / historical scoring behaviour or schema is touched.
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_family_recovery.db");
for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const dbUrl = `file:${dbFile}`;
const client = createClient({ url: dbUrl });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

// --- corpus reset between tests -------------------------------------------

async function resetCorpus() {
  await client.execute("PRAGMA foreign_keys = ON");
  for (const sql of [
    "DELETE FROM corpus_admission_promotions",
    "DELETE FROM corpus_admission_accepted_shingles",
    "DELETE FROM corpus_admission_accepted_representations",
    "DELETE FROM corpus_admission_content_store",
    "DELETE FROM corpus_admission_decisions",
    "DELETE FROM corpus_document_shingles",
    "DELETE FROM corpus_submission_references",
    "DELETE FROM corpus_document_representations",
    "DELETE FROM document_identities",
  ]) {
    await client.execute(sql);
  }
}

// --- quality-passing English article generator (mirrors tests/corpus-admission-gate.test.mjs) ---

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
  return () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 0xffffffff; };
}
function plausibleArticleText(seed, targetWords = 3300) {
  const rng = seededRandom(seed);
  const paragraphs = [];
  let wordCount = 0;
  while (wordCount < targetWords) {
    const sentences = Array.from({ length: 5 + Math.floor(rng() * 4) }, () => {
      const length = 10 + Math.floor(rng() * 18);
      return `The ${Array.from({ length }, () => WORD_BANK[Math.floor(rng() * WORD_BANK.length)]).join(" ")}.`;
    });
    paragraphs.push(sentences.join(" "));
    wordCount += paragraphs[paragraphs.length - 1].split(/\s+/).length;
  }
  return paragraphs.join("\n\n");
}

// Non-English synthetic tokens — for DIRECT recoverPrunedAdmissionFamily /
// selectAdmissionRecoveryProbeHashes tests that never pass through the
// language / word-count hard gate. Every 5-gram is a fully informative,
// globally distinctive run of >= 5-char non-common words.
function synthTokens(prefix, n) {
  return Array.from({ length: n }, (_, i) => `${prefix}token${i.toString(36)}`);
}
function synthText(prefix, n) {
  return synthTokens(prefix, n).join(" ");
}

const RESOLVED_PROVENANCE = (sourceUrl) => ({
  kind: "BULK_IMPORT_PROVENANCE",
  provenance: { sourceUrl, acquisitionMethod: "BULK_IMPORT_DOWNLOAD", licenseOrPermission: "CC-BY-4.0", retentionBasis: "LICENSED_REUSE", retentionRightsResolved: true, notes: null },
});
function evaluateDryRun(sourceRef, bytes) {
  return evaluateCorpusAdmissionCandidate(client, {
    sourceRef,
    filename: `${sourceRef}.txt`,
    bytes,
    consent: RESOLVED_PROVENANCE(`https://example.test/${sourceRef}`),
    dryRun: true,
  });
}

// --- raw seeders --------------------------------------------------------

let repRowId = 0;

/** Raw-insert one corpus_document_representations row (optionally with a pinned id) + its shingle rows. */
async function seedRepresentationRaw({ id, canonicalText, wordCount, shingleHashes, canonicalSha256: pinnedHash }) {
  const repId = id ?? randomUUID();
  const hash = pinnedHash ?? `raw-${repId}`;
  await client.execute({
    sql: `INSERT INTO corpus_document_representations
          (id, canonical_sha256, canonical_text, word_count, language, canonicalization_version, extractor_version, first_seen_at, created_at)
          VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [repId, hash, canonicalText ?? `placeholder ${repId}`, wordCount, "English", "canonical-text-v1", null],
  });
  if (shingleHashes && shingleHashes.length > 0) await insertShingleRows(repId, shingleHashes);
  return repId;
}

async function insertShingleRows(repId, hashes) {
  const all = [...hashes];
  const PER = 1000;
  const statements = [];
  for (let i = 0; i < all.length; i += PER) {
    const slice = all.slice(i, i + PER);
    statements.push({
      sql: `INSERT OR IGNORE INTO corpus_document_shingles (representation_id, shingle_hash, fingerprint_version, created_at)
            VALUES ${slice.map(() => "(?,?,?,CURRENT_TIMESTAMP)").join(",")}`,
      args: slice.flatMap((h) => [repId, h, CORPUS_FINGERPRINT_VERSION]),
    });
  }
  for (let i = 0; i < statements.length; i += 80) await client.batch(statements.slice(i, i + 80), "write");
}

/** `count` distinct fake cohort reps, each carrying exactly `sharedHashes` (so those hashes reach DF > count). ADMISSION_DEDUP-eligible via arm 3 (no promotion rows). */
async function seedFakeCohort(count, sharedHashes) {
  const ids = [];
  const repStmts = [];
  for (let i = 0; i < count; i += 1) {
    const id = randomUUID();
    ids.push(id);
    repStmts.push({
      sql: `INSERT INTO corpus_document_representations
            (id, canonical_sha256, canonical_text, word_count, language, canonicalization_version, extractor_version, first_seen_at, created_at)
            VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      args: [id, `fakecohort-${id}`, `placeholder cohort body ${id}`, 3200, "English", "canonical-text-v1", null],
    });
  }
  for (let i = 0; i < repStmts.length; i += 100) await client.batch(repStmts.slice(i, i + 100), "write");

  const all = [...sharedHashes];
  const shingleStmts = [];
  for (const id of ids) {
    for (let i = 0; i < all.length; i += 1000) {
      const slice = all.slice(i, i + 1000);
      shingleStmts.push({
        sql: `INSERT OR IGNORE INTO corpus_document_shingles (representation_id, shingle_hash, fingerprint_version, created_at)
              VALUES ${slice.map(() => "(?,?,?,CURRENT_TIMESTAMP)").join(",")}`,
        args: slice.flatMap((h) => [id, h, CORPUS_FINGERPRINT_VERSION]),
      });
    }
  }
  for (let i = 0; i < shingleStmts.length; i += 60) await client.batch(shingleStmts.slice(i, i + 60), "write");
  return ids;
}

/** A representation whose ONLY backing is a revoked NEW_CONTENT_REPRESENTATION promotion — ineligible under every ADMISSION_DEDUP arm. */
async function seedRevokedOnlyRepresentation(canonicalText) {
  const canonical = canonicalizeText(canonicalText);
  const rep = await createReusableDocumentRepresentation(client, { canonicalText: canonical });
  await recordCorpusShingles(client, rep.id, canonical);
  const decisionId = randomUUID();
  const acceptedId = randomUUID();
  const sha = `revoked-${decisionId}`;
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,CURRENT_TIMESTAMP)`,
    args: [
      decisionId, null, `report-upload:account=revoked-acct:device=d:report=r`, "v1", "ACCEPT", "[]", 1, "[]",
      "txt", 3200, "English", 0.95, sha, "v1", null, 80, "v1", "{}", "{}", "v1", 0.9, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [acceptedId, decisionId, sha, 3200, "v1"],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_promotions (id, decision_id, accepted_representation_id, representation_id, link_type, fingerprint_version, status, attempt_count, created_at, updated_at)
          VALUES (?,?,?,?,?,?,'indexed',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    args: [randomUUID(), decisionId, acceptedId, rep.id, "NEW_CONTENT_REPRESENTATION", CORPUS_FINGERPRINT_VERSION],
  });
  return rep;
}

/** An eligible real corpus representation (via a real submission reference — ADMISSION_DEDUP arm 1). */
async function seedEligibleRealRepresentation(rawText, accountId = "recovery-owner") {
  const canonical = canonicalizeText(rawText);
  const rep = await createReusableDocumentRepresentation(client, { canonicalText: canonical });
  await recordCorpusShingles(client, rep.id, canonical);
  await client.execute({ sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)", args: [accountId, `${accountId}@example.test`, accountId, "x"] });
  const identityId = randomUUID();
  await client.execute({
    sql: "INSERT INTO document_identities (id, account_id, title, author, raw_sha256, canonical_sha256, created_at) VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)",
    args: [identityId, accountId, "seed", null, `raw-${identityId}`, canonicalSha256(rawText)],
  });
  await client.execute({
    sql: "INSERT INTO corpus_submission_references (representation_id, document_identity_id, link_type, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)",
    args: [rep.id, identityId, "NEW_CONTENT_REPRESENTATION"],
  });
  return rep;
}

const LENGTH_FLOOR = DEFAULT_CORPUS_FAMILY_THRESHOLDS.lengthCompatibilityFloor.value; // 0.7
const CONTAINMENT_FLOOR = DEFAULT_CORPUS_FAMILY_THRESHOLDS.editedVersionContainmentFloor.value; // 0.85

// ==========================================================================
// 1. Eligible exact canonical duplicate -> resolved by STEP A, recovery not needed.
// ==========================================================================

test("1: an ELIGIBLE exact canonical duplicate is REJECTed as EXACT_DUPLICATE via the STEP A guard", async () => {
  await resetCorpus();
  const text = plausibleArticleText(2001, 3300);
  await seedEligibleRealRepresentation(text);

  // STEP A guard resolves it directly.
  const guarded = await findAdmissionDedupRepresentationByCanonicalHash(client, canonicalSha256(text));
  assert.ok(guarded, "the eligible exact canonical duplicate is visible to the STEP A guard");

  const decision = await evaluateDryRun("recovery-exact-eligible", Buffer.from(text, "utf8"));
  assert.equal(decision.decision, "REJECT");
  assert.equal(decision.familyRelation, "EXACT_DUPLICATE");
  assert.ok(decision.reasonCodes.includes("DUPLICATE_ALREADY_REPRESENTED"), decision.reasonCodes.join(","));
});

// ==========================================================================
// 2. Revoked-only canonical duplicate -> STEP A guard ignores it, re-admission not blocked.
// ==========================================================================

test("2: a REVOKED-ONLY canonical duplicate is ignored by the exact-hash guard — re-admission is not incorrectly blocked", async () => {
  await resetCorpus();
  const text = plausibleArticleText(2002, 3300);
  const revoked = await seedRevokedOnlyRepresentation(text);

  // bare hash lookup DOES see it; the eligibility-aware guard MUST NOT.
  assert.ok(await findReusableRepresentationByCanonicalHash(client, canonicalSha256(text)), "bare hash lookup still returns the revoked-only representation");
  assert.equal(
    await findAdmissionDedupRepresentationByCanonicalHash(client, canonicalSha256(text)),
    null,
    "the STEP A guard must ignore a representation whose only backing is a revoked promotion",
  );
  assert.equal(revoked.canonicalSha256, canonicalSha256(text));

  const decision = await evaluateDryRun("recovery-exact-revoked", Buffer.from(text, "utf8"));
  assert.notEqual(decision.familyRelation, "EXACT_DUPLICATE", "a revoked-only duplicate must not resolve EXACT_DUPLICATE");
  assert.ok(!decision.reasonCodes.includes("DUPLICATE_ALREADY_REPRESENTED"), decision.reasonCodes.join(","));
});

// ==========================================================================
// 3. Large cohort, base absent from the primary maxDF candidate set ->
//    recovery restores EDITED_VERSION / REJECT (end-to-end).
// ==========================================================================

test("3: a genuine edited re-upload of an article already present in a >50-strong cohort is recovered as EDITED_VERSION even though pruning drops its base from primary discovery", async () => {
  await resetCorpus();
  const shared = plausibleArticleText(2003, 3100);
  const sharedHashes = [...corpusShingleHashes(canonicalizeText(shared))];
  assert.ok(sharedHashes.length > ADMISSION_RECOVERY_MIN_RUN * 4, `shared body must yield a long pruned run (${sharedHashes.length})`);

  // The base is the shared article verbatim — so EVERY one of its shingles is
  // a cohort shingle at DF 56, and pruning removes all of them from primary
  // discovery. (The cohort's unique per-member tails live only in the fake
  // rows, which never need real text.)
  const baseCanonical = canonicalizeText(shared);
  const baseId = "00000000-0000-4000-8000-000000000001";
  await seedRepresentationRaw({
    id: baseId,
    canonicalText: baseCanonical,
    wordCount: baseCanonical.split(/\s+/).length,
    canonicalSha256: canonicalSha256(shared),
    shingleHashes: [...corpusShingleHashes(baseCanonical)],
  });
  await seedFakeCohort(55, sharedHashes); // shared body now at DF 56 (> 50)

  const candidateText = `${shared}\n\n${plausibleArticleText(2023, 420)}`;

  // Precondition: primary maxDF discovery does NOT surface the base — its
  // shared shingles are all pruned and it has no distinctive overlap.
  const ownShingleHashes = corpusShingleHashes(canonicalizeText(candidateText));
  const diag = { inputShingleCount: 0, survivingShingleCount: 0, highDfPrunedCount: 0, fallbackUsed: false, appliedMaxDocumentFrequency: null, prunedShingleHashes: [] };
  const realCandidates = await findCandidateCorpusRepresentations(client, ownShingleHashes, {
    eligibilityMode: "ADMISSION_DEDUP",
    maxDocumentFrequency: ADMISSION_DEDUP_MAX_SHINGLE_DOCUMENT_FREQUENCY,
    minDiscriminativeShingles: ADMISSION_DEDUP_MIN_DISCRIMINATIVE_SHINGLES,
    diagnostics: diag,
  });
  assert.ok(!diag.fallbackUsed, "enough distinctive edit shingles survive — no low-information fallback");
  assert.ok(diag.highDfPrunedCount > 0, "the cohort's shared body is pruned from primary discovery");
  assert.ok(!realCandidates.some((c) => c.representationId === baseId), "the base is ABSENT from the primary maxDF candidate set");

  const decision = await evaluateDryRun("recovery-cohort-edited", Buffer.from(candidateText, "utf8"));
  assert.equal(decision.decision, "REJECT");
  assert.equal(decision.familyRelation, "EDITED_VERSION", `recovery must restore EDITED_VERSION (got ${decision.familyRelation}, ${decision.reasonCodes.join(",")})`);
  assert.ok(decision.reasonCodes.includes("EDITED_VERSION_ALREADY_REPRESENTED"), decision.reasonCodes.join(","));
});

// ==========================================================================
// 4. Cohort > 220 / large-DF -> no DF hard-cap cliff (direct, practical size).
// ==========================================================================

test("4: recovery still resolves EDITED_VERSION for a cohort of 230, and the bounded owner scan does not grow with the cohort size (no DF hard-cap cliff)", async () => {
  await resetCorpus();
  const shared = synthText("cohort4shared", 900);
  const sharedHashes = [...corpusShingleHashes(shared)];
  const baseId = "00000000-0000-4000-8000-00000000000a";
  const baseText = `${shared} ${synthText("cohort4basetail", 90)}`;
  await seedRepresentationRaw({
    id: baseId,
    canonicalText: baseText,
    wordCount: baseText.split(/\s+/).length,
    canonicalSha256: `base4-${randomUUID()}`,
    shingleHashes: [...corpusShingleHashes(baseText)],
  });
  await seedFakeCohort(230, sharedHashes); // shared body at DF 231

  const candidateText = `${shared} ${synthText("cohort4edit", 90)}`;
  const ownShingleHashes = corpusShingleHashes(candidateText);
  const ordered = [...ownShingleHashes];
  const sharedSet = new Set(sharedHashes);
  const prunedHashes = ordered.filter((h) => sharedSet.has(h));

  const result = await recoverPrunedAdmissionFamily({
    client,
    target: { canonicalSha256: canonicalSha256(candidateText), wordCount: candidateText.split(/\s+/).length },
    ownShingleHashes,
    orderedQueryHashes: ordered,
    prunedHashes,
    alreadyResolvedRepresentationIds: new Set(),
    priorFamilyCandidates: [],
  });

  assert.equal(result.family.relation, "EDITED_VERSION", "a 230-strong cohort is still recovered — DF 231 is not a cliff");
  assert.equal(result.family.matchedSourceRef, baseId);
  assert.ok(
    result.accounting.rawOwnerRowsExamined <= ADMISSION_RECOVERY_SELECTED_HASHES * ADMISSION_RECOVERY_OWNER_MAX_PAGES * ADMISSION_RECOVERY_OWNER_SCAN_CAP,
    `raw rows examined (${result.accounting.rawOwnerRowsExamined}) must stay within the proven hard bound`,
  );
  assert.ok(result.accounting.ownerPagesFetched <= ADMISSION_RECOVERY_SELECTED_HASHES * ADMISSION_RECOVERY_OWNER_MAX_PAGES);
});

// ==========================================================================
// 5. Genuine NONE with high-DF boilerplate -> stays NONE; full-text verify rejects false candidates.
// ==========================================================================

test("5: a distinctive submission that merely shares a high-DF boilerplate block with 55 documents stays familyRelation NONE — recovery triggers but full-text verification rejects every false candidate", async () => {
  await resetCorpus();
  const boiler = plausibleArticleText(2005, 260);
  const boilerHashes = [...corpusShingleHashes(canonicalizeText(boiler))];
  await seedFakeCohort(55, boilerHashes);

  const candidateText = `${boiler}\n\n${plausibleArticleText(2015, 3200)}`;
  const ownShingleHashes = corpusShingleHashes(canonicalizeText(candidateText));
  const diag = { inputShingleCount: 0, survivingShingleCount: 0, highDfPrunedCount: 0, fallbackUsed: false, appliedMaxDocumentFrequency: null, prunedShingleHashes: [] };
  await findCandidateCorpusRepresentations(client, ownShingleHashes, {
    eligibilityMode: "ADMISSION_DEDUP",
    maxDocumentFrequency: ADMISSION_DEDUP_MAX_SHINGLE_DOCUMENT_FREQUENCY,
    minDiscriminativeShingles: ADMISSION_DEDUP_MIN_DISCRIMINATIVE_SHINGLES,
    diagnostics: diag,
  });
  assert.ok(diag.highDfPrunedCount > 0, "the shared boilerplate block is pruned (recovery is eligible to trigger)");

  const decision = await evaluateDryRun("recovery-genuine-none", Buffer.from(candidateText, "utf8"));
  assert.equal(decision.familyRelation, "NONE", "a distinctive article that only shares boilerplate must not become a family match");
  assert.ok(!decision.reasonCodes.includes("EDITED_VERSION_ALREADY_REPRESENTED"), decision.reasonCodes.join(","));
  assert.ok(!decision.reasonCodes.includes("DUPLICATE_ALREADY_REPRESENTED"), decision.reasonCodes.join(","));
});

// ==========================================================================
// 6. Longest-runs round-robin selection -> the cohort core survives selection
//    even against a longer competing boilerplate/methods run (not highest-DF).
// ==========================================================================

test("6: selectAdmissionRecoveryProbeHashes picks round-robin across the longest runs — the cohort run is represented even when a 3x-longer boilerplate run competes", () => {
  const cohortRun = synthTokens("cohortcore", 40);
  const methodsRun = synthTokens("methods", 90);
  const boilerplateRun = synthTokens("boilerplate", 240);
  const survivorA = "aaaaaaaaaaaaaaaa";
  const survivorB = "bbbbbbbbbbbbbbbb";

  const ordered = [...cohortRun, survivorA, ...boilerplateRun, survivorB, ...methodsRun];
  const pruned = [...cohortRun, ...boilerplateRun, ...methodsRun];

  const selected = selectAdmissionRecoveryProbeHashes(ordered, pruned);
  assert.equal(selected.length, ADMISSION_RECOVERY_SELECTED_HASHES);
  assert.ok(selected.includes(cohortRun[0]), "the shortest (cohort core) run is still represented via round-robin");
  assert.ok(selected.includes(boilerplateRun[0]) && selected.includes(methodsRun[0]), "the longer runs are represented too");
  // Not a highest-DF / longest-run-only strategy: round 0 takes one hash from
  // each of the three runs before any run gets a second slot.
  assert.deepEqual(selected.slice(0, 3), [boilerplateRun[0], methodsRun[0], cohortRun[0]], "round 0 is one-per-run, ranked by run length");

  // runs shorter than ADMISSION_RECOVERY_MIN_RUN are ignored entirely.
  const tinyRun = synthTokens("tiny", ADMISSION_RECOVERY_MIN_RUN - 1);
  assert.deepEqual(selectAdmissionRecoveryProbeHashes([...tinyRun], [...tinyRun]), [], "a run below the minimum length yields no probe hashes");
});

// ==========================================================================
// 7. Owner paging hard bound -> a very-high-DF posting list never increases work.
// ==========================================================================

test("7: the bounded owner scan never exceeds selectedHashes x maxPages x pageSize raw rows, and a 4x-larger posting list does not increase the work", async () => {
  await resetCorpus();
  await client.execute("PRAGMA foreign_keys = OFF");
  try {
    // 8 hashes forming one pruned run; each owned by a huge posting list of
    // ineligible (non-existent) representations, so every scan runs the full
    // 4-page budget and gathers 0 eligible owners.
    const runHashes = synthTokens("hardbound", 12);
    const ordered = [...runHashes, ...synthTokens("hardboundsurvivor", 30)];

    const seedPostingList = async (rowsPerHash) => {
      await resetCorpus();
      await client.execute("PRAGMA foreign_keys = OFF");
      const stmts = [];
      for (const h of runHashes) {
        for (let i = 0; i < rowsPerHash; i += 1000) {
          const count = Math.min(1000, rowsPerHash - i);
          stmts.push({
            sql: `INSERT OR IGNORE INTO corpus_document_shingles (representation_id, shingle_hash, fingerprint_version, created_at)
                  VALUES ${Array.from({ length: count }, () => "(?,?,?,CURRENT_TIMESTAMP)").join(",")}`,
            args: Array.from({ length: count }, (_, k) => [`ghost-${h}-${i + k}`, h, CORPUS_FINGERPRINT_VERSION]).flat(),
          });
        }
      }
      for (let i = 0; i < stmts.length; i += 60) await client.batch(stmts.slice(i, i + 60), "write");
    };

    const runRecovery = () => recoverPrunedAdmissionFamily({
      client,
      target: { canonicalSha256: `t-${randomUUID()}`, wordCount: 500 },
      ownShingleHashes: new Set(ordered),
      orderedQueryHashes: ordered,
      prunedHashes: runHashes,
      alreadyResolvedRepresentationIds: new Set(),
      priorFamilyCandidates: [],
    });

    await seedPostingList(1500); // > 4 pages worth per hash
    const small = await runRecovery();
    await seedPostingList(6000); // 4x larger posting list
    const large = await runRecovery();

    const HARD_BOUND = ADMISSION_RECOVERY_SELECTED_HASHES * ADMISSION_RECOVERY_OWNER_MAX_PAGES * ADMISSION_RECOVERY_OWNER_SCAN_CAP;
    assert.ok(small.accounting.rawOwnerRowsExamined <= HARD_BOUND, `small: ${small.accounting.rawOwnerRowsExamined} <= ${HARD_BOUND}`);
    assert.ok(large.accounting.rawOwnerRowsExamined <= HARD_BOUND, `large: ${large.accounting.rawOwnerRowsExamined} <= ${HARD_BOUND}`);
    assert.equal(large.accounting.rawOwnerRowsExamined, small.accounting.rawOwnerRowsExamined, "a 4x-larger posting list examines the exact same bounded number of rows");
    assert.equal(large.accounting.ownerPagesFetched, small.accounting.ownerPagesFetched);
    assert.ok(small.accounting.ownerPagesFetched <= ADMISSION_RECOVERY_SELECTED_HASHES * ADMISSION_RECOVERY_OWNER_MAX_PAGES);
    assert.equal(small.family.relation, "NONE", "no eligible owner -> no candidate -> NONE");
  } finally {
    await client.execute("PRAGMA foreign_keys = ON");
  }
});

// ==========================================================================
// 8. Hash agreement -> below-threshold candidates excluded; candidate cap <= 24.
// ==========================================================================

test("8: a representation owning fewer than ADMISSION_RECOVERY_MIN_HASH_AGREEMENT probed hashes is excluded, and the recovery candidate set is capped at 24", async () => {
  await resetCorpus();
  const runHashes = synthTokens("agree", 12);
  const ordered = [...runHashes, ...synthTokens("agreesurvivor", 30)];
  const ownShingleHashes = new Set(ordered);

  // "weak": owns only 2 probed hashes -> below the agreement floor.
  const weakId = await seedRepresentationRaw({
    canonicalText: synthText("agreeweak", 400),
    wordCount: 400,
    canonicalSha256: `weak-${randomUUID()}`,
    shingleHashes: runHashes.slice(0, 2),
  });
  // 30 "strong" reps: each owns >= 3 probed hashes but none is a genuine
  // family match (disjoint bodies) -> all verified, none resolves, cap applies.
  const strongIds = [];
  for (let i = 0; i < 30; i += 1) {
    strongIds.push(await seedRepresentationRaw({
      canonicalText: synthText(`agreestrong${i}`, 400),
      wordCount: 400,
      canonicalSha256: `strong-${i}-${randomUUID()}`,
      shingleHashes: runHashes.slice(0, 8),
    }));
  }

  const result = await recoverPrunedAdmissionFamily({
    client,
    target: { canonicalSha256: `t-${randomUUID()}`, wordCount: 500 },
    ownShingleHashes,
    orderedQueryHashes: ordered,
    prunedHashes: runHashes,
    alreadyResolvedRepresentationIds: new Set(),
    priorFamilyCandidates: [],
  });

  assert.equal(result.family.relation, "NONE", "no strong rep is a genuine family match");
  assert.equal(result.accounting.agreementCandidateCount, ADMISSION_RECOVERY_CANDIDATE_CAP, "30 qualifying reps -> capped at 24");
  assert.equal(result.accounting.fullTextVerifications, ADMISSION_RECOVERY_CANDIDATE_CAP, "exactly the capped set is full-text verified");
  assert.ok(!result.verifiedCandidates.some((c) => c.sourceRef === weakId), "the below-agreement representation is never a recovery candidate");
});

// ==========================================================================
// 9. Early exit -> a real cohort resolves after the FIRST valid recovery candidate.
// ==========================================================================

test("9: recovery stops after a single full-text re-verification once the deterministically-first candidate resolves the family", async () => {
  await resetCorpus();
  const shared = synthText("early9shared", 900);
  const sharedHashes = [...corpusShingleHashes(shared)];
  const baseId = "00000000-0000-4000-8000-000000000009";
  const baseText = `${shared} ${synthText("early9basetail", 90)}`;
  await seedRepresentationRaw({
    id: baseId,
    canonicalText: baseText,
    wordCount: baseText.split(/\s+/).length,
    canonicalSha256: `base9-${randomUUID()}`,
    shingleHashes: [...corpusShingleHashes(baseText)],
  });
  await seedFakeCohort(60, sharedHashes);

  const candidateText = `${shared} ${synthText("early9edit", 90)}`;
  const ownShingleHashes = corpusShingleHashes(candidateText);
  const ordered = [...ownShingleHashes];
  const sharedSet = new Set(sharedHashes);

  const result = await recoverPrunedAdmissionFamily({
    client,
    target: { canonicalSha256: canonicalSha256(candidateText), wordCount: candidateText.split(/\s+/).length },
    ownShingleHashes,
    orderedQueryHashes: ordered,
    prunedHashes: ordered.filter((h) => sharedSet.has(h)),
    alreadyResolvedRepresentationIds: new Set(),
    priorFamilyCandidates: [],
  });

  assert.equal(result.family.relation, "EDITED_VERSION");
  assert.equal(result.family.matchedSourceRef, baseId, "the pinned-low-id base sorts first and resolves the family");
  assert.equal(result.accounting.fullTextVerifications, 1, "a real cohort needs exactly one full-text re-verification (early exit)");
});

// ==========================================================================
// 10. Component C alone -> a primary candidate whose PRUNED containment is
//     below the family floor but whose FULL containment is above 0.85 resolves
//     EDITED_VERSION after the STEP C full-text re-verify.
// ==========================================================================

test("10: STEP C alone — a discovered candidate with pruned containment < 0.85 but full containment > 0.85 resolves EDITED_VERSION (no recovery involved)", async () => {
  await resetCorpus();
  // A shared body carried by 55 reps (pruned), PLUS a distinctive tail that
  // base and candidate share (survives pruning -> base IS discovered), but
  // whose share of the pruned candidate shingle set is small.
  const shared = plausibleArticleText(2010, 3000);
  const sharedHashes = [...corpusShingleHashes(canonicalizeText(shared))];
  const commonTail = plausibleArticleText(2020, 260);

  const baseText = `${shared}\n\n${commonTail}`;
  const baseCanonical = canonicalizeText(baseText);
  const baseId = "00000000-0000-4000-8000-0000000000c0";
  await seedRepresentationRaw({
    id: baseId,
    canonicalText: baseCanonical,
    wordCount: baseCanonical.split(/\s+/).length,
    canonicalSha256: canonicalSha256(baseText),
    shingleHashes: [...corpusShingleHashes(baseCanonical)],
  });
  await seedFakeCohort(55, sharedHashes);

  const candidateText = `${shared}\n\n${commonTail}\n\n${plausibleArticleText(2030, 120)}`;
  const ownShingleHashes = corpusShingleHashes(canonicalizeText(candidateText));

  const diag = { inputShingleCount: 0, survivingShingleCount: 0, highDfPrunedCount: 0, fallbackUsed: false, appliedMaxDocumentFrequency: null, prunedShingleHashes: [] };
  const realCandidates = await findCandidateCorpusRepresentations(client, ownShingleHashes, {
    eligibilityMode: "ADMISSION_DEDUP",
    maxDocumentFrequency: ADMISSION_DEDUP_MAX_SHINGLE_DOCUMENT_FREQUENCY,
    minDiscriminativeShingles: ADMISSION_DEDUP_MIN_DISCRIMINATIVE_SHINGLES,
    diagnostics: diag,
  });
  const discovered = realCandidates.find((c) => c.representationId === baseId);
  assert.ok(discovered, "base IS discovered by primary maxDF discovery (via the surviving common tail)");
  assert.ok(discovered.containment < CONTAINMENT_FLOOR, `pruned discovery containment (${discovered.containment.toFixed(3)}) is below the family floor`);

  const decision = await evaluateDryRun("recovery-stepc-only", Buffer.from(candidateText, "utf8"));
  assert.equal(decision.familyRelation, "EDITED_VERSION", "STEP C's full-text re-verify lifts it back over the family floor");
  assert.equal(decision.decision, "REJECT");
});

// ==========================================================================
// 11. Maturity invariant -> an immature representation stays visible under ADMISSION_DEDUP.
// ==========================================================================

test("11: recovery and the exact-hash guard both see IMMATURE representations (ADMISSION_DEDUP emits no maturity term)", async () => {
  await resetCorpus();
  const text = plausibleArticleText(2011, 3300);
  // seeded moments ago -> maximally immature.
  await seedEligibleRealRepresentation(text);

  assert.ok(await findAdmissionDedupRepresentationByCanonicalHash(client, canonicalSha256(text)), "the exact-hash guard sees a just-seeded (immature) representation");
  const decision = await evaluateDryRun("recovery-immature-exact", Buffer.from(text, "utf8"));
  assert.equal(decision.familyRelation, "EXACT_DUPLICATE", "an immature representation must still block a byte-identical re-admission");

  // recovery path: an immature cohort is still recoverable.
  await resetCorpus();
  const shared = synthText("imm11shared", 900);
  const sharedHashes = [...corpusShingleHashes(shared)];
  const baseId = "00000000-0000-4000-8000-0000000000b1";
  const baseText = `${shared} ${synthText("imm11tail", 90)}`;
  await seedRepresentationRaw({
    id: baseId, canonicalText: baseText, wordCount: baseText.split(/\s+/).length,
    canonicalSha256: `imm11-${randomUUID()}`, shingleHashes: [...corpusShingleHashes(baseText)],
  });
  await seedFakeCohort(55, sharedHashes); // all first_seen_at = now (immature)

  const candidateText = `${shared} ${synthText("imm11edit", 90)}`;
  const ownShingleHashes = corpusShingleHashes(candidateText);
  const ordered = [...ownShingleHashes];
  const sharedSet = new Set(sharedHashes);
  const eligible = await filterRepresentationIdsByEligibility(client, [baseId]);
  assert.deepEqual(eligible, [baseId], "an immature representation is ADMISSION_DEDUP-eligible for recovery");

  const result = await recoverPrunedAdmissionFamily({
    client,
    target: { canonicalSha256: canonicalSha256(candidateText), wordCount: candidateText.split(/\s+/).length },
    ownShingleHashes,
    orderedQueryHashes: ordered,
    prunedHashes: ordered.filter((h) => sharedSet.has(h)),
    alreadyResolvedRepresentationIds: new Set(),
    priorFamilyCandidates: [],
  });
  assert.equal(result.family.relation, "EDITED_VERSION", "an immature cohort is still recovered");
});

// ==========================================================================
// 12. Threshold guard -> family thresholds / minSharedShingles unchanged.
// ==========================================================================

test("12: Slice 2H changed no family threshold, no minSharedShingles default, and froze its own recovery constants", () => {
  assert.equal(DEFAULT_CORPUS_FAMILY_THRESHOLDS.editedVersionContainmentFloor.value, 0.85);
  assert.equal(DEFAULT_CORPUS_FAMILY_THRESHOLDS.lengthCompatibilityFloor.value, 0.7);

  assert.equal(ADMISSION_DEDUP_MAX_SHINGLE_DOCUMENT_FREQUENCY, 50);
  assert.equal(ADMISSION_DEDUP_MIN_DISCRIMINATIVE_SHINGLES, 24);
  assert.equal(ADMISSION_RECOVERY_SELECTED_HASHES, 8);
  assert.equal(ADMISSION_RECOVERY_OWNER_SCAN_CAP, 256);
  assert.equal(ADMISSION_RECOVERY_OWNER_MAX_PAGES, 4);
  assert.equal(ADMISSION_RECOVERY_ELIGIBLE_OWNER_CAP_PER_HASH, 64);
  assert.equal(ADMISSION_RECOVERY_MIN_HASH_AGREEMENT, 3);
  assert.equal(ADMISSION_RECOVERY_CANDIDATE_CAP, 24);
  assert.equal(ADMISSION_RECOVERY_MIN_RUN, 6);

  // minSharedShingles is still defaulted to 1 by findCandidateCorpusRepresentations,
  // and the gate never overrides it.
  const corpusSrc = fs.readFileSync(path.join(repoRoot, "lib/user-submission-corpus.ts"), "utf8");
  assert.ok(/const minSharedShingles = options\.minSharedShingles \?\? 1;/.test(corpusSrc), "findCandidateCorpusRepresentations still defaults minSharedShingles to 1");
  const gateSrc = fs.readFileSync(path.join(repoRoot, "lib/corpus-admission-gate.ts"), "utf8");
  assert.ok(!/minSharedShingles/.test(gateSrc), "the admission gate must not set minSharedShingles");
});

// ==========================================================================
// Hard bound arithmetic — the worst-case posting-row budget.
// ==========================================================================

test("hard bound: 8 selected hashes x 4 pages x 256 raw rows = 8,192 posting rows is the proven ceiling", () => {
  assert.equal(ADMISSION_RECOVERY_SELECTED_HASHES * ADMISSION_RECOVERY_OWNER_MAX_PAGES * ADMISSION_RECOVERY_OWNER_SCAN_CAP, 8192);
});

// ==========================================================================
// findRepresentationOwnersForShingle — bounded rowid cursor contract.
// ==========================================================================

test("findRepresentationOwnersForShingle: rowid cursor pages are bounded by `limit`, advance deterministically, and report exhaustion", async () => {
  await resetCorpus();
  await client.execute("PRAGMA foreign_keys = OFF");
  try {
    const h = "cursorcontracthash";
    const stmts = [];
    for (let i = 0; i < 700; i += 700) {
      stmts.push({
        sql: `INSERT OR IGNORE INTO corpus_document_shingles (representation_id, shingle_hash, fingerprint_version, created_at)
              VALUES ${Array.from({ length: 700 }, () => "(?,?,?,CURRENT_TIMESTAMP)").join(",")}`,
        args: Array.from({ length: 700 }, (_, k) => [`cursor-rep-${k.toString().padStart(4, "0")}`, h, CORPUS_FINGERPRINT_VERSION]).flat(),
      });
    }
    await client.batch(stmts, "write");

    const p1 = await findRepresentationOwnersForShingle(client, h, { afterId: 0, limit: 256 });
    assert.equal(p1.examinedRowCount, 256, "a full page examines exactly `limit` rows");
    assert.equal(p1.owners.length, 256);
    assert.ok(p1.nextAfterId !== null, "a full page yields a cursor for the next page");

    const p2 = await findRepresentationOwnersForShingle(client, h, { afterId: p1.nextAfterId, limit: 256 });
    assert.equal(p2.examinedRowCount, 256);
    assert.ok(p2.owners.every((o) => !p1.owners.some((x) => x.rowId === o.rowId)), "the cursor never re-yields a prior page's rows");

    const p3 = await findRepresentationOwnersForShingle(client, h, { afterId: p2.nextAfterId, limit: 256 });
    assert.equal(p3.examinedRowCount, 700 - 512, "the final partial page examines only what is left");
    assert.equal(p3.nextAfterId, null, "a short page reports posting-list exhaustion");
  } finally {
    await client.execute("PRAGMA foreign_keys = ON");
  }
});

// ==========================================================================
// Slice 2H fingerprint-version-safe recovery — stale-generation starvation
// regression. corpus_document_shingles deliberately lets multiple
// fingerprint generations coexist for one hash (drizzle/0019's
// version-scoped unique key). The recovery cursor
// (findRepresentationOwnersForShingle) now scopes fingerprint_version in the
// WHERE clause, served by the drizzle/0051 composite index
// (shingle_hash, fingerprint_version, id), so a bounded prefix of
// stale-generation rows can never consume the fixed
// ADMISSION_RECOVERY_OWNER_MAX_PAGES x ADMISSION_RECOVERY_OWNER_SCAN_CAP
// (4 x 256 = 1024) cursor budget before the current-generation cohort is
// reached. These three tests are the regression proof for that fix.
// ==========================================================================

test("A (starvation regression, helper level): >1024 stale-generation rows ahead of the current cohort never starve the bounded recovery cursor", async () => {
  await resetCorpus();
  await client.execute("PRAGMA foreign_keys = OFF");
  try {
    const h = "starvation-regression-hash-A";
    // ADMISSION_RECOVERY_OWNER_MAX_PAGES * ADMISSION_RECOVERY_OWNER_SCAN_CAP
    // == 1024 — the full four-page cursor budget for one probed hash. Seed
    // strictly MORE stale rows than that, all with lower rowids than the
    // current cohort (inserted first), so a hash-only cursor would spend the
    // entire budget on stale rows and never reach a single real owner.
    const STALE = 1100;
    const CURRENT = 40;
    assert.ok(STALE > ADMISSION_RECOVERY_OWNER_MAX_PAGES * ADMISSION_RECOVERY_OWNER_SCAN_CAP, "the stale prefix must exceed the whole cursor budget");

    const stmts = [];
    for (let i = 0; i < STALE; i += 500) {
      const n = Math.min(500, STALE - i);
      stmts.push({
        sql: `INSERT INTO corpus_document_shingles (representation_id, shingle_hash, fingerprint_version, created_at)
              VALUES ${Array.from({ length: n }, () => "(?,?,?,CURRENT_TIMESTAMP)").join(",")}`,
        args: Array.from({ length: n }, (_, k) => [`staleA-${i + k}`, h, "archive-shingle-v1"]).flat(),
      });
    }
    // current generation inserted AFTER every stale row -> strictly higher rowids.
    stmts.push({
      sql: `INSERT INTO corpus_document_shingles (representation_id, shingle_hash, fingerprint_version, created_at)
            VALUES ${Array.from({ length: CURRENT }, () => "(?,?,?,CURRENT_TIMESTAMP)").join(",")}`,
      args: Array.from({ length: CURRENT }, (_, k) => [`currentA-${k.toString().padStart(3, "0")}`, h, CORPUS_FINGERPRINT_VERSION]).flat(),
    });
    for (let i = 0; i < stmts.length; i += 40) await client.batch(stmts.slice(i, i + 40), "write");

    // paginate EXACTLY as recoverPrunedAdmissionFamily does.
    const collected = [];
    let afterId = 0;
    let pages = 0;
    let rawRowsExamined = 0;
    for (let p = 0; p < ADMISSION_RECOVERY_OWNER_MAX_PAGES; p += 1) {
      const page = await findRepresentationOwnersForShingle(client, h, {
        afterId,
        limit: ADMISSION_RECOVERY_OWNER_SCAN_CAP,
        fingerprintVersion: CORPUS_FINGERPRINT_VERSION,
      });
      pages += 1;
      rawRowsExamined += page.examinedRowCount;
      collected.push(...page.owners);
      if (page.nextAfterId === null) break;
      afterId = page.nextAfterId;
    }

    assert.equal(collected.length, CURRENT, "every current-generation owner is reached despite 1100 stale predecessors");
    assert.ok(collected.every((o) => o.representationId.startsWith("currentA-")), "no stale-generation owner is ever returned");
    assert.ok(pages <= ADMISSION_RECOVERY_OWNER_MAX_PAGES, `pages (${pages}) stay within the recovery budget`);
    assert.ok(
      rawRowsExamined <= ADMISSION_RECOVERY_OWNER_SCAN_CAP * ADMISSION_RECOVERY_OWNER_MAX_PAGES,
      `raw rows examined (${rawRowsExamined}) stay within the proven hard bound`,
    );
    // The crisp proof the drizzle/0051 predicate did its job: the cursor
    // examined exactly the current cohort and not one stale predecessor.
    assert.equal(rawRowsExamined, CURRENT, "the indexed (hash, version, id) seek skips every stale predecessor — none is examined to fill LIMIT");
    assert.equal(pages, 1, "the whole current cohort is drained in the first bounded page");

    // isolation, not deletion: the stale generation stays fully cursorable.
    const stalePage = await findRepresentationOwnersForShingle(client, h, {
      afterId: 0,
      limit: ADMISSION_RECOVERY_OWNER_SCAN_CAP,
      fingerprintVersion: "archive-shingle-v1",
    });
    assert.equal(stalePage.owners.length, ADMISSION_RECOVERY_OWNER_SCAN_CAP, "the stale generation is still independently cursorable");
    assert.ok(stalePage.owners.every((o) => o.representationId.startsWith("staleA-")), "the stale cursor never yields a current-generation owner");
  } finally {
    await client.execute("PRAGMA foreign_keys = ON");
  }
});

test("B (starvation regression, production recovery): a genuine edited re-upload is still recovered as EDITED_VERSION / REJECT when >1024 stale-generation rows sit ahead of the current cohort on every probed recovery hash", async () => {
  await resetCorpus();
  const shared = plausibleArticleText(2101, 3100);
  const sharedCanonical = canonicalizeText(shared);
  const sharedHashes = [...corpusShingleHashes(sharedCanonical)];

  const candidateText = `${shared}\n\n${plausibleArticleText(2121, 420)}`;

  // The recovery pass probes a deterministic, bounded set of the pruned
  // shared run's hashes — compute exactly that set the way the gate will.
  const ownShingleHashes = corpusShingleHashes(canonicalizeText(candidateText));
  const ordered = [...ownShingleHashes];
  const sharedSet = new Set(sharedHashes);
  const prunedHashes = ordered.filter((hh) => sharedSet.has(hh));
  const probeHashes = selectAdmissionRecoveryProbeHashes(ordered, prunedHashes);
  assert.ok(probeHashes.length > 0 && probeHashes.length <= ADMISSION_RECOVERY_SELECTED_HASHES, `recovery selects a bounded probe-hash set (${probeHashes.length})`);

  // Seed a full four-page cursor budget of stale-generation rows for EVERY
  // probed hash BEFORE any current-generation row exists — so a hash-only
  // cursor would exhaust its budget on stale rows for all of them at once.
  const STALE_PER_HASH = 1100;
  await client.execute("PRAGMA foreign_keys = OFF");
  try {
    const staleStmts = [];
    for (const hh of probeHashes) {
      for (let i = 0; i < STALE_PER_HASH; i += 500) {
        const n = Math.min(500, STALE_PER_HASH - i);
        staleStmts.push({
          sql: `INSERT INTO corpus_document_shingles (representation_id, shingle_hash, fingerprint_version, created_at)
                VALUES ${Array.from({ length: n }, () => "(?,?,?,CURRENT_TIMESTAMP)").join(",")}`,
          args: Array.from({ length: n }, (_, k) => [`staleB-${hh}-${i + k}`, hh, "archive-shingle-v1"]).flat(),
        });
      }
    }
    for (let i = 0; i < staleStmts.length; i += 40) await client.batch(staleStmts.slice(i, i + 40), "write");
  } finally {
    await client.execute("PRAGMA foreign_keys = ON");
  }

  // The genuine base: the shared article verbatim — every one of its shingles
  // is a cohort shingle at DF > 50, so pruning removes all of them from
  // primary discovery. Its current-generation shingle rows land AFTER the
  // 1100-row stale prefix on each probed hash.
  const baseId = "00000000-0000-4000-8000-0000000000b2";
  await seedRepresentationRaw({
    id: baseId,
    canonicalText: sharedCanonical,
    wordCount: sharedCanonical.split(/\s+/).length,
    canonicalSha256: canonicalSha256(shared),
    shingleHashes: [...corpusShingleHashes(sharedCanonical)],
  });
  await seedFakeCohort(55, sharedHashes); // shared body now at DF 56 (> 50)

  // Preconditions: pruning fires, the base is invisible to primary discovery,
  // and the stale prefix really is on disk ahead of the current cohort.
  const diag = { inputShingleCount: 0, survivingShingleCount: 0, highDfPrunedCount: 0, fallbackUsed: false, appliedMaxDocumentFrequency: null, prunedShingleHashes: [] };
  const realCandidates = await findCandidateCorpusRepresentations(client, ownShingleHashes, {
    eligibilityMode: "ADMISSION_DEDUP",
    maxDocumentFrequency: ADMISSION_DEDUP_MAX_SHINGLE_DOCUMENT_FREQUENCY,
    minDiscriminativeShingles: ADMISSION_DEDUP_MIN_DISCRIMINATIVE_SHINGLES,
    diagnostics: diag,
  });
  assert.ok(!diag.fallbackUsed, "enough distinctive edit shingles survive — no low-information fallback");
  assert.ok(diag.highDfPrunedCount > 0, "the cohort's shared body is pruned from primary discovery");
  assert.ok(!realCandidates.some((c) => c.representationId === baseId), "the base is ABSENT from the primary maxDF candidate set");
  // Starvation precondition: for every probed hash, a fingerprint-version-blind
  // rowid cursor (the pre-fix behaviour) would spend its entire four-page
  // budget on stale rows — the first 1024 rows by rowid are all stale.
  for (const hh of probeHashes) {
    const blind = await client.execute({
      sql: `SELECT fingerprint_version FROM corpus_document_shingles
            WHERE shingle_hash = ? AND id > 0 ORDER BY id
            LIMIT ${ADMISSION_RECOVERY_OWNER_SCAN_CAP * ADMISSION_RECOVERY_OWNER_MAX_PAGES}`,
      args: [hh],
    });
    assert.ok(
      blind.rows.length === ADMISSION_RECOVERY_OWNER_SCAN_CAP * ADMISSION_RECOVERY_OWNER_MAX_PAGES
        && blind.rows.every((r) => r.fingerprint_version === "archive-shingle-v1"),
      "a version-blind cursor would exhaust its whole budget on stale rows — the starvation precondition holds",
    );
  }

  const decision = await evaluateDryRun("recovery-stale-prefix-B", Buffer.from(candidateText, "utf8"));
  assert.equal(decision.decision, "REJECT", `recovery must not degrade to ACCEPT/REVIEW (got ${decision.decision}, ${decision.reasonCodes.join(",")})`);
  assert.equal(decision.familyRelation, "EDITED_VERSION", `recovery must restore EDITED_VERSION through the stale prefix (got ${decision.familyRelation})`);
  assert.ok(decision.reasonCodes.includes("EDITED_VERSION_ALREADY_REPRESENTED"), decision.reasonCodes.join(","));
});

test("C (version isolation): each fingerprint generation of one hash is independently and completely cursorable, regardless of how their rowids interleave", async () => {
  await resetCorpus();
  await client.execute("PRAGMA foreign_keys = OFF");
  try {
    const h = "version-isolation-hash-C";
    // Interleave insertion so neither generation is a clean rowid prefix of
    // the other: 3 rounds of [200 stale, 4 current].
    let staleCount = 0;
    let currentCount = 0;
    for (let round = 0; round < 3; round += 1) {
      const staleBatch = Array.from({ length: 200 }, () => [`staleC-${staleCount++}`, h, "archive-shingle-v1"]);
      await client.batch([{
        sql: `INSERT INTO corpus_document_shingles (representation_id, shingle_hash, fingerprint_version, created_at)
              VALUES ${staleBatch.map(() => "(?,?,?,CURRENT_TIMESTAMP)").join(",")}`,
        args: staleBatch.flat(),
      }], "write");
      const currentBatch = Array.from({ length: 4 }, () => [`currentC-${(currentCount++).toString().padStart(2, "0")}`, h, CORPUS_FINGERPRINT_VERSION]);
      await client.batch([{
        sql: `INSERT INTO corpus_document_shingles (representation_id, shingle_hash, fingerprint_version, created_at)
              VALUES ${currentBatch.map(() => "(?,?,?,CURRENT_TIMESTAMP)").join(",")}`,
        args: currentBatch.flat(),
      }], "write");
    }
    assert.equal(staleCount, 600);
    assert.equal(currentCount, 12);

    // current generation — one bounded page drains it completely despite 600
    // interleaved stale rows.
    const cur = await findRepresentationOwnersForShingle(client, h, { afterId: 0, limit: 256, fingerprintVersion: CORPUS_FINGERPRINT_VERSION });
    assert.equal(cur.owners.length, 12, "exactly the 12 current-generation owners are returned");
    assert.ok(cur.owners.every((o) => o.representationId.startsWith("currentC-")), "no stale-generation owner leaks into the current cursor");
    assert.equal(cur.nextAfterId, null, "the current cohort is fully drained in one bounded page");
    assert.deepEqual(cur.owners.map((o) => o.rowId), [...cur.owners.map((o) => o.rowId)].sort((a, b) => a - b), "owners are returned in ascending rowid order");

    // stale generation — independently, fully cursorable across its own pages.
    let afterId = 0;
    let staleSeen = 0;
    let pages = 0;
    for (;;) {
      const page = await findRepresentationOwnersForShingle(client, h, { afterId, limit: 256, fingerprintVersion: "archive-shingle-v1" });
      pages += 1;
      assert.ok(page.owners.every((o) => o.representationId.startsWith("staleC-")), "the stale cursor never yields a current-generation owner");
      staleSeen += page.owners.length;
      if (page.nextAfterId === null) break;
      afterId = page.nextAfterId;
    }
    assert.equal(staleSeen, 600, "every stale-generation owner is reachable through its own version-scoped cursor");
    assert.equal(pages, 3, "600 stale rows drain in exactly ceil(600 / 256) = 3 pages");

    // a generation that does not exist for this hash cursors to empty, not to
    // the other generation's rows.
    const absent = await findRepresentationOwnersForShingle(client, h, { afterId: 0, limit: 256, fingerprintVersion: "some-unused-generation-v9" });
    assert.deepEqual(absent.owners, []);
    assert.equal(absent.nextAfterId, null);
  } finally {
    await client.execute("PRAGMA foreign_keys = ON");
  }
});
