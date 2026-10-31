import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import { indexDocumentSubmissionIntoCorpus } from "../lib/user-submission-corpus.ts";
import { matchAgainstUserSubmissionCorpus, USER_SUBMISSION_MATCH_THRESHOLDS } from "../lib/user-submission-matching.ts";
import { matureCorpusBackings } from "./helpers/corpus-maturity.mjs";

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
  // Phase A: this suite predates 7-day corpus maturity and seeds every source
  // immediately before querying it. matchAgainstUserSubmissionCorpus now
  // enforces maturity by default (safe-by-default hardening), so age the
  // just-seeded backings past the 7-day window first — these tests exercise
  // matching logic, not the activation clock (that is covered by
  // tests/corpus-activation-7day.test.mjs).
  await matureCorpusBackings(client);
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

// =============================================================================
// PHASE 6.6 PART 2 — distinctivePassageMatch: a short but genuinely distinctive
// exact/near-exact passage must be detectable even when it is a minority of the
// source document; common short academic boilerplate and fragmented weak
// evidence must still be rejected. See lib/document-correspondence.ts's own
// header comment on distinctivePassageMatch and USER_SUBMISSION_MATCH_THRESHOLDS's
// own comment on why minimumDistinctivePassageWords is set to 30.
// =============================================================================

// A long (~560-word), distinctive real-shaped source document — long enough
// that a 40-word excerpt of it sits at roughly 25-30% document-level
// containment against a short submission, mirroring the real case this
// phase's own task description names (40 words in a 156-word source).
const LONG_DISTINCTIVE_SOURCE_PARAGRAPHS = [
  "Hydrothermal vent communities along a remote spreading ridge segment have provided researchers with an unusually clear natural experiment in chemosynthetic succession following a documented eruptive event in the surveyed region.",
  "The research team interpreted the observed decline in bacterial mat coverage as evidence of active ecosystem engineering by the tubeworm colonies themselves, rather than a simple consequence of diffuse-flow chemistry drifting away from conditions favorable to the mat-forming microbial taxa.",
  "Paired fluid-chemistry samples supported this interpretation: hydrogen sulfide concentrations measured immediately adjacent to dense tubeworm bushes were consistently lower than concentrations measured at open, mat-dominated patches sampled during the same visit to the site.",
  "Genetic sampling of the dominant tubeworm population revealed limited differentiation among the surveyed vent orifices despite considerable separation along the ridge axis, consistent with a larval dispersal regime capable of maintaining regional connectivity at this spreading rate.",
  "Grazer densities within the tubeworm bushes rose steadily across the multi-year survey window, tracking the increasing structural complexity of the aggregations rather than tracking elapsed time since the eruption directly.",
  "The authors conclude that the observed successional sequence may represent a general template applicable to other slow-spreading vent systems recovering from a comparable discrete disturbance event, pending confirmation from additional survey series conducted elsewhere.",
].join(" ");

function distinctiveExcerptWords(count, offset = 0) {
  return LONG_DISTINCTIVE_SOURCE_PARAGRAPHS.split(/\s+/).slice(offset, offset + count).join(" ");
}

function shortHostFor(excerpt, marker) {
  return `Independent original commentary of real length precedes the borrowed material below, discussing an entirely unrelated logistics topic so the excerpt has unambiguous non-matching context on both sides. ${excerpt} A closing paragraph, again unrelated, discusses freight scheduling variance at a regional terminal, included only to give this short submission a realistic surrounding length. ${marker}`;
}

test("PART 2 / A: a 40-word exact passage inside a much longer (~156-word submission over a ~560-word source) is now detected via distinctivePassageMatch", async () => {
  await indexSubmission("account-p2a-author", "Doc P2A", LONG_DISTINCTIVE_SOURCE_PARAGRAPHS);

  const excerpt = distinctiveExcerptWords(40, 28); // "The research team interpreted..." — the same real sentence Phase 6.5's own validation found rejected
  const shortSubmission = shortHostFor(excerpt, "fixture-p2a-marker");

  const result = await match("account-p2a-reader", shortSubmission);
  assert.equal(result.status, "MATCHED", "a real 40-word exact passage must now be reportable evidence even at low document-level containment");
  assert.equal(result.matches[0].relationshipType, "PRIOR_SUBMISSION");
  assert.equal(result.matches[0].matchType, "STRONG_TEXT_MATCH");
  assert.ok(result.matches[0].containment < USER_SUBMISSION_MATCH_THRESHOLDS.correspondence.strongContainmentThreshold, "the fixture must genuinely have low whole-document containment for this test to prove distinctivePassageMatch, not strongCorrespondence, is what accepted it");
  assert.ok(result.matches[0].longestMatchWords >= 30, "the accepted passage must be the long contiguous span, not scattered fragments");
});

test("PART 2 / B: a 20-word generic/common academic phrase at the same low containment scale is still rejected", async () => {
  const genericPhrase = "The purpose of this study is to examine the research problem in question using a combination of established analytical";
  const longGenericSource = `${genericPhrase} methods applied consistently across every stage of the investigation described in the remainder of this document. ` + UNRELATED_PARAGRAPHS.join(" ");
  await indexSubmission("account-p2b-author", "Doc P2B", longGenericSource);

  const shortSubmission = shortHostFor(genericPhrase, "fixture-p2b-marker");
  const result = await match("account-p2b-reader", shortSubmission);
  assert.equal(result.status, "NO_HISTORICAL_MATCH", "a 20-word generic academic phrase must not become a match just because distinctivePassageMatch now exists");
});

test("PART 2 / C: a second, independent 40-word distinctive exact passage (different excerpt of the same source) is also detected", async () => {
  await indexSubmission("account-p2c-author", "Doc P2C", LONG_DISTINCTIVE_SOURCE_PARAGRAPHS);

  const excerpt = distinctiveExcerptWords(40, 0); // a different 40-word span from the start of the source
  const shortSubmission = shortHostFor(excerpt, "fixture-p2c-marker");

  const result = await match("account-p2c-reader", shortSubmission);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].relationshipType, "PRIOR_SUBMISSION");
});

test("PART 2 / D: fragmented, individually-short unrelated phrases (none reaching 30 contiguous words) are rejected even though their aggregate exceeds minimumMatchedWords", async () => {
  const frag1 = "the results suggest that further work remains";
  const frag2 = "additional analysis would benefit the wider field";
  const frag3 = "more research is needed going forward here";
  const longFragmentSource = `${frag1}, entirely surrounded by substantial unrelated original material of real length discussing an unconnected subject at length. ${frag2}, again surrounded by more unrelated original material of real substance and length. ${frag3}, with yet more surrounding unrelated original material to close out this source document.`;
  await indexSubmission("account-p2d-author", "Doc P2D", longFragmentSource);

  const fragmentedSubmission = `Opening original material of real length with no relation whatsoever to what follows. ${frag1}. Bridging original material of real length separating the fragments clearly from one another. ${frag2}. More original bridging material once again, entirely unrelated in content. ${frag3}. Closing original material. fixture-p2d-marker`;
  const result = await match("account-p2d-reader", fragmentedSubmission);
  assert.equal(result.status, "NO_HISTORICAL_MATCH", "fragmented weak evidence — no single span reaching minimumDistinctivePassageWords — must stay rejected");
});

test("PART 2 / E: exact full source copying is still detected via EXACT_CANONICAL_MATCH, unaffected by the new gate", async () => {
  const text = LONG_DISTINCTIVE_SOURCE_PARAGRAPHS + " fixture-p2e-marker";
  await indexSubmission("account-p2e-author", "Doc P2E", text);

  const result = await match("account-p2e-reader", text);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].matchType, "EXACT_CANONICAL_MATCH");
  assert.equal(result.matches[0].containment, 1);
});

test("PART 2 / F: exact large-portion (majority) copying is still detected via strongCorrespondence, unaffected by the new gate", async () => {
  await indexSubmission("account-p2f-author", "Doc P2F", LONG_DISTINCTIVE_SOURCE_PARAGRAPHS);

  const words = LONG_DISTINCTIVE_SOURCE_PARAGRAPHS.split(/\s+/);
  const majorityPortion = words.slice(0, Math.floor(words.length * 0.8)).join(" ");
  const submission = `${majorityPortion} A short original closing sentence added by this submitter. fixture-p2f-marker`;

  const result = await match("account-p2f-reader", submission);
  assert.equal(result.status, "MATCHED");
  assert.equal(result.matches[0].relationshipType, "PRIOR_SUBMISSION");
  assert.ok(result.matches[0].containment >= USER_SUBMISSION_MATCH_THRESHOLDS.correspondence.strongContainmentThreshold, "an 80% copy must clear strongCorrespondence on its own");
});

test("PART 2 / G: distinctivePassageMatch is opt-in only — a caller-supplied config without minimumDistinctivePassageWords reproduces pre-fix behavior exactly (the real 40-word case stays rejected)", async () => {
  await indexSubmission("account-p2g-author", "Doc P2G", LONG_DISTINCTIVE_SOURCE_PARAGRAPHS);

  const excerpt = distinctiveExcerptWords(40, 28);
  const shortSubmission = shortHostFor(excerpt, "fixture-p2g-marker");

  const configWithoutNewGate = {
    ...USER_SUBMISSION_MATCH_THRESHOLDS,
    correspondence: { ...USER_SUBMISSION_MATCH_THRESHOLDS.correspondence, minimumDistinctivePassageWords: undefined },
  };
  const result = await matchAgainstUserSubmissionCorpus(client, {
    accountId: "account-p2g-reader",
    canonicalText: shortSubmission,
    config: configWithoutNewGate,
  });
  assert.equal(result.status, "NO_HISTORICAL_MATCH", "with the new gate explicitly disabled, behavior must exactly match the pre-fix state");
});
