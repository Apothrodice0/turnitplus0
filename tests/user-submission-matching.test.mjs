import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { matchAgainstUserSubmissionCorpus, USER_SUBMISSION_MATCH_THRESHOLDS } from "../lib/user-submission-matching.ts";

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_user_submission_matching.db");
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

/** Indexes a submission into the E8A corpus (as a future E8C caller eventually would after save) and returns the identity. */
async function indexSubmission(accountId, title, rawText) {
  await ensureUser(accountId);
  const identity = await createDocumentIdentity(client, { accountId, title, author: null, rawText });
  const indexResult = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  return { identity, indexResult };
}

async function match(accountId, canonicalText, documentIdentityId = null) {
  return matchAgainstUserSubmissionCorpus(client, { accountId, documentIdentityId, canonicalText });
}

const BASE_PARAGRAPHS = [
  "Ornithologists tracking migratory songbirds fitted with miniature geolocators documented a previously unrecorded stopover site in a coastal wetland reserve.",
  "Birds using the stopover site gained significantly more body mass per day than birds recorded at three other established stopover locations nearby.",
  "Habitat quality assessments suggested the reserve's dense insect populations were the primary driver of the elevated refueling rate observed there.",
  "Conservation planners recommended prioritizing the newly identified stopover site for protection given its apparent importance to the broader migratory route.",
];
function baseDoc(marker) {
  return BASE_PARAGRAPHS.join(" ") + ` ${marker}`;
}

const UNRELATED_PARAGRAPHS = [
  "Ceramicists studying a regional pottery tradition analyzed clay composition across dozens of excavated fragments spanning three centuries of production.",
  "Trace-element ratios shifted gradually over time, consistent with a slow change in the clay source used by successive generations of potters.",
  "The findings offer a new dating method for otherwise undated fragments recovered from disturbed archaeological contexts in the same region.",
];
function unrelatedDoc(marker) {
  return UNRELATED_PARAGRAPHS.join(" ") + ` ${marker}`;
}

// A distinct third paragraph set for tests that need guaranteed isolation
// from every baseDoc()/unrelatedDoc() variant in this file — baseDoc()'s
// shared paragraphs differ between fixtures only by a trailing marker word,
// which is nowhere near enough shingle difference to drop below
// strongContainmentThreshold (0.5), so those fixtures are all mutually
// "similar" to each other by design and must not be reused where a test
// asserts an exact match count.
const ISOLATED_PARAGRAPHS = [
  "Metallurgists analyzing a set of recovered shipwreck artifacts identified an unusual bronze alloy composition inconsistent with regional production standards.",
  "Isotope ratio analysis traced the copper source to a mining region several thousand kilometers from the vessel's presumed trade route.",
  "The discrepancy suggests either an undocumented long-distance trade network or a later repair using imported replacement material.",
];
function isolatedDoc(marker) {
  return ISOLATED_PARAGRAPHS.join(" ") + ` ${marker}`;
}

// --- FIXTURE A: completely identical -> EXACT_CANONICAL_MATCH ---------------

test("FIXTURE A: completely identical content -> EXACT_CANONICAL_MATCH, PRIOR_SUBMISSION for a different account", async () => {
  const text = baseDoc("fixture-a-marker");
  await indexSubmission("account-fixture-a-author", "Doc A", text);

  const result = await match("account-fixture-a-reader", text);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].matchType, "EXACT_CANONICAL_MATCH");
  assert.equal(result.matches[0].relationshipType, "PRIOR_SUBMISSION");
  assert.equal(result.matches[0].containment, 1);
});

// --- FIXTURE B: formatting-only changes -> still EXACT_CANONICAL_MATCH -----

test("FIXTURE B: formatting-only differences (whitespace/case-preserving reflow) still resolve to EXACT_CANONICAL_MATCH", async () => {
  const text = baseDoc("fixture-b-marker");
  await indexSubmission("account-fixture-b-author", "Doc B", text);

  const reformatted = "  \t " + text.replace(/ /g, "   ") + "  \n";
  const result = await match("account-fixture-b-reader", reformatted);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].matchType, "EXACT_CANONICAL_MATCH");
});

// --- FIXTURE C: small number of meaningful edits -> STRONG_TEXT_MATCH ------

test("FIXTURE C: a document with a few edited sentences still matches as STRONG_TEXT_MATCH", async () => {
  const original = baseDoc("fixture-c-marker");
  await indexSubmission("account-fixture-c-author", "Doc C", original);

  const edited = BASE_PARAGRAPHS.slice(0, 3).join(" ") +
    " A newly written final sentence replaces the original conclusion entirely for this fixture. fixture-c-marker";
  const result = await match("account-fixture-c-reader", edited);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].matchType, "STRONG_TEXT_MATCH");
  assert.ok(result.matches[0].containment >= USER_SUBMISSION_MATCH_THRESHOLDS.correspondence.strongContainmentThreshold);
});

// --- FIXTURE D: strong revision -> STRONG_TEXT_MATCH -----------------------

test("FIXTURE D: a more heavily revised document (still majority-overlapping) matches as STRONG_TEXT_MATCH", async () => {
  const original = baseDoc("fixture-d-marker");
  await indexSubmission("account-fixture-d-author", "Doc D", original);

  const revised = BASE_PARAGRAPHS.slice(0, 2).join(" ") +
    " An expanded methodology section was added describing the geolocator deployment protocol used across the reserve in additional detail for this fixture." +
    " " + BASE_PARAGRAPHS[3] + " fixture-d-marker";
  const result = await match("account-fixture-d-reader", revised);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].matchType, "STRONG_TEXT_MATCH");
});

// --- FIXTURE E: unrelated document -> NO_HISTORICAL_MATCH ------------------

test("FIXTURE E: a genuinely unrelated document -> NO_HISTORICAL_MATCH", async () => {
  const text = baseDoc("fixture-e-marker");
  await indexSubmission("account-fixture-e-author", "Doc E", text);

  const result = await match("account-fixture-e-reader", unrelatedDoc("fixture-e-unrelated-marker"));
  assert.equal(result.status, "NO_HISTORICAL_MATCH");
});

// --- FIXTURE F: generic/common-phrase document -> NO_HISTORICAL_MATCH -----

test("FIXTURE F: a document built almost entirely from generic boilerplate phrases does not match", async () => {
  const boilerplate = [
    "Introduction. The results of this study indicate that further research is needed.",
    "In conclusion, this paper has shown that more work remains to be done in this area.",
    "The purpose of this study is to examine the topic in question. Discussion. Conclusion.",
  ].join(" ");
  await indexSubmission("account-fixture-f-author", "Doc F", baseDoc("fixture-f-marker"));

  const result = await match("account-fixture-f-reader", boilerplate);
  assert.equal(result.status, "NO_HISTORICAL_MATCH", "generic boilerplate alone must never manufacture a historical match");
});

// --- FIXTURE G: same "title" concept, different content -> no match --------

test("FIXTURE G: matching only requires text — a differently-worded document with the same nominal subject does not match", async () => {
  await indexSubmission("account-fixture-g-author", "A Study of Migratory Songbirds", baseDoc("fixture-g-marker"));
  // A different document that a title-based system might conflate with the one above, sharing only the general topic, not the actual text.
  const differentContentSameTopic = unrelatedDoc("fixture-g-different-content") +
    " This paper is also titled A Study of Migratory Songbirds but contains completely different analysis.";
  const result = await match("account-fixture-g-reader", differentContentSameTopic);
  assert.equal(result.status, "NO_HISTORICAL_MATCH");
});

// --- FIXTURE H: same author concept, different content -> no match ---------

test("FIXTURE H: matching never uses author identity — same nominal author, different content does not match", async () => {
  await indexSubmission("account-fixture-h-author", "Doc H", baseDoc("fixture-h-marker"));
  const differentContentSameAuthor = unrelatedDoc("fixture-h-different-content");
  const result = await match("account-fixture-h-reader", differentContentSameAuthor);
  assert.equal(result.status, "NO_HISTORICAL_MATCH");
});

// --- SELF / PRIOR_SUBMISSION / UNKNOWN_RELATIONSHIP classification ---------

test("SELF: the same account matching its own prior submission is classified SELF, not PRIOR_SUBMISSION", async () => {
  const text = baseDoc("fixture-self-marker");
  await indexSubmission("account-self-test", "Doc Self", text);
  const result = await match("account-self-test", text);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].relationshipType, "SELF");
});

test("PRIOR_SUBMISSION: a different account matching someone else's submission is classified PRIOR_SUBMISSION, never SELF", async () => {
  const text = baseDoc("fixture-prior-marker");
  await indexSubmission("account-prior-a", "Doc Prior", text);
  const result = await match("account-prior-b", text);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].relationshipType, "PRIOR_SUBMISSION");
});

test("M / UNKNOWN_RELATIONSHIP: an anonymous (accountId null) current submission never invents SELF, and is classified UNKNOWN_RELATIONSHIP", async () => {
  const text = baseDoc("fixture-unknown-marker");
  await indexSubmission("account-unknown-owner", "Doc Unknown", text);
  const result = await match(null, text);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].relationshipType, "UNKNOWN_RELATIONSHIP");
  assert.notEqual(result.matches[0].relationshipType, "SELF");
});

test("SELF priority: when the current account has a same-account historical submission, that representation is reported once as SELF, never duplicated as PRIOR_SUBMISSION", async () => {
  const text = baseDoc("fixture-self-priority-marker");
  await indexSubmission("account-self-priority", "Doc", text);
  await indexSubmission("account-self-priority-other", "Doc (other account too)", text);
  const result = await match("account-self-priority", text);
  assert.equal(result.status, "MATCHED");
  const selfEntries = result.matches.filter((m) => m.matchedRepresentationId === result.matches[0].matchedRepresentationId);
  assert.equal(selfEntries.length, 1, "the same representation must never appear twice in one result");
  assert.equal(selfEntries[0].relationshipType, "SELF");
});

// --- MULTIPLE SUBMITTERS COLLAPSE (section 16) ------------------------------

test("N: three different accounts submitting the same document collapse to one historical relationship, with a bounded count, for a fourth account", async () => {
  const text = isolatedDoc("fixture-multi-submitter-marker");
  await indexSubmission("account-multi-a", "Doc", text);
  await indexSubmission("account-multi-b", "Doc", text);
  await indexSubmission("account-multi-c", "Doc", text);

  const result = await match("account-multi-d", text);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches.length, 1, "must not return one match per historical submitter");
  assert.equal(result.matches[0].relationshipType, "PRIOR_SUBMISSION");
  assert.equal(result.matches[0].historicalSubmissionCount, 3);
});

test("historicalSubmissionCount excludes the current account when the relationship is SELF", async () => {
  const text = isolatedDoc("fixture-self-count-marker");
  await indexSubmission("account-self-count-me", "Doc", text);
  await indexSubmission("account-self-count-other-1", "Doc", text);
  await indexSubmission("account-self-count-other-2", "Doc", text);

  const result = await match("account-self-count-me", text);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].relationshipType, "SELF");
  assert.equal(result.matches[0].historicalSubmissionCount, 2, "count must exclude the querying account's own submission");
});

// --- POISONING TEST (section 28) --------------------------------------------

test("POISONING: an earlier submission by another account never implies that account authored the content — result is PRIOR_SUBMISSION, no authorship claim, no identity", async () => {
  const stolenPaper = baseDoc("poisoning-fixture-marker");
  const attackerAccount = "account-poisoning-attacker";
  const realAuthorAccount = "account-poisoning-real-author";

  await indexSubmission(attackerAccount, "Someone Else's Unpublished Paper", stolenPaper);
  const result = await match(realAuthorAccount, stolenPaper);

  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].relationshipType, "PRIOR_SUBMISSION", "must never be silently upgraded or downgraded — just an observed prior submission");
  assert.notEqual(result.matches[0].relationshipType, "SELF");

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(attackerAccount), "the attacker's account id must never appear in the result");
  assert.ok(!serialized.toLowerCase().includes("author"), "the result must not contain any field implying authorship");
});

// --- DETERMINISTIC ORDERING (section 18) ------------------------------------

test("deterministic ordering: exact match ranks before a strong-but-inexact match for the same query", async () => {
  const exactText = baseDoc("fixture-order-exact-marker");
  await indexSubmission("account-order-exact", "Doc", exactText);

  const revisedText = BASE_PARAGRAPHS.slice(0, 3).join(" ") + " A different final sentence for the ordering fixture. fixture-order-exact-marker";
  await indexSubmission("account-order-revised", "Doc revised", revisedText);

  const result = await match("account-order-reader", exactText);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].matchType, "EXACT_CANONICAL_MATCH", "the exact match must be ranked first");
});

// --- NO MATCH DOES NOT FABRICATE --------------------------------------------

test("an empty/whitespace-only submission never fabricates a match", async () => {
  const result = await match("account-empty-query", "   \n\t  ");
  assert.equal(result.status, "NO_HISTORICAL_MATCH");
});

test("querying against an empty corpus (fresh account, nothing indexed yet) returns NO_HISTORICAL_MATCH, not an error", async () => {
  const result = await match("account-never-seen-before", "A completely novel document nobody has ever submitted before, fixture-novel-marker, with enough distinctive words to be indexable in principle.");
  assert.equal(result.status, "NO_HISTORICAL_MATCH");
});
