import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { createDocumentIdentity } from "../lib/document-identity.ts";
import {
  documentShingleHashes,
  recordDocumentIdentityShingles,
  createFamily,
  findFamilyForIdentity,
  attachIdentityToFamily,
  findFamilyMembers,
  findCandidateRelatedIdentities,
  resolveFamilyForIdentity,
  captureDocumentIdentityAndFamily,
} from "../lib/document-family.ts";
import { DEFAULT_DOCUMENT_FAMILY_THRESHOLDS } from "../lib/document-family-config.ts";

const repo = path.resolve(".");
const drizzleDir = path.join(repo, "drizzle");
const dbFile = path.join(repo, "test_document_family.db");
for (const suffix of ["", "-wal", "-shm"]) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

await client.execute({
  sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
  args: ["family-account-a", "family-a@example.com", "familyaccounta", "hash-a"],
});
await client.execute({
  sql: "INSERT INTO users (id, email, username, password_hash) VALUES (?,?,?,?)",
  args: ["family-account-b", "family-b@example.com", "familyaccountb", "hash-b"],
});

// All fixture pairs below were verified empirically (pairwise containment
// checked across every combination) before being written into this file, so
// each group's assertions rest on measured numbers, not assumptions:
//   EXACT_MATCH_TEXT: isolated, shares 0 shingles with every other fixture.
//   BASE vs REVISED: containment 0.810 (three word-level edits in a ~58-shingle document).
//   THRESH_BASE vs THRESH_PARTIAL: containment 0.462 (shared opening sentence only).
//   SHORT_A vs SHORT_B: containment 0.167 (one shared generic shingle).
//   TITLE_A/TITLE_B, AUTHOR_A/AUTHOR_B, MARINE: each shares 0 shingles with every other fixture.
const EXACT_MATCH_TEXT = "Historical analysis of trade route development across medieval Mediterranean port cities demonstrates complex interdependencies between merchant guild structures and diplomatic alliances. Archival records indicate significant fluctuations in shipping volume correlating with seasonal weather patterns and recurring political conflicts among rival maritime powers.";
const BASE = "Recent scholarship examining municipal governance structures reveals persistent gaps between administrative capacity and community expectations. Researchers analyzing budgetary allocations across metropolitan districts found substantial variation in infrastructure investment priorities. These disparities correlate strongly with historical patterns of political representation and civic engagement. Policymakers seeking sustainable reform must therefore consider both structural constraints and participatory mechanisms when designing intervention strategies for underserved neighborhoods.";
const REVISED = "Recent scholarship examining municipal governance structures reveals persistent gaps between administrative capacity and public expectations. Researchers analyzing budgetary allocations across metropolitan districts found substantial variation in infrastructure investment priorities. These disparities correlate strongly with historical patterns of political representation and civic participation. Policymakers seeking sustainable reform must therefore consider both structural constraints and participatory mechanisms when designing intervention strategies for underserved communities.";
const MARINE = "Marine biologists conducting longitudinal surveys along coral reef ecosystems documented substantial declines in fish population density. Sampling protocols involved quarterly transect measurements across multiple depth gradients throughout the monitoring period. Researchers attributed these declines primarily to elevated water temperature fluctuations and increased sedimentation runoff from coastal development projects. Conservation strategies proposed by the research team emphasized establishing protected marine sanctuaries alongside community fishing regulations.";
const THRESH_BASE = "Agricultural economists studying crop yield variability across drought-prone regions identified strong correlations between irrigation infrastructure investment and long-term farm profitability. Longitudinal surveys spanning multiple growing seasons revealed that smallholder farmers adopting precision irrigation technologies experienced measurably higher net returns compared to conventional rain-fed cultivation methods.";
const THRESH_PARTIAL = "Agricultural economists studying crop yield variability across drought-prone regions identified strong correlations between irrigation infrastructure investment and long-term farm profitability. However, subsequent policy analysis instead examined subsidy allocation mechanisms and their differential effects on regional market price stability across export commodities.";
const TITLE_A = "Engineers evaluating offshore wind turbine efficiency examined blade rotation patterns under variable atmospheric pressure conditions. Comparative testing across multiple turbine configurations revealed meaningful differences in energy conversion rates. These findings suggest promising directions for optimizing turbine placement strategies in future coastal installations.";
const TITLE_B = "Professional chefs experimenting with fermentation techniques discovered unexpected flavor complexity when combining traditional grain varieties with regional spice blends. Extended aging periods produced noticeably richer texture profiles compared to conventional preparation methods. These culinary innovations have influenced contemporary restaurant menu development significantly.";
const AUTHOR_A = "Astronomers analyzing spectroscopic data from distant galaxy clusters identified unusual patterns in stellar formation rates. Observational campaigns utilizing advanced telescope arrays captured previously undetected radiation signatures across multiple wavelength ranges. These discoveries challenge existing theoretical models regarding early universe expansion dynamics.";
const AUTHOR_B = "Professional athletes undergoing specialized training regimens demonstrated measurable improvements in cardiovascular endurance metrics. Coaching staff implemented progressive resistance protocols combined with structured recovery periods between competitive events. These methodological adjustments produced significant performance gains across multiple tracked variables.";
const SHORT_A = "The study found that participants reported significant improvements over time.";
const SHORT_B = "The survey found that customers reported significant improvements over time in service quality.";
// Dedicated to the cross-account exact-match test only — must not be reused
// anywhere else in this file (THRESH_BASE below is a separate fixture,
// reserved for the threshold-configurability test, for exactly this reason).
const CROSS_ACCOUNT_TEXT = "Urban planners reviewing decades of zoning variance approvals across dense metropolitan corridors documented a steady shift toward mixed-use development permissions. Comparative case studies from several redevelopment districts revealed that community input sessions correlated with reduced approval timelines. These findings prompted several municipal planning departments to formalize earlier resident consultation requirements.";
// A second high-overlap pair (public health, not municipal governance), used
// only by the "strict threshold" test below so it never shares an identity
// with the BASE/REVISED pair used elsewhere in this file. Same edit pattern
// as BASE/REVISED (three word-level swaps); verified independently.
const STRICT_BASE = "Public health officials monitoring seasonal influenza transmission rates observed notable increases in emergency department visits among elderly populations. Epidemiological modeling incorporating vaccination coverage data suggested that expanded outreach programs could substantially reduce hospitalization burden during peak transmission periods. These projections informed subsequent resource allocation decisions across regional healthcare networks.";
const STRICT_REVISED = "Public health officials monitoring seasonal influenza transmission rates observed notable increases in emergency department visits among vulnerable populations. Epidemiological modeling incorporating vaccination coverage data suggested that expanded outreach programs could substantially reduce hospitalization burden during peak transmission months. These projections informed subsequent resource allocation decisions across regional healthcare systems.";
// Dedicated to the "identical author" false-positive test only — AUTHOR_A/
// AUTHOR_B above are already consumed by the cross-account "unrelated
// document" test, and reusing them here would spuriously EXACT_CANONICAL_MATCH
// against that earlier test's identities rather than testing what this test
// claims to test.
const AUTHOR2_A = "Linguists cataloguing endangered indigenous dialects across remote mountain villages recorded substantial variation in phonetic inventory between neighboring communities. Fieldwork methodology combined audio documentation with structured elicitation sessions involving multigenerational speaker panels. These recordings preserve grammatical structures that computational models had previously failed to capture accurately.";
const AUTHOR2_B = "Materials scientists synthesizing novel ceramic composites tested thermal resistance properties under extreme temperature cycling conditions. Laboratory experiments varying sintering temperature produced measurable differences in fracture toughness across sample batches. These composites showed unexpected durability advantages over conventional aerospace-grade alloys currently in industrial use.";
// Dedicated to the "moderately similar unrelated documents" test only. Built
// as two entirely independent paragraphs (not "BASE + a suffix"), which
// matters: appending a shared sentence to BASE would make that text a near-
// superset of the BASE identity already created by an earlier test in this
// file, producing a spurious STRONG_TEXT_MATCH against it that has nothing
// to do with what this test is meant to exercise.
const MODERATE_A = "Sociologists examining criminal justice reform proposals across several state legislatures traced how sentencing guideline revisions affected incarceration rates over successive fiscal years. Interview data collected from formerly incarcerated individuals highlighted persistent barriers to employment following release. Advocacy coalitions pushing for further legislative change emphasized reducing recidivism through expanded reentry support programs.";
const MODERATE_B = "Political scientists analyzing immigration policy shifts across neighboring border jurisdictions traced how visa processing backlogs affected labor market participation among recent arrivals. Survey data collected from resettlement caseworkers highlighted persistent barriers to housing access following relocation. Community organizations pushing for further procedural change emphasized reducing wait times through expanded caseworker staffing.";

async function makeIdentity({ accountId = null, title = null, author = null, text, recordShingles = true }) {
  const created = await createDocumentIdentity(client, { accountId, title, author, rawText: text });
  if (recordShingles) {
    await recordDocumentIdentityShingles(client, created.id, text);
  }
  return created;
}

// --- Required Behavior #8: the three-way classification exists and is not plagiarism/provenance language ---

test("NO_MATCH: a lone, unrelated document is not assigned to any family", async () => {
  const identity = await makeIdentity({ accountId: "family-account-a", text: MARINE });
  const result = await resolveFamilyForIdentity(client, identity.id);
  assert.equal(result.familyId, null);
  assert.equal(result.matchType, null);
  const stored = await findFamilyForIdentity(client, identity.id);
  assert.equal(stored, null, "no document_family_members row should exist for an unmatched identity");
});

// --- Required Behavior #1: exact canonical match is the strongest relationship ---

test("EXACT_CANONICAL_MATCH: two identities with identical text become eligible for, and end up in, the same family", async () => {
  const first = await makeIdentity({ accountId: "family-account-a", title: "essay-draft.pdf", text: EXACT_MATCH_TEXT });
  const alone = await resolveFamilyForIdentity(client, first.id);
  assert.equal(alone.familyId, null, "a single identity with no relatives must not spontaneously get a family");

  const second = await makeIdentity({ accountId: "family-account-a", title: "essay-final.pdf", text: EXACT_MATCH_TEXT });
  const candidates = await findCandidateRelatedIdentities(client, second.id);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].documentIdentityId, first.id);
  assert.equal(candidates[0].matchType, "EXACT_CANONICAL_MATCH");
  assert.equal(candidates[0].evidenceScore, 1);

  const resolved = await resolveFamilyForIdentity(client, second.id);
  assert.equal(resolved.matchType, "EXACT_CANONICAL_MATCH");
  assert.ok(resolved.familyId);

  const firstFamily = await findFamilyForIdentity(client, first.id);
  const secondFamily = await findFamilyForIdentity(client, second.id);
  assert.ok(firstFamily);
  assert.equal(firstFamily.family.id, secondFamily.family.id, "both identities must land in the same family");

  // Required Behavior #5: original identity rows are retained, not overwritten.
  const firstRow = await client.execute({ sql: "SELECT id, title, raw_sha256, canonical_sha256 FROM document_identities WHERE id = ?", args: [first.id] });
  assert.equal(firstRow.rows[0].title, "essay-draft.pdf", "the founding identity's own record must be untouched by later family resolution");
});

// --- Required Behavior #4/#9: account identity is retained but never used to prove sameness or difference ---

test("cross-account: Account B submitting an identical document joins Account A's family as a candidate/relationship, and account identity is retained on each member", async () => {
  const ownerIdentity = await makeIdentity({ accountId: "family-account-a", text: CROSS_ACCOUNT_TEXT });
  await resolveFamilyForIdentity(client, ownerIdentity.id); // alone, no family yet

  const strangerIdentity = await makeIdentity({ accountId: "family-account-b", text: CROSS_ACCOUNT_TEXT });
  const resolved = await resolveFamilyForIdentity(client, strangerIdentity.id);
  assert.equal(resolved.matchType, "EXACT_CANONICAL_MATCH", "a different account submitting the same document is still an exact match, not a lesser relationship");

  const ownerFamily = await findFamilyForIdentity(client, ownerIdentity.id);
  const strangerFamily = await findFamilyForIdentity(client, strangerIdentity.id);
  assert.equal(ownerFamily.family.id, strangerFamily.family.id, "different accounts submitting the same document must land in the same family");

  const members = await findFamilyMembers(client, ownerFamily.family.id);
  const byAccount = new Map(members.map((m) => [m.documentIdentityId, m.accountId]));
  assert.equal(byAccount.get(ownerIdentity.id), "family-account-a");
  assert.equal(byAccount.get(strangerIdentity.id), "family-account-b", "each member's own account_id must be retained, not collapsed or overwritten");
});

test("Account B submitting an unrelated document does not join Account A's family", async () => {
  const ownerIdentity = await makeIdentity({ accountId: "family-account-a", text: AUTHOR_A });
  const ownerFamily = await resolveFamilyForIdentity(client, ownerIdentity.id);
  // AUTHOR_A is a standalone fixture, so ownerIdentity alone has no candidates yet.
  assert.equal(ownerFamily.familyId, null);

  const unrelatedIdentity = await makeIdentity({ accountId: "family-account-b", text: AUTHOR_B });
  const unrelatedResolved = await resolveFamilyForIdentity(client, unrelatedIdentity.id);
  assert.equal(unrelatedResolved.familyId, null, "an unrelated document from a different account must not be pulled into any family");
});

test("same account, revised version: Account A resubmitting a lightly edited document is a STRONG_TEXT_MATCH and lands in the same family as the original", async () => {
  const original = await makeIdentity({ accountId: "family-account-a", text: BASE });
  await resolveFamilyForIdentity(client, original.id); // alone

  const revised = await makeIdentity({ accountId: "family-account-a", text: REVISED });
  assert.notEqual(revised.canonicalSha256, original.canonicalSha256, "sanity check: this is genuinely a different canonical text, not a formatting-only edit");

  const candidates = await findCandidateRelatedIdentities(client, revised.id);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].documentIdentityId, original.id);
  assert.equal(candidates[0].matchType, "STRONG_TEXT_MATCH");
  assert.ok(candidates[0].evidenceScore > DEFAULT_DOCUMENT_FAMILY_THRESHOLDS.strongTextMatchContainment);

  const resolved = await resolveFamilyForIdentity(client, revised.id);
  assert.equal(resolved.matchType, "STRONG_TEXT_MATCH");
  const originalFamily = await findFamilyForIdentity(client, original.id);
  const revisedFamily = await findFamilyForIdentity(client, revised.id);
  assert.equal(originalFamily.family.id, revisedFamily.family.id, "a revision must land in the same family as the document it revised");
});

// --- Required Behavior #2/#11: strong text similarity uses configurable, non-hard-coded thresholds ---

test("thresholds are configurable: the same pair is NO_MATCH under the default threshold and STRONG_TEXT_MATCH under a looser one", async () => {
  await makeIdentity({ accountId: "family-account-a", text: THRESH_BASE });
  const partial = await makeIdentity({ accountId: "family-account-b", text: THRESH_PARTIAL });

  const underDefault = await findCandidateRelatedIdentities(client, partial.id, DEFAULT_DOCUMENT_FAMILY_THRESHOLDS);
  assert.equal(underDefault.length, 0, "containment ~0.46 must not clear the default 0.6 threshold");

  const looseThresholds = { ...DEFAULT_DOCUMENT_FAMILY_THRESHOLDS, strongTextMatchContainment: 0.4 };
  const underLoose = await findCandidateRelatedIdentities(client, partial.id, looseThresholds);
  assert.equal(underLoose.length, 1, "the same pair must clear a deliberately loosened 0.4 threshold");
  assert.equal(underLoose[0].matchType, "STRONG_TEXT_MATCH");
});

test("thresholds are configurable: a high-overlap revision pair can be pushed below a stricter threshold", async () => {
  await makeIdentity({ accountId: "family-account-a", text: STRICT_BASE });
  const revised = await makeIdentity({ accountId: "family-account-a", text: STRICT_REVISED });

  const underDefault = await findCandidateRelatedIdentities(client, revised.id);
  assert.equal(underDefault.length, 1, "under the default threshold this revision pair is a match");
  assert.equal(underDefault[0].matchType, "STRONG_TEXT_MATCH");

  const strictThresholds = { ...DEFAULT_DOCUMENT_FAMILY_THRESHOLDS, strongTextMatchContainment: 0.97 };
  const underStrict = await findCandidateRelatedIdentities(client, revised.id, strictThresholds);
  assert.equal(underStrict.length, 0, "the same pair must fail a deliberately strict 0.97 threshold — nothing about the classification is hard-coded");
});

// --- Required Behavior #3/#10: metadata is supporting evidence only, never sufficient on its own ---

test("identical title alone does not create a family when the underlying text is unrelated", async () => {
  const a = await makeIdentity({ accountId: "family-account-a", title: "Final Research Paper.pdf", text: TITLE_A });
  const b = await makeIdentity({ accountId: "family-account-b", title: "Final Research Paper.pdf", text: TITLE_B });
  const candidates = await findCandidateRelatedIdentities(client, b.id);
  assert.equal(candidates.length, 0, "a shared title must not manufacture a family relationship when the text itself is unrelated");
  const resolved = await resolveFamilyForIdentity(client, b.id);
  assert.equal(resolved.familyId, null);
  void a;
});

test("identical author alone does not create a family when the underlying text is unrelated", async () => {
  const a = await makeIdentity({ accountId: "family-account-a", author: "J. Example Author", text: AUTHOR2_A });
  const b = await makeIdentity({ accountId: "family-account-b", author: "J. Example Author", text: AUTHOR2_B });
  const candidates = await findCandidateRelatedIdentities(client, b.id);
  assert.equal(candidates.length, 0, "a shared author must not manufacture a family relationship when the text itself is unrelated");
  void a;
});

test("short common phrasing does not automatically create a family", async () => {
  const a = await makeIdentity({ accountId: "family-account-a", text: SHORT_A });
  await resolveFamilyForIdentity(client, a.id);
  const b = await makeIdentity({ accountId: "family-account-b", text: SHORT_B });
  const candidates = await findCandidateRelatedIdentities(client, b.id);
  assert.equal(candidates.length, 0, "a couple of short documents sharing only generic phrasing must not clear the strong-match threshold");
});

test("moderately similar unrelated documents (shared topic register, different specific content) do not automatically become one family", async () => {
  // MODERATE_A and MODERATE_B were verified to share zero shingles despite
  // both being social-science, academic-register paragraphs about adjacent
  // policy topics — this specifically exercises the
  // could-look-similar-on-the-surface case, not just totally alien text.
  const a = await makeIdentity({ accountId: "family-account-a", text: MODERATE_A });
  await resolveFamilyForIdentity(client, a.id);
  const b = await makeIdentity({ accountId: "family-account-b", text: MODERATE_B });
  const candidates = await findCandidateRelatedIdentities(client, b.id);
  assert.equal(candidates.length, 0, "topically-adjacent but substantively different documents must not become one family");
});

// --- Repository primitives (Required Behavior #7), exercised directly ---

test("documentShingleHashes filters out non-informative shingles", () => {
  const hashes = documentShingleHashes("the of and a to in on at is", 5);
  assert.equal(hashes.size, 0, "a shingle made entirely of common/short words must never be informative");
});

test("createFamily / attachIdentityToFamily / findFamilyMembers compose correctly as standalone primitives", async () => {
  const identityOne = await makeIdentity({ accountId: "family-account-a", text: TITLE_A + " Standalone primitives test isolation clause one." });
  const identityTwo = await makeIdentity({ accountId: "family-account-b", text: TITLE_A + " Standalone primitives test isolation clause one." });

  const family = await createFamily(client);
  assert.ok(family.id);
  assert.ok(family.createdAt);

  await attachIdentityToFamily(client, {
    familyId: family.id,
    documentIdentityId: identityOne.id,
    matchType: "SEED",
    matchedAgainstIdentityId: null,
    evidenceScore: null,
  });
  await attachIdentityToFamily(client, {
    familyId: family.id,
    documentIdentityId: identityTwo.id,
    matchType: "EXACT_CANONICAL_MATCH",
    matchedAgainstIdentityId: identityOne.id,
    evidenceScore: 1,
  });

  const members = await findFamilyMembers(client, family.id);
  assert.equal(members.length, 2);
  const ids = members.map((m) => m.documentIdentityId).sort();
  assert.deepEqual(ids, [identityOne.id, identityTwo.id].sort());
  const seedMember = members.find((m) => m.documentIdentityId === identityOne.id);
  assert.equal(seedMember.matchType, "SEED");
  assert.equal(seedMember.matchedAgainstIdentityId, null);
});

test("attachIdentityToFamily rejects attaching the same identity to a second family (an identity belongs to at most one family)", async () => {
  const identity = await makeIdentity({ accountId: "family-account-a", text: TITLE_B + " Uniqueness constraint isolation clause." });
  const familyOne = await createFamily(client);
  const familyTwo = await createFamily(client);
  await attachIdentityToFamily(client, { familyId: familyOne.id, documentIdentityId: identity.id, matchType: "SEED", matchedAgainstIdentityId: null, evidenceScore: null });
  await assert.rejects(
    () => attachIdentityToFamily(client, { familyId: familyTwo.id, documentIdentityId: identity.id, matchType: "SEED", matchedAgainstIdentityId: null, evidenceScore: null }),
    /UNIQUE constraint failed/,
  );
});

// --- Phase C: captureDocumentIdentityAndFamily (the activation pipeline) ---

test("captureDocumentIdentityAndFamily creates an identity, records its fingerprint, and leaves it family-less when nothing relates to it yet", async () => {
  const text = "Paleontologists excavating a newly exposed sedimentary layer recovered an unusually complete set of theropod skeletal remains preserved in fine-grained mudstone. Detailed bone microstructure analysis suggested the specimen died during a period of rapid juvenile growth. These findings contribute additional evidence toward reconstructing growth rate variability across related theropod lineages.";
  const result = await captureDocumentIdentityAndFamily(client, { accountId: "family-account-a", title: "fossil-report.pdf", author: null, rawText: text });

  assert.ok(result.documentIdentityId);
  assert.equal(result.familyId, null, "a lone document with nothing to relate to must not get a family");
  assert.equal(result.matchType, null);

  const identityRow = await client.execute({ sql: "SELECT unique_shingle_count FROM document_identities WHERE id = ?", args: [result.documentIdentityId] });
  assert.ok(Number(identityRow.rows[0].unique_shingle_count) > 0, "the fingerprint step must have actually run and set unique_shingle_count");
});

test("captureDocumentIdentityAndFamily end-to-end: a second, lightly revised call is folded into the same family as the first, entirely through the composed pipeline (no manual family plumbing)", async () => {
  // Deliberately unrelated vocabulary to the previous test's fixture — reusing
  // or extending it (e.g. "base text + a suffix") would make this identity a
  // near-superset of that earlier one and spuriously match it, exactly the
  // cross-test contamination bug documented and fixed earlier in this file.
  const base = "Glaciologists tracking meltwater discharge from a retreating alpine glacier documented substantial acceleration in ice mass loss over the past decade. Repeated aerial surveys combined with ground-penetrating radar revealed thinning concentrated near the glacier's lower elevation margins. These measurements provide updated input for regional water supply forecasting models. Pipeline end-to-end isolation clause A.";
  const revised = "Glaciologists tracking meltwater discharge from a retreating alpine glacier documented substantial acceleration in ice mass loss over the past decade. Repeated aerial surveys combined with ground-penetrating radar revealed thinning concentrated near the glacier's upper elevation margins. These measurements provide updated input for regional water supply planning models. Pipeline end-to-end isolation clause A.";

  const first = await captureDocumentIdentityAndFamily(client, { accountId: "family-account-a", title: "draft.pdf", author: null, rawText: base });
  assert.equal(first.familyId, null);

  const second = await captureDocumentIdentityAndFamily(client, { accountId: "family-account-a", title: "final.pdf", author: null, rawText: revised });
  assert.equal(second.matchType, "STRONG_TEXT_MATCH");
  assert.ok(second.familyId);

  const members = await findFamilyMembers(client, second.familyId);
  const ids = members.map((m) => m.documentIdentityId).sort();
  assert.deepEqual(ids, [first.documentIdentityId, second.documentIdentityId].sort());
});

test.after(() => {
  client.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});
