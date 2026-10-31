import assert from "node:assert/strict";
import test from "node:test";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity, canonicalSha256 } from "../lib/document-identity.ts";
import { canonicalizeText } from "../lib/canonical-text.ts";
import {
  indexDocumentSubmissionIntoCorpus,
  createReusableDocumentRepresentation,
  recordCorpusShingles,
  corpusShingleHashes,
  findCandidateCorpusRepresentations as _findCandidateCorpusRepresentations,
  applyHighFrequencyShinglePruning as _applyHighFrequencyShinglePruning,
  CORPUS_FINGERPRINT_VERSION,
} from "../lib/user-submission-corpus.ts";
import { matchAgainstUserSubmissionCorpus as _matchAgainstUserSubmissionCorpus, USER_SUBMISSION_MATCH_THRESHOLDS } from "../lib/user-submission-matching.ts";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";

// Phase A safe-by-default maturity: this whole suite predates the 7-day corpus
// activation clock and every test seeds its sources (and boilerplate/revoked
// noise) immediately before probing. All three entry points now enforce
// maturity for MATCHING callers by default — so age the just-seeded backings
// past the window first. These tests exercise DF pruning, not the clock
// (that is tests/corpus-activation-7day.test.mjs). The applyHighFrequencyShingle
// -Pruning shim leaves the disabled-pruning path (maxDocumentFrequency
// undefined) untouched so test K's "no DB round trip" assertion still holds.
const matchAgainstUserSubmissionCorpus = async (client, params) => {
  await matureCorpusBackings(client);
  return _matchAgainstUserSubmissionCorpus(client, params);
};
const findCandidateCorpusRepresentations = async (client, hashes, opts) => {
  await matureCorpusBackings(client);
  return _findCandidateCorpusRepresentations(client, hashes, opts);
};
const applyHighFrequencyShinglePruning = async (client, hashes, opts) => {
  if (opts?.maxDocumentFrequency !== undefined) await matureCorpusBackings(client);
  return _applyHighFrequencyShinglePruning(client, hashes, opts);
};

/**
 * 10k+-own-corpus scale hardening: query-time high-frequency ("maxDF")
 * shingle pruning for candidate DISCOVERY only
 * (lib/user-submission-corpus.ts's applyHighFrequencyShinglePruning, wired
 * through findCandidateCorpusRepresentations and
 * matchAgainstUserSubmissionCorpus).
 *
 * The invariant under test: pruning changes WHICH representations reach
 * verification, never the verification itself. Most proofs run the SAME
 * matcher over the SAME corpus twice — once with
 * maxCandidateShingleDocumentFrequency: null (pruning off — the exact
 * pre-hardening behavior) and once with it set — and assert the verified
 * output for a genuine copy is byte-identical while boilerplate candidate
 * fanout collapses. Every fixture is synthetic; each test builds its own
 * isolated in-memory corpus.
 */

// TURNITPLUS_CORPUS_SOURCE is a valid relationshipType only when this flag
// is on (matches tests/corpus-admission-self-match-exclusion.test.mjs). F/G
// exercise promotion-backed sources, which are otherwise dropped for a
// signed-in reader regardless of pruning.
const priorCorpusSourceFlag = process.env.CORPUS_SOURCE_MATCHING_ENABLED;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
test.after(() => {
  if (priorCorpusSourceFlag === undefined) delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  else process.env.CORPUS_SOURCE_MATCHING_ENABLED = priorCorpusSourceFlag;
});

const drizzleDir = path.join(path.resolve("."), "drizzle");

async function freshCorpus() {
  const client = createClient({ url: ":memory:" });
  await client.execute("PRAGMA foreign_keys = ON");
  await applyMigrationsLibsql(client, drizzleDir);
  const users = new Set();

  const api = {
    client,
    async ensureUser(accountId) {
      if (accountId === null || users.has(accountId)) return;
      users.add(accountId);
      await client.execute({
        sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
        args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"],
      });
    },
    /**
     * `count` synthetic boilerplate representations, each carrying the exact
     * hashes in `sharedHashes` (so they genuinely collide with a
     * boilerplate-heavy query and drive fanout) plus a few unique hashes.
     * Eligible via admissionEligibilitySql condition 3 (no promotion rows).
     * canonical_text is a placeholder — these never need to pass
     * verification, only to be discovered.
     */
    async seedBoilerplate(count, sharedHashes) {
      for (let i = 0; i < count; i += 1) {
        const id = `noise-${randomUUID()}`;
        await client.execute({
          sql: `INSERT INTO corpus_document_representations
                (id, canonical_sha256, canonical_text, word_count, language, canonicalization_version, extractor_version, first_seen_at, created_at)
                VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
          args: [id, `noise-sha-${id}`, `boilerplate placeholder ${id}`, 400, "English", "canonical-text-v1", null],
        });
        const hashes = [...sharedHashes, `uniq-${id}-a`, `uniq-${id}-b`, `uniq-${id}-c`];
        const values = hashes.map(() => "(?,?,?,CURRENT_TIMESTAMP)").join(",");
        const args = [];
        for (const h of hashes) args.push(id, h, CORPUS_FINGERPRINT_VERSION);
        await client.execute({
          sql: `INSERT INTO corpus_document_shingles (representation_id, shingle_hash, fingerprint_version, created_at) VALUES ${values}`,
          args,
        });
      }
    },
    /** A real-text representation via the same primitives the promotion pipeline uses. Returns its id. */
    async seedRealRepresentation(rawText) {
      const canonicalText = canonicalizeText(rawText);
      const rep = await createReusableDocumentRepresentation(client, { canonicalText });
      await recordCorpusShingles(client, rep.id, canonicalText);
      return rep.id;
    },
    async indexRealSubmission(accountId, title, rawText) {
      await api.ensureUser(accountId);
      const identity = await createDocumentIdentity(client, { accountId, title, author: null, rawText });
      await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
      const rep = await client.execute({
        sql: "SELECT id FROM corpus_document_representations WHERE canonical_sha256 = ?",
        args: [canonicalSha256(rawText)],
      });
      return rep.rows[0].id;
    },
    async attachSubmissionReference(representationId, accountId) {
      await api.ensureUser(accountId);
      const identity = await createDocumentIdentity(client, { accountId, title: "ref", author: null, rawText: `ref ${randomUUID()}` });
      await client.execute({
        sql: "INSERT INTO corpus_submission_references (representation_id, document_identity_id, link_type, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)",
        args: [representationId, identity.id, "NEW_CONTENT_REPRESENTATION"],
      });
    },
    async insertPromotionBacking(representationId, { accountId, revoked = false }) {
      const decisionId = randomUUID();
      const sha = `${randomUUID()}`;
      await client.execute({
        sql: `INSERT INTO corpus_admission_decisions
              (id, run_id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes,
               detected_format, extracted_word_count, detected_language, language_confidence, canonical_sha256, extractor_version,
               content_store_id, quality_score, quality_model_version, component_scores, feature_vector, feature_vector_version,
               corpus_value_score, corpus_value_model_version, family_relation, family_matched_source_ref, family_containment,
               consent_metadata, dry_run, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
        args: [
          decisionId, null, `report-upload:account=${accountId}:device=d:report=r`, "v1", "ACCEPT", "[]", 1, "[]",
          "txt", 50, "English", 0.95, sha, "v1", null, 80, "v1", "{}", "{}", "v1", 0.9, "v1", "NONE", null, null,
          JSON.stringify({ kind: "PER_USER_CONSENT", consented: true }), 0,
        ],
      });
      const acceptedId = randomUUID();
      await client.execute({
        sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version, revoked_at, created_at)
              VALUES (?,?,?,?,?,${revoked ? "CURRENT_TIMESTAMP" : "NULL"},CURRENT_TIMESTAMP)`,
        args: [acceptedId, decisionId, sha, 50, "v1"],
      });
      await client.execute({
        sql: `INSERT INTO corpus_admission_promotions (id, decision_id, accepted_representation_id, representation_id, link_type, fingerprint_version, status, attempt_count, created_at, updated_at)
              VALUES (?,?,?,?,?,?,'indexed',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        args: [randomUUID(), decisionId, acceptedId, representationId, "NEW_CONTENT_REPRESENTATION", CORPUS_FINGERPRINT_VERSION],
      });
    },
    close() { client.close(); },
  };
  return api;
}

// --- Text building blocks -------------------------------------------------
//
// STOCK_TEXT is built almost entirely from
// lib/document-correspondence.ts's own GENERIC_ACADEMIC_REGISTER_WORDS: its
// 5-grams are still `informativeGram` (really indexed, really shared) but a
// stock-only matched span scores high on the generic-register density
// guardrail and can never be a distinctivePassageMatch — it stands in for
// "common academic boilerplate every document contains."
const STOCK_SENTENCES = [
  "the present study results and findings analysis discussion section",
  "further research using the standard procedure and appropriate treatment",
  "the general topic scope and broader consideration of related work",
  "prior observations reported throughout the paper and additional material",
  "the following section presents the document review and course assignment",
  "these terms taken together describe the process and the described method",
  "consistent results were noted following the standard analysis procedure",
];
const STOCK_TEXT = Array.from({ length: 10 }, () => STOCK_SENTENCES.join(". ")).join(". ") + ".";
const STOCK_HASHES = [...corpusShingleHashes(STOCK_TEXT, 5)];

// Genuinely distinctive ~70-word passages — specific nouns, no generic
// register — so a verbatim copy is an unambiguous distinctivePassageMatch.
const DISTINCTIVE_PASSAGE = [
  "Hydrothermal vent chimneys sampled along the Kairei field yielded pyrite framboids whose sulfur isotope signatures",
  "diverged sharply from the surrounding basalt-hosted deposits, implying a previously undocumented microbial sulfate reduction pathway",
  "operating within the chimney walls at temperatures near ninety degrees, and the recovered anhydrite laminae preserved",
  "fluid-inclusion evidence for episodic seawater entrainment that earlier surveys of the same ridge segment had entirely missed.",
].join(" ");
const DISTINCTIVE_PASSAGE_B = [
  "Excavation of the Late Bronze Age granary at Tel Qashish exposed a sealed storage jar containing carbonized",
  "emmer wheat interleaved with the mandibles of a commensal rodent species not previously attested north of the",
  "Jezreel valley, and residue analysis of the jar interior wall detected a beeswax lining applied in two",
  "distinct coats, a curation technique otherwise known only from contemporaneous sites on the Anatolian plateau.",
].join(" ");

function filler(marker, n = 45) {
  return Array.from({ length: n }, (_, i) => `${marker}nonce${i}word`).join(" ");
}

// Invariance configs: maxCandidates is raised well above the noise-rep count
// so ranked-LIMIT eviction is never the variable — the ONLY difference
// between these two runs is whether high-DF pruning happens, which is exactly
// the invariant under test. (Production keeps maxCandidates: 10; the A2 test
// below deliberately uses the real default to demonstrate the eviction that
// pruning fixes.)
const PRUNE_OFF = { maxCandidateShingleDocumentFrequency: null, maxCandidates: 300 };
const PRUNE_ON = { maxCandidateShingleDocumentFrequency: 50, maxCandidates: 300 };

function verifiedShape(match) {
  return match && {
    relationshipType: match.relationshipType,
    matchType: match.matchType,
    containment: match.containment,
    matchedWordCount: match.matchedWordCount,
    passageCount: match.passageCount,
    longestMatchWords: match.longestMatchWords,
    passages: match.passages,
  };
}
function entryFor(result, repId) {
  return result.status === "MATCHED" ? result.matches.find((m) => m.matchedRepresentationId === repId) : undefined;
}
function newDiag() {
  return { inputShingleCount: 0, survivingShingleCount: 0, highDfPrunedCount: 0, fallbackUsed: false, appliedMaxDocumentFrequency: null };
}

// =========================================================================
// A + B: boilerplate fanout collapses; the distinctive genuine candidate
// survives; verified output is byte-identical pruned vs unpruned.
// =========================================================================
test("A/B: boilerplate fanout collapses, the genuine distinctive source survives, and its verified match is byte-identical pruned vs unpruned", async () => {
  const c = await freshCorpus();
  try {
    // The source carries ONLY the distinctive passage (plus unique filler) —
    // no boilerplate — so the verified span is unambiguously the distinctive
    // passage. The query adds the shared boilerplate, which is what drives
    // fanout.
    const sourceText = `${filler("srcHead")} ${DISTINCTIVE_PASSAGE} ${filler("srcTail")}`;
    const sourceId = await c.indexRealSubmission("ab-source-owner", "Vent chimney study", sourceText);
    await c.seedBoilerplate(70, STOCK_HASHES); // every STOCK hash now has DF >= 70 > 50

    const queryText = canonicalizeText(`${filler("qHead")} ${DISTINCTIVE_PASSAGE} ${filler("qMid")} ${STOCK_TEXT} ${filler("qTail")}`);
    const queryShingles = corpusShingleHashes(queryText, 5);

    const before = await findCandidateCorpusRepresentations(c.client, queryShingles, {
      fingerprintVersion: CORPUS_FINGERPRINT_VERSION, minSharedShingles: 3, limit: 100000,
    });
    const diag = newDiag();
    const after = await findCandidateCorpusRepresentations(c.client, queryShingles, {
      fingerprintVersion: CORPUS_FINGERPRINT_VERSION, minSharedShingles: 3, limit: 100000,
      maxDocumentFrequency: 50, diagnostics: diag,
    });

    assert.ok(before.length >= 71, `unpruned: boilerplate reps + source are all candidates (got ${before.length})`);
    assert.ok(after.length <= 5, `pruned: boilerplate reps drop out of discovery (got ${after.length})`);
    assert.ok(after.length / before.length < 0.1, `fanout materially reduced (${after.length}/${before.length})`);
    assert.ok(before.some((x) => x.representationId === sourceId), "unpruned: genuine source is a candidate");
    assert.ok(after.some((x) => x.representationId === sourceId), "pruned: genuine source is STILL a candidate");
    assert.ok(diag.highDfPrunedCount > 0);
    assert.equal(diag.fallbackUsed, false);
    assert.equal(diag.appliedMaxDocumentFrequency, 50);
    assert.equal(diag.inputShingleCount, queryShingles.size);
    assert.equal(diag.survivingShingleCount + diag.highDfPrunedCount, queryShingles.size);

    const off = await matchAgainstUserSubmissionCorpus(c.client, { accountId: "ab-reader", canonicalText: queryText, config: PRUNE_OFF });
    const on = await matchAgainstUserSubmissionCorpus(c.client, { accountId: "ab-reader", canonicalText: queryText, config: PRUNE_ON });
    assert.equal(off.status, "MATCHED");
    assert.equal(on.status, "MATCHED");
    assert.deepEqual(verifiedShape(entryFor(on, sourceId)), verifiedShape(entryFor(off, sourceId)),
      "pruned vs unpruned: the genuine source's verified match must be byte-identical");
    assert.ok(entryFor(on, sourceId).longestMatchWords >= USER_SUBMISSION_MATCH_THRESHOLDS.correspondence.minimumDistinctivePassageWords);
  } finally { c.close(); }
});

// =========================================================================
// A2: at real scale pruning RESCUES a genuine source that boilerplate
// otherwise evicts past the ranked candidate limit.
// =========================================================================
test("A2: with many boilerplate reps, an unpruned search evicts the genuine source past maxCandidates; pruning restores it", async () => {
  const c = await freshCorpus();
  try {
    const sourceText = `${filler("a2src")} ${DISTINCTIVE_PASSAGE} ${filler("a2tail")}`;
    const sourceId = await c.indexRealSubmission("a2-owner", "S", sourceText);
    // 70 boilerplate reps: every STOCK hash now has DF 70 > maxDF(50), and
    // each noise rep shares MORE stock hashes with the query than the source
    // shares distinctive ones -> the real default maxCandidates: 10 evicts
    // the source unpruned.
    await c.seedBoilerplate(70, STOCK_HASHES);

    const queryText = canonicalizeText(`${filler("a2q")} ${DISTINCTIVE_PASSAGE} ${filler("a2qmid", 20)} ${STOCK_TEXT}`);

    // Real production defaults (maxCandidates: 10) — only the pruning knob differs.
    const off = await matchAgainstUserSubmissionCorpus(c.client, { accountId: "a2-reader", canonicalText: queryText, config: { maxCandidateShingleDocumentFrequency: null } });
    const on = await matchAgainstUserSubmissionCorpus(c.client, { accountId: "a2-reader", canonicalText: queryText, config: { maxCandidateShingleDocumentFrequency: 50 } });

    assert.ok(!entryFor(off, sourceId), "unpruned: the genuine source is evicted past maxCandidates by boilerplate noise (the bug this hardening fixes)");
    assert.ok(entryFor(on, sourceId), "pruned: the genuine source is restored to the candidate set and verified");
    assert.equal(on.matches[0].matchType, entryFor(on, sourceId).matchType);
  } finally { c.close(); }
});

// =========================================================================
// C: exact canonical duplicate survives even when every shingle is common.
// =========================================================================
test("C: an exact canonical duplicate of an all-boilerplate representation is still discovered, pruned and unpruned alike", async () => {
  const c = await freshCorpus();
  try {
    const dupText = `boilerplate-dup-marker ${STOCK_TEXT} ${STOCK_TEXT}`;
    const dupId = await c.seedRealRepresentation(dupText);
    await c.attachSubmissionReference(dupId, "c-owner");
    await c.seedBoilerplate(70, STOCK_HASHES);

    const canonical = canonicalizeText(dupText);
    const queryShingles = corpusShingleHashes(canonical, 5);
    const diag = newDiag();
    await findCandidateCorpusRepresentations(c.client, queryShingles, {
      fingerprintVersion: CORPUS_FINGERPRINT_VERSION, minSharedShingles: 3, limit: 100000, maxDocumentFrequency: 50, diagnostics: diag,
    });
    assert.ok(diag.fallbackUsed, "an all-boilerplate query trips the low-information fallback");
    assert.equal(diag.highDfPrunedCount, 0, "fallback ABANDONS pruning — nothing is pruned");
    assert.equal(diag.survivingShingleCount, queryShingles.size, "fallback searches on the complete original shingle set");

    const off = await matchAgainstUserSubmissionCorpus(c.client, { accountId: "c-reader", canonicalText: canonical, config: PRUNE_OFF });
    const on = await matchAgainstUserSubmissionCorpus(c.client, { accountId: "c-reader", canonicalText: canonical, config: PRUNE_ON });
    assert.equal(off.status, "MATCHED");
    assert.equal(on.status, "MATCHED", "exact canonical duplicate must remain discoverable even when every shingle is common");
    assert.equal(entryFor(on, dupId).matchType, "EXACT_CANONICAL_MATCH");
    assert.deepEqual(verifiedShape(entryFor(on, dupId)), verifiedShape(entryFor(off, dupId)));
  } finally { c.close(); }
});

// =========================================================================
// D: multiple genuine sources all survive.
// =========================================================================
test("D: a query copying distinctive passages from two different sources keeps BOTH, identical pruned vs unpruned", async () => {
  const c = await freshCorpus();
  try {
    const idA = await c.indexRealSubmission("d-owner-a", "Source A", `${filler("dA")} ${DISTINCTIVE_PASSAGE} ${filler("dAtail")}`);
    const idB = await c.indexRealSubmission("d-owner-b", "Source B", `${filler("dB")} ${DISTINCTIVE_PASSAGE_B} ${filler("dBtail")}`);
    await c.seedBoilerplate(70, STOCK_HASHES);

    const canonical = canonicalizeText(`${filler("dq1")} ${DISTINCTIVE_PASSAGE} ${filler("dq2")} ${DISTINCTIVE_PASSAGE_B} ${filler("dq3")} ${STOCK_TEXT}`);
    const off = await matchAgainstUserSubmissionCorpus(c.client, { accountId: "d-reader", canonicalText: canonical, config: PRUNE_OFF });
    const on = await matchAgainstUserSubmissionCorpus(c.client, { accountId: "d-reader", canonicalText: canonical, config: PRUNE_ON });

    for (const [label, r] of [["unpruned", off], ["pruned", on]]) {
      assert.equal(r.status, "MATCHED", `${label}: MATCHED`);
      assert.ok(entryFor(r, idA), `${label}: source A present`);
      assert.ok(entryFor(r, idB), `${label}: source B present`);
    }
    assert.deepEqual(verifiedShape(entryFor(on, idA)), verifiedShape(entryFor(off, idA)));
    assert.deepEqual(verifiedShape(entryFor(on, idB)), verifiedShape(entryFor(off, idB)));
  } finally { c.close(); }
});

// =========================================================================
// E: low-information query does not become a false NO_HISTORICAL_MATCH.
// =========================================================================
test("E: a mostly-boilerplate query that still contains a real copied passage stays MATCHED under pruning, same as unpruned", async () => {
  const c = await freshCorpus();
  try {
    const sourceId = await c.indexRealSubmission("e-owner", "Vent study E", `${filler("eSrc")} ${DISTINCTIVE_PASSAGE} ${filler("eSrcTail")}`);
    await c.seedBoilerplate(70, STOCK_HASHES);

    const canonical = canonicalizeText(`${STOCK_TEXT} ${STOCK_TEXT} ${DISTINCTIVE_PASSAGE} ${STOCK_TEXT}`);
    const off = await matchAgainstUserSubmissionCorpus(c.client, { accountId: "e-reader", canonicalText: canonical, config: PRUNE_OFF });
    const on = await matchAgainstUserSubmissionCorpus(c.client, { accountId: "e-reader", canonicalText: canonical, config: PRUNE_ON });
    assert.equal(off.status, "MATCHED", "unpruned finds the embedded copied passage");
    assert.equal(on.status, "MATCHED", "pruning must NOT turn 'insufficient discriminative shingles' into 'definitely no historical match'");
    assert.deepEqual(verifiedShape(entryFor(on, sourceId)), verifiedShape(entryFor(off, sourceId)));
  } finally { c.close(); }
});

// =========================================================================
// F: revoked/deactivated source stays excluded (pruning does not resurrect it).
// =========================================================================
test("F: a representation whose only backing is a revoked promotion is excluded pruned and unpruned alike", async () => {
  const c = await freshCorpus();
  try {
    const text = `${filler("fSrc")} ${DISTINCTIVE_PASSAGE} ${filler("fSrcTail")} ${STOCK_TEXT}`;
    const repId = await c.seedRealRepresentation(text);
    await c.insertPromotionBacking(repId, { accountId: "f-revoked-account", revoked: true });
    await c.seedBoilerplate(70, STOCK_HASHES);

    const canonical = canonicalizeText(text);
    const off = await matchAgainstUserSubmissionCorpus(c.client, { accountId: "f-reader", canonicalText: canonical, config: PRUNE_OFF });
    const on = await matchAgainstUserSubmissionCorpus(c.client, { accountId: "f-reader", canonicalText: canonical, config: PRUNE_ON });
    assert.ok(!entryFor(off, repId), "unpruned: revoked-only representation is not a match");
    assert.ok(!entryFor(on, repId), "pruned: revoked-only representation must still be excluded");
  } finally { c.close(); }
});

// =========================================================================
// G: same-account exclusion is preserved under pruning.
// =========================================================================
test("G: same-account-only backing stays excluded for that account under pruning; still matchable for a different account", async () => {
  const c = await freshCorpus();
  try {
    const text = `${filler("gSrc")} ${DISTINCTIVE_PASSAGE_B} ${filler("gSrcTail")} ${STOCK_TEXT}`;
    const repId = await c.seedRealRepresentation(text);
    await c.insertPromotionBacking(repId, { accountId: "g-account" });
    await c.seedBoilerplate(70, STOCK_HASHES);

    const canonical = canonicalizeText(text);
    const sameAccount = await matchAgainstUserSubmissionCorpus(c.client, { accountId: "g-account", canonicalText: canonical, excludeAccountId: "g-account", config: PRUNE_ON });
    assert.ok(!entryFor(sameAccount, repId), "pruned: a representation backed only by the querying account's own admission must not be offered to that account");
    const otherAccount = await matchAgainstUserSubmissionCorpus(c.client, { accountId: "g-other", canonicalText: canonical, excludeAccountId: "g-other", config: PRUNE_ON });
    assert.equal(otherAccount.status, "MATCHED", "pruned: a different account still matches it normally");
    assert.ok(entryFor(otherAccount, repId));
  } finally { c.close(); }
});

// =========================================================================
// H: large query drives the DF pass through multiple chunks; libSQL-safe.
// =========================================================================
test("H: a >32,766-shingle query drives the DF pass in chunks without exceeding the SQL variable limit", async () => {
  const c = await freshCorpus();
  try {
    const SQLITE_MAX_VARIABLE_NUMBER = 32_766;
    const largeText = Array.from({ length: 44_000 }, (_, i) => `mdtk${i.toString(36).padStart(6, "0")}`).join(" ");
    await c.indexRealSubmission("h-owner", "Large doc", largeText);
    const largeShingles = corpusShingleHashes(largeText, 5);
    assert.ok(largeShingles.size > SQLITE_MAX_VARIABLE_NUMBER, `precondition: ${largeShingles.size} > ${SQLITE_MAX_VARIABLE_NUMBER}`);

    const diag = newDiag();
    let survivors;
    await assert.doesNotReject(async () => {
      survivors = await applyHighFrequencyShinglePruning(c.client, largeShingles, {
        fingerprintVersion: CORPUS_FINGERPRINT_VERSION, maxDocumentFrequency: 50, minDiscriminativeShingles: 24, chunkSize: 20_000, diagnostics: diag,
      });
    }, "the DF pass must not throw SQLITE_ERROR: too many SQL variables");
    assert.equal(diag.inputShingleCount, largeShingles.size);
    assert.equal(survivors.size, largeShingles.size, "a unique large doc: every shingle is DF 1, nothing pruned");

    await assert.doesNotReject(async () => {
      await findCandidateCorpusRepresentations(c.client, largeShingles, {
        fingerprintVersion: CORPUS_FINGERPRINT_VERSION, minSharedShingles: 3, limit: 10, maxDocumentFrequency: 50,
      });
    });
  } finally { c.close(); }
});

// =========================================================================
// I: privacy — pruning adds no identity-shaped field anywhere.
// =========================================================================
test("I: candidate results and the diagnostics sink carry no account/representation identifiers under pruning", async () => {
  const c = await freshCorpus();
  try {
    const text = `${filler("iSrc")} ${DISTINCTIVE_PASSAGE} ${filler("iTail")} ${STOCK_TEXT}`;
    await c.indexRealSubmission("i-secret-account", "T", text);
    await c.seedBoilerplate(70, STOCK_HASHES);

    const diag = newDiag();
    const candidates = await findCandidateCorpusRepresentations(c.client, corpusShingleHashes(canonicalizeText(text), 5), {
      fingerprintVersion: CORPUS_FINGERPRINT_VERSION, minSharedShingles: 3, limit: 100, maxDocumentFrequency: 50,
      excludeAccountId: "i-secret-account", diagnostics: diag,
    });
    const serialized = JSON.stringify(candidates);
    assert.ok(!serialized.includes("i-secret-account"), "no account id in candidate results");
    assert.ok(!serialized.includes("secret-account@example.test"), "no email in candidate results");
    for (const candidate of candidates) {
      assert.deepEqual(
        Object.keys(candidate).sort(),
        ["canonicalSha256", "containment", "isActivelyPromoted", "representationId", "sharedShingleCount", "wordCount"].sort(),
        "the pruning feature must not add a field to the candidate shape",
      );
    }
    assert.deepEqual(
      Object.keys(diag).sort(),
      ["appliedMaxDocumentFrequency", "fallbackUsed", "highDfPrunedCount", "inputShingleCount", "survivingShingleCount"].sort(),
      "diagnostics are counts + one boolean only — no identifiers",
    );
    assert.ok(!JSON.stringify(diag).includes("i-secret-account"));
  } finally { c.close(); }
});

// =========================================================================
// J: no scoring/matcher threshold changed by this work.
// =========================================================================
test("J: the pruning work changed no correspondence / matcher threshold", () => {
  assert.equal(USER_SUBMISSION_MATCH_THRESHOLDS.correspondence.shingleSize, 5);
  assert.equal(USER_SUBMISSION_MATCH_THRESHOLDS.correspondence.strongContainmentThreshold, 0.5);
  assert.equal(USER_SUBMISSION_MATCH_THRESHOLDS.correspondence.minimumMatchedWords, 15);
  assert.equal(USER_SUBMISSION_MATCH_THRESHOLDS.correspondence.minimumPassageLengthWords, 8);
  assert.equal(USER_SUBMISSION_MATCH_THRESHOLDS.correspondence.minimumDistinctivePassageWords, 30);
  assert.equal(USER_SUBMISSION_MATCH_THRESHOLDS.candidateShingleThreshold, 3);
  assert.equal(USER_SUBMISSION_MATCH_THRESHOLDS.maxCandidates, 10);
  assert.equal(USER_SUBMISSION_MATCH_THRESHOLDS.maxCandidateWordCount, 20_000);
  assert.equal(USER_SUBMISSION_MATCH_THRESHOLDS.matchTimeBudgetMs, 2_500);
  assert.equal(USER_SUBMISSION_MATCH_THRESHOLDS.dbQueryTimeoutMs, 1_500);
  // The new knobs, asserted so a change is deliberate.
  assert.equal(USER_SUBMISSION_MATCH_THRESHOLDS.maxCandidateShingleDocumentFrequency, 50);
  assert.equal(USER_SUBMISSION_MATCH_THRESHOLDS.minDiscriminativeShingles, 24);
});

// =========================================================================
// K: disabled (null) => zero behavior change AND no extra DB round trip.
// =========================================================================
test("K: maxCandidateShingleDocumentFrequency null returns shingleHashes untouched with no DF query", async () => {
  const c = await freshCorpus();
  try {
    const hashes = corpusShingleHashes(canonicalizeText(`${filler("k")} ${DISTINCTIVE_PASSAGE}`), 5);
    let executeCalls = 0;
    const countingClient = {
      execute: (...args) => { executeCalls += 1; return c.client.execute(...args); },
      batch: (...args) => c.client.batch(...args),
      transaction: (...args) => c.client.transaction(...args),
      close: () => {},
    };
    const diag = newDiag();
    diag.appliedMaxDocumentFrequency = 999;
    const out = await applyHighFrequencyShinglePruning(countingClient, hashes, {
      fingerprintVersion: CORPUS_FINGERPRINT_VERSION, maxDocumentFrequency: undefined, minDiscriminativeShingles: 24, chunkSize: 20_000, diagnostics: diag,
    });
    assert.equal(executeCalls, 0, "disabled pruning must not touch the database");
    assert.equal(out, hashes, "disabled pruning returns the exact same Set reference");
    assert.equal(diag.appliedMaxDocumentFrequency, null);
    assert.equal(diag.highDfPrunedCount, 0);
    assert.equal(diag.inputShingleCount, hashes.size);
  } finally { c.close(); }
});

// =========================================================================
// L: INELIGIBLE-DF CORRECTNESS — DF counts MATCH-ELIGIBLE representations
// only. An eligible source sharing a copied passage with >50
// revoked/deactivated representations must still be discovered and MATCHED.
// (Run against the pre-fix raw-DF probe this FAILS: raw DF = 1 + 55 = 56 >
// 50 prunes every passage shingle and the source is never discovered.)
// =========================================================================
test("L: an eligible source is still discovered and MATCHED with maxDF on, even when >50 revoked/deactivated reps carry the same copied passage", async () => {
  const c = await freshCorpus();
  try {
    const passage = DISTINCTIVE_PASSAGE_B;
    const sourceId = await c.seedRealRepresentation(`${filler("lsrc")} ${passage} ${filler("lsrctail")}`);
    await c.attachSubmissionReference(sourceId, "l-source-owner"); // eligible via a real submission reference

    for (let i = 0; i < 55; i += 1) {
      const revId = await c.seedRealRepresentation(`${filler("lrev" + i)} ${passage} ${filler("lrevtail" + i)}`);
      await c.insertPromotionBacking(revId, { accountId: `l-revoked-${i}`, revoked: true }); // ineligible: revoked-only backing
    }

    // raw DF of every passage shingle is 56 (> maxDF 50); eligible DF is 1.
    const canonical = canonicalizeText(`${filler("lq")} ${passage} ${filler("lq2")} ${STOCK_TEXT}`); // NOT an exact canonical duplicate

    const diag = newDiag();
    const survivors = await applyHighFrequencyShinglePruning(c.client, corpusShingleHashes(canonical, 5), {
      fingerprintVersion: CORPUS_FINGERPRINT_VERSION, maxDocumentFrequency: 50, minDiscriminativeShingles: 24, chunkSize: 20_000, diagnostics: diag,
    });
    const passageHashes = [...corpusShingleHashes(canonicalizeText(passage), 5)];
    const keptPassage = passageHashes.filter((h) => survivors.has(h)).length;
    assert.ok(keptPassage >= passageHashes.length - 2, `the copied passage's shingles must survive — eligible DF is 1, not 56 (kept ${keptPassage}/${passageHashes.length})`);
    assert.equal(diag.fallbackUsed, false, "enough discriminative shingles survive without the fallback");

    const on = await matchAgainstUserSubmissionCorpus(c.client, { accountId: "l-reader", canonicalText: canonical, config: PRUNE_ON });
    const off = await matchAgainstUserSubmissionCorpus(c.client, { accountId: "l-reader", canonicalText: canonical, config: PRUNE_OFF });
    assert.equal(on.status, "MATCHED", "REQUIRED: the eligible active source must still be discovered and MATCHED with maxDF enabled");
    assert.ok(entryFor(on, sourceId), "the eligible source is the verified match");
    assert.equal(entryFor(on, sourceId).relationshipType, "PRIOR_SUBMISSION");
    assert.deepEqual(verifiedShape(entryFor(on, sourceId)), verifiedShape(entryFor(off, sourceId)));
    // and none of the 55 revoked reps leak into the result
    assert.equal(on.matches.length, 1, "only the eligible source matches; the 55 revoked reps are excluded");
  } finally { c.close(); }
});

// =========================================================================
// M: LOW-INFORMATION FALLBACK BYPASS — when fewer than
// minDiscriminativeShingles survive, pruning is abandoned for that query and
// a non-exact genuine copy still MATCHES, byte-identical to pruning disabled.
// =========================================================================
test("M: fallback abandons pruning (not 'keep N rarest') — a non-exact genuine copy in a mostly-boilerplate query MATCHES identically to pruning disabled", async () => {
  const c = await freshCorpus();
  try {
    const sourceId = await c.indexRealSubmission("m-owner", "S", `${filler("msrc")} ${DISTINCTIVE_PASSAGE} ${filler("mtail")}`);
    await c.seedBoilerplate(70, STOCK_HASHES);

    // The distinctive passage verbatim, embedded in heavy boilerplate — NOT
    // an exact canonical duplicate of the source.
    const canonical = canonicalizeText(`${STOCK_TEXT} ${DISTINCTIVE_PASSAGE} ${STOCK_TEXT} ${STOCK_TEXT}`);
    // floor set above the ~45 surviving distinctive shingles so the fallback
    // is the code path under test (not just "normal pruning kept enough").
    const cfgOn = { maxCandidateShingleDocumentFrequency: 50, minDiscriminativeShingles: 200, maxCandidates: 300 };
    const cfgOff = { maxCandidateShingleDocumentFrequency: null, maxCandidates: 300 };

    const diag = newDiag();
    await findCandidateCorpusRepresentations(c.client, corpusShingleHashes(canonical, 5), {
      fingerprintVersion: CORPUS_FINGERPRINT_VERSION, minSharedShingles: 3, limit: 100000,
      maxDocumentFrequency: 50, minDiscriminativeShingles: 200, diagnostics: diag,
    });
    assert.ok(diag.fallbackUsed, "surviving discriminative shingles < floor -> fallback");
    assert.equal(diag.highDfPrunedCount, 0, "fallback ABANDONS pruning — nothing pruned");
    assert.equal(diag.survivingShingleCount, diag.inputShingleCount, "fallback searches the complete original shingle set");

    const off = await matchAgainstUserSubmissionCorpus(c.client, { accountId: "m-reader", canonicalText: canonical, config: cfgOff });
    const on = await matchAgainstUserSubmissionCorpus(c.client, { accountId: "m-reader", canonicalText: canonical, config: cfgOn });
    assert.equal(off.status, "MATCHED", "the non-exact genuine copy is a real match");
    assert.equal(on.status, "MATCHED", "fallback bypass preserves it");
    assert.deepEqual(verifiedShape(entryFor(on, sourceId)), verifiedShape(entryFor(off, sourceId)),
      "fallback bypass == byte-identical to pruning disabled");
  } finally { c.close(); }
});

// =========================================================================
// N: DF is representation-frequency, not occurrence-frequency.
// =========================================================================
test("N: a phrase repeated many times inside ONE representation contributes DF 1, not N", async () => {
  const c = await freshCorpus();
  try {
    const sentence = "The obscure Zategelian ledger records seventeen previously uncatalogued riverine tribute tokens minted under a disputed provincial regency.";
    const repId = await c.seedRealRepresentation(Array.from({ length: 6 }, () => sentence).join(" "));
    await c.seedBoilerplate(60, STOCK_HASHES); // 60 reps that do NOT contain the sentence

    const sentenceHashes = [...corpusShingleHashes(canonicalizeText(sentence), 5)];
    assert.ok(sentenceHashes.length >= 3, "sanity: the sentence yields several informative shingles");
    const rows = await c.client.execute({
      sql: "SELECT COUNT(*) n FROM corpus_document_shingles WHERE representation_id = ? AND fingerprint_version = ? AND shingle_hash = ?",
      args: [repId, CORPUS_FINGERPRINT_VERSION, sentenceHashes[0]],
    });
    assert.equal(Number(rows.rows[0].n), 1, "ux_corpus_document_shingles_representation_version_hash: at most one row per (rep, version, hash), despite 6 occurrences");

    const diag = newDiag();
    const survivors = await applyHighFrequencyShinglePruning(c.client, new Set(sentenceHashes), {
      fingerprintVersion: CORPUS_FINGERPRINT_VERSION, maxDocumentFrequency: 2, minDiscriminativeShingles: 1, chunkSize: 20_000, diagnostics: diag,
    });
    assert.equal(diag.fallbackUsed, false);
    assert.equal(diag.highDfPrunedCount, 0, "representation-frequency is 1 (<= maxDf 2) -> nothing pruned, despite 6 in-document occurrences");
    assert.equal(survivors.size, sentenceHashes.length);
  } finally { c.close(); }
});

// =========================================================================
// O: DF MUST RESPECT REQUESTER ACCOUNT EXCLUSION — DF counts representations
// that are eligible FOR THIS REQUESTER, the same account-aware semantics the
// candidate query applies. A cross-account source sharing a copied passage
// with >50 of the REQUESTER'S OWN active promotion-backed representations
// must still be discovered and MATCHED.
// (Run against the account-NULL DF probe this FAILS: global eligible DF =
// 1 + 55 = 56 > 50 prunes the passage; account B's legitimate source
// becomes NO_HISTORICAL_MATCH for account A.)
// =========================================================================
test("O: a cross-account (B) source is still discovered and MATCHED for account A, even when >50 of account A's own active reps carry the same copied passage", async () => {
  const c = await freshCorpus();
  try {
    const passage = DISTINCTIVE_PASSAGE;
    const accountA = "o-account-a";
    const accountB = "o-account-b";

    // Cross-account source: account B, eligible via a real submission reference.
    const sourceB = await c.seedRealRepresentation(`${filler("osrcB")} ${passage} ${filler("osrcBtail")}`);
    await c.attachSubmissionReference(sourceB, `${accountB}-owner`);

    // 55 ACTIVE (non-revoked) representations backed only by account A's own
    // admission promotions — globally eligible, but NOT eligible for a query
    // from account A (excludeAccountId).
    for (let i = 0; i < 55; i += 1) {
      const repId = await c.seedRealRepresentation(`${filler("orepA" + i)} ${passage} ${filler("orepAtail" + i)}`);
      await c.insertPromotionBacking(repId, { accountId: accountA }); // active, account A
    }

    const canonical = canonicalizeText(`${filler("oq")} ${passage} ${filler("oq2")} ${STOCK_TEXT}`); // NOT an exact canonical duplicate

    // account-aware DF: only sourceB is eligible for account A -> DF 1.
    const diag = newDiag();
    const survivors = await applyHighFrequencyShinglePruning(c.client, corpusShingleHashes(canonical, 5), {
      fingerprintVersion: CORPUS_FINGERPRINT_VERSION, maxDocumentFrequency: 50, minDiscriminativeShingles: 24, chunkSize: 20_000,
      excludeAccountId: accountA, diagnostics: diag,
    });
    const passageHashes = [...corpusShingleHashes(canonicalizeText(passage), 5)];
    const keptPassage = passageHashes.filter((h) => survivors.has(h)).length;
    assert.ok(keptPassage >= passageHashes.length - 2, `the copied passage must survive — account-aware DF for account A is 1, not 56 (kept ${keptPassage}/${passageHashes.length})`);

    const onA = await matchAgainstUserSubmissionCorpus(c.client, { accountId: accountA, canonicalText: canonical, excludeAccountId: accountA, config: PRUNE_ON });
    const offA = await matchAgainstUserSubmissionCorpus(c.client, { accountId: accountA, canonicalText: canonical, excludeAccountId: accountA, config: PRUNE_OFF });
    assert.equal(onA.status, "MATCHED", "REQUIRED: account B's cross-account source must survive pruning and MATCH for account A");
    assert.ok(entryFor(onA, sourceB), "the cross-account source is the verified match");
    assert.equal(entryFor(onA, sourceB).relationshipType, "PRIOR_SUBMISSION");
    assert.deepEqual(verifiedShape(entryFor(onA, sourceB)), verifiedShape(entryFor(offA, sourceB)));

    // (2) account A's own 55 reps remain excluded — only sourceB matches.
    assert.equal(onA.matches.length, 1, "account A's own promotion-backed reps are excluded; only the cross-account source matches");

    // (3) the fix is SCOPED to the excluded account — it does not globally
    // loosen pruning. For a different-account requester (C) the 55 account-A
    // promotion-backed reps ARE eligible, so the passage's account-aware DF
    // for C is 56 (identical to global eligibility) and it is pruned exactly
    // as the pre-fix probe would have pruned it for everyone.
    const survivorsC = await applyHighFrequencyShinglePruning(c.client, corpusShingleHashes(canonical, 5), {
      fingerprintVersion: CORPUS_FINGERPRINT_VERSION, maxDocumentFrequency: 50, minDiscriminativeShingles: 24, chunkSize: 20_000,
      excludeAccountId: "o-account-c",
    });
    const keptPassageC = passageHashes.filter((h) => survivorsC.has(h)).length;
    assert.ok(keptPassageC <= 2, "for a different-account requester the 55 account-A reps ARE eligible -> passage DF is 56 -> pruned; the fix does not globally loosen pruning");

    const survivorsGlobal = await applyHighFrequencyShinglePruning(c.client, corpusShingleHashes(canonical, 5), {
      fingerprintVersion: CORPUS_FINGERPRINT_VERSION, maxDocumentFrequency: 50, minDiscriminativeShingles: 24, chunkSize: 20_000,
    });
    assert.equal(
      passageHashes.filter((h) => survivorsGlobal.has(h)).length,
      keptPassageC,
      "no-excludeAccountId and a different-account excludeAccountId agree — the fix only ever removes the requester's OWN backings from the count",
    );
  } finally { c.close(); }
});
