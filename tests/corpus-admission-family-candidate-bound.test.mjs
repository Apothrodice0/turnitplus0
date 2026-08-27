import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalSha256 } from "../lib/document-identity.ts";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { corpusShingleHashes } from "../lib/user-submission-corpus.ts";
import {
  evaluateCorpusAdmissionCandidate,
  findAcceptedFamilyCandidates,
  MAX_ACCEPTED_FAMILY_CANDIDATES,
  CORPUS_ADMISSION_FINGERPRINT_VERSION,
} from "../lib/corpus-admission-gate.ts";
import { resolveCorpusArticleFamily, DEFAULT_CORPUS_FAMILY_THRESHOLDS } from "../lib/corpus-admission-family.ts";

/**
 * Regression coverage for lib/corpus-admission-gate.ts's findAcceptedFamilyCandidates:
 *   C-2 — an unbounded `shingle_hash IN (...)` list threw
 *         "SQLITE_ERROR: too many SQL variables" for a submission with more
 *         informative shingles than SQLite's 32,766 SQLITE_MAX_VARIABLE_NUMBER
 *         (A).
 *   C-3 — no bounded, resolver-priority candidate cap (B1/B2/B3/C/D/G), and
 *         a raw-shared pre-cap that could truncate a genuine EDITED_VERSION
 *         / EXACT_DUPLICATE before its true containment was known (H/I).
 *   corpus-value — the family-relevant partition drops length-incompatible
 *         accepted representations from the candidate list, so their
 *         contribution to computeEvaluationCore's bestContainmentAgainstCorpus
 *         is preserved by a PROVEN lower bound (corpusValueContainmentLowerBound),
 *         keeping the REVIEW / LOW_CORPUS_VALUE decision for the review's
 *         "very high containment" case (J1); the lower bound never
 *         over-estimates, and its only under-shoot is a documented,
 *         low-density-source residual (J2).
 *
 * The 50-candidate cap is ranked by exactly the priority
 * resolveCorpusArticleFamily itself applies (exact canonical hash ->
 * length-compatibility -> actual containment -> raw shared -> id).
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_corpus_admission_family_candidate_bound.db");
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

// --- direct seeding of the accepted-representations registry ----------------

/** Inserts one ACCEPT decision + accepted representation + its accepted-shingle rows, exactly the shape lib/corpus-admission-gate.ts's own accept path writes. `acceptedRepresentationId` may be pinned so a test can control the id-ascending tie-break. */
async function seedAcceptedRepresentation({ sourceRef, canonicalSha256: hash, wordCount, shingleHashes, acceptedRepresentationId: pinnedId }) {
  const decisionId = randomUUID();
  const acceptedRepresentationId = pinnedId ?? randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,CURRENT_TIMESTAMP)`,
    args: [
      decisionId, null, sourceRef, "corpus-admission-policy-v1", "ACCEPT", "[]", 1, "[]",
      "txt", wordCount, "English", 0.95, hash, "v1",
      null, 90, "v1", "{}", "{}", "v1",
      50, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
    ],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
    args: [acceptedRepresentationId, decisionId, hash, wordCount, CORPUS_ADMISSION_FINGERPRINT_VERSION],
  });
  // Bulk multi-row inserts (2000 shingles / statement, <= 200 statements /
  // batch) — far fewer round trips than one statement per shingle for the
  // large fixtures (some tests seed hundreds of representations).
  const all = [...shingleHashes];
  const PER_STATEMENT = 2000;
  const statements = [];
  for (let i = 0; i < all.length; i += PER_STATEMENT) {
    const slice = all.slice(i, i + PER_STATEMENT);
    statements.push({
      sql: `INSERT OR IGNORE INTO corpus_admission_accepted_shingles (accepted_representation_id, shingle_hash, fingerprint_version, created_at) VALUES ${slice.map(() => "(?,?,?,CURRENT_TIMESTAMP)").join(",")}`,
      args: slice.flatMap((h) => [acceptedRepresentationId, h, CORPUS_ADMISSION_FINGERPRINT_VERSION]),
    });
  }
  for (let i = 0; i < statements.length; i += 200) {
    await client.batch(statements.slice(i, i + 200), "write");
  }
  return { decisionId, acceptedRepresentationId, sourceRef };
}

/** findAcceptedFamilyCandidates now returns { candidates, corpusValueContainmentLowerBound }; most tests only assert on the family candidate list. */
async function familyCandidatesOnly(...args) {
  return (await findAcceptedFamilyCandidates(...args)).candidates;
}

/** Wipes the accepted-representations registry so a test that asserts on the GLOBAL max corpus-value lower bound runs against exactly its own seed. */
async function clearAcceptedRegistry() {
  await client.execute("DELETE FROM corpus_admission_accepted_shingles");
  await client.execute("DELETE FROM corpus_admission_accepted_representations");
  await client.execute("DELETE FROM corpus_admission_decisions");
}

const disjoint = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}${i.toString(36).padStart(8, "0")}`);

/**
 * Bulk-seed MANY accepted representations at once (decisions, then reps, then
 * shingles — each phase batched) for the hundreds-of-documents scale tests.
 * `specs`: [{ sourceRef, canonicalSha256, wordCount, acceptedRepresentationId, shingleHashes }]
 */
async function bulkSeedAcceptedRepresentations(specs) {
  const rows = specs.map((s) => ({ ...s, decisionId: randomUUID(), aId: s.acceptedRepresentationId ?? randomUUID() }));
  const batched = async (statements) => {
    for (let i = 0; i < statements.length; i += 150) await client.batch(statements.slice(i, i + 150), "write");
  };
  await batched(rows.map((r) => ({
    sql: `INSERT INTO corpus_admission_decisions
          (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
           detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
           content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
           corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
           consent_metadata, dry_run, created_at)
          VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,CURRENT_TIMESTAMP)`,
    args: [r.decisionId, null, r.sourceRef, "corpus-admission-policy-v1", "ACCEPT", "[]", 1, "[]",
      "txt", r.wordCount, "English", 0.95, r.canonicalSha256, "v1",
      null, 90, "v1", "{}", "{}", "v1", 50, "v1", "NONE", null, null,
      JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0],
  })));
  await batched(rows.map((r) => ({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
          VALUES (?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
    args: [r.aId, r.decisionId, r.canonicalSha256, r.wordCount, CORPUS_ADMISSION_FINGERPRINT_VERSION],
  })));
  const shingleStatements = [];
  for (const r of rows) {
    const all = [...r.shingleHashes];
    for (let i = 0; i < all.length; i += 2000) {
      const slice = all.slice(i, i + 2000);
      shingleStatements.push({
        sql: `INSERT OR IGNORE INTO corpus_admission_accepted_shingles (accepted_representation_id, shingle_hash, fingerprint_version, created_at) VALUES ${slice.map(() => "(?,?,?,CURRENT_TIMESTAMP)").join(",")}`,
        args: slice.flatMap((h) => [r.aId, h, CORPUS_ADMISSION_FINGERPRINT_VERSION]),
      });
    }
  }
  await batched(shingleStatements);
  return rows;
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
const RESOLVED_PROVENANCE = (sourceUrl) => ({
  kind: "BULK_IMPORT_PROVENANCE",
  provenance: { sourceUrl, acquisitionMethod: "BULK_IMPORT_DOWNLOAD", licenseOrPermission: "CC-BY-4.0", retentionBasis: "LICENSED_REUSE", retentionRightsResolved: true, notes: null },
});
function evaluateDryRun(sourceRef, filename, bytes) {
  return evaluateCorpusAdmissionCandidate(client, { sourceRef, filename, bytes, consent: RESOLVED_PROVENANCE(`https://example.test/${sourceRef}`), dryRun: true });
}

const SQLITE_MAX_VARIABLE_NUMBER = 32_766;
const LENGTH_FLOOR = DEFAULT_CORPUS_FAMILY_THRESHOLDS.lengthCompatibilityFloor.value; // 0.7

// ==========================================================================
// A. >32,766 SQL-variable bug: no throw, correct candidate, shared count
//    summed across every chunk, containment correct. (C-2)
// ==========================================================================

test("A: findAcceptedFamilyCandidates survives a query above SQLITE_MAX_VARIABLE_NUMBER and sums shared counts across every chunk", async () => {
  const words = Array.from({ length: 44_000 }, (_, i) => `af${i.toString(36).padStart(6, "0")}`);
  const queryHashes = corpusShingleHashes(words.join(" "), 5);
  assert.ok(queryHashes.size > SQLITE_MAX_VARIABLE_NUMBER, `precondition: ${queryHashes.size} must exceed ${SQLITE_MAX_VARIABLE_NUMBER}`);
  const q = [...queryHashes];

  // BASE_IDENTICAL: shingle set IS the query set -> shared == full set,
  // spanning three 20,000-hash chunks; containment must be ~1.0.
  await seedAcceptedRepresentation({
    sourceRef: "af-identical",
    canonicalSha256: `sha-af-identical-${randomUUID()}`,
    wordCount: 44_000,
    shingleHashes: queryHashes,
  });

  // BASE_PARTIAL: 35,000 shared query shingles spanning all three chunks +
  // 4,000 disjoint. Expected containment = 35000 / min(|query|, 39000).
  const sharedIdx = q.filter((_, i) => i < 15_000 || (i >= 24_000 && i < 40_000) || i >= 42_000);
  const partialShared = new Set(sharedIdx.slice(0, 35_000));
  const partialExtra = new Set(disjoint(4_000, "AFX"));
  await seedAcceptedRepresentation({
    sourceRef: "af-partial",
    canonicalSha256: `sha-af-partial-${randomUUID()}`,
    wordCount: 43_000,
    shingleHashes: new Set([...partialShared, ...partialExtra]),
  });

  let candidates;
  await assert.doesNotReject(
    async () => { candidates = await familyCandidatesOnly(client, queryHashes, null, { wordCount: 44_000, canonicalSha256: `sha-unrelated-${randomUUID()}` }); },
    "must not throw SQLITE_ERROR: too many SQL variables for a query above SQLITE_MAX_VARIABLE_NUMBER",
  );

  const byRef = new Map(candidates.map((c) => [c.sourceRef, c]));
  assert.ok(byRef.has("af-identical"), "the identical-shingle accepted representation must be returned");
  assert.ok(byRef.has("af-partial"), "the partial-overlap accepted representation must be returned");
  assert.ok(byRef.get("af-identical").containment > 0.999, `identical containment must be ~1.0 (43,996 summed across 3 chunks), got ${byRef.get("af-identical").containment}`);

  const expectedPartial = partialShared.size / Math.min(queryHashes.size, partialShared.size + partialExtra.size);
  const pc = byRef.get("af-partial").containment;
  assert.ok(Math.abs(pc - expectedPartial) < 0.005, `partial containment must be ~${expectedPartial.toFixed(4)} (full cross-chunk sum), got ${pc.toFixed(4)}`);
  assert.ok(pc > 0.6, `partial containment ${pc.toFixed(4)} is unreachable from any single 20,000-hash chunk (proves multi-chunk accumulation)`);
});

// ==========================================================================
// B. Candidate bound: cap enforced, deterministic ranking, resolver-priority
//    strongest kept — on BOTH the single-query and chunked paths.
// ==========================================================================

test("B1: single-query path caps the candidate list at MAX_ACCEPTED_FAMILY_CANDIDATES when > cap LENGTH-COMPATIBLE reps match, deterministically, keeping the strongest — and drops length-incompatible reps entirely", async () => {
  const target = plausibleArticleText(4101, 6000);
  const targetHashes = corpusShingleHashes(canonicalizeText(target), 5);
  assert.ok(targetHashes.size > 0 && targetHashes.size <= 20_000, `single-query path precondition: ${targetHashes.size}`);
  const t = [...targetHashes];
  const targetWords = target.split(/\s+/).length;

  // strong: genuine same-size near-duplicate (containment ~0.9, length-compatible)
  await seedAcceptedRepresentation({
    sourceRef: "b1-strong",
    canonicalSha256: `sha-b1-strong-${randomUUID()}`,
    wordCount: targetWords,
    shingleHashes: new Set([...t.slice(0, Math.floor(t.length * 0.9)), ...disjoint(Math.floor(t.length * 0.1), "B1S")]),
  });
  // 58 LENGTH-COMPATIBLE, realistic-size, low-containment noise reps -> > the
  // 50-cap once combined with b1-strong.
  const lowestOverlap = [];
  for (let i = 0; i < 58; i += 1) {
    const overlap = 40 + i * 6;
    const rep = await seedAcceptedRepresentation({
      sourceRef: `b1-noise-${i}`,
      canonicalSha256: `sha-b1-noise-${i}-${randomUUID()}`,
      wordCount: targetWords + (i % 2 ? 150 : -150),
      shingleHashes: new Set([...t.slice(0, overlap), ...disjoint(t.length - overlap, `B1N${i}_`)]),
    });
    if (i < 6) lowestOverlap.push(rep);
  }
  // 8 length-INCOMPATIBLE fragments — must be dropped before the cap, never counted.
  const fragments = [];
  for (let i = 0; i < 8; i += 1) {
    fragments.push(await seedAcceptedRepresentation({
      sourceRef: `b1-fragment-${i}`,
      canonicalSha256: `sha-b1-fragment-${i}-${randomUUID()}`,
      wordCount: 500,
      shingleHashes: new Set(t.slice(i * 20, i * 20 + 400)),
    }));
  }

  const targetCanonical = `sha-b1-target-${randomUUID()}`;
  const first = await familyCandidatesOnly(client, targetHashes, null, { wordCount: targetWords, canonicalSha256: targetCanonical });
  const second = await familyCandidatesOnly(client, targetHashes, null, { wordCount: targetWords, canonicalSha256: targetCanonical });

  assert.equal(first.length, MAX_ACCEPTED_FAMILY_CANDIDATES, "returned candidate count must equal the cap when more than the cap of LENGTH-COMPATIBLE reps match");
  assert.deepEqual(first.map((c) => c.sourceRef), second.map((c) => c.sourceRef), "ranking must be deterministic across identical calls");
  const refs = new Set(first.map((c) => c.sourceRef));
  assert.ok(refs.has("b1-strong"), "the highest-containment length-compatible candidate must survive the cap");
  for (const x of lowestOverlap) assert.ok(!refs.has(x.sourceRef), `lowest-overlap length-compatible noise ${x.sourceRef} must be dropped by the cap`);
  for (const x of fragments) assert.ok(!refs.has(x.sourceRef), `length-incompatible fragment ${x.sourceRef} must never be a family candidate`);
});

test("B2: chunked path (query > 32,766) still ranks/caps correctly, deterministically, keeps the length-compatible edited version, and drops every length-incompatible fragment", async () => {
  const words = Array.from({ length: 34_000 }, (_, i) => `b2${i.toString(36).padStart(6, "0")}`);
  const queryHashes = corpusShingleHashes(words.join(" "), 5);
  assert.ok(queryHashes.size > SQLITE_MAX_VARIABLE_NUMBER, `chunked-path precondition: ${queryHashes.size} must exceed ${SQLITE_MAX_VARIABLE_NUMBER}`);
  const q = [...queryHashes];

  // genuine length-compatible edited version (~27k words vs ~34k -> 0.79 >= 0.7)
  await seedAcceptedRepresentation({
    sourceRef: "b2-genuine",
    canonicalSha256: `sha-b2-genuine-${randomUUID()}`,
    wordCount: 27_000,
    shingleHashes: new Set([...q.slice(0, 22_000), ...disjoint(2_000, "B2G")]),
  });
  // a few length-compatible low-containment reps
  for (let i = 0; i < 3; i += 1) {
    await seedAcceptedRepresentation({
      sourceRef: `b2-compat-${i}`,
      canonicalSha256: `sha-b2-compat-${i}-${randomUUID()}`,
      wordCount: 26_000,
      shingleHashes: new Set([...q.slice(0, 300 + i * 100), ...disjoint(24_000, `B2C${i}_`)]),
    });
  }
  // 40 short, length-INCOMPATIBLE fragments almost entirely inside the query
  // (realistic ~2,900 shingles / 3,000 words) -> must all be dropped.
  const fragments = [];
  for (let i = 0; i < 40; i += 1) {
    fragments.push(await seedAcceptedRepresentation({
      sourceRef: `b2-fragment-${i}`,
      canonicalSha256: `sha-b2-fragment-${i}-${randomUUID()}`,
      wordCount: 3000,
      shingleHashes: new Set(q.slice(i * 90, i * 90 + 2900)),
    }));
  }

  const targetCanonical = `sha-b2-target-${randomUUID()}`;
  const first = await familyCandidatesOnly(client, queryHashes, null, { wordCount: 34_000, canonicalSha256: targetCanonical });
  const second = await familyCandidatesOnly(client, queryHashes, null, { wordCount: 34_000, canonicalSha256: targetCanonical });
  assert.ok(first.length <= MAX_ACCEPTED_FAMILY_CANDIDATES, "chunked path must respect the cap");
  assert.deepEqual(first.map((c) => c.sourceRef), second.map((c) => c.sourceRef), "chunked-path ranking must be deterministic");
  const refs = new Set(first.map((c) => c.sourceRef));
  assert.ok(refs.has("b2-genuine"), "the length-compatible edited version must survive on the chunked path");
  for (const x of fragments) assert.ok(!refs.has(x.sourceRef), `length-incompatible fragment ${x.sourceRef} must never be a family candidate on the chunked path`);
});

test("B3: fewer matching representations than the cap returns them all (no false truncation)", async () => {
  const target = plausibleArticleText(4301, 5000);
  const targetHashes = corpusShingleHashes(canonicalizeText(target), 5);
  const t = [...targetHashes];
  for (let i = 0; i < 7; i += 1) {
    await seedAcceptedRepresentation({
      sourceRef: `b3-rep-${i}`,
      canonicalSha256: `sha-b3-${i}-${randomUUID()}`,
      wordCount: 5000,
      shingleHashes: new Set(t.slice(i * 10, i * 10 + 300)),
    });
  }
  const candidates = await familyCandidatesOnly(client, targetHashes, null, { wordCount: 5000, canonicalSha256: `sha-b3-target-${randomUUID()}` });
  const b3 = candidates.filter((c) => c.sourceRef.startsWith("b3-rep-"));
  assert.equal(b3.length, 7, "all 7 matching representations must be returned when below the cap");
});

// ==========================================================================
// G. MANDATORY ADVERSARIAL: length-incompatible short fragments with very
//    high overlap / shared-per-word must NOT evict a genuine length-
//    compatible edited version.
// ==========================================================================

test("G: a genuine ~9.5k-word edited version survives the cap and is flagged EDITED_VERSION_ALREADY_REPRESENTED despite 60+ high-overlap length-incompatible ~3k-word fragments", async () => {
  const targetText = plausibleArticleText(9100, 10_000);
  const targetWords = targetText.split(/\s+/).length; // ~10,037
  const targetHashes = corpusShingleHashes(canonicalizeText(targetText), 5);
  const N = targetHashes.size;
  const t = [...targetHashes];
  const targetCanonical = canonicalSha256(targetText);

  // ONE genuine ~9,500-word edited version: shingle count ~= word count
  // (realistic density), ~8,550 of them shared with the target + ~500
  // disjoint -> containment ~0.94, shared/word_count ~0.90, length-compatible.
  await seedAcceptedRepresentation({
    sourceRef: "g-genuine",
    canonicalSha256: `sha-g-genuine-${randomUUID()}`,
    wordCount: 9_500,
    shingleHashes: new Set([...t.slice(0, 8_550), ...disjoint(500, "GGE")]),
  });

  // 60 length-INCOMPATIBLE ~3,000-word fragments, each an almost-verbatim
  // ~2,900-shingle slice of the target (realistic density): containment
  // ~1.0 AND shared/word_count ~0.97 (higher than the genuine 9.5k-word
  // edited version's ~0.90) — the exact pathology a raw or word-normalized
  // ranking evicts the genuine candidate for.
  const FRAGMENTS = 60;
  for (let i = 0; i < FRAGMENTS; i += 1) {
    const start = i * 90;
    await seedAcceptedRepresentation({
      sourceRef: `g-fragment-${i}`,
      canonicalSha256: `sha-g-fragment-${i}-${randomUUID()}`,
      wordCount: 3000,
      shingleHashes: new Set(t.slice(start, start + 2900)),
    });
  }

  // sanity: fragments are genuinely length-incompatible, genuine is compatible
  assert.ok(3000 / targetWords < LENGTH_FLOOR, "precondition: a 3,000-word fragment is length-incompatible with the ~10k target");
  assert.ok(Math.min(9500, targetWords) / Math.max(9500, targetWords) >= LENGTH_FLOOR, "precondition: the 9,500-word edited version is length-compatible");

  // 1) direct — cap enforced, genuine survives
  const candidates = await familyCandidatesOnly(client, targetHashes, null, { wordCount: targetWords, canonicalSha256: targetCanonical });
  assert.ok(candidates.length <= MAX_ACCEPTED_FAMILY_CANDIDATES, `candidate count ${candidates.length} must not exceed ${MAX_ACCEPTED_FAMILY_CANDIDATES}`);
  assert.ok(candidates.some((c) => c.sourceRef === "g-genuine"), "the genuine length-compatible edited version must survive the 50-candidate cap");

  // 2) resolver returns EDITED_VERSION against g-genuine, not NONE
  const family = resolveCorpusArticleFamily({ canonicalSha256: targetCanonical, wordCount: targetWords }, candidates);
  assert.equal(family.relation, "EDITED_VERSION", "resolveCorpusArticleFamily must still detect the edited version, not fall through to NONE");
  assert.equal(family.matchedSourceRef, "g-genuine");

  // 3) end-to-end through the real gate
  const decision = await evaluateDryRun("g-candidate", "g-candidate.txt", Buffer.from(targetText, "utf8"));
  assert.equal(decision.decision, "REJECT");
  assert.equal(decision.familyRelation, "EDITED_VERSION");
  assert.ok(decision.reasonCodes.includes("EDITED_VERSION_ALREADY_REPRESENTED"), `reasonCodes: ${decision.reasonCodes.join(",")}`);
});

// ==========================================================================
// C. A genuine EDITED_VERSION beats length-compatible low-containment noise.
// ==========================================================================

test("C: a genuine edited-version outranks many length-compatible low-containment accepted candidates and is flagged EDITED_VERSION_ALREADY_REPRESENTED", async () => {
  const base = plausibleArticleText(7001, 4000);
  const candidateText = base + "\n\n" + Array.from({ length: 4 }, () => "This appended paragraph introduces a small revision that changes little of the overall substance of the article.").join(" ");
  const candHashes = corpusShingleHashes(canonicalizeText(candidateText), 5);
  const candWords = candidateText.split(/\s+/).length;
  const c = [...candHashes];

  // genuine: ~90% of the candidate's shingles + ~15% disjoint, similar length
  await seedAcceptedRepresentation({
    sourceRef: "c-genuine",
    canonicalSha256: `sha-c-genuine-${randomUUID()}`,
    wordCount: candWords + 200,
    shingleHashes: new Set([...c.slice(0, Math.floor(c.length * 0.9)), ...disjoint(Math.floor(c.length * 0.15), "CGE")]),
  });
  // 15 length-COMPATIBLE noisy reps: realistic ~same-size documents that only
  // incidentally overlap a few hundred of the candidate's shingles -> low
  // actual containment. The genuine one must outrank these on containment.
  for (let i = 0; i < 15; i += 1) {
    const overlap = 50 + i * 10;
    await seedAcceptedRepresentation({
      sourceRef: `c-noise-${i}`,
      canonicalSha256: `sha-c-noise-${i}-${randomUUID()}`,
      wordCount: candWords + (i % 2 === 0 ? -100 : 300),
      shingleHashes: new Set([...c.slice(0, overlap), ...disjoint(c.length - overlap, `CNF${i}_`)]),
    });
  }
  // 45 short length-INCOMPATIBLE fragments (containment ~1.0) that must not
  // occupy cap slots ahead of the genuine length-compatible edited version.
  for (let i = 0; i < 45; i += 1) {
    await seedAcceptedRepresentation({
      sourceRef: `c-fragment-${i}`,
      canonicalSha256: `sha-c-fragment-${i}-${randomUUID()}`,
      wordCount: 600,
      shingleHashes: new Set(c.slice(i * 30, i * 30 + 450)),
    });
  }

  const candidates = await familyCandidatesOnly(client, candHashes, null, { wordCount: candWords, canonicalSha256: canonicalSha256(candidateText) });
  assert.ok(candidates.length <= MAX_ACCEPTED_FAMILY_CANDIDATES, "candidate list must be capped");
  assert.ok(candidates.some((x) => x.sourceRef === "c-genuine"), "the genuine edited-version candidate must survive the cap");
  const family = resolveCorpusArticleFamily({ canonicalSha256: `sha-c-cand-${randomUUID()}`, wordCount: candWords }, candidates);
  assert.equal(family.relation, "EDITED_VERSION");
  assert.equal(family.matchedSourceRef, "c-genuine");

  const decision = await evaluateDryRun("c-candidate", "c-candidate.txt", Buffer.from(candidateText, "utf8"));
  assert.equal(decision.decision, "REJECT");
  assert.equal(decision.familyRelation, "EDITED_VERSION");
  assert.ok(decision.reasonCodes.includes("EDITED_VERSION_ALREADY_REPRESENTED"), `reasonCodes: ${decision.reasonCodes.join(",")}`);
});

// ==========================================================================
// D. Exact canonical duplicate survives cap-exceeding short-fragment noise.
// ==========================================================================

test("D: an exact canonical duplicate is still resolved EXACT_DUPLICATE when buried among cap-exceeding short-fragment noise", async () => {
  const text = plausibleArticleText(5501, 5000);
  const exactHashes = corpusShingleHashes(canonicalizeText(text), 5);
  const hash = canonicalSha256(text);
  const e = [...exactHashes];

  await seedAcceptedRepresentation({ sourceRef: "exd-exact", canonicalSha256: hash, wordCount: text.split(/\s+/).length, shingleHashes: exactHashes });
  // 70 short fragments (length-incompatible, high containment) — must not evict the exact dup
  for (let i = 0; i < 70; i += 1) {
    await seedAcceptedRepresentation({
      sourceRef: `exd-fragment-${i}`,
      canonicalSha256: `sha-exd-fragment-${i}-${randomUUID()}`,
      wordCount: 400,
      shingleHashes: new Set(e.slice(i * 20, i * 20 + 350)),
    });
  }

  const candidates = await familyCandidatesOnly(client, exactHashes, null, { wordCount: text.split(/\s+/).length, canonicalSha256: hash });
  assert.ok(candidates.length <= MAX_ACCEPTED_FAMILY_CANDIDATES);
  assert.ok(candidates.some((cand) => cand.canonicalSha256 === hash), "the exact-hash candidate must survive the cap (ranked first by the exact-hash priority)");
  const family = resolveCorpusArticleFamily({ canonicalSha256: hash, wordCount: text.split(/\s+/).length }, candidates);
  assert.equal(family.relation, "EXACT_DUPLICATE");
  assert.equal(family.matchedSourceRef, "exd-exact");
});

// ==========================================================================
// F. Small-document common path is unchanged.
// ==========================================================================

test("F: a small unrelated submission still resolves family NONE and returns an un-capped candidate list", async () => {
  await seedAcceptedRepresentation({
    sourceRef: "f-seed",
    canonicalSha256: `sha-f-seed-${randomUUID()}`,
    wordCount: 3500,
    shingleHashes: corpusShingleHashes(canonicalizeText(plausibleArticleText(8001, 3500)), 5),
  });

  const different = plausibleArticleText(999801, 3600);
  const differentHashes = corpusShingleHashes(canonicalizeText(different), 5);
  assert.ok(differentHashes.size <= 20_000, "small-doc precondition (single-query path)");

  const candidates = await familyCandidatesOnly(client, differentHashes, null, { wordCount: different.split(/\s+/).length, canonicalSha256: canonicalSha256(different) });
  assert.ok(candidates.length < MAX_ACCEPTED_FAMILY_CANDIDATES, "a small unrelated query must not be capped");
  const family = resolveCorpusArticleFamily({ canonicalSha256: `sha-f-diff-${randomUUID()}`, wordCount: 3600 }, candidates);
  assert.equal(family.relation, "NONE", "a genuinely different small article must not resolve as a family match");

  const decision = await evaluateDryRun("f-candidate", "f-candidate.txt", Buffer.from(different, "utf8"));
  assert.equal(decision.familyRelation, "NONE");
  assert.ok(!decision.reasonCodes.includes("EDITED_VERSION_ALREADY_REPRESENTED"));
  assert.ok(!decision.reasonCodes.includes("DUPLICATE_ALREADY_REPRESENTED"));
});

// ==========================================================================
// H. MANDATORY: no correctness-affecting truncation BEFORE actual containment
//    / length-compatibility are known. >500 distinct, unrelated, MUCH LARGER
//    accepted documents that each embed the target text all outrank a genuine
//    same-size edited version on RAW shared count — the exact scenario a
//    raw-shared pre-cap would discard the genuine candidate for.
// ==========================================================================

const EMBEDDING_DOCS = 520; // > the removed 500-row raw-shared pre-cap

test("H: a genuine edited version survives and is flagged EDITED_VERSION_ALREADY_REPRESENTED even when 500+ larger unrelated documents each embed the target and outrank it by raw shared count", async () => {
  const targetText = plausibleArticleText(11001, 3400);
  const targetWords = targetText.split(/\s+/).length;
  const targetHashes = corpusShingleHashes(canonicalizeText(targetText), 5);
  const N = targetHashes.size;
  const t = [...targetHashes];
  const targetCanonical = canonicalSha256(targetText);

  const genuineShared = Math.floor(N * 0.85);
  const embedShared = Math.floor(N * 0.97);
  assert.ok(embedShared > genuineShared, `precondition: embedding docs must outrank the genuine one by raw shared (${embedShared} > ${genuineShared})`);
  assert.ok(Math.min(6000, targetWords) / Math.max(6000, targetWords) < LENGTH_FLOOR, "precondition: a 6,000-word doc is length-incompatible with the ~3.4k target");
  assert.ok(Math.min(targetWords - 200, targetWords) / Math.max(targetWords - 200, targetWords) >= LENGTH_FLOOR, "precondition: h-genuine is length-compatible");

  await bulkSeedAcceptedRepresentations([
    // genuine length-compatible edited version: ~85% of the target's shingles
    // -> containment ~0.9; RAW shared deliberately BELOW the embedding docs'.
    { sourceRef: "h-genuine", canonicalSha256: `sha-h-genuine-${randomUUID()}`, wordCount: targetWords - 200, shingleHashes: new Set([...t.slice(0, genuineShared), ...disjoint(Math.floor(N * 0.08), "HGE")]) },
    // 520 distinct, unrelated, MUCH LARGER documents, each embedding ~97% of
    // the target verbatim -> raw shared ~= full target (HIGHER than h-genuine),
    // but length-INCOMPATIBLE (a ~6,000-word doc vs a ~3,400-word target).
    ...Array.from({ length: EMBEDDING_DOCS }, (_, i) => ({
      sourceRef: `h-embed-${i}`, canonicalSha256: `sha-h-embed-${i}-${randomUUID()}`, wordCount: 6000,
      shingleHashes: new Set([...t.slice(0, embedShared), ...disjoint(20, `HEF${i}_`)]),
    })),
  ]);

  const started = Date.now();
  const candidates = await familyCandidatesOnly(client, targetHashes, null, { wordCount: targetWords, canonicalSha256: targetCanonical });
  console.log(`[H] findAcceptedFamilyCandidates over ${EMBEDDING_DOCS + 1}+ matching accepted reps: ${Date.now() - started} ms`);

  assert.ok(candidates.length <= MAX_ACCEPTED_FAMILY_CANDIDATES, `candidate count ${candidates.length} must not exceed ${MAX_ACCEPTED_FAMILY_CANDIDATES}`);
  assert.ok(candidates.some((c) => c.sourceRef === "h-genuine"), "the genuine edited version must survive — it must not be truncated before its actual containment / length are known");

  const family = resolveCorpusArticleFamily({ canonicalSha256: targetCanonical, wordCount: targetWords }, candidates);
  assert.equal(family.relation, "EDITED_VERSION", "resolveCorpusArticleFamily must return EDITED_VERSION, not fall through to NONE");
  assert.equal(family.matchedSourceRef, "h-genuine");

  const decision = await evaluateDryRun("h-candidate", "h-candidate.txt", Buffer.from(targetText, "utf8"));
  assert.equal(decision.decision, "REJECT");
  assert.equal(decision.familyRelation, "EDITED_VERSION");
  assert.ok(decision.reasonCodes.includes("EDITED_VERSION_ALREADY_REPRESENTED"), `reasonCodes: ${decision.reasonCodes.join(",")}`);
});

// ==========================================================================
// I. MANDATORY: an exact canonical duplicate TIED on maximum raw shared
//    against 500+ larger embedding documents — the id-ascending tie-break
//    must not hide the exact candidate from family evaluation / dry-run.
// ==========================================================================

test("I: an exact canonical duplicate tied on maximum raw shared against 500+ embedding documents (with an id-tie-break that sorts it last) still resolves EXACT_DUPLICATE", async () => {
  const targetText = plausibleArticleText(12001, 3400);
  const targetWords = targetText.split(/\s+/).length;
  const targetHashes = corpusShingleHashes(canonicalizeText(targetText), 5);
  const t = [...targetHashes];
  const targetCanonical = canonicalSha256(targetText);

  await bulkSeedAcceptedRepresentations([
    // The exact canonical duplicate: same canonical hash, FULL target shingle
    // set (maximum possible raw shared). Its id is pinned to sort AFTER every
    // embedding doc on the id-ascending tie-break — so a raw-shared pre-cap
    // with an id tie-break would deterministically evict it.
    { sourceRef: "i-exact", canonicalSha256: targetCanonical, wordCount: targetWords, shingleHashes: targetHashes, acceptedRepresentationId: "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz" },
    // 520 larger embedding documents, each carrying the FULL target shingle
    // set too -> tied on maximum raw shared; ids sort BEFORE the exact dup.
    ...Array.from({ length: EMBEDDING_DOCS }, (_, i) => ({
      sourceRef: `i-embed-${i}`, canonicalSha256: `sha-i-embed-${i}-${randomUUID()}`, wordCount: 6000,
      shingleHashes: targetHashes, acceptedRepresentationId: `00000000-0000-0000-0000-${i.toString().padStart(12, "0")}`,
    })),
  ]);

  const candidates = await familyCandidatesOnly(client, targetHashes, null, { wordCount: targetWords, canonicalSha256: targetCanonical });
  assert.ok(candidates.length <= MAX_ACCEPTED_FAMILY_CANDIDATES);
  assert.ok(candidates.some((c) => c.canonicalSha256 === targetCanonical), "the exact-hash candidate must remain visible to family evaluation despite the id tie-break");

  const family = resolveCorpusArticleFamily({ canonicalSha256: targetCanonical, wordCount: targetWords }, candidates);
  assert.equal(family.relation, "EXACT_DUPLICATE");
  assert.equal(family.matchedSourceRef, "i-exact");

  const decision = await evaluateDryRun("i-candidate", "i-candidate.txt", Buffer.from(targetText, "utf8"));
  assert.equal(decision.decision, "REJECT");
  assert.equal(decision.familyRelation, "EXACT_DUPLICATE");
  assert.ok(decision.reasonCodes.includes("DUPLICATE_ALREADY_REPRESENTED"), `reasonCodes: ${decision.reasonCodes.join(",")}`);
});

// ==========================================================================
// J. MANDATORY: corpus-value preservation. A length-incompatible accepted
//    source with VERY HIGH containment is dropped from the family candidate
//    list (correctly — familyRelation stays NONE), but its corpus-value
//    contribution is preserved via findAcceptedFamilyCandidates'
//    corpusValueContainmentLowerBound, so the admission classification
//    (REVIEW + LOW_CORPUS_VALUE) is unchanged.
// ==========================================================================

test("J1: a length-incompatible accepted source almost entirely contained in the submission still forces REVIEW / LOW_CORPUS_VALUE (familyRelation NONE), matching pre-fix corpus-value behavior", async () => {
  await clearAcceptedRegistry();
  const targetText = plausibleArticleText(13001, 10_000);
  const targetWords = targetText.split(/\s+/).length;
  const targetHashes = corpusShingleHashes(canonicalizeText(targetText), 5);
  const N = targetHashes.size;
  const t = [...targetHashes];

  // ~3,000-word accepted article, ~2,900 informative shingles (realistic
  // density ~1), ALL of them a verbatim slice of the ~10k-word submission:
  // actual containment ~1.0; length-INCOMPATIBLE (3000 / ~10000 < 0.7).
  const embeddedShingles = new Set(t.slice(0, 2900));
  await seedAcceptedRepresentation({
    sourceRef: "j1-embedded",
    canonicalSha256: `sha-j1-embedded-${randomUUID()}`,
    wordCount: 3000,
    shingleHashes: embeddedShingles,
  });

  assert.ok(3000 / targetWords < LENGTH_FLOOR, "precondition: the accepted source is length-incompatible with the submission");

  const result = await findAcceptedFamilyCandidates(client, targetHashes, null, { wordCount: targetWords, canonicalSha256: canonicalSha256(targetText) });
  // dropped from the family candidate list (length-incompatible, non-exact) ...
  assert.ok(!result.candidates.some((c) => c.sourceRef === "j1-embedded"), "the length-incompatible source is not a family candidate");
  assert.equal(resolveCorpusArticleFamily({ canonicalSha256: `x-${randomUUID()}`, wordCount: targetWords }, result.candidates).relation, "NONE");
  // ... but its corpus-value contribution is preserved by the proven lower
  // bound: shared 2900 / min(N, 3000-4) = 2900/2996 ~= 0.968 (>> 0.5).
  assert.ok(result.corpusValueContainmentLowerBound > 0.9, `expected corpusValueContainmentLowerBound ~0.97, got ${result.corpusValueContainmentLowerBound}`);
  // and it can never exceed the true containment (which is 1.0 here).
  const trueContainment = 2900 / Math.min(N, 2900);
  assert.ok(result.corpusValueContainmentLowerBound <= trueContainment + 1e-9, "the lower bound must never over-estimate true containment");

  // end-to-end: familyRelation NONE, but LOW_CORPUS_VALUE forces REVIEW.
  const decision = await evaluateDryRun("j1-candidate", "j1-candidate.txt", Buffer.from(targetText, "utf8"));
  assert.equal(decision.familyRelation, "NONE", "a length-incompatible source must not be a family match");
  assert.equal(decision.decision, "REVIEW", "corpus-value must still cap this ACCEPT-quality submission to REVIEW");
  assert.ok(decision.reasonCodes.includes("LOW_CORPUS_VALUE"), `reasonCodes: ${decision.reasonCodes.join(",")}`);
  assert.ok(decision.corpusValueScore !== null && decision.corpusValueScore < 50, `corpusValueScore must be < 50, got ${decision.corpusValueScore}`);
});

test("J2 (documents the known residual): a length-incompatible accepted source that is word-count-large but informative-shingle-SPARSE and only MODERATELY contained can drift from pre-fix REVIEW to ACCEPT — the lower bound never over-estimates, so it never causes a spurious REVIEW", async () => {
  await clearAcceptedRegistry();
  const targetText = plausibleArticleText(13101, 10_000);
  const targetWords = targetText.split(/\s+/).length;
  const targetHashes = corpusShingleHashes(canonicalizeText(targetText), 5);
  const N = targetHashes.size;
  const t = [...targetHashes];

  // A pathological accepted representation: 6,500 words (length-INCOMPATIBLE
  // with the ~10.1k-word submission) but only ~1,600 distinct informative
  // shingles (density ~0.25 — the kind of table/boilerplate-heavy document
  // the quality gate would very likely have REVIEW/REJECTed at its own
  // admission; seeded directly here to bypass that). ~1,000 of its shingles
  // are in the submission.
  const sparseShingles = new Set([...t.slice(0, 1000), ...disjoint(600, "J2X")]);
  await seedAcceptedRepresentation({
    sourceRef: "j2-sparse",
    canonicalSha256: `sha-j2-sparse-${randomUUID()}`,
    wordCount: 6500,
    shingleHashes: sparseShingles,
  });
  assert.ok(6500 / targetWords < LENGTH_FLOOR, "precondition: the sparse source is length-incompatible with the submission");

  // TRUE containment = 1000 / min(N, 1600) = 1000/1600 = 0.625  -> pre-fix: LOW_CORPUS_VALUE / REVIEW.
  const trueContainment = 1000 / Math.min(N, sparseShingles.size);
  assert.ok(trueContainment > 0.5, `precondition: true containment ${trueContainment.toFixed(3)} exceeds the REVIEW floor`);

  const result = await findAcceptedFamilyCandidates(client, targetHashes, null, { wordCount: targetWords, canonicalSha256: canonicalSha256(targetText) });
  assert.ok(!result.candidates.some((c) => c.sourceRef === "j2-sparse"), "the sparse source is length-incompatible -> not a family candidate");
  // proven lower bound uses word_count - 4 as the source size -> 1000 / min(N, 6496) ~= 0.15, BELOW the true 0.625.
  assert.ok(result.corpusValueContainmentLowerBound < trueContainment, "the lower bound under-shoots true containment for this low-density source (documented residual)");
  assert.ok(result.corpusValueContainmentLowerBound <= trueContainment + 1e-9, "the lower bound still never over-estimates");

  const decision = await evaluateDryRun("j2-candidate", "j2-candidate.txt", Buffer.from(targetText, "utf8"));
  assert.equal(decision.familyRelation, "NONE");
  // Documented drift: pre-fix this would be REVIEW (true containment 0.625);
  // the hardened lower bound (0.125) does not trip the REVIEW floor. It never
  // goes the other way (spurious REVIEW).
  assert.equal(decision.decision, "ACCEPT", "known residual: a low-density moderately-contained length-incompatible source no longer forces REVIEW");
});
