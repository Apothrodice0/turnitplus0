import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import path from "path";
import crypto, { webcrypto, createHash } from "node:crypto";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { canonicalizeText } from "../lib/canonical-text.ts";
import { tokens } from "../lib/similarity-core.ts";
import { canonicalSha256, createDocumentIdentity } from "../lib/document-identity.ts";
import {
  createReusableDocumentRepresentation,
  recordCorpusShingles,
  indexDocumentSubmissionIntoCorpus,
} from "../lib/user-submission-corpus.ts";
import { buildReportAdmissionSourceRef } from "../lib/corpus-admission-source-ref.ts";
import { computeUnifiedSimilarity } from "../lib/unified-similarity.ts";
import { resolvePrimarySimilaritySummary } from "../lib/report-primary-similarity.ts";
import {
  runDeviceProvenanceShadowEvaluation,
  DEVICE_PROVENANCE_SHADOW_POLICY_VERSION,
} from "../lib/device-provenance-shadow.ts";
import { getReportSimilarityDecisionTrace } from "../lib/developer-repo.ts";
import {
  classifyDeviceSelfMatch,
  productionCountsRelationship,
  isDeviceSelfEligibleMatchType,
  DEVICE_SELF_SCORING_REASON,
  DEVICE_SELF_STRONG_TEXT_SCORING_REASON,
} from "../lib/device-self-scoring-rule.ts";
import {
  derivePassportId,
  buildDevicePassportSignedMessage,
  createDevicePassportChallenge,
  DEVICE_PASSPORT_ALGORITHM,
} from "../lib/device-passport-server.ts";
import * as reportsRoute from "../app/api/reports/route.ts";
import * as reportIdRoute from "../app/api/reports/[id]/route.ts";
import { resetRateForTest, resetReadRateForTest } from "../lib/rate-limit.ts";

/**
 * Preview-gated same-device SELF unified-similarity SCORING rule
 * (DEVICE_PASSPORT_SELF_ENABLED). Covers the 16 required scenarios plus the
 * pure classifier and the shadow/production shared-helper equivalence.
 *
 * Scoring invariants proven here:
 *   A  proven same-device corpus-only fixture: flag OFF -> 100, flag ON -> 0
 *   B  a different verified device: still counts
 *   C  no verified passport on the target report: still counts
 *   D  same device + STRONG_TEXT_MATCH: NOW an effective SELF too (distinct
 *      reason SAME_DEVICE_STRONG_TEXT_DOCUMENT); a different device / an
 *      independent backing still block it
 *   E  same device exact BUT independent backing exists: still counts
 *   F  independent archive / scholarly positions survive the SELF exclusion
 *      (exact AND strong)
 *   G  existing same-account SELF behaviour is unchanged
 *   H  flag OFF preserves the current unified similarity output byte-for-byte
 */

const repoRoot = path.resolve(".");
const drizzleDir = path.join(repoRoot, "drizzle");
const dbFile = path.join(repoRoot, "test_device_passport_self_scoring.db");
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
}

process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.CORPUS_SOURCE_MATCHING_ENABLED = "true";
const originalPassportFlag = process.env.DEVICE_PASSPORT_ENABLED;
const originalSelfFlag = process.env.DEVICE_PASSPORT_SELF_ENABLED;
process.env.DEVICE_PASSPORT_ENABLED = "true";
delete process.env.DEVICE_PASSPORT_SELF_ENABLED; // per-test via withSelfScoring()

const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, drizzleDir);

test.after(() => {
  client.close();
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.CORPUS_SOURCE_MATCHING_ENABLED;
  if (originalPassportFlag === undefined) delete process.env.DEVICE_PASSPORT_ENABLED;
  else process.env.DEVICE_PASSPORT_ENABLED = originalPassportFlag;
  if (originalSelfFlag === undefined) delete process.env.DEVICE_PASSPORT_SELF_ENABLED;
  else process.env.DEVICE_PASSPORT_SELF_ENABLED = originalSelfFlag;
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
const sha256Hex = (b) => createHash("sha256").update(b).digest("hex");
const SAME_ORIGIN = { origin: "http://localhost", host: "localhost" };
let ipSeq = 0;
const nextIp = () => `dpss-${++ipSeq}`;

function withSelfScoring(value, fn) {
  const original = process.env.DEVICE_PASSPORT_SELF_ENABLED;
  if (value === undefined) delete process.env.DEVICE_PASSPORT_SELF_ENABLED;
  else process.env.DEVICE_PASSPORT_SELF_ENABLED = value;
  return Promise.resolve(fn()).finally(() => {
    if (original === undefined) delete process.env.DEVICE_PASSPORT_SELF_ENABLED;
    else process.env.DEVICE_PASSPORT_SELF_ENABLED = original;
  });
}

// Eight genuinely distinct paragraphs so no two DB-backed scenarios cross-match
// (matchAgainstUserSubmissionCorpus does a real global shingle search).
const TEXT_POOL = [
  "Seismologists analyzing a dense array of borehole strainmeters detected a slow-slip transient event migrating along a subduction interface over several weeks, with surface GPS stations recording displacement magnitudes too small to be felt but clearly resolvable in the processed strain time series, a pattern the authors argue represents a genuine precursory process worth continued monitoring at this specific segment.",
  "Glaciologists resurveying an alpine ice cap used repeat airborne lidar to quantify surface elevation change across four consecutive melt seasons, finding thinning concentrated at lower elevations near the terminus consistent with the ablation-dominated mass balance expected for a cap of this size and latitude, while interior accumulation zones showed comparatively little change over the same survey interval.",
  "Entomologists surveying a fragmented grassland network used pan traps to compare wild bee community composition across patches of varying isolation, finding species richness declined significantly with increasing distance from the nearest large reserve while total abundance was comparatively insensitive to isolation alone, with specialist species accounting for nearly all of the richness decline observed.",
  "Limnologists sampling a chain of postglacial lakes measured dissolved organic carbon concentration as a proxy for terrestrial carbon subsidy to each lake basin, finding concentration increased predictably with the proportion of forested land in each catchment independent of lake surface area or maximum depth, with recently logged catchments showing a transient spike that declined over subsequent seasons.",
  "Marine biologists tracking a tagged population of leatherback turtles across the equatorial current recorded an unexpected mid-ocean foraging detour that coincided precisely with a transient bloom of gelatinous zooplankton detected by three independent satellite chlorophyll passes over the same fortnight, which the survey team flagged as the strongest evidence yet for opportunistic long-range prey tracking in this species.",
  "Paleoclimatologists reconstructing sea-surface temperature records from coral core samples identified a centuries-long warming trend preceding the onset of a regional monsoon shift, with isotopic banding patterns providing an annually resolved chronology that closely tracked independent ice-core proxies from the same latitude band across the full sampled interval and lent unusual confidence to the inferred timing.",
  "Archaeobotanists sieving hearth deposits from a series of upland rock shelters catalogued charred seed assemblages spanning roughly three millennia of intermittent occupation, finding the relative frequency of wild cereal grains rose steadily through the sequence before collapsing abruptly in the uppermost layers, coinciding with a marked increase in charcoal from shrubby taxa across the region.",
  "Radio astronomers monitoring a millisecond pulsar over eleven years measured tiny timing residuals consistent with a low-frequency gravitational-wave background rather than any single resolvable source, with the correlation between residuals from widely separated pulsars in the array following the quadrupolar angular pattern predicted for an isotropic stochastic background across the full monitored baseline.",
  "Hydrologists instrumenting a small headwater catchment with a dense network of shallow piezometers observed that the water table responded to rainfall within hours near the stream channel but with a lag of several days on the upper hillslopes, a spatial gradient the authors attribute to contrasting soil transmissivity between the riparian corridor and the surrounding till-mantled slopes across the study reach.",
  "Ornithologists banding a migratory warbler population at a single stopover woodland over fifteen autumns documented a gradual advance in median passage date that closely tracked a warming trend in late-summer temperatures on the breeding grounds, while body-condition indices at capture showed no comparable directional change over the same fifteen-year monitoring window.",
  "Volcanologists deploying a temporary broadband seismic array around a persistently degassing stratovolcano resolved a shallow cluster of long-period events whose depth and repeating waveform they interpret as pressurization cycles in a crack connecting the hydrothermal system to a shallow magma body a few kilometres beneath the summit crater.",
  "Soil scientists comparing tillage regimes on adjacent long-term experimental plots found that particulate organic matter in the surface horizon was markedly higher under continuous no-till, whereas deeper mineral-associated carbon pools differed little between treatments after two decades, suggesting the management effect was concentrated near the surface rather than distributed through the profile.",
  "Ecologists conducting a whole-lake nutrient-addition experiment tracked a rapid shift in the phytoplankton assemblage from diatom dominance toward filamentous cyanobacteria within a single growing season, with zooplankton grazing pressure appearing insufficient to counteract the change once water-column stratification set in for the summer.",
  "Geneticists sequencing a panel of isolated alpine plant populations along a latitudinal transect detected a clear signature of postglacial northward expansion, with southern populations retaining substantially more allelic diversity than the recently colonized northern range edge across the majority of the neutral markers surveyed.",
  "Atmospheric chemists operating a mountaintop monitoring station recorded episodic enhancements in fine particulate matter that back-trajectory analysis linked to agricultural burning several hundred kilometres upwind, with the enhancement events clustering in a narrow seasonal window each year that coincided with the regional post-harvest period.",
  "Mycologists surveying a temperate hardwood forest across a soil-moisture gradient catalogued ectomycorrhizal fruiting bodies over five autumns, finding sporocarp diversity peaked on moderately drained mid-slope plots while both the wettest hollows and the driest ridgetops supported markedly fewer species, a pattern the team links to fine-root density rather than canopy composition alone.",
  "Oceanographers deploying a moored profiler on the continental slope captured a train of nonlinear internal waves each generated on the ebb tide at a submarine ridge, with the leading wave of each packet displacing the thermocline by tens of metres and driving brief but intense near-bottom currents recorded by the lowest instrument on the mooring line.",
  "Demographers reconstructing parish registers from three neighbouring valleys traced a century of marriage patterns, finding the age gap between spouses narrowed steadily as seasonal labour migration drew younger men away from the home villages, while remarriage rates for widows fell over the same interval across all three valleys studied.",
  "Materials scientists cycling a prototype solid-state battery cell through several hundred charge-discharge cycles tracked the growth of interfacial resistance with impedance spectroscopy, attributing most of the capacity fade to a slowly thickening reaction layer at one electrode rather than to loss of active material in the bulk of the cell.",
];
let textCursor = 0;
const takeText = () => {
  if (textCursor >= TEXT_POOL.length) throw new Error("text pool exhausted");
  return TEXT_POOL[textCursor++];
};

async function ensureUser(accountId) {
  if (!accountId) return;
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (id, email, username, password_hash, corpus_reuse_consented_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)",
    args: [accountId, `${accountId}@ex.test`, accountId, "not-a-real-hash"],
  });
}

async function ensurePassport(passportId, spkiDer = null) {
  await client.execute({
    sql: "INSERT OR IGNORE INTO device_passports (id, public_key_spki, algorithm, created_at, provenance_generation) VALUES (?,?,?,?,0)",
    args: [passportId, spkiDer ?? Buffer.from(`spki-${passportId}`), DEVICE_PASSPORT_ALGORITHM, Date.now()],
  });
}

async function seedReport({ deviceKey, reportId, accountId = null, passportId = null, rawText, documentIdentityId = null }) {
  await ensureUser(accountId);
  if (passportId) await ensurePassport(passportId);
  const wordCount = tokens(canonicalizeText(rawText)).length;
  const payload = JSON.stringify({
    version: 11, id: reportId, submissionId: `sub-${reportId}`, title: "t.pdf", text: rawText,
    wordCount, score: 0, archiveScore: 0, sources: [], repeats: [],
  });
  await client.execute({
    sql: `INSERT INTO saved_reports (id, device_key, submission_id, title, report_created_at, word_count, archive_score, score_band, payload_json, user_id, verified_device_passport_id, document_identity_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [reportId, deviceKey, `sub-${reportId}`, "t.pdf", new Date().toISOString(), wordCount, 0, "Low", payload, accountId, passportId, documentIdentityId],
  });
  return { wordCount };
}

/** An active indexed admission backing for `representationId` (mirrors tests/device-provenance-shadow.test.mjs). */
async function addAdmissionBacking(representationId, { sourceAccountId, passportId = null } = {}) {
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
  if (passportId) {
    await ensurePassport(passportId);
    await client.execute({
      sql: `INSERT INTO corpus_admission_decision_device_provenance (decision_id, device_passport_id, verified_at) VALUES (?,?,?)`,
      args: [decisionId, passportId, Date.now()],
    });
  }
  return decisionId;
}

/**
 * A promoted corpus representation whose canonical text EXACTLY matches
 * `rawText`, backed only by a same-device admission promotion (optionally a
 * different passport, or an extra independent backing) — the real
 * TURNITPLUS_CORPUS_SOURCE / EXACT_CANONICAL_MATCH shape the matcher produces.
 */
async function seedExactCorpusSource(rawText, { backingPassportId = null, extraIndependentBacking = false, sourceAccountId = null } = {}) {
  const canonicalText = canonicalizeText(rawText);
  const rep = await createReusableDocumentRepresentation(client, { canonicalText });
  await recordCorpusShingles(client, rep.id, canonicalText);
  const srcAcc = sourceAccountId ?? uniq("srcacc");
  await addAdmissionBacking(rep.id, { sourceAccountId: srcAcc, passportId: backingPassportId });
  if (extraIndependentBacking) {
    // A second admission backing from a DIFFERENT verified device — an
    // independent backing (INDEPENDENT_BACKING_DEFINITION rule 2) that keeps
    // the relationship TURNITPLUS_CORPUS_SOURCE (no submission reference).
    await addAdmissionBacking(rep.id, { sourceAccountId: uniq("indep-acc"), passportId: uniq("indep-passport") });
  }
  return rep.id;
}

async function resolve({ deviceKey, reportId, accountId = null, rawText, archiveMatchedPositions = null, externalAcademicEvidence = null }) {
  return resolvePrimarySimilaritySummary(client, {
    reportDeviceKey: deviceKey, reportId, accountId, rawText,
    wordCount: tokens(canonicalizeText(rawText)).length,
    archiveMatchedPositions, externalAcademicEvidence, archiveScore: 0,
  });
}

async function shadowRow(deviceKey, reportId) {
  const r = await client.execute({
    sql: "SELECT * FROM historical_match_shadow_evaluations WHERE report_device_key = ? AND report_id = ? AND policy_version = ?",
    args: [deviceKey, reportId, DEVICE_PROVENANCE_SHADOW_POLICY_VERSION],
  });
  return r.rows[0] ? { ...r.rows[0] } : null;
}

// A synthetic MATCHED result (for the pure computeUnifiedSimilarity invariant tests).
function matchEntry(repId, { relationshipType = "TURNITPLUS_CORPUS_SOURCE", matchType = "EXACT_CANONICAL_MATCH", matchedWordCount = 6291, passages = [] } = {}) {
  return {
    relationshipType, matchedRepresentationId: repId, matchType,
    containment: 1, matchedWordCount, passageCount: passages.length, longestMatchWords: matchedWordCount,
    passages, historicalSubmissionCount: 0,
  };
}
const matched = (matches) => ({ status: "MATCHED", matches, computedAt: new Date().toISOString(), matcherVersion: "x", fingerprintVersion: "x", canonicalizationVersion: "x" });
const range = (a, b) => { const o = []; for (let i = a; i < b; i += 1) o.push(i); return o; };

// ===========================================================================
// pure classifier
// ===========================================================================

test("pure: productionCountsRelationship — only PRIOR_SUBMISSION and TURNITPLUS_CORPUS_SOURCE", () => {
  assert.equal(productionCountsRelationship("PRIOR_SUBMISSION"), true);
  assert.equal(productionCountsRelationship("TURNITPLUS_CORPUS_SOURCE"), true);
  assert.equal(productionCountsRelationship("SELF"), false);
  assert.equal(productionCountsRelationship("UNKNOWN_RELATIONSHIP"), false);
  assert.equal(productionCountsRelationship(null), false);
  assert.equal(productionCountsRelationship(undefined), false);
});

test("pure: classifyDeviceSelfMatch fires only when ALL four conditions hold (matchType: EXACT or STRONG)", () => {
  const base = { relationshipType: "TURNITPLUS_CORPUS_SOURCE", matchType: "EXACT_CANONICAL_MATCH", sameVerifiedDeviceBacking: true, independentBackingCount: 0 };
  assert.equal(classifyDeviceSelfMatch(base).isEffectiveDeviceSelf, true);
  assert.equal(classifyDeviceSelfMatch(base).reason, DEVICE_SELF_SCORING_REASON);
  assert.equal(classifyDeviceSelfMatch(base).exactCanonicalMatch, true);
  assert.equal(classifyDeviceSelfMatch(base).strongTextMatch, false);

  // STRONG_TEXT_MATCH now ALSO qualifies — with a DISTINCT reason.
  const strong = { ...base, matchType: "STRONG_TEXT_MATCH" };
  assert.equal(classifyDeviceSelfMatch(strong).isEffectiveDeviceSelf, true);
  assert.equal(classifyDeviceSelfMatch(strong).reason, DEVICE_SELF_STRONG_TEXT_SCORING_REASON);
  assert.equal(classifyDeviceSelfMatch(strong).strongTextMatch, true);
  assert.equal(classifyDeviceSelfMatch(strong).exactCanonicalMatch, false);
  assert.equal(classifyDeviceSelfMatch(strong).eligibleMatchType, true);

  // the other three conditions still each independently block, for BOTH match types.
  for (const mt of ["EXACT_CANONICAL_MATCH", "STRONG_TEXT_MATCH"]) {
    const b = { ...base, matchType: mt };
    assert.equal(classifyDeviceSelfMatch({ ...b, relationshipType: "SELF" }).isEffectiveDeviceSelf, false);
    assert.equal(classifyDeviceSelfMatch({ ...b, relationshipType: "UNKNOWN_RELATIONSHIP" }).isEffectiveDeviceSelf, false);
    assert.equal(classifyDeviceSelfMatch({ ...b, sameVerifiedDeviceBacking: false }).isEffectiveDeviceSelf, false);
    assert.equal(classifyDeviceSelfMatch({ ...b, independentBackingCount: 1 }).isEffectiveDeviceSelf, false);
    assert.equal(classifyDeviceSelfMatch({ ...b, independentBackingCount: 1 }).reason, "NOT_DEVICE_SELF");
  }

  // any non-EXACT/STRONG matchType is still not eligible.
  assert.equal(isDeviceSelfEligibleMatchType("EXACT_CANONICAL_MATCH"), true);
  assert.equal(isDeviceSelfEligibleMatchType("STRONG_TEXT_MATCH"), true);
  assert.equal(isDeviceSelfEligibleMatchType("NEAR_MATCH"), false);
  assert.equal(isDeviceSelfEligibleMatchType(null), false);
  assert.equal(classifyDeviceSelfMatch({ ...base, matchType: "NEAR_MATCH" }).isEffectiveDeviceSelf, false);
});

// ===========================================================================
// 16 / H — flag OFF preserves current unified similarity output byte-for-byte
// ===========================================================================

test("16/H: computeUnifiedSimilarity with an empty effectiveDeviceSelfRepresentationIds is byte-identical to omitting the parameter", () => {
  const hsm = matched([matchEntry("rep-a", { relationshipType: "PRIOR_SUBMISSION", matchedWordCount: 100, passages: [{ submittedText: "x", submittedWordStart: 0, submittedWordEnd: 99, matchedWordCount: 100 }] })]);
  const params = { wordCount: 400, archiveMatchedPositions: range(0, 20), externalAcademicEvidence: null, historicalSubmissionMatch: hsm };
  const without = computeUnifiedSimilarity(params);
  const withEmptyArray = computeUnifiedSimilarity({ ...params, effectiveDeviceSelfRepresentationIds: [] });
  const withEmptySet = computeUnifiedSimilarity({ ...params, effectiveDeviceSelfRepresentationIds: new Set() });
  const withNull = computeUnifiedSimilarity({ ...params, effectiveDeviceSelfRepresentationIds: null });
  assert.deepEqual(withEmptyArray, without);
  assert.deepEqual(withEmptySet, without);
  assert.deepEqual(withNull, without);
  assert.equal(without.deviceSelfExcludedWords, 0);
});

// ===========================================================================
// A — proven same-device corpus-only fixture: OFF -> 100, ON -> 0
// ===========================================================================

test("A/1/2: proven same-device exact corpus-only fixture — flag OFF stays 100%, flag ON becomes 0%", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), passportId = uniq("passport");
  const repId = await seedExactCorpusSource(text, { backingPassportId: passportId });
  await seedReport({ deviceKey, reportId, passportId, rawText: text });

  const off = await withSelfScoring(undefined, () => resolve({ deviceKey, reportId, rawText: text }));
  assert.equal(off.historicalSubmissionMatch.status, "MATCHED");
  assert.equal(off.historicalSubmissionMatch.matches[0].relationshipType, "TURNITPLUS_CORPUS_SOURCE");
  assert.equal(off.historicalSubmissionMatch.matches[0].matchType, "EXACT_CANONICAL_MATCH");
  assert.equal(off.unifiedSimilarity.unifiedScore, 100, "flag OFF: current scoring, an exact whole-document corpus match is 100%");
  assert.deepEqual(off.effectiveDeviceSelfRepresentationIds, [], "flag OFF: never even resolved");
  assert.equal(off.unifiedSimilarity.deviceSelfExcludedWords, 0);

  const on = await withSelfScoring("true", () => resolve({ deviceKey, reportId, rawText: text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 0, "flag ON: the same-device corpus source is an effective SELF and contributes nothing");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [repId]);
  assert.ok(on.unifiedSimilarity.deviceSelfExcludedWords > 0);
  assert.equal(on.unifiedSimilarity.selfExcludedWords, 0, "G: genuine same-account SELF tally is untouched");
  // the persisted historical-match snapshot / relationship is unchanged (baseline evidence)
  assert.deepEqual(on.historicalSubmissionMatch, off.historicalSubmissionMatch, "the matcher result / snapshot is not rewritten by the rule");
  const contrib = on.unifiedSimilarity.contributions.find((c) => c.sourceId === repId);
  assert.equal(contrib.relationship, "TURNITPLUS_CORPUS_SOURCE", "baseline relationship preserved on the contribution");
  assert.equal(contrib.effectiveScoringRelationship, "SELF");
  assert.equal(contrib.effectiveScoringReason, "SAME_DEVICE_EXACT_DOCUMENT");
  assert.equal(contrib.evidenceStatus, "excluded_effective_device_self");
});

// ===========================================================================
// B / 3 — a different verified device: still counts
// ===========================================================================

test("B/3: exact same corpus document backed by a DIFFERENT verified device -> still counts normally", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), reportPassport = uniq("passport"), otherPassport = uniq("passport");
  await seedExactCorpusSource(text, { backingPassportId: otherPassport });
  await seedReport({ deviceKey, reportId, passportId: reportPassport, rawText: text });

  const on = await withSelfScoring("true", () => resolve({ deviceKey, reportId, rawText: text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 100, "a different verified device is not the report's own -> no downgrade");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, []);
});

// ===========================================================================
// C / 4 — no verified Passport on the target report: still counts
// ===========================================================================

test("C/4: same corpus document, same-device backing, but the target report has NO verified passport -> still counts", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), backingPassport = uniq("passport");
  await seedExactCorpusSource(text, { backingPassportId: backingPassport });
  await seedReport({ deviceKey, reportId, passportId: null, rawText: text });

  const on = await withSelfScoring("true", () => resolve({ deviceKey, reportId, rawText: text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 100, "no verified passport on the report -> condition 3 fails -> no downgrade");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, []);
});

// ===========================================================================
// D / 5 — same device + STRONG_TEXT_MATCH (near, not exact): now an effective
//         SELF too, with a DISTINCT reason, contributing 0 corpus/prior words
// ===========================================================================

test("D/5: same-device backing + STRONG_TEXT_MATCH (not exact canonical) -> effective SELF, reason SAME_DEVICE_STRONG_TEXT_DOCUMENT, 0 prior words", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), passportId = uniq("passport");
  // A representation whose canonical text is a NEAR (not exact) variant of the report -> STRONG_TEXT_MATCH.
  const nearText = `${text} An additional trailing clause that makes this a near but not byte-identical variant of the submitted document for the purposes of this test.`;
  const repId = await seedExactCorpusSource(nearText, { backingPassportId: passportId });
  await seedReport({ deviceKey, reportId, passportId, rawText: text });

  const on = await withSelfScoring("true", () => resolve({ deviceKey, reportId, rawText: text }));
  assert.equal(on.historicalSubmissionMatch.status, "MATCHED");
  assert.equal(on.historicalSubmissionMatch.matches[0].matchType, "STRONG_TEXT_MATCH", "test setup: a near variant is a strong, not exact, match");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [repId], "a same-device STRONG_TEXT_MATCH now qualifies");
  assert.ok(on.unifiedSimilarity.deviceSelfExcludedWords > 0);
  assert.equal(on.unifiedSimilarity.previousUploadOnlyWords, 0, "the same-passport STRONG match contributes 0 corpus/prior words");
  assert.equal(on.unifiedSimilarity.unifiedScore, 0, "with no other evidence the strong same-device source zeroes the score");
  assert.equal(on.unifiedSimilarity.selfExcludedWords, 0, "genuine same-account SELF tally is untouched");
  const contrib = on.unifiedSimilarity.contributions.find((c) => c.sourceId === repId);
  assert.equal(contrib.relationship, "TURNITPLUS_CORPUS_SOURCE", "baseline relationship preserved on the contribution");
  assert.equal(contrib.effectiveScoringRelationship, "SELF");
  assert.equal(contrib.effectiveScoringReason, "SAME_DEVICE_STRONG_TEXT_DOCUMENT", "distinct reason for the strong case");
  assert.equal(contrib.evidenceStatus, "excluded_effective_device_self");
  // the persisted matcher snapshot / relationship is unchanged
  const offMatch = on.historicalSubmissionMatch.matches[0];
  assert.equal(offMatch.relationshipType, "TURNITPLUS_CORPUS_SOURCE", "the matcher result is not rewritten by the rule");
});

test("D/5b: a DIFFERENT verified device + STRONG_TEXT_MATCH -> still counts (not the report's own passport)", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), reportPassport = uniq("passport"), otherPassport = uniq("passport");
  const nearText = `${text} A distinct trailing clause added so this is a near variant rather than a byte-identical copy of the document.`;
  await seedExactCorpusSource(nearText, { backingPassportId: otherPassport });
  await seedReport({ deviceKey, reportId, passportId: reportPassport, rawText: text });

  const on = await withSelfScoring("true", () => resolve({ deviceKey, reportId, rawText: text }));
  assert.equal(on.historicalSubmissionMatch.matches[0].matchType, "STRONG_TEXT_MATCH");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [], "a different verified device -> no downgrade even for STRONG");
  assert.ok(on.unifiedSimilarity.unifiedScore > 0, "the strong match still contributes normally");
});

test("D/5c: same-device STRONG_TEXT_MATCH BUT an independent (other-device) backing exists -> still counts", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), passportId = uniq("passport");
  const nearText = `${text} Yet another trailing clause making this a strong near variant rather than an exact canonical match here.`;
  await seedExactCorpusSource(nearText, { backingPassportId: passportId, extraIndependentBacking: true });
  await seedReport({ deviceKey, reportId, passportId, rawText: text });

  const on = await withSelfScoring("true", () => resolve({ deviceKey, reportId, rawText: text }));
  assert.equal(on.historicalSubmissionMatch.matches[0].matchType, "STRONG_TEXT_MATCH");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [], "independentBackingCount > 0 blocks the SELF downgrade for STRONG too");
  assert.ok(on.unifiedSimilarity.unifiedScore > 0);
});

// ===========================================================================
// E / 6 — same device exact BUT independent backing exists: still counts
// ===========================================================================

test("E/6: same-device exact canonical match BUT an independent (other-account) backing exists -> still counts", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), passportId = uniq("passport");
  await seedExactCorpusSource(text, { backingPassportId: passportId, extraIndependentBacking: true });
  await seedReport({ deviceKey, reportId, passportId, rawText: text });

  const on = await withSelfScoring("true", () => resolve({ deviceKey, reportId, rawText: text }));
  assert.equal(on.unifiedSimilarity.unifiedScore, 100, "independent backing blocks the SELF downgrade");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, []);
});

// ===========================================================================
// F / 7 / 8 / 9 — independent archive / scholarly positions survive the exclusion
// ===========================================================================

test("F/7: an independent ARCHIVE footprint survives while a same-device corpus source is excluded (pure computeUnifiedSimilarity)", () => {
  const repId = "rep-corpus-6291";
  const hsm = matched([matchEntry(repId, { relationshipType: "TURNITPLUS_CORPUS_SOURCE", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 6291 })]);
  const archivePositions = range(0, 400); // independent archive evidence for 400 positions
  const result = computeUnifiedSimilarity({
    wordCount: 6291,
    archiveMatchedPositions: archivePositions,
    externalAcademicEvidence: null,
    historicalSubmissionMatch: hsm,
    effectiveDeviceSelfRepresentationIds: [repId],
  });
  assert.equal(result.uniqueMatchedWords, 400, "only the independent 400 archive positions survive — not the whole 6291");
  assert.equal(result.matchedPositions.length, 400);
  assert.equal(result.deviceSelfExcludedWords, 6291);
  assert.equal(result.previousUploadOnlyWords, 0);
  assert.equal(result.archiveOnlyWords, 400);
  assert.ok(result.unifiedScore > 0 && result.unifiedScore < 100, "not zeroed just because one source is SELF");
});

test("F/8: an independent SCHOLARLY footprint survives while a same-device corpus source is excluded", () => {
  const repId = "rep-corpus-2";
  const hsm = matched([matchEntry(repId, { relationshipType: "TURNITPLUS_CORPUS_SOURCE", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 1000 })]);
  const result = computeUnifiedSimilarity({
    wordCount: 1000,
    archiveMatchedPositions: null,
    externalAcademicEvidence: [{
      provider: "openaire", providerId: "o-1", title: "Ext", authors: null, publication: null, year: null,
      doi: "10.1/x", url: "https://ex.test/x", similarity: 90,
      matchedPassages: [{ submittedText: "", submittedWordStart: 100, submittedWordEnd: 499, matchedWordCount: 400 }],
    }],
    historicalSubmissionMatch: hsm,
    effectiveDeviceSelfRepresentationIds: [repId],
  });
  assert.equal(result.liveAcademicOnlyWords, 400, "the 400 scholarly positions survive");
  assert.equal(result.uniqueMatchedWords, 400);
  assert.equal(result.deviceSelfExcludedWords, 1000);
});

test("9: multi-source position union stays correct after one corpus source becomes an effective SELF", () => {
  const selfRep = "rep-self-device";
  const priorRep = "rep-other-account";
  const hsm = matched([
    matchEntry(selfRep, { relationshipType: "TURNITPLUS_CORPUS_SOURCE", matchType: "EXACT_CANONICAL_MATCH", matchedWordCount: 1000, passages: [{ submittedText: "", submittedWordStart: 0, submittedWordEnd: 999, matchedWordCount: 1000 }] }),
    matchEntry(priorRep, { relationshipType: "PRIOR_SUBMISSION", matchType: "STRONG_TEXT_MATCH", matchedWordCount: 200, passages: [{ submittedText: "", submittedWordStart: 700, submittedWordEnd: 899, matchedWordCount: 200 }] }),
  ]);
  const result = computeUnifiedSimilarity({
    wordCount: 1000,
    archiveMatchedPositions: range(0, 100),
    externalAcademicEvidence: null,
    historicalSubmissionMatch: hsm,
    effectiveDeviceSelfRepresentationIds: [selfRep],
  });
  // union = archive 0..99  ∪  prior 700..899  (self-device 0..999 excluded)
  assert.equal(result.uniqueMatchedWords, 300);
  assert.deepEqual(result.matchedPositions, [...range(0, 100), ...range(700, 900)]);
  assert.equal(result.deviceSelfExcludedWords, 1000);
  assert.equal(result.previousUploadOnlyWords, 200, "the other-account PRIOR_SUBMISSION still counts");
  assert.equal(result.archiveOnlyWords, 100);
});

test("9-STRONG: a same-device STRONG_TEXT_MATCH is excluded like a SELF; independent archive + other-account STRONG survive", () => {
  const selfRep = "rep-self-device-strong";
  const priorRep = "rep-other-account-strong";
  const hsm = matched([
    matchEntry(selfRep, { relationshipType: "TURNITPLUS_CORPUS_SOURCE", matchType: "STRONG_TEXT_MATCH", matchedWordCount: 800, passages: [{ submittedText: "", submittedWordStart: 0, submittedWordEnd: 799, matchedWordCount: 800 }] }),
    matchEntry(priorRep, { relationshipType: "PRIOR_SUBMISSION", matchType: "STRONG_TEXT_MATCH", matchedWordCount: 150, passages: [{ submittedText: "", submittedWordStart: 850, submittedWordEnd: 999, matchedWordCount: 150 }] }),
  ]);
  const result = computeUnifiedSimilarity({
    wordCount: 1000,
    archiveMatchedPositions: range(0, 100),
    externalAcademicEvidence: null,
    historicalSubmissionMatch: hsm,
    effectiveDeviceSelfRepresentationIds: [selfRep],
  });
  // union = archive 0..99  ∪  other-account STRONG 850..999  (self-device STRONG 0..799 excluded)
  assert.equal(result.uniqueMatchedWords, 250);
  assert.deepEqual(result.matchedPositions, [...range(0, 100), ...range(850, 1000)]);
  assert.equal(result.deviceSelfExcludedWords, 800, "the same-device STRONG match's words are excluded");
  assert.equal(result.previousUploadOnlyWords, 150, "the other-account STRONG match still counts");
  assert.equal(result.archiveOnlyWords, 100, "independent archive positions survive");
  const contrib = result.contributions.find((c) => c.sourceId === selfRep);
  assert.equal(contrib.effectiveScoringRelationship, "SELF");
  assert.equal(contrib.effectiveScoringReason, "SAME_DEVICE_STRONG_TEXT_DOCUMENT");
  assert.equal(contrib.evidenceStatus, "excluded_effective_device_self");
});

// ===========================================================================
// G / 10 — existing same-account SELF behaviour unchanged
// ===========================================================================

test("G/10: an existing same-account SELF match behaves exactly as before, flag ON or OFF", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), account = uniq("acc-self");
  await ensureUser(account);
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: (await createDocumentIdentity(client, { accountId: account, title: "p1", author: null, rawText: text })).id, rawText: text });
  await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: (await createDocumentIdentity(client, { accountId: account, title: "p2", author: null, rawText: text })).id, rawText: text });
  await seedReport({ deviceKey, reportId, accountId: account, rawText: text });

  const off = await withSelfScoring(undefined, () => resolve({ deviceKey, reportId, accountId: account, rawText: text }));
  assert.equal(off.historicalSubmissionMatch.matches[0].relationshipType, "SELF");
  assert.equal(off.unifiedSimilarity.unifiedScore, 0);

  const on = await withSelfScoring("true", () => resolve({ deviceKey, reportId, accountId: account, rawText: text }));
  assert.deepEqual(on.unifiedSimilarity, off.unifiedSimilarity, "a genuine SELF match's unified result is identical with the flag on");
  assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [], "a genuine SELF is never re-labelled as an effective device SELF");
  assert.equal(on.unifiedSimilarity.selfExcludedWords > 0, true);
  assert.equal(on.unifiedSimilarity.deviceSelfExcludedWords, 0);
});

// ===========================================================================
// 11 — first-save POST applies the rule immediately (real routes)
// ===========================================================================

async function keyPair() {
  const kp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spkiDer = Buffer.from(await webcrypto.subtle.exportKey("spki", kp.publicKey));
  return { kp, spkiDer, spkiB64: spkiDer.toString("base64"), id: derivePassportId(spkiDer) };
}

async function postReportWithPassport({ deviceKey, reportId, text, k }) {
  await client.execute({
    sql: `INSERT INTO device_passports (id, public_key_spki, algorithm, created_at, provenance_generation) VALUES (?,?,?,?,0) ON CONFLICT(id) DO NOTHING`,
    args: [k.id, k.spkiDer, DEVICE_PASSPORT_ALGORITHM, Date.now()],
  });
  const { challengeId, nonce } = await createDevicePassportChallenge(client, { accountId: null, sessionTokenHash: null });
  const message = buildDevicePassportSignedMessage({
    nonceBase64: nonce, challengeId, method: "POST", path: "/api/reports",
    payloadTextSha256Hex: sha256Hex(Buffer.from(text, "utf8")), reportId,
  });
  const signature = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.kp.privateKey, message)).toString("base64");
  const ip = nextIp();
  await resetRateForTest(ip);
  return reportsRoute.POST(new Request("http://localhost/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...SAME_ORIGIN },
    body: JSON.stringify({
      deviceKey, id: reportId, submissionId: "sub", title: "t.pdf", createdAt: new Date().toISOString(),
      wordCount: tokens(canonicalizeText(text)).length, archiveScore: 0, scoreBand: "Low",
      payload: { version: 11, id: 1, submissionId: "sub", title: "t.pdf", created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount: tokens(canonicalizeText(text)).length, text },
      devicePassport: { challengeId, nonce, publicKeySpki: k.spkiB64, signature },
    }),
  }));
}

async function persistedUnifiedScore(deviceKey, reportId) {
  const r = await client.execute({ sql: "SELECT payload_json FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, reportId] });
  return JSON.parse(r.rows[0].payload_json).unifiedSimilarity?.unifiedScore ?? null;
}

test("11: the FIRST-SAVE POST already applies the rule — no second POST or GET required", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r");
  const k = await keyPair();
  await seedExactCorpusSource(text, { backingPassportId: k.id });

  await withSelfScoring("true", async () => {
    const res = await postReportWithPassport({ deviceKey, reportId, text, k });
    assert.equal(res.status, 200);
    // exactly ONE POST has happened; no GET
    assert.equal(await persistedUnifiedScore(deviceKey, reportId), 0, "the first persisted unified score is already 0 — the passport verified in THIS request was available to write-time finalization");
    const stored = (await client.execute({ sql: "SELECT verified_device_passport_id FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, reportId] })).rows[0];
    assert.equal(String(stored.verified_device_passport_id), k.id, "sanity: the upload passport was captured");
  });
});

test("11b: flag OFF — the same first-save POST persists the current 100% (regression baseline)", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r");
  const k = await keyPair();
  await seedExactCorpusSource(text, { backingPassportId: k.id });

  await withSelfScoring(undefined, async () => {
    const res = await postReportWithPassport({ deviceKey, reportId, text, k });
    assert.equal(res.status, 200);
    assert.equal(await persistedUnifiedScore(deviceKey, reportId), 100, "flag OFF: current behaviour — an exact same-device corpus match still scores 100%");
  });
});

// ===========================================================================
// 12 — Device Passport verification failure cannot accidentally trigger SELF
// ===========================================================================

test("12: a Device Passport verification failure (bad signature) never triggers the SELF downgrade — the source counts normally", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r");
  const k = await keyPair();
  await seedExactCorpusSource(text, { backingPassportId: k.id });
  await client.execute({
    sql: `INSERT INTO device_passports (id, public_key_spki, algorithm, created_at, provenance_generation) VALUES (?,?,?,?,0) ON CONFLICT(id) DO NOTHING`,
    args: [k.id, k.spkiDer, DEVICE_PASSPORT_ALGORITHM, Date.now()],
  });
  const { challengeId, nonce } = await createDevicePassportChallenge(client, { accountId: null, sessionTokenHash: null });

  await withSelfScoring("true", async () => {
    const ip = nextIp();
    await resetRateForTest(ip);
    const res = await reportsRoute.POST(new Request("http://localhost/api/reports", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip, ...SAME_ORIGIN },
      body: JSON.stringify({
        deviceKey, id: reportId, submissionId: "sub", title: "t.pdf", createdAt: new Date().toISOString(),
        wordCount: tokens(canonicalizeText(text)).length, archiveScore: 0, scoreBand: "Low",
        payload: { version: 11, id: 1, submissionId: "sub", title: "t.pdf", created: new Date().toISOString(), score: 0, archiveScore: 0, wordCount: tokens(canonicalizeText(text)).length, text },
        devicePassport: { challengeId, nonce, publicKeySpki: k.spkiB64, signature: Buffer.alloc(64).toString("base64") /* invalid */ },
      }),
    }));
    assert.equal(res.status, 200, "a bad attestation is fail-safe — the upload still succeeds");
    const row = (await client.execute({ sql: "SELECT verified_device_passport_id FROM saved_reports WHERE device_key = ? AND id = ?", args: [deviceKey, reportId] })).rows[0];
    assert.equal(row.verified_device_passport_id, null, "no verified passport was persisted");
    assert.equal(await persistedUnifiedScore(deviceKey, reportId), 100, "with no verified passport the same-device SELF rule cannot fire — the source counts normally");
  });
});

// ===========================================================================
// 13 — ordinary user response leaks no provenance identity
// ===========================================================================

test("13: with the rule active and the score downgraded to 0, the ordinary GET response leaks no passport id / account id / email / device identifier", async () => {
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r");
  const k = await keyPair();
  const srcAccount = "leak-canary-src-account-13";
  await seedExactCorpusSource(text, { backingPassportId: k.id, sourceAccountId: srcAccount });

  await withSelfScoring("true", async () => {
    const postRes = await postReportWithPassport({ deviceKey, reportId, text, k });
    assert.equal(postRes.status, 200);
    assert.equal(await persistedUnifiedScore(deviceKey, reportId), 0, "sanity: the rule fired");

    await resetReadRateForTest(nextIp());
    const getRes = await reportIdRoute.GET(
      new Request(`http://localhost/api/reports/${reportId}?deviceKey=${encodeURIComponent(deviceKey)}`, { headers: { "x-forwarded-for": nextIp() } }),
      { params: Promise.resolve({ id: reportId }) },
    );
    assert.equal(getRes.status, 200);
    const bodyText = await getRes.text();
    const body = JSON.parse(bodyText);
    assert.equal(body.payload.unifiedSimilarity.unifiedScore, 0, "the GET route also reflects the downgrade (reads the persisted upload passport itself)");
    // ordinary viewer: contributions stripped, no historical-match, no trace
    assert.deepEqual(body.payload.unifiedSimilarity.contributions, [], "contributions[] (which carry effectiveScoringRelationship + the representation id) are stripped for a non-admin");
    assert.equal(body.payload.historicalSubmissionMatch, undefined);
    for (const forbidden of [k.id, k.spkiB64, srcAccount, `${srcAccount}@ex.test`, "verified_device_passport_id", "device_passport_id", "effectiveScoringRelationship", "SAME_DEVICE_EXACT_DOCUMENT", "excluded_effective_device_self"]) {
      assert.equal(bodyText.includes(forbidden), false, `ordinary GET leaked: ${String(forbidden).slice(0, 30)}`);
    }
    // deviceSelfExcludedWords (a bare count, same class as selfExcludedWords) MAY appear — it carries no identity.
  });
});

// ===========================================================================
// 14 — admin decision trace explains the exclusion safely
// ===========================================================================

test("14: the admin similarity decision trace distinguishes baseline vs effective relationship + reason, and leaks no passport secret", async () => {
  process.env.DEVICE_PASSPORT_ENABLED = "true";
  const text = takeText();
  const deviceKey = uniq("dk"), reportId = uniq("r"), account = uniq("acc-admin"), passportId = uniq("passport"), srcAccount = uniq("acc-src");
  const repId = await seedExactCorpusSource(text, { backingPassportId: passportId, sourceAccountId: srcAccount });
  await seedReport({ deviceKey, reportId, accountId: account, passportId, rawText: text });

  await withSelfScoring("true", async () => {
    const resolution = await resolve({ deviceKey, reportId, accountId: account, rawText: text });
    assert.equal(resolution.unifiedSimilarity.unifiedScore, 0, "sanity: the rule fired for this fixture");

    // shadow telemetry (test 15 lives here too) — run it, it must not affect the score
    await runDeviceProvenanceShadowEvaluation(client, { reportDeviceKey: deviceKey, reportId, accountId: account, rawText: text, productionResult: resolution.historicalSubmissionMatch });

    const trace = await getReportSimilarityDecisionTrace(client, deviceKey, reportId);
    assert.ok(trace.resolvable);
    assert.equal(trace.finalScore, 0, "the trace explains the real 0% production score");
    assert.equal(trace.scoreUnchangedByDeviceShadow, true);
    assert.ok(trace.excludedEffectiveDeviceSelfMatchedWordCount > 0);

    const source = trace.sources.find((s) => s.sourceId === repId);
    assert.ok(source, "the downgraded corpus source appears in the per-source trace");
    assert.equal(source.relationshipType, "TURNITPLUS_CORPUS_SOURCE", "BASELINE relationship");
    assert.equal(source.effectiveScoringRelationship, "SELF", "EFFECTIVE scoring relationship");
    assert.equal(source.effectiveScoringReason, "SAME_DEVICE_EXACT_DOCUMENT", "REASON");
    assert.equal(source.countedTowardScore, false);
    assert.equal(source.exclusionReason, "EXCLUDED_EFFECTIVE_DEVICE_SELF");
    assert.ok(trace.zeroScoreExplanation);
    assert.equal(trace.zeroScoreExplanation.reason, "MATCHES_PRESENT_BUT_ALL_EXCLUDED");
    assert.equal(trace.zeroScoreExplanation.excludedEffectiveDeviceSelfSourceCount, 1);

    // The SAME-DEVICE SELF additions expose only safe enums/counts — never a
    // passport id, raw device identifier, key material, challenge/nonce/session
    // value, or the report owner's own account id. (Cross-account BACKING
    // emails on PRIOR_SUBMISSION sources are a separate, pre-existing
    // admin-only feature — see tests/admin-similarity-decision-trace-integration.test.mjs §15E.)
    const serialized = JSON.stringify(trace);
    for (const forbidden of [passportId, `spki-${passportId}`, account, `${account}@ex.test`, "public_key_spki", "device_passport_id", "verified_device_passport_id", "session_token_hash", "nonce_hash", "publicKeySpki", "challengeId"]) {
      assert.equal(serialized.includes(forbidden), false, `admin trace leaked: ${forbidden}`);
    }
    // The device evidence block itself is bounded booleans / counts only.
    const devEvidence = source.deviceEvidence;
    if (devEvidence) {
      for (const v of Object.values(devEvidence)) assert.ok(typeof v === "boolean" || typeof v === "number", "device evidence is bounded primitives only");
    }
  }).finally(() => { delete process.env.DEVICE_PASSPORT_ENABLED; process.env.DEVICE_PASSPORT_ENABLED = "true"; });
});

test("14-STRONG: the admin trace shows matchType STRONG_TEXT_MATCH and reason SAME_DEVICE_STRONG_TEXT_DOCUMENT for a near-identical same-device source", async () => {
  process.env.DEVICE_PASSPORT_ENABLED = "true";
  const text = takeText();
  const nearText = `${text} A trailing clause appended for the admin-trace strong-match test so the source is a near, not exact, variant.`;
  const deviceKey = uniq("dk"), reportId = uniq("r"), account = uniq("acc-admin"), passportId = uniq("passport"), srcAccount = uniq("acc-src");
  const repId = await seedExactCorpusSource(nearText, { backingPassportId: passportId, sourceAccountId: srcAccount });
  await seedReport({ deviceKey, reportId, accountId: account, passportId, rawText: text });

  await withSelfScoring("true", async () => {
    const resolution = await resolve({ deviceKey, reportId, accountId: account, rawText: text });
    assert.equal(resolution.historicalSubmissionMatch.matches[0].matchType, "STRONG_TEXT_MATCH", "sanity: a near variant");
    assert.equal(resolution.unifiedSimilarity.unifiedScore, 0, "sanity: the strong same-device source is an effective SELF");

    await runDeviceProvenanceShadowEvaluation(client, { reportDeviceKey: deviceKey, reportId, accountId: account, rawText: text, productionResult: resolution.historicalSubmissionMatch });

    const trace = await getReportSimilarityDecisionTrace(client, deviceKey, reportId);
    const source = trace.sources.find((s) => s.sourceId === repId);
    assert.ok(source, "the downgraded strong corpus source appears in the per-source trace");
    assert.equal(source.matchType, "STRONG_TEXT_MATCH", "the trace carries production's own matchType");
    assert.equal(source.relationshipType, "TURNITPLUS_CORPUS_SOURCE", "BASELINE relationship preserved");
    assert.equal(source.effectiveScoringRelationship, "SELF");
    assert.equal(source.effectiveScoringReason, "SAME_DEVICE_STRONG_TEXT_DOCUMENT", "DISTINCT reason for the strong case — not SAME_DEVICE_EXACT_DOCUMENT");
    assert.equal(source.exclusionReason, "EXCLUDED_EFFECTIVE_DEVICE_SELF");
    // the shadow telemetry mirrors the score-path decision (shared classifier — no drift)
    assert.equal(trace.deviceShadow.reason, "SAME_DEVICE_STRONG_TEXT_DOCUMENT");
    assert.equal(trace.deviceShadow.candidateReason, "SAME_DEVICE_STRONG_TEXT_DOCUMENT");
    assert.equal(trace.deviceShadow.wouldDowngrade, true);
    assert.equal(trace.scoreUnchangedByDeviceShadow, true);

    // (srcAccount — the corpus source's own backing account — legitimately
    // appears in the admin-only cross-account BACKING evidence, exactly as in
    // test 14; only the PASSPORT secret and the REPORT OWNER's identity are
    // forbidden here.)
    const serialized = JSON.stringify(trace);
    for (const forbidden of [passportId, `spki-${passportId}`, account, `${account}@ex.test`, "public_key_spki", "verified_device_passport_id", "session_token_hash", "publicKeySpki"]) {
      assert.equal(serialized.includes(forbidden), false, `admin trace leaked: ${forbidden}`);
    }
  }).finally(() => { delete process.env.DEVICE_PASSPORT_ENABLED; process.env.DEVICE_PASSPORT_ENABLED = "true"; });
});

// ===========================================================================
// 15 — shadow telemetry still works and does not control scoring
// ===========================================================================

test("15: shadow telemetry (device-provenance-shadow-v1) still records wouldDowngrade; the score does NOT depend on it", async () => {
  process.env.DEVICE_PASSPORT_ENABLED = "true";
  try {
    const text = takeText();
    const deviceKey = uniq("dk"), reportId = uniq("r"), account = uniq("acc"), passportId = uniq("passport");
    const repId = await seedExactCorpusSource(text, { backingPassportId: passportId });
    await seedReport({ deviceKey, reportId, accountId: account, passportId, rawText: text });

    // (a) score flag OFF: shadow still runs exactly as today, score unchanged (100)
    const off = await withSelfScoring(undefined, async () => {
      const r = await resolve({ deviceKey, reportId, accountId: account, rawText: text });
      await runDeviceProvenanceShadowEvaluation(client, { reportDeviceKey: deviceKey, reportId, accountId: account, rawText: text, productionResult: r.historicalSubmissionMatch });
      return r;
    });
    assert.equal(off.unifiedSimilarity.unifiedScore, 100, "score flag OFF: existing behaviour, shadow does not change the score");
    let row = await shadowRow(deviceKey, reportId);
    assert.ok(row, "the shadow row is written regardless of the scoring flag");
    let ev = JSON.parse(String(row.proposed_evidence));
    assert.equal(ev.wouldDowngrade, true, "the shadow's own wouldDowngrade signal is unchanged by the refactor");
    assert.equal(row.proposed_relationship, "SELF");

    // (b) score flag ON: the score changes to 0 from the DETERMINISTIC evidence,
    //     NOT because it reads the shadow table — prove it by wiping the shadow row first.
    await client.execute({ sql: "DELETE FROM historical_match_shadow_evaluations WHERE report_device_key = ? AND report_id = ?", args: [deviceKey, reportId] });
    const on = await withSelfScoring("true", () => resolve({ deviceKey, reportId, accountId: account, rawText: text }));
    assert.equal(on.unifiedSimilarity.unifiedScore, 0, "scoring reads the underlying provenance evidence directly — no shadow row present and it still downgrades");
    assert.deepEqual(on.effectiveDeviceSelfRepresentationIds, [repId]);
  } finally {
    delete process.env.DEVICE_PASSPORT_ENABLED;
    process.env.DEVICE_PASSPORT_ENABLED = "true";
  }
});

console.log("device-passport-self-scoring: pure classifier + invariants A-H + scenarios 1-16 passed");
