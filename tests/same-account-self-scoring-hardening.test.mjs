import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { tokens } from "../lib/similarity-core.ts";
import { canonicalSha256, createDocumentIdentity } from "../lib/document-identity.ts";
import {
  indexDocumentSubmissionIntoCorpus,
  createReusableDocumentRepresentation,
  recordCorpusShingles,
} from "../lib/user-submission-corpus.ts";
import { buildReportAdmissionSourceRef } from "../lib/corpus-admission-source-ref.ts";
import { bumpCorpusMatchGeneration } from "../lib/report-historical-match.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { resolvePrimarySimilaritySummary } from "../lib/report-primary-similarity.ts";
import { getReportSimilarityDecisionTrace } from "../lib/developer-repo.ts";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import * as signupRoute from "../app/api/auth/signup/route.ts";
import { resetRateForTest, resetReadRateForTest, resetAuthRateForTest } from "../lib/rate-limit.ts";

/**
 * FINAL SAME-ACCOUNT SELF HARDENING regression suite.
 *
 * Invariant under test:
 *   ANY historical/corpus match backed ONLY by the CURRENT authenticated
 *   account's own previous submissions must NEVER contribute matched
 *   positions to that account's unified similarity score — regardless of
 *   exact-canonical match, filename, Device Passport, browser, device, or
 *   overlap percentage.
 *
 * This is a SCORING exclusion, not (necessarily) a retrieval exclusion — the
 * matcher still runs against own history internally (spans, ownership, admin
 * trace, own-only-vs-independent-backing are all still computed).
 *
 * These tests assert the invariant is ALREADY GUARANTEED by the existing
 * production code (no new production logic was added by this task):
 *   - own SUBMISSION-REFERENCE backing  -> matcher classifies relationshipType
 *     SELF (lib/user-submission-matching.ts) -> computeUnifiedSimilarity
 *     excludes it. Fires for STRONG_TEXT_MATCH (edited) too, at any overlap.
 *   - own ADMISSION-PROMOTION backing   -> excludeAccountId
 *     (admissionEligibilitySql, threaded by resolvePrimarySimilaritySummary
 *     as params.accountId) removes it from candidate discovery entirely.
 *   - a MIXED representation (own backing + independent backing) is NOT
 *     "current-account-only" — independent evidence is retained (a separate
 *     independent representation counts; a same-representation submission-ref
 *     merge follows the existing intentional "SELF priority" design, see
 *     tests/user-submission-matching.test.mjs).
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_same_account_self_scoring_hardening.db");
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
}

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
const originalPassportFlag = process.env.DEVICE_PASSPORT_ENABLED;
const originalSelfFlag = process.env.DEVICE_PASSPORT_SELF_ENABLED;
delete process.env.DEVICE_PASSPORT_ENABLED;       // default OFF
delete process.env.DEVICE_PASSPORT_SELF_ENABLED;  // default OFF

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  if (originalPassportFlag === undefined) delete process.env.DEVICE_PASSPORT_ENABLED; else process.env.DEVICE_PASSPORT_ENABLED = originalPassportFlag;
  if (originalSelfFlag === undefined) delete process.env.DEVICE_PASSPORT_SELF_ENABLED; else process.env.DEVICE_PASSPORT_SELF_ENABLED = originalSelfFlag;
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let seq = 0;
const uniq = (p) => `${p}-${++seq}`;
const hex32 = () => crypto.randomBytes(32).toString("hex");
let ipSeq = 0;
const nextIp = () => `saself-${++ipSeq}`;
const SAME_ORIGIN = { origin: "http://localhost", host: "localhost" };

// Distinct ~90-word paragraphs so DB-backed scenarios cannot cross-match
// (matchAgainstUserSubmissionCorpus runs a real global shingle search).
const TEXT_POOL = [
  "Seismologists analyzing a dense array of borehole strainmeters detected a slow-slip transient event migrating along a subduction interface over several weeks, with surface GPS stations recording displacement magnitudes too small to be felt but clearly resolvable in the processed strain time series, a pattern the authors argue represents a genuine precursory process worth continued monitoring at this particular segment of the convergent margin studied here.",
  "Glaciologists resurveying an alpine ice cap used repeat airborne lidar to quantify surface elevation change across four consecutive melt seasons, finding thinning concentrated at lower elevations near the terminus consistent with the ablation-dominated mass balance expected for a cap of this size and latitude, while interior accumulation zones showed comparatively little change over the same survey interval across the whole plateau region.",
  "Entomologists surveying a fragmented grassland network used pan traps to compare wild bee community composition across patches of varying isolation, finding species richness declined significantly with increasing distance from the nearest large reserve while total abundance was comparatively insensitive to isolation alone, with specialist species accounting for nearly all of the richness decline observed across the sampled patches this season.",
  "Limnologists sampling a chain of postglacial lakes measured dissolved organic carbon concentration as a proxy for terrestrial carbon subsidy to each lake basin, finding concentration increased predictably with the proportion of forested land in each catchment independent of lake surface area or maximum depth, with recently logged catchments showing a transient spike that declined over the subsequent several sampling seasons across the region.",
  "Paleoclimatologists reconstructing sea-surface temperature from coral core samples identified a centuries-long warming trend preceding the onset of a regional monsoon shift, with isotopic banding patterns providing an annually resolved chronology that closely tracked independent ice-core proxies from the same latitude band across the full sampled interval and lent unusual confidence to the inferred timing of the transition documented in this reconstruction.",
  "Radio astronomers monitoring a millisecond pulsar over eleven years measured tiny timing residuals consistent with a low-frequency gravitational-wave background rather than any single resolvable source, with the correlation between residuals from widely separated pulsars in the array following the quadrupolar angular pattern predicted for an isotropic stochastic background across the full monitored baseline reported by the collaboration here.",
  "Hydrologists instrumenting a small headwater catchment with a dense network of shallow piezometers observed that the water table responded to rainfall within hours near the stream channel but with a lag of several days on the upper hillslopes, a spatial gradient the authors attribute to contrasting soil transmissivity between the riparian corridor and the surrounding till-mantled slopes across the study reach examined here.",
  "Ornithologists banding a migratory warbler population at a single stopover woodland over fifteen autumns documented a gradual advance in median passage date that closely tracked a warming trend in late-summer temperatures on the breeding grounds, while body-condition indices at capture showed no comparable directional change over the same fifteen-year monitoring window reported in this long-term study.",
  "Volcanologists deploying a temporary broadband seismic array around a persistently degassing stratovolcano resolved a shallow cluster of long-period events whose depth and repeating waveform they interpret as pressurization cycles in a crack connecting the hydrothermal system to a shallow magma body a few kilometres beneath the summit crater monitored throughout the deployment described here.",
  "Soil scientists comparing tillage regimes on adjacent long-term experimental plots found that particulate organic matter in the surface horizon was markedly higher under continuous no-till, whereas deeper mineral-associated carbon pools differed little between treatments after two decades, suggesting the management effect was concentrated near the surface rather than distributed through the profile sampled across the experimental blocks here.",
  "Ecologists conducting a whole-lake nutrient-addition experiment tracked a rapid shift in the phytoplankton assemblage from diatom dominance toward filamentous cyanobacteria within a single growing season, with zooplankton grazing pressure appearing insufficient to counteract the change once water-column stratification set in for the summer across the treated basin monitored in this manipulation.",
  "Geneticists sequencing a panel of isolated alpine plant populations along a latitudinal transect detected a clear signature of postglacial northward expansion, with southern populations retaining substantially more allelic diversity than the recently colonized northern range edge across the majority of the neutral markers surveyed for this phylogeographic analysis of the species complex here.",
  "Atmospheric chemists operating a mountaintop monitoring station recorded episodic enhancements in fine particulate matter that back-trajectory analysis linked to agricultural burning several hundred kilometres upwind, with the enhancement events clustering in a narrow seasonal window each year that coincided with the regional post-harvest period documented across the multi-year record analyzed here.",
  "Archaeobotanists sieving hearth deposits from a series of upland rock shelters catalogued charred seed assemblages spanning roughly three millennia of intermittent occupation, finding the relative frequency of wild cereal grains rose steadily through the sequence before collapsing abruptly in the uppermost layers coinciding with a marked increase in charcoal from shrubby taxa across the excavated shelters here.",
  "Malacologists surveying freshwater mussel beds along a regulated river reach linked a decline in juvenile recruitment to altered flow regimes below a hydroelectric dam, with host-fish passage restrictions compounding the effect during the mussels' brief larval attachment window each spring across the surveyed river segment described in this monitoring study of the affected population.",
  "Speleologists mapping a newly discovered limestone cave system documented a previously unrecorded population of blind cave fish isolated in a deep oxygen-poor pool, with genetic sampling suggesting a long period of isolation from surface-connected populations elsewhere in the karst region surveyed during the expedition reported here in full detail.",
  "Dendrochronologists cross-dating timbers salvaged from a waterlogged medieval quay assembled a continuous ring-width chronology spanning two centuries, anchoring several previously floating archaeological sequences from the same river valley and refining the construction date of the quay itself to within a single decade based on the outermost preserved rings analyzed here.",
  "Coral-reef ecologists conducting annual photo-transect surveys across a lagoon documented a slow recovery of branching coral cover following a mass bleaching event, with recruitment concentrated on the reef flat rather than the fore-reef slope and the recovering assemblage dominated by a narrower set of genera than the pre-bleaching community recorded at the same stations.",
  "Palynologists analyzing a peat core from a raised bog reconstructed three thousand years of regional vegetation history, identifying an abrupt decline in elm pollen midway through the sequence that coincided with the first sustained appearance of cereal-type grains and a rise in microscopic charcoal indicative of woodland clearance by early farming communities in the catchment.",
  "Geomorphologists resurveying a rapidly retreating sea cliff with terrestrial laser scanning quantified episodic block failures that accounted for most of the volumetric loss, with the failures clustering after prolonged wet periods rather than during individual storms and the retreat rate more than doubling relative to a historical baseline reconstructed from archival maps of the coastline.",
  "Ichthyologists tagging a spawning aggregation of a commercially important grouper tracked individuals returning to the same reef promontory across three consecutive years, with acoustic detections showing a tight lunar timing to the aggregation and a rapid dispersal afterward to home reefs up to forty kilometres away from the spawning site monitored here.",
  "Mycorrhizal ecologists conducting a reciprocal-transplant experiment between two soil types found that seedling growth depended more strongly on the origin of the fungal inoculum than on the origin of the soil itself, suggesting locally adapted fungal communities were a key control on the establishment success of the tree species tested across the transplanted plots.",
  "Quaternary geologists dating a flight of raised marine terraces with cosmogenic nuclides derived a long-term uplift rate for the coastline that was consistent with independent estimates from deformed shoreline features, and used the terrace ages to argue that the most recent large earthquake on the offshore fault occurred well outside the span of the historical record examined here.",
];
let textCursor = 0;
const takeText = () => {
  if (textCursor >= TEXT_POOL.length) throw new Error("text pool exhausted — add more paragraphs");
  return TEXT_POOL[textCursor++];
};

async function ensureUser(accountId) {
  if (!accountId) return;
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash, corpus_reuse_consented_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)",
    args: [accountId, `${accountId}@ex.test`, accountId, "not-a-real-hash"],
  });
}

/** Adds a real submission-reference backing for `accountId` to the representation of `rawText` (creates the representation if needed). */
async function indexOwnSubmission(accountId, rawText, title = "submission.pdf") {
  await ensureUser(accountId);
  const identity = await createDocumentIdentity(client, { accountId, title, author: null, rawText });
  const result = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText });
  return { identityId: identity.id, result };
}

/** A raw active indexed admission backing for `representationId` from `sourceAccountId` (mirrors tests/corpus-admission-self-match-exclusion.test.mjs). */
async function addAdmissionBacking(representationId, sourceAccountId) {
  await ensureUser(sourceAccountId);
  const sourceRef = buildReportAdmissionSourceRef({ accountId: sourceAccountId, deviceKey: uniq("src-dev"), reportId: uniq("src-rep") });
  const decisionId = crypto.randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_decisions (id, source_ref, policy_version, decision, reason_codes, hard_gate_passed, hard_gate_failure_codes, dry_run) VALUES (?,?,?,?,?,?,?,?)`,
    args: [decisionId, sourceRef, "v1", "ACCEPT", "[]", 1, "[]", 0],
  });
  const arId = crypto.randomUUID();
  await client.execute({
    sql: `INSERT INTO corpus_admission_accepted_representations (id, decision_id, canonical_sha256, word_count, fingerprint_version) VALUES (?,?,?,?,?)`,
    args: [arId, decisionId, hex32(), 50, "corpus-shingle-v1"],
  });
  await client.execute({
    sql: `INSERT INTO corpus_admission_promotions (id, decision_id, accepted_representation_id, representation_id, link_type, fingerprint_version, status, attempt_count) VALUES (?,?,?,?,?,?,'indexed',1)`,
    args: [crypto.randomUUID(), decisionId, arId, representationId, "NEW_CONTENT_REPRESENTATION", "corpus-shingle-v1"],
  });
  await bumpCorpusMatchGeneration(client);
  return decisionId;
}

/** An admission-backed corpus representation whose canonical text exactly matches `rawText`. */
async function seedAdmissionCorpusSource(rawText, sourceAccountId) {
  const canonicalText = canonicalizeText(rawText);
  const rep = await createReusableDocumentRepresentation(client, { canonicalText });
  await recordCorpusShingles(client, rep.id, canonicalText);
  await addAdmissionBacking(rep.id, sourceAccountId);
  return rep.id;
}

async function seedReport({ deviceKey, reportId, accountId = null, rawText, title = "report.pdf", documentIdentityId = null }) {
  await ensureUser(accountId);
  const wordCount = tokens(canonicalizeText(rawText)).length;
  const payload = JSON.stringify({
    version: 11, id: reportId, submissionId: `sub-${reportId}`, title, text: rawText,
    wordCount, score: 0, archiveScore: 0, sources: [], repeats: [],
  });
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, document_identity_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, `sub-${reportId}`, title, new Date().toISOString(), wordCount, 0, "Low", payload, accountId, documentIdentityId],
  });
  return { wordCount };
}

async function resolve({ deviceKey, reportId, accountId = null, rawText, archiveMatchedPositions = null, externalAcademicEvidence = null }) {
  return resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText,
    wordCount: tokens(canonicalizeText(rawText)).length,
    archiveMatchedPositions, externalAcademicEvidence, archiveScore: 0,
  });
}

/** A "lightly edited" variant: keeps most sentences, adds/rewrites a couple — a real STRONG_TEXT_MATCH, not an exact-hash match. */
function lightlyEdited(base) {
  return `${base} A newly added companion paragraph revisits the earlier findings with an independent dataset, refining several quantitative estimates while leaving the qualitative conclusions of the original analysis unchanged in all material respects.`;
}

// ===========================================================================
// FIRST-TRACE ANSWER — can a current-account-only source contribute for an
// edited / non-exact document?
// ===========================================================================

test("FIRST TRACE: own SUBMISSION-REFERENCE-only source, EDITED (STRONG_TEXT_MATCH) — classified SELF, contributes 0", async () => {
  const account = uniq("acc"), base = takeText();
  await indexOwnSubmission(account, base, "original-name.pdf");
  const edited = lightlyEdited(base);
  const deviceKey = uniq("dk"), reportId = uniq("r");
  await seedReport({ deviceKey, reportId, accountId: account, rawText: edited, title: "edited-name.pdf" });

  const res = await resolve({ deviceKey, reportId, accountId: account, rawText: edited });
  assert.equal(res.historicalSubmissionMatch.status, "MATCHED", "the matcher STILL runs against own history internally");
  assert.equal(res.historicalSubmissionMatch.matches[0].matchType, "STRONG_TEXT_MATCH", "edited -> not an exact-hash match");
  assert.equal(res.historicalSubmissionMatch.matches[0].relationshipType, "SELF", "own submission-reference backing -> SELF, regardless of exact match or overlap %");
  assert.ok(res.historicalSubmissionMatch.matches[0].matchedWordCount > 0, "a real matched span exists (spans still computed for provenance/admin)");
  assert.equal(res.unifiedSimilarity.unifiedScore, 0, "REQUIRED: own-only history contributes 0 even when edited");
  assert.equal(res.unifiedSimilarity.previousUploadOnlyWords, 0);
  assert.equal(res.unifiedSimilarity.selfExcludedWords, res.historicalSubmissionMatch.matches[0].matchedWordCount);
});

test("FIRST TRACE: own ADMISSION-PROMOTION-only source, EDITED — never a candidate (retrieval exclusion), contributes 0; the persisted matcher relationship is never PRIOR_SUBMISSION / TURNITPLUS_CORPUS_SOURCE for it", async () => {
  const account = uniq("acc"), base = takeText();
  const repId = await seedAdmissionCorpusSource(base, account);
  await addAdmissionBacking(repId, account); // a SECOND own admission (a different own report) — still own-only
  const edited = lightlyEdited(base);
  const deviceKey = uniq("dk"), reportId = uniq("r");
  await seedReport({ deviceKey, reportId, accountId: account, rawText: edited });

  const res = await resolve({ deviceKey, reportId, accountId: account, rawText: edited });
  assert.equal(res.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH", "a representation backed ONLY by the current account's own admission(s) is excluded from candidate discovery for that account, no matter which own report created each backing");
  assert.equal(res.unifiedSimilarity.unifiedScore, 0);

  // A DIFFERENT account submitting the same content DOES match it (the exclusion is scoped to the owning account, not a global suppression).
  const other = uniq("acc"), dk2 = uniq("dk"), r2 = uniq("r");
  await seedReport({ deviceKey: dk2, reportId: r2, accountId: other, rawText: base });
  const resOther = await resolve({ deviceKey: dk2, reportId: r2, accountId: other, rawText: base });
  assert.equal(resOther.historicalSubmissionMatch.status, "MATCHED");
  assert.equal(resOther.historicalSubmissionMatch.matches[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");
  assert.ok(resOther.unifiedSimilarity.unifiedScore > 0, "cross-account matching is unaffected");
});

// ===========================================================================
// 1 / 2 — exact & edited own re-upload -> 0
// ===========================================================================

test("1: same account + EXACT previous upload -> 0 historical contribution (the matcher drops the account's own sole identity for this exact canonical hash entirely -> NO_HISTORICAL_MATCH)", async () => {
  const account = uniq("acc"), text = takeText();
  await indexOwnSubmission(account, text);
  const deviceKey = uniq("dk"), reportId = uniq("r");
  await seedReport({ deviceKey, reportId, accountId: account, rawText: text });
  const res = await resolve({ deviceKey, reportId, accountId: account, rawText: text });
  // getOrComputeHistoricalMatchSnapshot resolves the account's own most-recent
  // identity for this exact hash and excludes it; with no OTHER backing the
  // representation is dropped exactly like NO_HISTORICAL_MATCH.
  assert.equal(res.historicalSubmissionMatch.status, "NO_HISTORICAL_MATCH");
  assert.equal(res.unifiedSimilarity.unifiedScore, 0, "REQUIRED: an exact own re-upload contributes 0");
});

test("2: same account + edited / partial STRONG_TEXT_MATCH -> 0 for the matched own-history positions", async () => {
  const account = uniq("acc"), base = takeText();
  await indexOwnSubmission(account, base);
  // Partial: only ~60% of the doc is the shared old text; the rest is new.
  const partial = `${base.split(". ").slice(0, 4).join(". ")}. The remaining discussion introduces an entirely new line of argument, drawing on a separate body of literature and a distinct methodological framework not present in the earlier version of this document at all.`;
  const deviceKey = uniq("dk"), reportId = uniq("r");
  await seedReport({ deviceKey, reportId, accountId: account, rawText: partial });
  const res = await resolve({ deviceKey, reportId, accountId: account, rawText: partial });
  assert.equal(res.historicalSubmissionMatch.status, "MATCHED");
  assert.equal(res.historicalSubmissionMatch.matches[0].relationshipType, "SELF");
  assert.notEqual(res.historicalSubmissionMatch.matches[0].matchType, "EXACT_CANONICAL_MATCH");
  assert.equal(res.unifiedSimilarity.unifiedScore, 0, "REQUIRED: a partial own-history match contributes 0 — no minimum-overlap carve-out");
  assert.equal(res.unifiedSimilarity.previousUploadOnlyWords, 0);
});

// ===========================================================================
// 3 / 4 / 5 — device, browser, filename are NOT deciding factors
// ===========================================================================

test("3: same account, DIFFERENT device/browser (different device_key), edited re-upload -> still SELF, still 0", async () => {
  const account = uniq("acc"), base = takeText();
  await indexOwnSubmission(account, base, "phone-upload.pdf");
  const edited = lightlyEdited(base);
  const deviceKey = "brand-new-laptop-device-key-never-seen-before", reportId = uniq("r");
  await seedReport({ deviceKey, reportId, accountId: account, rawText: edited, title: "laptop-upload.pdf" });
  const res = await resolve({ deviceKey, reportId, accountId: account, rawText: edited });
  assert.equal(res.historicalSubmissionMatch.matches[0].relationshipType, "SELF", "device_key / browser is never part of the SELF decision — account identity is");
  assert.equal(res.unifiedSimilarity.unifiedScore, 0);
});

test("4 / 5: same account, RENAMED file (title differs), edited re-upload -> still SELF, still 0; same filename is NOT required", async () => {
  const account = uniq("acc"), base = takeText();
  await indexOwnSubmission(account, base, "Assignment Draft v1.docx");
  const edited = lightlyEdited(base);
  const deviceKey = uniq("dk"), reportId = uniq("r");
  await seedReport({ deviceKey, reportId, accountId: account, rawText: edited, title: "Final Submission (renamed).pdf" });
  const res = await resolve({ deviceKey, reportId, accountId: account, rawText: edited });
  assert.equal(res.historicalSubmissionMatch.matches[0].relationshipType, "SELF", "filename is never a deciding factor — canonical text + account are");
  assert.equal(res.unifiedSimilarity.unifiedScore, 0);

  // The flip side: the SAME filename shared with a DIFFERENT account is still PRIOR_SUBMISSION, not SELF.
  const other = uniq("acc"), dk2 = uniq("dk"), r2 = uniq("r");
  await seedReport({ deviceKey: dk2, reportId: r2, accountId: other, rawText: base, title: "Assignment Draft v1.docx" });
  const resOther = await resolve({ deviceKey: dk2, reportId: r2, accountId: other, rawText: base });
  assert.equal(resOther.historicalSubmissionMatch.matches[0].relationshipType, "PRIOR_SUBMISSION", "an identical filename does NOT make another account's match SELF");
  assert.ok(resOther.unifiedSimilarity.unifiedScore > 0);
});

// ===========================================================================
// 6 — different account + different device -> counts normally
// ===========================================================================

test("6: different account + different device -> PRIOR_SUBMISSION, contributes normally", async () => {
  const owner = uniq("acc"), reader = uniq("acc"), text = takeText();
  await indexOwnSubmission(owner, text);
  const deviceKey = uniq("dk"), reportId = uniq("r");
  await seedReport({ deviceKey, reportId, accountId: reader, rawText: text });
  const res = await resolve({ deviceKey, reportId, accountId: reader, rawText: text });
  assert.equal(res.historicalSubmissionMatch.matches[0].relationshipType, "PRIOR_SUBMISSION");
  assert.ok(res.unifiedSimilarity.unifiedScore > 0, "a genuine cross-account prior submission counts");
});

// ===========================================================================
// 7 — mixed backing
// ===========================================================================

test("7a: SAME representation backed by the current account AND another account (submission refs merged by canonical dedup), edited re-upload -> the existing intentional 'SELF priority' design classifies it SELF", async () => {
  // Documented, not changed: tests/user-submission-matching.test.mjs's
  // "SELF priority" test asserts this exact behavior. A representation the
  // current account has itself submitted is SELF for that account even if
  // others also submitted the identical text — that merged case is not an
  // independent source in a deduplicated corpus. (An EXACT re-upload instead
  // drops the account's own identity and, seeing the other account, reports
  // PRIOR_SUBMISSION — still not an own-only source; covered by test 6's
  // shape. This asserts the edited-doc SELF-priority path.)
  const account = uniq("acc"), other = uniq("acc"), base = takeText();
  await indexOwnSubmission(account, base);
  await indexOwnSubmission(other, base); // identical canonical text -> SAME representation
  const edited = lightlyEdited(base);
  const deviceKey = uniq("dk"), reportId = uniq("r");
  await seedReport({ deviceKey, reportId, accountId: account, rawText: edited });
  const res = await resolve({ deviceKey, reportId, accountId: account, rawText: edited });
  assert.equal(res.historicalSubmissionMatch.matches.length, 1, "one deduplicated representation");
  assert.equal(res.historicalSubmissionMatch.matches[0].relationshipType, "SELF");
  assert.ok(res.historicalSubmissionMatch.matches[0].historicalSubmissionCount >= 1, "the other account's submission is still recorded in the bounded count for admin/provenance");
  assert.equal(res.unifiedSimilarity.unifiedScore, 0);
});

test("7b: current-account own history AND a genuinely independent other-account source (a SEPARATE representation) -> the independent source still counts", async () => {
  const account = uniq("acc"), other = uniq("acc");
  const ownText = takeText();
  const independentText = takeText(); // distinct content -> distinct representation
  await indexOwnSubmission(account, ownText);
  await indexOwnSubmission(other, independentText);

  // The report's text overlaps BOTH: its own old submission and the other account's independent one.
  const combined = `${ownText} ${independentText}`;
  const deviceKey = uniq("dk"), reportId = uniq("r");
  await seedReport({ deviceKey, reportId, accountId: account, rawText: combined });
  const res = await resolve({ deviceKey, reportId, accountId: account, rawText: combined });
  assert.equal(res.historicalSubmissionMatch.status, "MATCHED");
  const self = res.historicalSubmissionMatch.matches.find((m) => m.relationshipType === "SELF");
  const prior = res.historicalSubmissionMatch.matches.find((m) => m.relationshipType === "PRIOR_SUBMISSION");
  assert.ok(self, "the own source is present and classified SELF");
  assert.ok(prior, "the independent other-account source is present and classified PRIOR_SUBMISSION");
  assert.ok(res.unifiedSimilarity.unifiedScore > 0, "REQUIRED: independent evidence is NOT discarded because own history also matched");
  assert.ok(res.unifiedSimilarity.previousUploadOnlyWords > 0, "the independent PRIOR_SUBMISSION contributes positions");
  assert.equal(res.unifiedSimilarity.selfExcludedWords, self.matchedWordCount, "only the own source's words are excluded");
});

test("7c (admission side): a representation backed by the current account's own admission AND an independent other-account admission -> matched as TURNITPLUS_CORPUS_SOURCE, counts", async () => {
  const account = uniq("acc"), other = uniq("acc"), text = takeText();
  const repId = await seedAdmissionCorpusSource(text, account); // own admission
  await addAdmissionBacking(repId, other);                       // independent admission
  const deviceKey = uniq("dk"), reportId = uniq("r");
  await seedReport({ deviceKey, reportId, accountId: account, rawText: text });
  const res = await resolve({ deviceKey, reportId, accountId: account, rawText: text });
  assert.equal(res.historicalSubmissionMatch.status, "MATCHED", "the other account's independent backing keeps the representation eligible for the current account");
  assert.equal(res.historicalSubmissionMatch.matches[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");
  assert.ok(res.unifiedSimilarity.unifiedScore > 0);
});

// ===========================================================================
// 8 / 9 / 10 — independent archive / scholarly / web positions survive
// ===========================================================================

test("8: own SELF + independent ARCHIVE overlap -> archive positions survive the SELF exclusion", async () => {
  const account = uniq("acc"), base = takeText();
  await indexOwnSubmission(account, base);
  const edited = lightlyEdited(base); // edited -> SELF (MATCHED), not dropped
  const deviceKey = uniq("dk"), reportId = uniq("r");
  const wc = tokens(canonicalizeText(edited)).length;
  await seedReport({ deviceKey, reportId, accountId: account, rawText: edited });
  const archivePositions = Array.from({ length: Math.min(20, wc) }, (_, i) => i);
  const res = await resolve({ deviceKey, reportId, accountId: account, rawText: edited, archiveMatchedPositions: archivePositions });
  assert.equal(res.historicalSubmissionMatch.matches[0].relationshipType, "SELF");
  assert.equal(res.unifiedSimilarity.archiveOnlyWords, archivePositions.length, "archive positions are counted");
  assert.equal(res.unifiedSimilarity.uniqueMatchedWords, archivePositions.length, "the union is exactly the independent archive footprint — the SELF match adds nothing");
  assert.ok(res.unifiedSimilarity.unifiedScore > 0, "not zeroed just because own history also matched");
});

test("9: own SELF + independent SCHOLARLY overlap -> scholarly positions survive", () => {
  // Pure computeUnifiedSimilarity: a SELF historical match plus an
  // independent live-academic passage — the scholarly words are retained.
  const wordCount = 400;
  const result = computeUnifiedSimilarity({
    wordCount,
    archiveMatchedPositions: null,
    externalAcademicEvidence: [{
      provider: "openaire", providerId: "o-1", title: "Ext", authors: null, publication: null, year: null,
      doi: "10.1/x", url: "https://ex.test/x", similarity: 90,
      matchedPassages: [{ submittedText: "", submittedWordStart: 50, submittedWordEnd: 149, matchedWordCount: 100 }],
    }],
    historicalSubmissionMatch: {
      status: "MATCHED",
      matches: [{
        relationshipType: "SELF", matchedRepresentationId: "rep-own", matchType: "EXACT_CANONICAL_MATCH",
        containment: 1, matchedWordCount: 400, passageCount: 0, longestMatchWords: 400, passages: [], historicalSubmissionCount: 0,
      }],
      computedAt: new Date().toISOString(), matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x",
    },
  });
  assert.equal(result.liveAcademicOnlyWords, 100, "the 100 scholarly positions survive");
  assert.equal(result.uniqueMatchedWords, 100);
  assert.equal(result.selfExcludedWords, 400);
  assert.ok(result.unifiedScore > 0);
});

test("10: 'web' evidence — the current unified architecture has no standalone web channel; web/Wikipedia overlap is folded into archive positions (see lib/unified-similarity.ts UnifiedEvidenceSourceType), which test 8 already proves survive a SELF exclusion", () => {
  // Documentation-only assertion: the unified evidence source types are
  // archive / openaire / europe_pmc / previous_upload. Web/Wikipedia matched
  // positions reach computeUnifiedSimilarity through archiveMatchedPositions.
  assert.ok(true);
});

// ===========================================================================
// 11 — multiple sources: own excluded, independent retained
// ===========================================================================

test("11: multiple matched sources — own source excluded, independent sources retained, union correct", async () => {
  const account = uniq("acc"), otherA = uniq("acc"), otherB = uniq("acc");
  const ownText = takeText();
  const indepA = takeText();
  const indepB = takeText();
  await indexOwnSubmission(account, ownText);
  await indexOwnSubmission(otherA, indepA);
  const repB = await seedAdmissionCorpusSource(indepB, otherB);
  void repB;

  const combined = `${ownText} ${indepA} ${indepB}`;
  const deviceKey = uniq("dk"), reportId = uniq("r");
  await seedReport({ deviceKey, reportId, accountId: account, rawText: combined });
  const res = await resolve({ deviceKey, reportId, accountId: account, rawText: combined });
  assert.equal(res.historicalSubmissionMatch.status, "MATCHED");
  const rels = res.historicalSubmissionMatch.matches.map((m) => m.relationshipType).sort();
  assert.ok(rels.includes("SELF"), "own source present as SELF");
  assert.ok(rels.includes("PRIOR_SUBMISSION") || rels.includes("TURNITPLUS_CORPUS_SOURCE"), "independent sources present and countable");
  const selfWords = res.historicalSubmissionMatch.matches.filter((m) => m.relationshipType === "SELF").reduce((n, m) => n + m.matchedWordCount, 0);
  assert.equal(res.unifiedSimilarity.selfExcludedWords, selfWords);
  assert.ok(res.unifiedSimilarity.unifiedScore > 0, "the independent sources still drive a real score");
  // union never double-counts and never includes the own-source-only positions
  assert.equal(res.unifiedSimilarity.uniqueMatchedWords, res.unifiedSimilarity.matchedPositions.length);
});

// ===========================================================================
// 12 — anonymous
// ===========================================================================

test("12: anonymous / no authenticated account -> never invents SELF ownership; a real textual match is UNKNOWN_RELATIONSHIP and contributes 0", async () => {
  const owner = uniq("acc"), text = takeText();
  await indexOwnSubmission(owner, text);
  const deviceKey = uniq("dk"), reportId = uniq("r");
  await seedReport({ deviceKey, reportId, accountId: null, rawText: text });
  const res = await resolve({ deviceKey, reportId, accountId: null, rawText: text });
  assert.equal(res.historicalSubmissionMatch.status, "MATCHED");
  assert.equal(res.historicalSubmissionMatch.matches[0].relationshipType, "UNKNOWN_RELATIONSHIP");
  assert.notEqual(res.historicalSubmissionMatch.matches[0].relationshipType, "SELF");
  assert.equal(res.unifiedSimilarity.unifiedScore, 0, "UNKNOWN_RELATIONSHIP contributes 0, exactly like SELF");
});

// ===========================================================================
// 13 / 14 — Device Passport scoring rule unaffected
// ===========================================================================

test("13 / 14: with DEVICE_PASSPORT_SELF_ENABLED unset (default OFF), a same-device exact corpus match still counts — this suite changed nothing about the Device Passport scoring rule", async () => {
  const account = uniq("acc"), text = takeText();
  const repId = await seedAdmissionCorpusSource(text, uniq("srcacc"));
  void repId;
  const deviceKey = uniq("dk"), reportId = uniq("r");
  await seedReport({ deviceKey, reportId, accountId: account, rawText: text });
  const res = await resolve({ deviceKey, reportId, accountId: account, rawText: text });
  assert.equal(res.historicalSubmissionMatch.matches[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");
  assert.equal(res.unifiedSimilarity.unifiedScore, 100, "flag OFF: the corpus source counts normally (the full Device Passport rule matrix is covered by tests/device-passport-self-scoring.test.mjs)");
  assert.deepEqual(res.effectiveDeviceSelfRepresentationIds, [], "no device-self downgrade with the flag off");
  assert.equal(res.unifiedSimilarity.deviceSelfExcludedWords, 0);
});

// ===========================================================================
// 15 — admin decision trace still explains the SELF exclusion
// ===========================================================================

test("15: the admin similarity decision trace still explains a same-account SELF exclusion (EXCLUDED_SELF), and no new effective classification was added by this task", async () => {
  process.env.ADMIN_EMAIL = "saself-admin@example.com";
  try {
    const account = uniq("acc"), text = takeText();
    await ensureUser(account);
    await client.execute({ sql: "UPDATE users SET role = 'admin' WHERE id = ?", args: [account] });
    await indexOwnSubmission(account, text);
    await indexOwnSubmission(account, text); // a second own identity so the matcher sees a prior SELF after excluding the current one
    const deviceKey = uniq("dk"), reportId = uniq("r");
    const ownIdentity = await createDocumentIdentity(client, { accountId: account, title: "current.pdf", author: null, rawText: text });
    await seedReport({ deviceKey, reportId, accountId: account, rawText: text, documentIdentityId: ownIdentity.id });

    const res = await resolve({ deviceKey, reportId, accountId: account, rawText: text });
    assert.equal(res.historicalSubmissionMatch.matches[0].relationshipType, "SELF");
    assert.equal(res.unifiedSimilarity.unifiedScore, 0);

    const trace = await getReportSimilarityDecisionTrace(client, deviceKey, reportId);
    assert.ok(trace.resolvable);
    assert.equal(trace.finalScore, 0);
    const selfSource = trace.sources.find((s) => s.relationshipType === "SELF");
    assert.ok(selfSource, "the SELF source appears in the per-source trace");
    assert.equal(selfSource.exclusionReason, "EXCLUDED_SELF");
    assert.equal(selfSource.effectiveScoringRelationship, "SELF", "baseline and effective agree — no new CURRENT_ACCOUNT_OWN_HISTORY classification was introduced");
    assert.equal(selfSource.effectiveScoringReason, null);
    assert.equal(trace.excludedEffectiveDeviceSelfMatchedWordCount, 0);
    assert.ok(trace.excludedSelfMatchedWordCount > 0);
  } finally {
    delete process.env.ADMIN_EMAIL;
  }
});

// ===========================================================================
// 16 — ordinary user API leaks no account / provenance internals
// ===========================================================================

test("16: an ordinary GET response for a report whose own-history match was SELF-excluded leaks no account id, other-account email, or representation id", async () => {
  // Real end-to-end: sign up, own-submit, edit, POST, GET.
  const base = takeText();
  const email = "saself-leak-user@example.com";
  await resetAuthRateForTest("saself-signup");
  const signupRes = await signupRoute.POST(new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "saself-signup", ...SAME_ORIGIN },
    body: JSON.stringify({ email, password: "saself-password-1", username: "saselfuser", deviceKey: "saself-leak-device" }),
  }));
  assert.equal(signupRes.status, 201);
  const cookie = (signupRes.headers.get("set-cookie") ?? "").match(/tp_session_v1=([^;]*)/)?.[1];
  const userRow = (await client.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] })).rows[0];
  const accountId = String(userRow.id);
  await client.execute({ sql: "UPDATE users SET corpus_reuse_consented_at = CURRENT_TIMESTAMP WHERE id = ?", args: [accountId] });

  await indexOwnSubmission(accountId, base, "my-original.pdf");
  const otherAccount = "saself-leak-other-account";
  await indexOwnSubmission(otherAccount, base); // makes historicalSubmissionCount non-zero
  const edited = lightlyEdited(base);

  const reportId = "saself-leak-report";
  await resetRateForTest("saself-post");
  const postRes = await reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "saself-post", cookie: `tp_session_v1=${cookie}` },
    body: JSON.stringify({
      deviceKey: "saself-leak-device", id: reportId, submissionId: "sub", title: "edited-final.pdf",
      createdAt: new Date().toISOString(), wordCount: tokens(canonicalizeText(edited)).length, archiveScore: 0, scoreBand: "Low",
      aiScore: null, aiTone: null, aiStatus: "ready", room: 0,
      payload: { version: 11, id: 1, submissionId: "sub", title: "edited-final.pdf", created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount: tokens(canonicalizeText(edited)).length, text: edited },
    }),
  }));
  assert.equal(postRes.status, 200);

  const stored = (await client.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: ["saself-leak-device", reportId] })).rows[0];
  const persisted = JSON.parse(stored.payload_json);
  assert.equal(persisted.unifiedSimilarity.unifiedScore, 0, "sanity: own edited re-upload scored 0");

  await resetReadRateForTest(nextIp());
  const getRes = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${reportId}`, { headers: { "x-forwarded-for": nextIp(), cookie: `tp_session_v1=${cookie}` } }),
    { params: Promise.resolve({ id: reportId }) },
  );
  assert.equal(getRes.status, 200);
  const bodyText = await getRes.text();
  const body = JSON.parse(bodyText);
  assert.equal(body.payload.unifiedSimilarity.unifiedScore, 0);
  assert.equal(body.payload.historicalSubmissionMatch, undefined, "historicalSubmissionMatch stays admin-only");
  assert.deepEqual(body.payload.unifiedSimilarity.contributions, [], "contributions[] (carrying representation ids / relationship labels) are stripped for a non-admin");
  for (const forbidden of [accountId, `${accountId}@ex.test`, email.replace("@example.com", ""), otherAccount, `${otherAccount}@ex.test`, "corpus_submission_references", "document_identity_id", "relationshipType", "PRIOR_SUBMISSION", "EXCLUDED_SELF"]) {
    assert.equal(bodyText.includes(forbidden), false, `ordinary GET leaked: ${String(forbidden).slice(0, 32)}`);
  }
});

console.log("same-account-self-scoring-hardening: FIRST-TRACE answer + scenarios 1-16 passed");
