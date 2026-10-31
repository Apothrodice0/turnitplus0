import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import {
  indexDocumentSubmissionIntoCorpus,
  createReusableDocumentRepresentation,
  recordCorpusShingles,
  findCandidateCorpusRepresentations,
  isRepresentationEligibleForMatching,
  corpusShingleHashes,
  corpusMaturityCutoff,
} from "../lib/user-submission-corpus.ts";
import { matchAgainstUserSubmissionCorpus } from "../lib/user-submission-matching.ts";

/**
 * Phase A — 7-day corpus maturity. Backing-level eligibility:
 *   submission-reference backing T0 = corpus_submission_references.created_at
 *   admission-promotion backing  T0 = corpus_admission_decisions.created_at
 *                                     WHERE decisions.id = promotions.decision_id
 *   legacy representation        T0 = corpus_document_representations.first_seen_at
 * Mature INCLUSIVELY at T0 + CORPUS_ACTIVATION_DELAY_DAYS <= asOf.
 * asOf is injected as `maturityCutoff` (== corpusMaturityCutoff(asOf)).
 */

const repoRoot = path.resolve(".");
const dbFile = path.join(repoRoot, "test_corpus_activation_7day.db");
for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, path.join(repoRoot, "drizzle"));

test.after(() => {
  client.close();
  for (const s of ["", "-wal", "-shm", "-journal"]) { try { fs.unlinkSync(`${dbFile}${s}`); } catch { /* ignore */ } }
});

// Every fixture shares a common academic-register boilerplate prefix, so two
// unrelated fixtures can cross-match through computeDocumentCorrespondence's
// 0.5 containment gate. Wipe the corpus between tests so each scenario is
// evaluated in isolation.
test.beforeEach(async () => {
  for (const t of [
    "corpus_document_shingles",
    "corpus_submission_references",
    "corpus_admission_promotions",
    "corpus_admission_accepted_representations",
    "corpus_admission_decisions",
    "corpus_document_representations",
    "document_identities",
    "report_historical_match_snapshots",
  ]) {
    await client.execute(`DELETE FROM ${t}`);
  }
});

const DAY = 86_400_000;
const NOW = Date.now();
const asOf = (offsetDays) => new Date(NOW + offsetDays * DAY);
const cutoff = (offsetDays) => corpusMaturityCutoff(asOf(offsetDays));
const sqlTs = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString().replace("T", " ").slice(0, 19);

let seq = 0;
function uniqueCanonicalText() {
  seq += 1;
  return canonicalizeText(
    "Hydrologists gauging a braided river reach installed acoustic doppler current profilers to quantify how bedload " +
    "transport responded to a managed flow release across the following fortnight of monitoring at this exact gauged " +
    `cross section. Distinct marker paragraph number ${seq} keeps each fixture's canonical fingerprint and corpus ` +
    "representation unambiguous so the exact-pair maturity resolver stays deterministic across every scenario tested.",
  );
}
async function account(id) {
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id,email,username,password_hash,corpus_reuse_consented_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)",
    args: [id, `${id}@t.test`, id, "h"],
  });
}

/** Index `text` for `accountId` (real path) and backdate its submission-reference T0. Returns representationId. */
async function seedSubmissionBacking(text, accountId, refDaysAgo) {
  await account(accountId);
  const identity = await createDocumentIdentity(client, { accountId, title: "d", author: null, rawText: text });
  const res = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText: text });
  await client.execute({
    sql: "UPDATE corpus_submission_references SET created_at = ? WHERE document_identity_id = ?",
    args: [sqlTs(refDaysAgo), identity.id],
  });
  return res.representationId;
}

/**
 * A direct admission-promotion backing: a decision aged `decisionDaysAgo`, an
 * accepted-representation aged `acceptedRepDaysAgo` (default = decision age;
 * override to prove maturity follows the DECISION), an 'indexed' promotion,
 * over `representationId` (created here if omitted). Returns { representationId, decisionId }.
 */
async function seedAdmissionBacking(text, accountId, decisionDaysAgo, opts = {}) {
  const {
    acceptedRepDaysAgo = decisionDaysAgo,
    repDaysAgo = decisionDaysAgo,
    revoked = false,
    linkType = "NEW_CONTENT_REPRESENTATION",
    representationId = null,
  } = opts;
  let repId = representationId;
  if (!repId) {
    const rep = await createReusableDocumentRepresentation(client, { canonicalText: text });
    repId = rep.id;
    await recordCorpusShingles(client, repId, text);
    await client.execute({
      sql: "UPDATE corpus_document_representations SET first_seen_at = ?, created_at = ? WHERE id = ?",
      args: [sqlTs(repDaysAgo), sqlTs(repDaysAgo), repId],
    });
  }
  const uid = randomUUID();
  const decId = `dec-${uid}`;
  const arId = `ar-${uid}`;
  const srcRef = `report-upload:account=${accountId}:device=dev-${uid}:report=r-${uid}`;
  await client.execute({
    sql: "INSERT INTO corpus_admission_decisions (id,source_ref,policy_version,decision,reason_codes,hard_gate_passed,hard_gate_failure_codes,canonical_sha256,dry_run,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    args: [decId, srcRef, "p1", "ACCEPT", "[]", 1, "[]", randomUUID().replace(/-/g, "").padEnd(64, "0"), 0, sqlTs(decisionDaysAgo)],
  });
  await client.execute({
    sql: "INSERT INTO corpus_admission_accepted_representations (id,decision_id,canonical_sha256,word_count,fingerprint_version,created_at,revoked_at) VALUES (?,?,?,?,?,?,?)",
    args: [arId, decId, randomUUID().replace(/-/g, "").padEnd(64, "0"), 40, "adm-fp", sqlTs(acceptedRepDaysAgo), revoked ? sqlTs(0) : null],
  });
  await client.execute({
    sql: "INSERT INTO corpus_admission_promotions (id,decision_id,accepted_representation_id,representation_id,link_type,fingerprint_version,status,attempt_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    args: [`prom-${uid}`, decId, arId, repId, linkType, "corpus-shingle-v1", "indexed", 1, sqlTs(decisionDaysAgo), sqlTs(0)],
  });
  return { representationId: repId, decisionId: decId };
}

/** A raw legacy representation — no submission reference, no promotion at all. */
async function seedLegacyRepresentation(text, firstSeenDaysAgo) {
  const rep = await createReusableDocumentRepresentation(client, { canonicalText: text });
  await recordCorpusShingles(client, rep.id, text);
  await client.execute({
    sql: "UPDATE corpus_document_representations SET first_seen_at = ?, created_at = ? WHERE id = ?",
    args: [sqlTs(firstSeenDaysAgo), sqlTs(firstSeenDaysAgo), rep.id],
  });
  return rep.id;
}

async function matchAsOf(reportText, reportAccount, asOfDays) {
  return matchAgainstUserSubmissionCorpus(client, {
    accountId: reportAccount,
    canonicalText: reportText,
    excludeAccountId: reportAccount ?? undefined,
    corpusSourceMatchingEnabled: true,
    maturityCutoff: cutoff(asOfDays),
  });
}

// ---------------------------------------------------------------------------

test("drizzle/0043 range indexes are applied", async () => {
  const names = (await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_corpus_submission_references_created_at','idx_corpus_admission_decisions_created_at')",
  )).rows.map((r) => r.name).sort();
  assert.deepEqual(names, ["idx_corpus_admission_decisions_created_at", "idx_corpus_submission_references_created_at"]);
  // The maturity-window range query uses an indexed SEARCH, not a table SCAN
  // (planner wording varies by SQLite build — assert only that no full scan
  // of the two big tables appears).
  const plan = (await client.execute({
    sql: `EXPLAIN QUERY PLAN
          SELECT (
            EXISTS (SELECT 1 FROM corpus_submission_references sr WHERE sr.created_at > ? AND sr.created_at <= ?)
            OR EXISTS (SELECT 1 FROM corpus_admission_decisions d WHERE d.created_at > ? AND d.created_at <= ?
                        AND EXISTS (SELECT 1 FROM corpus_admission_promotions p WHERE p.decision_id = d.id AND p.status = 'indexed'))
          ) AS matured`,
    args: [sqlTs(9), cutoff(0), sqlTs(9), cutoff(0)],
  })).rows.map((r) => r.detail).join(" | ");
  assert.ok(/idx_corpus_submission_references_created_at/.test(plan), `SR side should use the created_at index — plan: ${plan}`);
  assert.ok(/idx_corpus_admission_decisions_created_at/.test(plan), `decisions side should use the created_at index — plan: ${plan}`);
  assert.ok(!/SCAN corpus_submission_references\b(?!.*USING)/.test(plan) && !/SCAN corpus_admission_decisions\b(?!.*USING)/.test(plan), `no full table scan — plan: ${plan}`);
});

test("submission backing 6 days -> invisible; exactly 7 days (inclusive) -> visible; 8 days -> visible", async () => {
  const text = uniqueCanonicalText();
  await seedSubmissionBacking(text, "A-subage", /* refDaysAgo */ 6);

  const at0 = await matchAsOf(text, "B-subage", 0); // A is 6 days old
  assert.equal(at0.status, "NO_HISTORICAL_MATCH", "A backing 6 days old is not yet eligible");

  const at1 = await matchAsOf(text, "B-subage", 1); // A is 7 days old exactly
  assert.equal(at1.status, "MATCHED");
  assert.equal(at1.matches[0].relationshipType, "PRIOR_SUBMISSION");

  const at2 = await matchAsOf(text, "B-subage", 2); // A is 8 days old
  assert.equal(at2.status, "MATCHED");
});

test("admission decision 6 days -> invisible; 8 days -> visible (TURNITPLUS_CORPUS_SOURCE)", async () => {
  const text = uniqueCanonicalText();
  await seedAdmissionBacking(text, "A-admage", /* decisionDaysAgo */ 6);
  const before = await matchAsOf(text, "B-admage", 0);
  assert.equal(before.status, "NO_HISTORICAL_MATCH");
  const after = await matchAsOf(text, "B-admage", 2);
  assert.equal(after.status, "MATCHED");
  assert.equal(after.matches[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");
});

test("accepted-representation age OLD but this backing's own DECISION young -> the young decision keeps it invisible", async () => {
  const text = uniqueCanonicalText();
  // canonical-SHA-unique accepted_representations row is 40 days old; THIS backing's decision is 2 days old.
  await seedAdmissionBacking(text, "A-anchor", /* decisionDaysAgo */ 2, { acceptedRepDaysAgo: 40, repDaysAgo: 40 });
  const soon = await matchAsOf(text, "B-anchor", 3); // decision 5 days old -> still immature
  assert.equal(soon.status, "NO_HISTORICAL_MATCH", "maturity follows the decision (5d), not the 43d-old accepted-representation or first_seen_at");
  const later = await matchAsOf(text, "B-anchor", 6); // decision 8 days old
  assert.equal(later.status, "MATCHED");
});

test("revoked OLD backing + live YOUNG backing on the same representation -> does not inherit the old age", async () => {
  const text = uniqueCanonicalText();
  // First backing: decision 40 days ago, its accepted_representation now revoked.
  const first = await seedAdmissionBacking(text, "A-old", 40, { revoked: true, repDaysAgo: 40 });
  // Second backing on the SAME representation: decision 3 days ago, live.
  await seedAdmissionBacking(text, "C-new", 3, { representationId: first.representationId, linkType: "EXACT_CANONICAL_DUPLICATE" });

  const soon = await matchAsOf(text, "B-rr", 3); // live decision is 6 days old
  assert.equal(soon.status, "NO_HISTORICAL_MATCH", "the live young backing (6d) governs; the revoked 43d one is not eligible");
  const later = await matchAsOf(text, "B-rr", 6); // live decision 9 days old
  assert.equal(later.status, "MATCHED");
});

test("A day 0 + C day 4 (independent submission backings): day6 none / day8 A only / day12 both mature", async () => {
  const text = uniqueCanonicalText();
  const repId = await seedSubmissionBacking(text, "A-2b", /* refDaysAgo */ 0); // T0 = day 0
  await account("C-2b");
  const cIdent = await createDocumentIdentity(client, { accountId: "C-2b", title: "d", author: null, rawText: text });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: cIdent.id, rawText: text });
  await client.execute({ sql: "UPDATE corpus_submission_references SET created_at = ? WHERE document_identity_id = ?", args: [sqlTs(-4), cIdent.id] }); // T0 = day +4

  const matureBackings = async (offsetDays) =>
    Number((await client.execute({
      sql: "SELECT COUNT(*) AS c FROM corpus_submission_references WHERE representation_id = ? AND created_at <= ?",
      args: [repId, cutoff(offsetDays)],
    })).rows[0].c);
  assert.equal(await matureBackings(6), 0, "day 6: neither backing mature");
  assert.equal(await matureBackings(8), 1, "day 8: only A (day 0) mature");
  assert.equal(await matureBackings(12), 2, "day 12: both A (day 0) and C (day 4) mature");

  assert.equal(await isRepresentationEligibleForMatching(client, repId, { maturityCutoff: cutoff(6) }), false);
  assert.equal(await isRepresentationEligibleForMatching(client, repId, { maturityCutoff: cutoff(8) }), true, "one mature backing makes the representation visible while the other is immature");
  assert.equal(await isRepresentationEligibleForMatching(client, repId, { maturityCutoff: cutoff(12) }), true);
});

test("fresh legacy representation (no submission ref, no promotion) waits the full 7 days via first_seen_at", async () => {
  const text = uniqueCanonicalText();
  const repId = await seedLegacyRepresentation(text, /* firstSeenDaysAgo */ 2);
  assert.equal(await isRepresentationEligibleForMatching(client, repId, { maturityCutoff: cutoff(0) }), false, "first_seen_at 2d ago -> not eligible");
  assert.equal(await isRepresentationEligibleForMatching(client, repId, { maturityCutoff: cutoff(4) }), false, "first_seen_at ~6d ago -> still not eligible");
  assert.equal(await isRepresentationEligibleForMatching(client, repId, { maturityCutoff: cutoff(5) }), true, "first_seen_at 7d ago -> eligible (inclusive)");
});

test("old legacy representation remains eligible (first_seen_at far in the past)", async () => {
  const text = uniqueCanonicalText();
  const repId = await seedLegacyRepresentation(text, /* firstSeenDaysAgo */ 400);
  assert.equal(await isRepresentationEligibleForMatching(client, repId, { maturityCutoff: cutoff(0) }), true);
  // End-to-end: an anonymous submission of the same text still reaches this
  // legacy rep as a candidate (a signed-in account drops a no-ownership,
  // no-promotion legacy match as UNKNOWN — pre-existing E8D behaviour,
  // unrelated to Phase A).
  const res = await matchAsOf(text, null, 0);
  assert.equal(res.status, "MATCHED");
  assert.equal(res.matches[0].relationshipType, "UNKNOWN_RELATIONSHIP");
});

test("account exclusion uses the promotion decision's OWN source_ref (byte-identical where p.decision_id == ar.decision_id)", async () => {
  const text = uniqueCanonicalText();
  const { representationId } = await seedAdmissionBacking(text, "OWNER-excl", 20);
  const ownerView = await matchAsOf(text, "OWNER-excl", 0);
  assert.equal(ownerView.status, "NO_HISTORICAL_MATCH", "own admission backing excluded via d.source_ref (d joined on p.decision_id)");
  const otherView = await matchAsOf(text, "OTHER-excl", 0);
  assert.equal(otherView.status, "MATCHED");
  assert.equal(otherView.matches[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");
  assert.equal(await isRepresentationEligibleForMatching(client, representationId, { excludeAccountId: "OWNER-excl", maturityCutoff: cutoff(0) }), false);
  assert.equal(await isRepresentationEligibleForMatching(client, representationId, { excludeAccountId: "OTHER-excl", maturityCutoff: cutoff(0) }), true);
});

test("DF / high-frequency shingle pruning counts only MATURE eligible representations", async () => {
  const sharedHash = `sh-shared-${randomUUID()}`;
  for (let i = 0; i < 60; i++) {
    await account(`imm-acct-${i}`);
    const di = await createDocumentIdentity(client, { accountId: `imm-acct-${i}`, title: "d", author: null, rawText: `immature distinct body number ${i} ${uniqueCanonicalText()}` });
    const rep = await createReusableDocumentRepresentation(client, { canonicalText: `immature distinct body number ${i}` });
    await client.execute({
      sql: "INSERT INTO corpus_submission_references (representation_id,document_identity_id,link_type,created_at) VALUES (?,?,?,?)",
      args: [rep.id, di.id, "NEW_CONTENT_REPRESENTATION", sqlTs(1)], // 1 day old -> immature
    });
    await client.execute({
      sql: "INSERT OR IGNORE INTO corpus_document_shingles (representation_id,shingle_hash,fingerprint_version,created_at) VALUES (?,?,?,?)",
      args: [rep.id, sharedHash, "corpus-shingle-v1", sqlTs(1)],
    });
  }
  // one mature source carrying the same shingle
  await account("df-mature");
  const matureDi = await createDocumentIdentity(client, { accountId: "df-mature", title: "d", author: null, rawText: `mature df carrier ${uniqueCanonicalText()}` });
  const matureRep = await createReusableDocumentRepresentation(client, { canonicalText: `mature df carrier body` });
  await client.execute({
    sql: "INSERT INTO corpus_submission_references (representation_id,document_identity_id,link_type,created_at) VALUES (?,?,?,?)",
    args: [matureRep.id, matureDi.id, "NEW_CONTENT_REPRESENTATION", sqlTs(30)],
  });
  await client.execute({
    sql: "INSERT OR IGNORE INTO corpus_document_shingles (representation_id,shingle_hash,fingerprint_version,created_at) VALUES (?,?,?,?)",
    args: [matureRep.id, sharedHash, "corpus-shingle-v1", sqlTs(30)],
  });

  const diag = {};
  const results = await findCandidateCorpusRepresentations(client, new Set([sharedHash]), {
    minSharedShingles: 1,
    maxDocumentFrequency: 50,
    minDiscriminativeShingles: 0,
    maturityCutoff: cutoff(0),
    diagnostics: diag,
  });
  assert.equal(diag.highDfPrunedCount, 0, "maturity-aware DF sees only 1 eligible rep for the shared shingle -> nothing pruned");
  assert.ok(results.some((c) => c.representationId === matureRep.id), "the mature source survives discovery");

  // Contrast: the ADMISSION_DEDUP bypass — the ONLY way to skip the maturity
  // gate — counts all 62 and the shared shingle trips the DF ceiling. An
  // ordinary matching caller cannot reach this behaviour (see
  // tests/corpus-maturity-safe-by-default.test.mjs).
  const diagBlind = {};
  await findCandidateCorpusRepresentations(client, new Set([sharedHash]), {
    minSharedShingles: 1,
    maxDocumentFrequency: 50,
    minDiscriminativeShingles: 0,
    eligibilityMode: "ADMISSION_DEDUP",
    diagnostics: diagBlind,
  });
  assert.equal(diagBlind.highDfPrunedCount, 1, "ADMISSION_DEDUP DF counts all 62 -> prunes the shared shingle");
});
