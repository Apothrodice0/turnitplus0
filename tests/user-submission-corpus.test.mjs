import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity, canonicalSha256 } from "../lib/document-identity.ts";
import {
  indexDocumentSubmissionIntoCorpus,
  findReusableRepresentationByCanonicalHash,
  findReusableRepresentationByRawHash,
  findSubmissionReferencesForAccount,
  findAccountSubmissionForCanonicalHash,
  findCandidateCorpusRepresentations,
  recordSubmissionReference,
  createReusableDocumentRepresentation,
  corpusShingleHashes,
  CORPUS_FINGERPRINT_VERSION,
} from "../lib/user-submission-corpus.ts";

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_user_submission_corpus.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

const knownUsers = new Set();
async function ensureUser(accountId) {
  if (accountId === null || knownUsers.has(accountId)) return;
  knownUsers.add(accountId);
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
    args: [accountId, `${accountId}@example.test`, accountId, "not-a-real-hash"],
  });
}

async function submit(accountId, title, rawText) {
  await ensureUser(accountId);
  const identity = await createDocumentIdentity(client, { accountId, title, author: null, rawText });
  const result = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  return { identity, result };
}

async function countRepresentations() {
  const r = await client.execute("SELECT COUNT(*) AS cnt FROM corpus_document_representations");
  return Number(r.rows[0].cnt);
}
async function countSubmissionReferences() {
  const r = await client.execute("SELECT COUNT(*) AS cnt FROM corpus_submission_references");
  return Number(r.rows[0].cnt);
}

const DOCUMENT_X = [
  "Ornithologists tracking migratory songbirds fitted with miniature geolocators documented a previously unrecorded stopover site.",
  "Birds using the stopover site gained significantly more body mass per day than birds recorded at three other established locations.",
  "Habitat quality assessments suggested the reserve's dense insect populations were the primary driver of the elevated refueling rate.",
].join(" ");

const DOCUMENT_Y_UNRELATED = [
  "Ceramicists studying a regional pottery tradition analyzed clay composition across dozens of excavated fragments spanning centuries.",
  "Trace-element ratios shifted gradually over time, consistent with a slow change in the clay source used by successive generations.",
  "The findings offer a new dating method for otherwise undated fragments recovered from disturbed archaeological contexts.",
].join(" ");

// --- FIXTURE A/B/C: same-account repeat, then cross-account, exact dup ------

const DOCUMENT_X_FIXTURE_A = DOCUMENT_X + " fixture-a-marker.";
const DOCUMENT_X_FIXTURE_B = DOCUMENT_X + " fixture-b-marker.";
const DOCUMENT_X_FIXTURE_C = DOCUMENT_X + " fixture-c-marker.";

test("FIXTURE A: Account A submits Document X -> one representation, NEW_CONTENT_REPRESENTATION, one submission reference", async () => {
  const before = await countRepresentations();
  const { identity, result } = await submit("account-a-fixture-abc", "Document X", DOCUMENT_X_FIXTURE_A);
  assert.equal(result.status, "INDEXED");
  assert.equal(result.linkType, "NEW_CONTENT_REPRESENTATION");
  assert.equal(await countRepresentations(), before + 1);

  const rep = await findReusableRepresentationByCanonicalHash(client, canonicalSha256(DOCUMENT_X_FIXTURE_A));
  assert.ok(rep);
  assert.equal(rep.id, result.representationId);
  assert.equal(rep.canonicalText.includes("Ornithologists"), true);
});

test("FIXTURE B: Account A submits exact Document X again -> still one representation, EXACT_CANONICAL_DUPLICATE, two submission references, SELF query works", async () => {
  const repsBefore = await countRepresentations();
  const { result: firstResult } = await submit("account-a-fixture-b", "Document X", DOCUMENT_X_FIXTURE_B);
  const { result: secondResult } = await submit("account-a-fixture-b", "Document X (resubmitted)", DOCUMENT_X_FIXTURE_B);

  assert.equal(firstResult.linkType, "NEW_CONTENT_REPRESENTATION");
  assert.equal(secondResult.linkType, "EXACT_CANONICAL_DUPLICATE");
  assert.equal(secondResult.representationId, firstResult.representationId);
  assert.equal(await countRepresentations(), repsBefore + 1, "no second representation for an exact duplicate");

  const selfCheck = await findAccountSubmissionForCanonicalHash(client, "account-a-fixture-b", canonicalSha256(DOCUMENT_X_FIXTURE_B));
  assert.ok(selfCheck);
  assert.equal(selfCheck.submissionReferences.length, 2, "the SELF query must find both of this account's own submissions");

  const references = await findSubmissionReferencesForAccount(client, "account-a-fixture-b");
  assert.equal(references.length, 2);
});

test("FIXTURE C: Account B submits the exact same document -> still one representation, three total references, cross-account visible without leaking identity", async () => {
  const accountA = "account-a-fixture-c";
  const accountB = "account-b-fixture-c";
  const { result: r1 } = await submit(accountA, "Document X", DOCUMENT_X_FIXTURE_C);
  const { result: r2 } = await submit(accountA, "Document X again", DOCUMENT_X_FIXTURE_C);
  const { result: r3 } = await submit(accountB, "Document X (account B)", DOCUMENT_X_FIXTURE_C);

  assert.equal(r2.representationId, r1.representationId);
  assert.equal(r3.representationId, r1.representationId);
  assert.equal(r3.linkType, "EXACT_CANONICAL_DUPLICATE");

  const rep = await findReusableRepresentationByCanonicalHash(client, canonicalSha256(DOCUMENT_X_FIXTURE_C));
  assert.ok(!("accountId" in rep), "a representation object must never carry an accountId field");
  assert.ok(!("account_id" in rep), "a representation object must never carry a raw account_id field");

  const referencesForRepresentation = await client.execute({
    sql: "SELECT COUNT(*) AS cnt FROM corpus_submission_references WHERE representation_id = ?",
    args: [rep.id],
  });
  assert.equal(Number(referencesForRepresentation.rows[0].cnt), 3);
});

// --- FIXTURE D: revision is NOT deduplicated as an exact match --------------

test("FIXTURE D: Account A submits a revised version of X -> a new content representation, not deduplicated as exact X", async () => {
  const accountId = "account-a-fixture-d";
  const { result: original } = await submit(accountId, "Document X", DOCUMENT_X);
  const revised = DOCUMENT_X + " A newly added concluding paragraph substantially expands on the reserve's long-term conservation implications for regional policy.";
  const { result: revisedResult } = await submit(accountId, "Document X (revised)", revised);

  assert.equal(revisedResult.linkType, "NEW_CONTENT_REPRESENTATION");
  assert.notEqual(revisedResult.representationId, original.representationId);
});

// --- FIXTURE E: 10 accounts, one representation, ten references ------------

test("FIXTURE E: 10 accounts submit identical content -> one representation, 10 submission references, canonical text stored exactly once", async () => {
  const text = DOCUMENT_X + " A unique marker sentence for fixture E deduplication counting purposes only.";
  const hash = canonicalSha256(text);
  let representationId = null;
  for (let i = 0; i < 10; i++) {
    const { result } = await submit(`account-fixture-e-${i}`, "Document X", text);
    if (representationId) assert.equal(result.representationId, representationId);
    representationId = result.representationId;
  }
  const repRows = await client.execute({ sql: "SELECT COUNT(*) AS cnt FROM corpus_document_representations WHERE canonical_sha256 = ?", args: [hash] });
  assert.equal(Number(repRows.rows[0].cnt), 1, "exactly one representation row, never one per account");

  const refRows = await client.execute({ sql: "SELECT COUNT(*) AS cnt FROM corpus_submission_references WHERE representation_id = ?", args: [representationId] });
  assert.equal(Number(refRows.rows[0].cnt), 10);
});

// --- FIXTURE F/H: unrelated documents get separate representations ---------

test("FIXTURE F/H: two unrelated documents produce two representations with no shared canonical identity", async () => {
  const { result: rX } = await submit("account-fixture-f", "Document X", DOCUMENT_X + " fixture-f-marker-one");
  const { result: rY } = await submit("account-fixture-f", "Document Y", DOCUMENT_Y_UNRELATED + " fixture-f-marker-two");
  assert.notEqual(rX.representationId, rY.representationId);
});

// --- FIXTURE G: formatting differences still canonicalize to one rep -------

test("FIXTURE G: the same content with only whitespace/line-ending differences produces one canonical representation", async () => {
  const base = DOCUMENT_X + " fixture-g-marker.";
  // Harmless formatting noise only: tripled inner spaces/tabs and extra
  // leading/trailing whitespace — deliberately no new line breaks, since a
  // genuine blank-line paragraph break is real content structure that
  // canonicalizeText preserves on purpose (see lib/canonical-text.ts).
  const reformatted = "  \t " + base.replace(/ /g, "   ") + "   \n";
  const { result: r1 } = await submit("account-fixture-g", "Document X", base);
  const { result: r2 } = await submit("account-fixture-g", "Document X reformatted", reformatted);
  assert.equal(r2.linkType, "EXACT_CANONICAL_DUPLICATE");
  assert.equal(r2.representationId, r1.representationId);
});

// --- FIXTURE I: anonymous submission is skipped, never invents an identity --

test("FIXTURE I: an anonymous submission (account_id null) is explicitly skipped, not indexed under an invented identity", async () => {
  const repsBefore = await countRepresentations();
  const refsBefore = await countSubmissionReferences();
  const identity = await createDocumentIdentity(client, { accountId: null, title: "Anonymous Document", author: null, rawText: DOCUMENT_X + " fixture-i-anonymous-marker" });
  const result = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText: DOCUMENT_X + " fixture-i-anonymous-marker" });

  assert.equal(result.status, "SKIPPED_ANONYMOUS");
  assert.equal(await countRepresentations(), repsBefore, "no representation created for an anonymous submission");
  assert.equal(await countSubmissionReferences(), refsBefore, "no submission reference created for an anonymous submission");
});

// --- INTEGRITY: mismatched text is refused, not silently indexed -----------

test("indexDocumentSubmissionIntoCorpus refuses to index text that doesn't match the document identity's own stored canonical hash", async () => {
  await ensureUser("account-integrity");
  const identity = await createDocumentIdentity(client, { accountId: "account-integrity", title: "T", author: null, rawText: DOCUMENT_X });
  await assert.rejects(
    () => indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText: DOCUMENT_Y_UNRELATED }),
    /does not match/,
  );
});

test("indexDocumentSubmissionIntoCorpus is idempotent for the same document identity", async () => {
  await ensureUser("account-idempotent");
  const identity = await createDocumentIdentity(client, { accountId: "account-idempotent", title: "T", author: null, rawText: DOCUMENT_X + " idempotent-marker" });
  const first = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText: DOCUMENT_X + " idempotent-marker" });
  const second = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText: DOCUMENT_X + " idempotent-marker" });
  assert.equal(first.status, "INDEXED");
  assert.equal(second.status, "SKIPPED_ALREADY_INDEXED");
  assert.equal(second.representationId, first.representationId);
});

// --- REPOSITORY SEARCH PRIMITIVES (section 27) ------------------------------

test("findReusableRepresentationByRawHash resolves via document_identities' raw hash and returns the deterministic representation", async () => {
  const text = DOCUMENT_X + " raw-hash-lookup-marker";
  const { identity, result } = await submit("account-raw-hash", "T", text);
  const found = await findReusableRepresentationByRawHash(client, identity.rawSha256);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, result.representationId);
});

test("findCandidateCorpusRepresentations returns deterministic, containment-ranked candidates from the shingle index", async () => {
  const text = DOCUMENT_X + " candidate-search-marker-unique-phrase-alpha";
  await submit("account-candidate-search", "T", text);
  const hashes = corpusShingleHashes(text.replace(/canonical/gi, ""), 5); // approximate query text, not identical
  // Use the exact text's own shingles for a guaranteed, deterministic hit.
  const exactHashes = corpusShingleHashes(text, 5);
  const candidates = await findCandidateCorpusRepresentations(client, exactHashes, { fingerprintVersion: CORPUS_FINGERPRINT_VERSION });
  assert.ok(candidates.length >= 1);
  assert.ok(candidates[0].containment > 0.9, `expected near-1.0 containment for the exact same text, got ${candidates[0].containment}`);
  assert.ok(!("accountId" in candidates[0]));
});

test("findCandidateCorpusRepresentations returns an empty array for an empty shingle set, deterministically", async () => {
  const candidates = await findCandidateCorpusRepresentations(client, new Set());
  assert.deepEqual(candidates, []);
});
