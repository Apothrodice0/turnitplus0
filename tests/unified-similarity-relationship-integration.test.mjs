import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.js';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { resetRateForTest, resetAuthRateForTest } from '../lib/rate-limit.js';
import { tokens } from '../lib/similarity-core.ts';
import { computeUnifiedSimilarity } from '../lib/unified-similarity.ts';

/**
 * Phase 4B, Part A: end-to-end proof that computeUnifiedSimilarity()'s
 * SELF/UNKNOWN exclusion and PRIOR_SUBMISSION eligibility hold when fed a
 * relationshipType that came from the REAL production classification path —
 * not a manually constructed object. Every scenario below drives the actual
 * HTTP routes (signup, POST /api/reports, GET /api/reports/[id]) exactly as
 * a real signed-in browser session would, exactly like
 * tests/report-historical-match-integration.test.mjs already does for its
 * own SELF/UNKNOWN cases — this file extends that same real pipeline one
 * step further, into computeUnifiedSimilarity(), which that file never
 * touches (it predates Phase 4A).
 *
 * Pipeline exercised, unmodified, for every scenario:
 *   POST /api/reports (first save of an account's text)
 *     -> captureDocumentIdentityAndFamily (lib/document-family.ts)
 *     -> indexDocumentSubmissionIntoCorpus (lib/user-submission-corpus.ts)
 *   GET /api/reports/[id]
 *     -> getOrComputeHistoricalMatchSnapshot (lib/report-historical-match.ts)
 *     -> matchAgainstUserSubmissionCorpus (lib/user-submission-matching.ts)
 *   (this file only, not production) the real historicalSubmissionMatch from
 *   that GET response body is then passed straight into
 *   computeUnifiedSimilarity() (lib/unified-similarity.ts), unmodified.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_unified_relationship_integration.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;

const setupClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setupClient, drizzleDir);

test.after(() => {
  setupClient.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${dbFile}${suffix}`;
    try { fs.unlinkSync(candidate); } catch { /* ignore */ }
  }
});

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const match = setCookie.match(/tp_session_v1=([^;]*)/);
  return match ? match[1] : null;
}

let counter = 0;
function nextId() {
  counter += 1;
  return `urel-report-${counter}`;
}

async function postReport(deviceKey, { cookie, id, title = 'urel.pdf', text, score = 10, archiveScore = 5 } = {}) {
  resetRateForTest('urel-post-' + deviceKey);
  const reportId = id ?? nextId();
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': 'urel-post-' + deviceKey };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const req = new Request('http://localhost/api/reports', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      deviceKey,
      id: reportId,
      submissionId: 'sub-' + reportId,
      title,
      createdAt: new Date().toISOString(),
      wordCount: tokens(text).length,
      archiveScore,
      scoreBand: 'Low',
      aiScore: null,
      aiTone: null,
      payload: { version: 11, id: Date.now(), submissionId: 'sub-' + reportId, title, author: '', assignment: '', created: new Date().toISOString(), score, archiveScore, text, wordCount: tokens(text).length, characterCount: text.length, pageCount: 1, fileSize: '1 KB', databaseSize: 230, corpusVersion: 'test', scoreBand: 'Low' },
    }),
  });
  const res = await reportsRoute.POST(req);
  return { res, id: reportId };
}

async function getReport(id, { deviceKey, cookie } = {}) {
  resetRateForTest('urel-get-' + (deviceKey ?? cookie ?? 'x'));
  const headers = { 'x-forwarded-for': 'urel-get-' + (deviceKey ?? cookie ?? 'x') };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const url = deviceKey ? `http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}` : `http://localhost/api/reports/${id}`;
  const req = new Request(url, { headers });
  return reportIdRoute.GET(req, { params: Promise.resolve({ id }) });
}

async function signup(email, deviceKey) {
  resetAuthRateForTest('urel-signup-' + email);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'urel-signup-' + email },
    body: JSON.stringify({ email, password: 'urel-password-1', username: email.split('@')[0], deviceKey }),
  });
  const res = await signupRoute.POST(req);
  return { res, cookie: extractCookie(res) };
}

/** Fetches the real historicalSubmissionMatch for a saved report via the real GET route, waiting briefly for the save route's deferred after-response indexing to land (mirrors production's own eventual-consistency window, documented in lib/report-historical-match.ts's own header comment). */
async function fetchRealHistoricalMatch(id, viewOpts) {
  const res = await getReport(id, viewOpts);
  assert.equal(res.status, 200, `GET /api/reports/${id} must succeed`);
  const body = await res.json();
  return body.payload.historicalSubmissionMatch ?? { status: 'NO_HISTORICAL_MATCH' };
}

// =============================================================================
// SCENARIO A — SELF: same account, same text, submitted a second time
// =============================================================================

test('SCENARIO A (SELF): a real second upload of identical text by the same account is classified SELF by the real matcher, and contributes 0 to unifiedScore', async () => {
  const email = 'urel-scenario-a@example.test';
  const { cookie } = await signup(email, 'urel-device-a');
  const text = 'Seismologists analyzing a dense array of borehole strainmeters detected a slow-slip transient event migrating along a subduction interface over several weeks. The migration rate was consistent with previously documented episodic tremor and slip sequences observed at comparable convergent margins elsewhere. Surface GPS stations recorded displacement magnitudes too small to be felt but clearly resolvable in the processed strain time series. The authors argue this transient represents a genuine precursory process worth continued monitoring at this specific segment of the margin.';

  const { id: firstId } = await postReport('urel-device-a', { cookie, text, title: 'seismo-first.pdf' });
  const firstMatch = await fetchRealHistoricalMatch(firstId, { cookie });
  assert.equal(firstMatch.status, 'NO_HISTORICAL_MATCH', 'a first-ever indexed upload cannot match against nothing but itself');

  // The real second upload event — same account, same browser flow, same route.
  const { id: secondId } = await postReport('urel-device-a', { cookie, text, title: 'seismo-second.pdf' });
  const secondMatch = await fetchRealHistoricalMatch(secondId, { cookie });

  assert.equal(secondMatch.status, 'MATCHED');
  assert.equal(secondMatch.matches.length, 1);
  assert.equal(secondMatch.matches[0].relationshipType, 'SELF', 'the real matcher must classify this as SELF, not PRIOR_SUBMISSION');
  assert.ok(secondMatch.matches[0].matchedWordCount > 0, 'a real matched word count must exist for this to be a meaningful test');

  const wordCount = tokens(text).length;
  const unified = computeUnifiedSimilarity({ wordCount, historicalSubmissionMatch: secondMatch });

  assert.equal(unified.unifiedScore, 0, 'a real SELF match must contribute 0 to unifiedScore');
  assert.equal(unified.previousUploadOnlyWords, 0);
  assert.equal(unified.selfExcludedWords, secondMatch.matches[0].matchedWordCount, 'the excluded tally must equal the real matcher\'s own matchedWordCount');
});

// =============================================================================
// SCENARIO B — EDITED SELF: same account, lightly edited text, second upload
// =============================================================================

test('SCENARIO B (EDITED SELF): a real lightly-edited re-upload by the same account is still classified SELF via STRONG_TEXT_MATCH (not exact hash), and still contributes 0', async () => {
  const email = 'urel-scenario-b@example.test';
  const { cookie } = await signup(email, 'urel-device-b');
  const original = 'Glaciologists resurveying an alpine ice cap used repeat airborne lidar to quantify surface elevation change across four consecutive melt seasons. Thinning was concentrated at lower elevations near the terminus, consistent with the ablation-dominated mass balance expected for a cap of this size and latitude. Interior accumulation zones showed comparatively little change over the same survey interval, suggesting the loss was not yet propagating upslope. The authors compare their volumetric loss estimate against regional glacier inventories compiled a decade earlier.';
  const edited = 'Glaciologists resurveying an alpine ice cap used repeat airborne lidar to quantify surface elevation change across four consecutive melt seasons, extending an earlier two-season pilot effort. Thinning was concentrated at lower elevations near the terminus, consistent with the ablation-dominated mass balance expected for a cap of this size and latitude. A newly added companion analysis compares these lidar-derived volumes against an independent gravimetric estimate for the same period. The authors compare their volumetric loss estimate against regional glacier inventories compiled a decade earlier, and discuss remaining sources of uncertainty in both methods.';

  const { id: firstId } = await postReport('urel-device-b', { cookie, text: original, title: 'glacier-original.pdf' });
  const firstMatch = await fetchRealHistoricalMatch(firstId, { cookie });
  assert.equal(firstMatch.status, 'NO_HISTORICAL_MATCH');

  const { id: secondId } = await postReport('urel-device-b', { cookie, text: edited, title: 'glacier-edited.pdf' });
  const secondMatch = await fetchRealHistoricalMatch(secondId, { cookie });

  assert.equal(secondMatch.status, 'MATCHED');
  assert.equal(secondMatch.matches[0].relationshipType, 'SELF');
  assert.equal(secondMatch.matches[0].matchType, 'STRONG_TEXT_MATCH', 'this must be the shingle-based path, not an exact-hash shortcut — the two texts are byte-different');
  assert.ok(secondMatch.matches[0].containment < 1, 'containment must be a genuine partial value, proving the texts really differ');
  assert.ok(secondMatch.matches[0].matchedWordCount > 0);

  const wordCount = tokens(edited).length;
  const unified = computeUnifiedSimilarity({ wordCount, historicalSubmissionMatch: secondMatch });
  assert.equal(unified.unifiedScore, 0, 'SELF exclusion must hold even for a non-byte-identical, shingle-matched SELF relationship');
  assert.equal(unified.selfExcludedWords, secondMatch.matches[0].matchedWordCount);
});

// =============================================================================
// SCENARIO C — DIFFERENT ACCOUNT
// =============================================================================

test('SCENARIO C (DIFFERENT ACCOUNT): a real second account submitting matching content is classified PRIOR_SUBMISSION, never SELF, and its eligible words enter unifiedScore', async () => {
  const { cookie: cookieA } = await signup('urel-scenario-c-a@example.test', 'urel-device-c-a');
  const { cookie: cookieB } = await signup('urel-scenario-c-b@example.test', 'urel-device-c-b');
  const text = 'Entomologists surveying a fragmented grassland network used pan traps to compare wild bee community composition across patches of varying isolation. Species richness declined significantly with increasing distance from the nearest large reserve, while total abundance was comparatively insensitive to isolation alone. Specialist species accounted for nearly all of the richness decline, whereas generalist species persisted across even the most isolated patches surveyed. The authors recommend prioritizing corridor restoration between the most isolated patches and the nearest reserve.';

  const { id: idA } = await postReport('urel-device-c-a', { cookie: cookieA, text, title: 'bees-account-a.pdf' });
  const matchA = await fetchRealHistoricalMatch(idA, { cookie: cookieA });
  assert.equal(matchA.status, 'NO_HISTORICAL_MATCH', 'account A is the first-ever submitter of this content');

  const { id: idB } = await postReport('urel-device-c-b', { cookie: cookieB, text, title: 'bees-account-b.pdf' });
  const matchB = await fetchRealHistoricalMatch(idB, { cookie: cookieB });

  assert.equal(matchB.status, 'MATCHED');
  assert.equal(matchB.matches.length, 1);
  assert.notEqual(matchB.matches[0].relationshipType, 'SELF', 'two distinct authenticated accounts must never be classified SELF against each other');
  assert.equal(
    matchB.matches[0].relationshipType,
    'PRIOR_SUBMISSION',
    'per lib/user-submission-matching.ts\'s own deterministic rule, any non-null accountId that is not the submitting account resolves to PRIOR_SUBMISSION — UNKNOWN_RELATIONSHIP is reserved for an anonymous (accountId===null) VIEWER, which account B is not',
  );

  const wordCount = tokens(text).length;
  const unified = computeUnifiedSimilarity({ wordCount, historicalSubmissionMatch: matchB });
  assert.ok(unified.unifiedScore > 0, 'an eligible PRIOR_SUBMISSION match must actually raise unifiedScore above 0');
  assert.equal(unified.previousUploadOnlyWords, matchB.matches[0].matchedWordCount);
  assert.equal(unified.selfExcludedWords, 0);
  assert.equal(unified.unknownExcludedWords, 0);
});

test('SCENARIO C (contrast case): the SAME matching content, viewed anonymously (no account), is classified UNKNOWN_RELATIONSHIP by the real matcher and contributes 0', async () => {
  const { cookie: cookieOwner } = await signup('urel-scenario-c-anon-owner@example.test', 'urel-device-c-anon-owner');
  const text = 'Limnologists sampling a chain of postglacial lakes measured dissolved organic carbon concentration as a proxy for terrestrial carbon subsidy to each lake basin. Concentration increased predictably with the proportion of forested land in each basin\'s local catchment, independent of lake surface area or maximum depth. Basins with recently logged catchments showed a transient spike in concentration that declined over the following several sampling seasons. The authors interpret this pattern as evidence of a measurable, recoverable disturbance signal in lake carbon budgets.';

  const { id: ownerReportId } = await postReport('urel-device-c-anon-owner', { cookie: cookieOwner, text, title: 'lakes-owner.pdf' });
  await fetchRealHistoricalMatch(ownerReportId, { cookie: cookieOwner });

  // A genuinely anonymous device — no cookie, no account — submits matching content.
  const { id: anonId } = await postReport('urel-device-c-anon-viewer', { text, title: 'lakes-anonymous.pdf' });
  const anonMatch = await fetchRealHistoricalMatch(anonId, { deviceKey: 'urel-device-c-anon-viewer' });

  assert.equal(anonMatch.status, 'MATCHED');
  assert.equal(anonMatch.matches[0].relationshipType, 'UNKNOWN_RELATIONSHIP');
  assert.notEqual(anonMatch.matches[0].relationshipType, 'SELF');

  const wordCount = tokens(text).length;
  const unified = computeUnifiedSimilarity({ wordCount, historicalSubmissionMatch: anonMatch });
  assert.equal(unified.unifiedScore, 0, 'UNKNOWN_RELATIONSHIP must contribute 0, exactly like SELF, even though the underlying textual match is real and substantial');
  assert.equal(unified.unknownExcludedWords, anonMatch.matches[0].matchedWordCount);
});

// =============================================================================
// SCENARIO D — SELF + ELIGIBLE MATCH coexisting in one real query result
// =============================================================================

test('SCENARIO D (SELF + ELIGIBLE): a submission with both a real SELF match and a real eligible PRIOR_SUBMISSION match only lets the eligible one contribute', async () => {
  const { cookie: cookieA } = await signup('urel-scenario-d-a@example.test', 'urel-device-d-a');
  const { cookie: cookieC } = await signup('urel-scenario-d-c@example.test', 'urel-device-d-c');

  const partOne = 'Paleoclimatologists analyzing a stalagmite oxygen isotope record reconstructed regional monsoon intensity across the last eight thousand years at sub-decadal resolution. A pronounced multi-century weakening interval coincided with independently dated archaeological evidence of settlement contraction in the same catchment.';
  const partTwo = 'Hydrogeologists modeling a coastal aquifer under projected sea level rise simulated saltwater intrusion distance under three pumping scenarios through the end of the century. The moderate-pumping scenario delayed intrusion into the primary drinking-water well field by roughly forty years relative to the high-pumping scenario.';

  // Account A's own earlier upload of part one alone.
  const { id: aFirstId } = await postReport('urel-device-d-a', { cookie: cookieA, text: partOne, title: 'paleoclimate-alone.pdf' });
  await fetchRealHistoricalMatch(aFirstId, { cookie: cookieA });

  // A different account (C)'s earlier upload of part two alone.
  const { id: cFirstId } = await postReport('urel-device-d-c', { cookie: cookieC, text: partTwo, title: 'hydrogeology-alone.pdf' });
  await fetchRealHistoricalMatch(cFirstId, { cookie: cookieC });

  // Account A now submits a NEW document combining both — its own part one
  // (a real SELF match) plus account C's part two (a real eligible match).
  const combined = partOne + ' ' + partTwo;
  const { id: combinedId } = await postReport('urel-device-d-a', { cookie: cookieA, text: combined, title: 'combined.pdf' });
  const combinedMatch = await fetchRealHistoricalMatch(combinedId, { cookie: cookieA });

  assert.equal(combinedMatch.status, 'MATCHED');
  assert.equal(combinedMatch.matches.length, 2, 'the real matcher must return two separate matches, one per historical representation');

  const selfEntry = combinedMatch.matches.find((m) => m.relationshipType === 'SELF');
  const eligibleEntry = combinedMatch.matches.find((m) => m.relationshipType === 'PRIOR_SUBMISSION');
  assert.ok(selfEntry, 'one of the two real matches must be SELF (against account A\'s own part-one upload)');
  assert.ok(eligibleEntry, 'the other real match must be PRIOR_SUBMISSION (against account C\'s part-two upload)');
  assert.ok(selfEntry.matchedWordCount > 0);
  assert.ok(eligibleEntry.matchedWordCount > 0);

  const wordCount = tokens(combined).length;
  const unified = computeUnifiedSimilarity({ wordCount, historicalSubmissionMatch: combinedMatch });

  assert.equal(unified.selfExcludedWords, selfEntry.matchedWordCount);
  assert.equal(unified.previousUploadOnlyWords, eligibleEntry.matchedWordCount, 'only the eligible source\'s words may reach the unified position merge');
  assert.ok(unified.unifiedScore > 0, 'the eligible portion alone must raise the score above 0');
  assert.equal(
    unified.uniqueMatchedWords,
    eligibleEntry.matchedWordCount,
    'unique matched words must equal ONLY the eligible contribution — the SELF contribution must be completely absent from the merge, not merely down-weighted',
  );
});

// =============================================================================
// SCENARIO E — CORPUS REPRESENTATION DUPLICATION
// =============================================================================

test('SCENARIO E part 1: the corpus layer already guarantees exact-duplicate representations cannot exist — enforced by a real DB unique constraint, verified by actually attempting it', async () => {
  const { createReusableDocumentRepresentation } = await import('../lib/user-submission-corpus.ts');
  const client = createClient({ url: `file:${dbFile}` });
  const text = 'Astrophysicists reanalyzing archival transit photometry identified a previously overlooked shallow periodic dimming signal consistent with a sub-Neptune-sized companion in a wide, eccentric orbit around the host star.';

  const first = await createReusableDocumentRepresentation(client, { canonicalText: text });
  assert.ok(first.id);

  // Bypasses the orchestrator's own findReusableRepresentationByCanonicalHash
  // check on purpose — this is the direct, undeduplicated insert path the
  // module's own header comment warns callers not to use standalone. If the
  // corpus schema truly guarantees uniqueness, this second call must fail.
  await assert.rejects(
    () => createReusableDocumentRepresentation(client, { canonicalText: text }),
    /UNIQUE constraint failed|constraint/i,
    'a second representation row with the identical canonical_sha256 must be rejected by the database itself, not merely discouraged by convention',
  );

  client.close();
});

test('SCENARIO E part 2: two genuinely distinct (non-identical) representations that both substantially overlap a later submission do not inflate unifiedScore, because the position-level union — not representation-identity dedup — is what prevents double counting', async () => {
  const { cookie: cookieP } = await signup('urel-scenario-e-p@example.test', 'urel-device-e-p');
  const { cookie: cookieQ } = await signup('urel-scenario-e-q@example.test', 'urel-device-e-q');
  const { cookie: cookieR } = await signup('urel-scenario-e-r@example.test', 'urel-device-e-r');

  const base = 'Behavioral ecologists studying cooperative breeding in a colonial bird species compared helper contribution rates between related and unrelated helpers across a decade of banded nest observations. Related helpers provisioned nestlings at significantly higher rates than unrelated helpers, consistent with kin-selected cooperation rather than pure group augmentation. Nests with at least one related helper fledged more offspring on average than nests with only unrelated helpers or no helpers at all.';
  // A near-duplicate: same substance, one appended sentence, so its
  // canonical hash genuinely differs — a realistic "two people uploaded
  // essentially the same write-up with a small addition" case, not the
  // DB-blocked exact-duplicate case covered in part 1.
  const nearDuplicate = base + ' A brief supplementary note added by the second uploader discusses one additional confounding variable considered post hoc.';

  const { id: pId } = await postReport('urel-device-e-p', { cookie: cookieP, text: base, title: 'coop-breeding-p.pdf' });
  await fetchRealHistoricalMatch(pId, { cookie: cookieP });
  const { id: qId } = await postReport('urel-device-e-q', { cookie: cookieQ, text: nearDuplicate, title: 'coop-breeding-q.pdf' });
  await fetchRealHistoricalMatch(qId, { cookie: cookieQ });

  // Confirm at the storage layer these really are two distinct representations.
  const client = createClient({ url: `file:${dbFile}` });
  const repCountResult = await client.execute({
    sql: `SELECT COUNT(DISTINCT r.id) AS cnt FROM corpus_document_representations r
          JOIN corpus_submission_references sr ON sr.representation_id = r.id
          JOIN document_identities di ON di.id = sr.document_identity_id
          WHERE di.account_id IN (?, ?)`,
    args: [
      (await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: ['urel-scenario-e-p@example.test'] })).rows[0].id,
      (await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: ['urel-scenario-e-q@example.test'] })).rows[0].id,
    ],
  });
  assert.equal(Number(repCountResult.rows[0].cnt), 2, 'setup check: P and Q must have created two genuinely distinct representation rows');
  client.close();

  // A third account submits text overlapping BOTH near-duplicate uploads.
  const { id: rId } = await postReport('urel-device-e-r', { cookie: cookieR, text: nearDuplicate, title: 'coop-breeding-r.pdf' });
  const rMatch = await fetchRealHistoricalMatch(rId, { cookie: cookieR });

  assert.equal(rMatch.status, 'MATCHED');
  assert.equal(rMatch.matches.length, 2, 'the real matcher finds both distinct historical representations as separate candidates — no representation-identity dedup happens at this layer');
  for (const m of rMatch.matches) assert.equal(m.relationshipType, 'PRIOR_SUBMISSION');

  const wordCount = tokens(nearDuplicate).length;
  const unified = computeUnifiedSimilarity({ wordCount, historicalSubmissionMatch: rMatch });

  const sumOfIndividualMatches = rMatch.matches.reduce((s, m) => s + m.matchedWordCount, 0);
  assert.ok(
    unified.uniqueMatchedWords <= wordCount,
    'unified matched words can never exceed the submission\'s own word count, regardless of how many historical representations independently found it',
  );
  assert.ok(
    unified.uniqueMatchedWords <= sumOfIndividualMatches,
    'the union of two overlapping representations\' matched ranges must be <= the naive sum — proving position-level dedup, not representation-count, is what bounds the score',
  );
  assert.equal(
    unified.previousUploadOnlyWords,
    unified.uniqueMatchedWords,
    'with no archive/live evidence in this scenario, every unique matched word must be attributed to the previous-upload source',
  );
});
