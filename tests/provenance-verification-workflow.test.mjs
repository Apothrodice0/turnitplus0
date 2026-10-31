import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { resolveFamilyForIdentity, recordDocumentIdentityShingles } from "../lib/document-family.ts";
import { classifySubmitterRelationship } from "../lib/document-relationship.ts";
import { createProvenanceSource, findProvenanceSourceById, findProvenanceEventsForSource, transitionProvenanceState } from "../lib/provenance-registry.ts";
import { createProvenanceEvidence, findEvidenceForSource } from "../lib/provenance-evidence.ts";
import { evaluateVerificationEligibility, evaluateVerificationGate } from "../lib/provenance-verification-policy.ts";
import {
  approveVerification,
  rejectVerification,
  recordDispute,
  recordRetraction,
  reaffirmVerification,
  findVerificationDecisionsForSource,
} from "../lib/provenance-verification-workflow.ts";

const repo = path.resolve(".");
const drizzleDir = path.join(repo, "drizzle");
const dbFile = path.join(repo, "test_provenance_verification_workflow.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

await client.execute({
  sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
  args: ["wf-account-a", "wf-a@example.com", "wfaccounta", "hash-a"],
});
await client.execute({
  sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
  args: ["wf-account-b", "wf-b@example.com", "wfaccountb", "hash-b"],
});

let evidenceSeq = 0;
function nextObservedAt() {
  evidenceSeq += 1;
  return `2026-08-01T00:${String(evidenceSeq).padStart(2, "0")}:00.000Z`;
}

/** Seeds the eight evidence records that together satisfy all nine gate criteria (the ninth, NO_UNRESOLVED_CONFLICT, is satisfied by the absence of any conflict/dispute/retraction record) — the same fixture shape proven in tests/provenance-verification-policy.test.mjs, but written through the real DB repository this time. */
async function seedFullEvidence(sourceId) {
  await createProvenanceEvidence(client, { sourceId, evidenceType: "EXTERNAL_IDENTIFIER", payload: { identifierType: "DOI", identifierValue: "10.1234/workflow-test" }, observedAt: nextObservedAt() });
  await createProvenanceEvidence(client, { sourceId, evidenceType: "SOURCE_CLASS", payload: { sourceClass: "academic_journal", eligibleForVerification: true }, observedAt: nextObservedAt() });
  await createProvenanceEvidence(client, { sourceId, evidenceType: "PUBLISHER_IDENTITY", payload: { publisher: "Example University Press", domain: "example.edu" }, observedAt: nextObservedAt() });
  await createProvenanceEvidence(client, { sourceId, evidenceType: "CANONICAL_CORRESPONDENCE", payload: { method: "canonical_hash", match: true }, observedAt: nextObservedAt() });
  await createProvenanceEvidence(client, { sourceId, evidenceType: "RETRIEVAL_TIMESTAMP", payload: { retrievedAt: "2026-08-01T00:00:00.000Z" }, observedAt: nextObservedAt() });
  await createProvenanceEvidence(client, { sourceId, evidenceType: "CONTENT_HASH", payload: { candidateHash: "abc", externalHash: "abc", algorithm: "sha256", match: true }, observedAt: nextObservedAt() });
  await createProvenanceEvidence(client, { sourceId, evidenceType: "URL_ACCESSIBILITY", payload: { url: "https://example.edu/article", httpStatus: 200, retrievedAt: "2026-08-01T00:00:00.000Z", accessible: true }, observedAt: nextObservedAt() });
  await createProvenanceEvidence(client, { sourceId, evidenceType: "DISCOVERY_INDEPENDENCE", payload: { discoveryType: "INDEPENDENT_DISCOVERY", independent: true, basis: "found via curated registry" }, observedAt: nextObservedAt() });
}

async function newPendingSourceWithFullEvidence(title) {
  const source = await createProvenanceSource(client, { provenanceState: "PROVENANCE_PENDING", sourceType: "external_reference", title });
  await seedFullEvidence(source.id);
  return source;
}

// --- BASIC ---------------------------------------------------------------

test("BASIC: candidate -> pending needs no new E5 code — it is a plain E1 transition with no evidence gate", async () => {
  const source = await createProvenanceSource(client, { provenanceState: "CANDIDATE_SOURCE", sourceType: "external_reference", title: "candidate to pending" });
  const { source: pending } = await transitionProvenanceState(client, { sourceId: source.id, toState: "PROVENANCE_PENDING", reason: "review started" });
  assert.equal(pending.provenanceState, "PROVENANCE_PENDING");
});

test("BASIC: pending -> verified via approveVerification", async () => {
  const source = await newPendingSourceWithFullEvidence("pending to verified");
  const result = await approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW", reason: "all nine criteria satisfied" });
  assert.equal(result.stateChanged, true);
  assert.equal(result.newState, "VERIFIED_SOURCE");
  assert.equal(result.decision.decision, "APPROVED");
});

test("BASIC: pending -> rejected via rejectVerification", async () => {
  const source = await createProvenanceSource(client, { provenanceState: "PROVENANCE_PENDING", sourceType: "external_reference", title: "pending to rejected" });
  const result = await rejectVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW", reason: "source identity could not be established" });
  assert.equal(result.stateChanged, true);
  assert.equal(result.newState, "VERIFICATION_REJECTED");
  assert.equal(result.decision.decision, "REJECTED");
});

// --- GATE ------------------------------------------------------------------

test("GATE: approveVerification fails when required evidence is missing", async () => {
  const source = await createProvenanceSource(client, { provenanceState: "PROVENANCE_PENDING", sourceType: "external_reference", title: "no evidence at all" });
  await assert.rejects(
    () => approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" }),
    /verification gate not satisfied/,
  );
  const unchanged = await findProvenanceSourceById(client, source.id);
  assert.equal(unchanged.provenanceState, "PROVENANCE_PENDING");
});

test("GATE: approveVerification succeeds when all nine criteria exist", async () => {
  const source = await newPendingSourceWithFullEvidence("all nine criteria");
  const result = await approveVerification(client, { sourceId: source.id, method: "SYSTEM_POLICY", reason: "automated policy check passed" });
  assert.equal(result.newState, "VERIFIED_SOURCE");
});

test("GATE: an explicit decision is required even when the gate already passes", async () => {
  const source = await newPendingSourceWithFullEvidence("gate passes but nobody decided yet");
  const evidence = await findEvidenceForSource(client, source.id);
  const evaluation = evaluateVerificationEligibility(evidence);
  assert.equal(evaluation.eligible, true, "the fixture must actually satisfy the gate for this test to mean anything");

  // Evaluating the gate is a pure, read-only computation — it must never by
  // itself move the source out of PROVENANCE_PENDING.
  const stillPending = await findProvenanceSourceById(client, source.id);
  assert.equal(stillPending.provenanceState, "PROVENANCE_PENDING");
  const decisions = await findVerificationDecisionsForSource(client, source.id);
  assert.equal(decisions.length, 0, "no decision has been made yet, so no decision row should exist");
});

// --- NEGATIVE EVIDENCE -------------------------------------------------------

test("NEGATIVE EVIDENCE: an unresolved mirror conflict blocks approveVerification", async () => {
  const source = await newPendingSourceWithFullEvidence("mirror conflict blocks");
  await createProvenanceEvidence(client, { sourceId: source.id, evidenceType: "MIRROR_CONFLICT", payload: { description: "a mirrored copy exists elsewhere", resolved: false }, observedAt: nextObservedAt() });
  await assert.rejects(() => approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" }), /verification gate not satisfied/);
});

test("NEGATIVE EVIDENCE: an unresolved source dispute blocks approveVerification", async () => {
  const source = await newPendingSourceWithFullEvidence("dispute blocks");
  await createProvenanceEvidence(client, { sourceId: source.id, evidenceType: "SOURCE_DISPUTE", payload: { description: "authenticity challenged", resolved: false }, observedAt: nextObservedAt() });
  await assert.rejects(() => approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" }), /verification gate not satisfied/);
});

test("NEGATIVE EVIDENCE: an active retraction record blocks approveVerification", async () => {
  const source = await newPendingSourceWithFullEvidence("retraction evidence blocks");
  await createProvenanceEvidence(client, { sourceId: source.id, evidenceType: "RETRACTION", payload: { description: "publisher retraction notice found", active: true }, observedAt: nextObservedAt() });
  await assert.rejects(() => approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" }), /verification gate not satisfied/);
});

test("NEGATIVE EVIDENCE: positive evidence remains after negative evidence appears", async () => {
  const source = await newPendingSourceWithFullEvidence("positive survives negative");
  const beforeCount = (await findEvidenceForSource(client, source.id)).length;
  await createProvenanceEvidence(client, { sourceId: source.id, evidenceType: "MIRROR_CONFLICT", payload: { description: "a mirrored copy exists elsewhere", resolved: false }, observedAt: nextObservedAt() });
  const evidence = await findEvidenceForSource(client, source.id);
  assert.equal(evidence.length, beforeCount + 1, "the negative record must be appended, not replace anything");
  assert.ok(evidence.some((e) => e.evidenceType === "CANONICAL_CORRESPONDENCE" && e.payload.match === true), "the original positive correspondence evidence must still be present and unchanged");
});

// --- STATE SAFETY ------------------------------------------------------------

test("STATE SAFETY: an invalid transition is rejected (approving a CANDIDATE_SOURCE directly, skipping PROVENANCE_PENDING)", async () => {
  const source = await createProvenanceSource(client, { provenanceState: "CANDIDATE_SOURCE", sourceType: "external_reference", title: "skip pending" });
  await seedFullEvidence(source.id);
  await assert.rejects(
    () => approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" }),
    /not an allowed provenance transition/,
  );
});

test("STATE SAFETY: the workflow reuses the centralized transition validator, not a second implementation", () => {
  const source = fs.readFileSync(path.join(repo, "lib", "provenance-verification-workflow.ts"), "utf8");
  const imports = source.split(/\r?\n/).filter((l) => /^\s*(?:import|export)\b.*\bfrom\b/.test(l)).join("\n");
  assert.match(imports, /isValidProvenanceTransition/, "must import and reuse Phase E1's validator");
  assert.doesNotMatch(source, /ALLOWED_TRANSITIONS/, "must not redefine the transition graph locally");
});

test("STATE SAFETY: a provenance_events row is created for a state-changing decision", async () => {
  const source = await newPendingSourceWithFullEvidence("event created");
  const beforeEvents = await findProvenanceEventsForSource(client, source.id);
  await approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW", reason: "looks good" });
  const afterEvents = await findProvenanceEventsForSource(client, source.id);
  assert.equal(afterEvents.length, beforeEvents.length + 1);
  const latest = afterEvents.at(-1);
  assert.equal(latest.previousState, "PROVENANCE_PENDING");
  assert.equal(latest.newState, "VERIFIED_SOURCE");
});

test("STATE SAFETY: a verification-decision row is created alongside the transition", async () => {
  const source = await newPendingSourceWithFullEvidence("decision row created");
  const result = await approveVerification(client, { sourceId: source.id, method: "ADMIN_REVIEW", reason: "reviewed and approved" });
  const decisions = await findVerificationDecisionsForSource(client, source.id);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].id, result.decision.id);
  assert.equal(decisions[0].method, "ADMIN_REVIEW");
  assert.equal(decisions[0].reason, "reviewed and approved");
});

test("STATE SAFETY: previousState is preserved on the decision record", async () => {
  const source = await newPendingSourceWithFullEvidence("previous state preserved");
  const result = await approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" });
  assert.equal(result.decision.previousState, "PROVENANCE_PENDING");
  assert.equal(result.decision.requestedState, "VERIFIED_SOURCE");
});

test("STATE SAFETY: a failed transition attempt leaves no partial state (no event, no decision, no state change)", async () => {
  const source = await createProvenanceSource(client, { provenanceState: "PROVENANCE_PENDING", sourceType: "external_reference", title: "failed attempt leaves nothing" });
  const eventsBefore = await findProvenanceEventsForSource(client, source.id);
  const decisionsBefore = await findVerificationDecisionsForSource(client, source.id);

  await assert.rejects(() => approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" }));

  const eventsAfter = await findProvenanceEventsForSource(client, source.id);
  const decisionsAfter = await findVerificationDecisionsForSource(client, source.id);
  const sourceAfter = await findProvenanceSourceById(client, source.id);

  assert.equal(eventsAfter.length, eventsBefore.length, "no new provenance_events row on failure");
  assert.equal(decisionsAfter.length, decisionsBefore.length, "no new decision row on failure");
  assert.equal(sourceAfter.provenanceState, "PROVENANCE_PENDING", "state must be unchanged on failure");
});

// --- RE-VERIFICATION ---------------------------------------------------------

test("RE-VERIFICATION: verified -> disputed via recordDispute", async () => {
  const source = await newPendingSourceWithFullEvidence("verified to disputed");
  await approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" });
  const result = await recordDispute(client, { sourceId: source.id, method: "HUMAN_REVIEW", reason: "authenticity challenged by a third party" });
  assert.equal(result.newState, "DISPUTED_SOURCE");
  assert.equal(result.decision.decision, "DISPUTED");
});

test("RE-VERIFICATION: verified -> retracted via recordRetraction", async () => {
  const source = await newPendingSourceWithFullEvidence("verified to retracted");
  await approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" });
  const result = await recordRetraction(client, { sourceId: source.id, method: "HUMAN_REVIEW", reason: "publisher issued a retraction notice" });
  assert.equal(result.newState, "RETRACTED_SOURCE");
  assert.equal(result.decision.decision, "RETRACTED");
});

test("RE-VERIFICATION: a retracted source cannot silently return to verified", async () => {
  const source = await newPendingSourceWithFullEvidence("retracted stays retracted");
  await approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" });
  await recordRetraction(client, { sourceId: source.id, method: "HUMAN_REVIEW", reason: "retracted" });
  await assert.rejects(
    () => approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW", reason: "attempting to un-retract" }),
    /not an allowed provenance transition/,
  );
  const stillRetracted = await findProvenanceSourceById(client, source.id);
  assert.equal(stillRetracted.provenanceState, "RETRACTED_SOURCE");
});

test("RE-VERIFICATION: explicit re-verification can restore VERIFIED_SOURCE from DISPUTED_SOURCE when the gate still passes", async () => {
  const source = await newPendingSourceWithFullEvidence("dispute resolves back to verified");
  await approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" });
  await recordDispute(client, { sourceId: source.id, method: "HUMAN_REVIEW", reason: "challenge raised" });
  const restored = await approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW", reason: "challenge investigated and found baseless" });
  assert.equal(restored.newState, "VERIFIED_SOURCE");
  assert.equal(restored.decision.previousState, "DISPUTED_SOURCE");
});

test("RE-VERIFICATION: reaffirmVerification records a REAFFIRMED decision without a state change or a new provenance_events row", async () => {
  const source = await newPendingSourceWithFullEvidence("reaffirmed");
  await approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" });
  const eventsBefore = await findProvenanceEventsForSource(client, source.id);

  const result = await reaffirmVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW", reason: "new evidence reviewed, still holds" });
  assert.equal(result.stateChanged, false);
  assert.equal(result.newState, "VERIFIED_SOURCE");
  assert.equal(result.decision.decision, "REAFFIRMED");
  assert.equal(result.decision.previousState, "VERIFIED_SOURCE");
  assert.equal(result.decision.requestedState, "VERIFIED_SOURCE");

  const eventsAfter = await findProvenanceEventsForSource(client, source.id);
  assert.equal(eventsAfter.length, eventsBefore.length, "reaffirmation must not create a provenance_events row");
});

test("RE-VERIFICATION: reaffirmVerification refuses to reaffirm once the gate no longer passes", async () => {
  const source = await newPendingSourceWithFullEvidence("cannot reaffirm once evidence fails");
  await approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" });
  await createProvenanceEvidence(client, { sourceId: source.id, evidenceType: "RETRACTION", payload: { description: "later found to be withdrawn", active: true }, observedAt: nextObservedAt() });
  await assert.rejects(
    () => reaffirmVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" }),
    /evidence no longer supports verification/,
  );
});

test("RE-VERIFICATION: reaffirmVerification refuses to run on a non-VERIFIED_SOURCE", async () => {
  const source = await newPendingSourceWithFullEvidence("not verified yet");
  await assert.rejects(() => reaffirmVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" }), /not VERIFIED_SOURCE/);
});

// --- IDEMPOTENCY ---------------------------------------------------------------

test("IDEMPOTENCY: a repeated equivalent approveVerification call is a safe no-op", async () => {
  const source = await newPendingSourceWithFullEvidence("idempotent repeat");
  const first = await approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" });
  assert.equal(first.stateChanged, true);
  const decisionsAfterFirst = await findVerificationDecisionsForSource(client, source.id);

  const second = await approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" });
  assert.equal(second.stateChanged, false);
  assert.equal(second.decision, null);
  assert.equal(second.newState, "VERIFIED_SOURCE");

  const decisionsAfterSecond = await findVerificationDecisionsForSource(client, source.id);
  assert.equal(decisionsAfterSecond.length, decisionsAfterFirst.length, "a pure repeat must not write a duplicate decision row");
});

test("IDEMPOTENCY: a contradictory decision request is rejected, not silently accepted", async () => {
  const source = await newPendingSourceWithFullEvidence("contradictory rejected");
  await approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" });
  // VERIFIED_SOURCE has no edge to VERIFICATION_REJECTED in Phase E1's graph
  // — attempting it must fail, not quietly overwrite the verified state.
  await assert.rejects(
    () => rejectVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW", reason: "trying to contradict an existing verification" }),
    /not an allowed provenance transition/,
  );
  const stillVerified = await findProvenanceSourceById(client, source.id);
  assert.equal(stillVerified.provenanceState, "VERIFIED_SOURCE");
});

// --- SEPARATION ----------------------------------------------------------------

test("SEPARATION: a PRIOR_SUBMISSION relationship has no bearing on verification eligibility", async () => {
  const relationship = classifySubmitterRelationship("wf-account-b", "wf-account-a");
  assert.equal(relationship, "PRIOR_SUBMISSION");

  const source = await createProvenanceSource(client, { provenanceState: "PROVENANCE_PENDING", sourceType: "external_reference", title: "prior submission does not verify" });
  await assert.rejects(() => approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" }), /verification gate not satisfied/);
});

test("SEPARATION: a SELF relationship has no bearing on verification eligibility", async () => {
  const relationship = classifySubmitterRelationship("wf-account-a", "wf-account-a");
  assert.equal(relationship, "SELF");

  const source = await createProvenanceSource(client, { provenanceState: "PROVENANCE_PENDING", sourceType: "external_reference", title: "self does not verify" });
  await assert.rejects(() => approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" }), /verification gate not satisfied/);
});

test("SEPARATION: resolving a document family creates no provenance_sources or verification-decision rows", async () => {
  // Identical text on purpose (guarantees EXACT_CANONICAL_MATCH deterministically,
  // with no dependence on the shingle-containment threshold) — this test only
  // needs "a family forms," not any particular match type.
  const text = "Volcanologists monitoring seismic tremor patterns beneath an active caldera correlated harmonic tremor onset with subsequent minor eruptive events. Historical records over four decades showed the correlation held even for eruptions rated below explosivity index two. The team proposed harmonic tremor duration as an early operational warning signal.";
  const first = await createDocumentIdentity(client, { accountId: "wf-account-a", title: "volcano-a.pdf", author: null, rawText: text });
  const second = await createDocumentIdentity(client, { accountId: "wf-account-a", title: "volcano-b.pdf", author: null, rawText: text });
  await recordDocumentIdentityShingles(client, first.id, text);
  await recordDocumentIdentityShingles(client, second.id, text);
  // Resolving `first` also discovers `second` (already fingerprinted above)
  // as a same-family candidate, so `first` itself is the one that comes back
  // EXACT_CANONICAL_MATCH; resolving `second` afterward just finds the
  // family it was already attached to as the SEED member. Either way, what
  // this test actually needs is simply "a family formed" — not which of the
  // two calls reports which label.
  const firstResolved = await resolveFamilyForIdentity(client, first.id);
  const secondResolved = await resolveFamilyForIdentity(client, second.id);
  assert.ok(firstResolved.familyId && secondResolved.familyId, "the fixture must actually form a family for this test to mean anything");
  assert.equal(firstResolved.familyId, secondResolved.familyId, "both identities must land in the same family");

  // first.id/second.id are document_identity_ids, never provenance_sources
  // ids — no provenance_sources row was created for either identity by
  // family resolution, so there is nothing to look up a decision for.
  const decisionsForFirst = await findVerificationDecisionsForSource(client, first.id);
  assert.equal(decisionsForFirst.length, 0);
});

test("SEPARATION: the verification workflow never changes relationship classification", async () => {
  const before = classifySubmitterRelationship("wf-account-b", "wf-account-a");
  const source = await newPendingSourceWithFullEvidence("relationship unaffected");
  await approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" });
  const after = classifySubmitterRelationship("wf-account-b", "wf-account-a");
  assert.equal(before, "PRIOR_SUBMISSION");
  assert.equal(after, "PRIOR_SUBMISSION");
});

// --- IMMUTABILITY --------------------------------------------------------------

test("IMMUTABILITY: lib/provenance-verification-workflow.ts never updates or deletes a verification-decision row", () => {
  const source = fs.readFileSync(path.join(repo, "lib", "provenance-verification-workflow.ts"), "utf8");
  assert.doesNotMatch(source, /UPDATE\s+provenance_verification_decisions/i);
  assert.doesNotMatch(source, /DELETE\s+FROM\s+provenance_verification_decisions/i);
});

// Strips comments before searching code — this file's own doc comments
// legitimately name "provenance_events" several times in prose (explaining
// that transitionProvenanceState owns it), which would otherwise false-
// positive a plain substring search; same fix as
// tests/provenance-scoring-invariance.test.mjs's stripComments.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("IMMUTABILITY: lib/provenance-verification-workflow.ts never issues SQL against provenance_events directly — every state change is routed through transitionProvenanceState", () => {
  const source = fs.readFileSync(path.join(repo, "lib", "provenance-verification-workflow.ts"), "utf8");
  assert.doesNotMatch(stripComments(source), /provenance_events/, "this file must have no direct SQL reference to provenance_events at all outside of comments");
});

test("IMMUTABILITY: evidence records are unchanged by a full approve/dispute/retract cycle", async () => {
  const source = await newPendingSourceWithFullEvidence("evidence unchanged through workflow");
  const before = await findEvidenceForSource(client, source.id);
  await approveVerification(client, { sourceId: source.id, method: "HUMAN_REVIEW" });
  await recordDispute(client, { sourceId: source.id, method: "HUMAN_REVIEW", reason: "challenge raised" });
  await recordRetraction(client, { sourceId: source.id, method: "HUMAN_REVIEW", reason: "retracted after dispute" });
  const after = await findEvidenceForSource(client, source.id);
  assert.deepEqual(after, before, "none of the four evidence-reading workflow calls above may modify any evidence row");
});

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});
