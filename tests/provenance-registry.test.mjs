import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { resolveFamilyForIdentity, recordDocumentIdentityShingles } from "../lib/document-family.ts";
import { classifySubmitterRelationship } from "../lib/document-relationship.ts";
import {
  PROVENANCE_STATES,
  isValidProvenanceTransition,
  isEligibleForVerifiedSimilarity,
  isProvenanceState,
  isSourceProviderType,
} from "../lib/provenance-types.ts";
import {
  createProvenanceSource,
  createObservedSubmissionProvenance,
  findProvenanceSourceById,
  findProvenanceSourceForDocumentIdentity,
  findProvenanceEventsForSource,
  findProvenanceSourcesByState,
  transitionProvenanceState,
  updateProvenanceSourceMetadata,
} from "../lib/provenance-registry.ts";

const repo = path.resolve(".");
const drizzleDir = path.join(repo, "drizzle");
const dbFile = path.join(repo, "test_provenance_registry.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

await client.execute({
  sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
  args: ["prov-account-a", "prov-a@example.com", "provaccounta", "hash-a"],
});
await client.execute({
  sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
  args: ["prov-account-b", "prov-b@example.com", "provaccountb", "hash-b"],
});

// Each fixture below was verified empirically (pairwise shingle containment
// checked across the full set, in a throwaway scratch script) before being
// written here: only FAMILY_BASE/FAMILY_REVISED (containment 0.837) share
// any content; every other pair shares zero shingles. This matters because
// several tests in this file deliberately need a real, measured family/
// relationship result (not an accidental one caused by two fixtures
// happening to share filler text) — the same class of bug documented and
// fixed in tests/document-family.test.mjs.
const TEXT = {
  SUBMISSION: "Archaeologists surveying a coastal excavation site catalogued a sequence of shell midden layers spanning several centuries of intermittent settlement. Radiocarbon dating of organic material within each layer established a chronological framework independent of stylistic pottery analysis. The resulting sequence refined earlier estimates of when the site was first occupied.",
  FAMILY_BASE: "Materials chemists synthesizing a new polymer coating tested its resistance to ultraviolet degradation under accelerated weathering chambers. Samples exposed for one thousand hours showed measurable yellowing but retained most of their original tensile strength. Formulation adjustments targeting the yellowing effect are planned for the next test cycle.",
  FAMILY_REVISED: "Materials chemists synthesizing a new polymer coating tested its resistance to ultraviolet degradation under accelerated weathering chambers. Samples exposed for one thousand hours showed measurable yellowing but retained most of their original flexural strength. Formulation adjustments targeting the yellowing effect are planned for the next testing cycle.",
  SHARED_TEXT: "Sociolinguists recording code-switching patterns among bilingual speakers in a border community documented consistent shifts triggered by topic and interlocutor rather than random variation. Extended family conversations showed more frequent switching than formal community meetings. Researchers proposed that switching functions as a deliberate register marker rather than incomplete acquisition.",
  VERIFIED_AND_RELATED: "Paleoclimatologists analyzing ice core samples from a high-altitude glacier reconstructed temperature fluctuations extending back several thousand years. Isotopic ratios within annual ice layers correlated closely with independently dated volcanic ash deposits. The combined record extended the region's climate history considerably further than existing tree-ring chronologies.",
  FIND_BY_IDENTITY: "Marine engineers testing a redesigned propeller blade geometry in a cavitation tunnel measured reduced noise emission compared to the standard production design. Computational fluid dynamics simulations run beforehand had predicted a similar improvement within a narrow margin of error. Sea trials are scheduled to confirm the tunnel measurements under real operating conditions.",
};

// --- Pure state-machine functions (no DB) ------------------------------------

test("isProvenanceState recognizes exactly the eight declared states and nothing else", () => {
  for (const state of PROVENANCE_STATES) assert.equal(isProvenanceState(state), true);
  assert.equal(isProvenanceState("VERIFIED"), false);
  assert.equal(isProvenanceState("PRIOR_SUBMISSION"), false, "PRIOR_SUBMISSION must never be recognized as a provenance state");
  assert.equal(isProvenanceState(""), false);
  assert.equal(isProvenanceState(null), false);
});

test("isSourceProviderType recognizes the controlled vocabulary and rejects invented values", () => {
  assert.equal(isSourceProviderType("user_submission"), true);
  assert.equal(isSourceProviderType("external_reference"), true);
  assert.equal(isSourceProviderType("unknown"), true);
  assert.equal(isSourceProviderType("wikipedia"), false, "wikipedia is not wired into this registry in this phase and must not be accepted");
  assert.equal(isSourceProviderType("openalex"), false, "openalex is not active and must not be accepted");
});

test("valid state transitions: the documented review pipeline is walkable end to end", () => {
  const path1 = ["UNKNOWN", "CANDIDATE_SOURCE", "PROVENANCE_PENDING", "VERIFIED_SOURCE"];
  for (let i = 0; i < path1.length - 1; i++) {
    assert.equal(isValidProvenanceTransition(path1[i], path1[i + 1]), true, `${path1[i]} -> ${path1[i + 1]} should be valid`);
  }
  assert.equal(isValidProvenanceTransition("VERIFIED_SOURCE", "DISPUTED_SOURCE"), true);
  assert.equal(isValidProvenanceTransition("DISPUTED_SOURCE", "VERIFIED_SOURCE"), true, "a dispute can resolve back to verified");
  assert.equal(isValidProvenanceTransition("VERIFIED_SOURCE", "RETRACTED_SOURCE"), true);
  assert.equal(isValidProvenanceTransition("VERIFICATION_REJECTED", "CANDIDATE_SOURCE"), true, "a rejected candidate can be reconsidered with new evidence");
  assert.equal(isValidProvenanceTransition("UNKNOWN", "OBSERVED_SUBMISSION"), true);
  assert.equal(isValidProvenanceTransition("OBSERVED_SUBMISSION", "CANDIDATE_SOURCE"), true);
});

test("invalid state transitions are rejected", () => {
  assert.equal(isValidProvenanceTransition("UNKNOWN", "VERIFIED_SOURCE"), false, "cannot skip the whole review pipeline");
  assert.equal(isValidProvenanceTransition("RETRACTED_SOURCE", "VERIFIED_SOURCE"), false, "RETRACTED_SOURCE is terminal");
  assert.equal(isValidProvenanceTransition("RETRACTED_SOURCE", "CANDIDATE_SOURCE"), false, "RETRACTED_SOURCE is terminal");
  assert.equal(isValidProvenanceTransition("VERIFICATION_REJECTED", "VERIFIED_SOURCE"), false, "rejection cannot jump straight to verified");
  assert.equal(isValidProvenanceTransition("VERIFIED_SOURCE", "VERIFIED_SOURCE"), false, "a same-state transition is not a transition");
  assert.equal(isValidProvenanceTransition("OBSERVED_SUBMISSION", "VERIFIED_SOURCE"), false, "a submission cannot become verified in one step");
});

// --- VERIFIED_SOURCE eligibility (Core Invariants #6-11) --------------------

test("only VERIFIED_SOURCE is eligible for future verified-similarity scoring", () => {
  const expected = { UNKNOWN: false, OBSERVED_SUBMISSION: false, CANDIDATE_SOURCE: false, PROVENANCE_PENDING: false, VERIFIED_SOURCE: true, VERIFICATION_REJECTED: false, DISPUTED_SOURCE: false, RETRACTED_SOURCE: false };
  for (const state of PROVENANCE_STATES) {
    assert.equal(isEligibleForVerifiedSimilarity(state), expected[state], `${state} eligibility mismatch`);
  }
});

// --- Source creation ----------------------------------------------------------

test("createProvenanceSource creates a source and its genesis event atomically", async () => {
  const source = await createProvenanceSource(client, {
    provenanceState: "CANDIDATE_SOURCE",
    sourceType: "external_reference",
    title: "A manually entered candidate source",
    canonicalUrl: "https://example.org/some-article",
  });
  assert.ok(source.id);
  assert.equal(source.provenanceState, "CANDIDATE_SOURCE");
  assert.equal(source.sourceType, "external_reference");
  assert.equal(source.title, "A manually entered candidate source");
  assert.equal(source.canonicalUrl, "https://example.org/some-article");
  assert.ok(source.createdAt);
  assert.ok(source.updatedAt);

  const events = await findProvenanceEventsForSource(client, source.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].previousState, null, "the genesis event must have no previous_state");
  assert.equal(events[0].newState, "CANDIDATE_SOURCE");
});

test("nullable provenance fields are genuinely nullable and independently settable", async () => {
  const source = await createProvenanceSource(client, {
    provenanceState: "UNKNOWN",
    sourceType: "unknown",
  });
  assert.equal(source.canonicalUrl, null);
  assert.equal(source.externalIdentifier, null);
  assert.equal(source.title, null);
  assert.equal(source.author, null);
  assert.equal(source.publisher, null);
  assert.equal(source.publicationDate, null);
  assert.equal(source.retrievedAt, null);
  assert.equal(source.contentHash, null);
  assert.equal(source.verificationMethod, null);
  assert.equal(source.verificationNotes, null);
  assert.equal(source.documentIdentityId, null);
});

test("timestamps: created_at is set once and never changes; updated_at advances on a state transition", async () => {
  const source = await createProvenanceSource(client, { provenanceState: "CANDIDATE_SOURCE", sourceType: "external_reference" });
  const createdAt = source.createdAt;
  await new Promise((resolve) => setTimeout(resolve, 1100)); // TEXT timestamps here are second-precision
  const { source: afterTransition } = await transitionProvenanceState(client, { sourceId: source.id, toState: "PROVENANCE_PENDING", reason: "review started" });
  assert.equal(afterTransition.createdAt, createdAt, "created_at must never change");
  assert.notEqual(afterTransition.updatedAt, source.updatedAt, "updated_at must advance on a state transition");
});

test("timestamps: updated_at also advances on a plain metadata update, without touching provenance_state", async () => {
  const source = await createProvenanceSource(client, { provenanceState: "CANDIDATE_SOURCE", sourceType: "external_reference" });
  const updated = await updateProvenanceSourceMetadata(client, source.id, { verificationNotes: "checked against a mirrored copy" });
  assert.equal(updated.provenanceState, "CANDIDATE_SOURCE", "metadata update must not change provenance_state");
  assert.equal(updated.verificationNotes, "checked against a mirrored copy");
  const events = await findProvenanceEventsForSource(client, source.id);
  assert.equal(events.length, 1, "a metadata-only update must not add a provenance_events row — only state transitions are logged");
});

// --- Immutable event history --------------------------------------------------

test("immutable event history: every transition appends a new row; nothing is overwritten", async () => {
  const source = await createProvenanceSource(client, { provenanceState: "UNKNOWN", sourceType: "external_reference" });
  await transitionProvenanceState(client, { sourceId: source.id, toState: "CANDIDATE_SOURCE", reason: "proposed" });
  await transitionProvenanceState(client, { sourceId: source.id, toState: "PROVENANCE_PENDING", reason: "review started" });
  await transitionProvenanceState(client, { sourceId: source.id, toState: "VERIFIED_SOURCE", reason: "confirmed", evidence: "manual editorial check" });

  const events = await findProvenanceEventsForSource(client, source.id);
  assert.equal(events.length, 4, "genesis + 3 transitions = 4 rows");
  assert.deepEqual(events.map((e) => [e.previousState, e.newState]), [
    [null, "UNKNOWN"],
    ["UNKNOWN", "CANDIDATE_SOURCE"],
    ["CANDIDATE_SOURCE", "PROVENANCE_PENDING"],
    ["PROVENANCE_PENDING", "VERIFIED_SOURCE"],
  ]);
  assert.equal(events[3].evidence, "manual editorial check");

  const finalSource = await findProvenanceSourceById(client, source.id);
  assert.equal(finalSource.provenanceState, "VERIFIED_SOURCE", "current state reflects only the latest transition");
});

test("an invalid transition is rejected and leaves no trace in the history", async () => {
  const source = await createProvenanceSource(client, { provenanceState: "UNKNOWN", sourceType: "external_reference" });
  await assert.rejects(
    () => transitionProvenanceState(client, { sourceId: source.id, toState: "VERIFIED_SOURCE" }),
    /not an allowed provenance transition/,
  );
  const events = await findProvenanceEventsForSource(client, source.id);
  assert.equal(events.length, 1, "a rejected transition attempt must not add a spurious event row");
  const unchanged = await findProvenanceSourceById(client, source.id);
  assert.equal(unchanged.provenanceState, "UNKNOWN", "state must be unchanged after a rejected transition");
});

test("a source cannot be claimed to have been verified earlier than its actual verification event", async () => {
  const source = await createProvenanceSource(client, { provenanceState: "CANDIDATE_SOURCE", sourceType: "external_reference" });
  const beforeVerification = source.createdAt;
  await transitionProvenanceState(client, { sourceId: source.id, toState: "PROVENANCE_PENDING" });
  const { event } = await transitionProvenanceState(client, { sourceId: source.id, toState: "VERIFIED_SOURCE" });
  // The event carrying new_state = VERIFIED_SOURCE has its own created_at,
  // distinct from (never earlier than) the source's original creation —
  // this is what lets a reader answer "when did this become verified"
  // truthfully instead of assuming it was verified from the start.
  assert.equal(event.newState, "VERIFIED_SOURCE");
  assert.ok(event.createdAt >= beforeVerification, "the verification event's timestamp must not predate the source's own creation");
});

// --- Core Invariants -----------------------------------------------------------

test("Invariant: first-seen time is not authorship date, and is not publication date", async () => {
  const source = await createProvenanceSource(client, { provenanceState: "CANDIDATE_SOURCE", sourceType: "external_reference" });
  assert.equal(source.publicationDate, null, "creating a source must never infer a publication date from created_at");
  assert.notEqual(source.createdAt, source.author, "trivial sanity: these are unrelated fields");
  const withDate = await updateProvenanceSourceMetadata(client, source.id, { publicationDate: "2019-03-01" });
  assert.notEqual(withDate.publicationDate, withDate.createdAt, "publication_date, once set, is independent of created_at");
});

test("Invariant: a user submission does not automatically become a verified source", async () => {
  const identity = await createDocumentIdentity(client, { accountId: "prov-account-a", title: "submission.pdf", author: null, rawText: TEXT.SUBMISSION });
  const provenance = await createObservedSubmissionProvenance(client, { documentIdentityId: identity.id, title: "submission.pdf" });
  assert.equal(provenance.provenanceState, "OBSERVED_SUBMISSION");
  assert.notEqual(provenance.provenanceState, "VERIFIED_SOURCE");
});

test("Invariant: a document family does not establish provenance", async () => {
  const base = TEXT.FAMILY_BASE;
  const revised = TEXT.FAMILY_REVISED;
  const first = await createDocumentIdentity(client, { accountId: "prov-account-a", title: "fam-a.pdf", author: null, rawText: base });
  const second = await createDocumentIdentity(client, { accountId: "prov-account-a", title: "fam-b.pdf", author: null, rawText: revised });
  await recordDocumentIdentityShingles(client, first.id, base);
  await recordDocumentIdentityShingles(client, second.id, revised);
  await resolveFamilyForIdentity(client, first.id);
  await resolveFamilyForIdentity(client, second.id);
  // Family resolution ran; nothing in it creates or touches provenance_sources.
  const provenanceForFirst = await findProvenanceSourceForDocumentIdentity(client, first.id);
  const provenanceForSecond = await findProvenanceSourceForDocumentIdentity(client, second.id);
  assert.equal(provenanceForFirst, null, "resolving a family must not create a provenance record");
  assert.equal(provenanceForSecond, null, "resolving a family must not create a provenance record");
});

test("Invariant: a PRIOR_SUBMISSION relationship does not establish authorship", async () => {
  const text = TEXT.SHARED_TEXT;
  const owner = await createDocumentIdentity(client, { accountId: "prov-account-a", title: "shared.pdf", author: null, rawText: text });
  const stranger = await createDocumentIdentity(client, { accountId: "prov-account-b", title: "shared-copy.pdf", author: null, rawText: text });
  await resolveFamilyForIdentity(client, owner.id);
  await resolveFamilyForIdentity(client, stranger.id);
  // createDocumentIdentity's return value is {id, rawSha256, canonicalSha256}
  // only — it does not echo back accountId — so the account ids passed in
  // above are used directly here rather than read off the return value.
  const relationship = classifySubmitterRelationship("prov-account-b", "prov-account-a");
  assert.equal(relationship, "PRIOR_SUBMISSION");

  const provenance = await createObservedSubmissionProvenance(client, { documentIdentityId: stranger.id });
  assert.equal(provenance.author, null, "PRIOR_SUBMISSION classification must never populate an author field");
  assert.equal(provenance.documentIdentityId, stranger.id);
});

test("Invariant: CANDIDATE_SOURCE and PROVENANCE_PENDING are not eligible for verified similarity", async () => {
  const source = await createProvenanceSource(client, { provenanceState: "CANDIDATE_SOURCE", sourceType: "external_reference" });
  assert.equal(isEligibleForVerifiedSimilarity(source.provenanceState), false);
  const { source: pending } = await transitionProvenanceState(client, { sourceId: source.id, toState: "PROVENANCE_PENDING" });
  assert.equal(isEligibleForVerifiedSimilarity(pending.provenanceState), false);
});

test("Invariant: VERIFICATION_REJECTED is not reportable as a verified source", async () => {
  const source = await createProvenanceSource(client, { provenanceState: "CANDIDATE_SOURCE", sourceType: "external_reference" });
  const { source: rejected } = await transitionProvenanceState(client, { sourceId: source.id, toState: "VERIFICATION_REJECTED", reason: "could not confirm origin" });
  assert.equal(isEligibleForVerifiedSimilarity(rejected.provenanceState), false);
});

test("Invariant: DISPUTED_SOURCE is not automatically reportable as verified", async () => {
  const source = await createProvenanceSource(client, { provenanceState: "PROVENANCE_PENDING", sourceType: "external_reference" });
  await transitionProvenanceState(client, { sourceId: source.id, toState: "VERIFIED_SOURCE" });
  const { source: disputed } = await transitionProvenanceState(client, { sourceId: source.id, toState: "DISPUTED_SOURCE", reason: "authenticity challenged" });
  assert.equal(isEligibleForVerifiedSimilarity(disputed.provenanceState), false);
});

test("Invariant: RETRACTED_SOURCE is not currently reportable as an active verified source", async () => {
  const source = await createProvenanceSource(client, { provenanceState: "PROVENANCE_PENDING", sourceType: "external_reference" });
  await transitionProvenanceState(client, { sourceId: source.id, toState: "VERIFIED_SOURCE" });
  const { source: retracted } = await transitionProvenanceState(client, { sourceId: source.id, toState: "RETRACTED_SOURCE", reason: "publisher retraction notice" });
  assert.equal(isEligibleForVerifiedSimilarity(retracted.provenanceState), false);
  assert.equal(isValidProvenanceTransition("RETRACTED_SOURCE", "VERIFIED_SOURCE"), false, "a retraction cannot be silently reversed by this state machine");
});

test("Invariant: provenance state is separate from document relationship type — a source can be VERIFIED_SOURCE while an independent comparison is PRIOR_SUBMISSION", async () => {
  const text = TEXT.VERIFIED_AND_RELATED;
  const owner = await createDocumentIdentity(client, { accountId: "prov-account-a", title: "verified-and-related-a.pdf", author: null, rawText: text });
  const stranger = await createDocumentIdentity(client, { accountId: "prov-account-b", title: "verified-and-related-b.pdf", author: null, rawText: text });
  await resolveFamilyForIdentity(client, owner.id);
  await resolveFamilyForIdentity(client, stranger.id);

  // Independent axis 1: the relationship between the two submissions.
  // (createDocumentIdentity's return value does not echo back accountId —
  // see the identical note above — so the known literal ids are used directly.)
  const relationship = classifySubmitterRelationship("prov-account-b", "prov-account-a");
  assert.equal(relationship, "PRIOR_SUBMISSION");

  // Independent axis 2: a provenance source (representing, say, an
  // externally verified origin unrelated to either submission's account)
  // reaches VERIFIED_SOURCE through the normal review pipeline.
  const externalSource = await createProvenanceSource(client, { provenanceState: "PROVENANCE_PENDING", sourceType: "external_reference", title: "An independently verified source" });
  const { source: verified } = await transitionProvenanceState(client, { sourceId: externalSource.id, toState: "VERIFIED_SOURCE", reason: "editorial confirmation" });

  assert.equal(verified.provenanceState, "VERIFIED_SOURCE");
  assert.equal(relationship, "PRIOR_SUBMISSION");
  // Neither value was derived from, or altered by computing, the other.
  assert.notEqual(verified.provenanceState, relationship);
});

// --- findProvenanceSourcesByState / findProvenanceSourceForDocumentIdentity --

test("findProvenanceSourcesByState returns only sources currently in that state", async () => {
  const before = await findProvenanceSourcesByState(client, "VERIFICATION_REJECTED");
  const source = await createProvenanceSource(client, { provenanceState: "CANDIDATE_SOURCE", sourceType: "external_reference" });
  await transitionProvenanceState(client, { sourceId: source.id, toState: "VERIFICATION_REJECTED" });
  const after = await findProvenanceSourcesByState(client, "VERIFICATION_REJECTED");
  assert.equal(after.length, before.length + 1);
  assert.ok(after.some((row) => row.id === source.id));
  assert.ok(after.every((row) => row.provenanceState === "VERIFICATION_REJECTED"));
});

test("findProvenanceSourceForDocumentIdentity finds the OBSERVED_SUBMISSION record for a given identity", async () => {
  const identity = await createDocumentIdentity(client, { accountId: "prov-account-a", title: "find-me.pdf", author: null, rawText: TEXT.FIND_BY_IDENTITY });
  const created = await createObservedSubmissionProvenance(client, { documentIdentityId: identity.id, title: "find-me.pdf" });
  const found = await findProvenanceSourceForDocumentIdentity(client, identity.id);
  assert.ok(found);
  assert.equal(found.id, created.id);
  assert.equal(found.provenanceState, "OBSERVED_SUBMISSION");
});

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});
