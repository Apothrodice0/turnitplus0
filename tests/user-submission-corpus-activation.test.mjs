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
import { canonicalSha256, createDocumentIdentity } from '../lib/document-identity.ts';
import { indexDocumentSubmissionIntoCorpus } from '../lib/user-submission-corpus.ts';

/**
 * Phase E8D: activation tests. E8A/E8B/E8C already had their own test
 * files proving the corpus/matcher/report-bridge work correctly in
 * isolation — this file is the one that proves the real, live save path
 * (app/api/reports/route.ts's POST handler) now actually calls
 * indexDocumentSubmissionIntoCorpus for signed-in submissions, with no
 * mocking (this repo's tests never mock — see every other tests/*.test.mjs
 * file), only real route calls + direct table/row inspection. Every fixture
 * below uses its own wholly distinct base paragraph (not a shared paragraph
 * with a trailing marker) to avoid the shingle cross-fixture pollution bug
 * documented in E7D/E8A/E8B/E8C's own reports.
 */

const repo = path.resolve('.');
const drizzleDir = path.join(repo, 'drizzle');
const dbFile = path.join(repo, 'test_user_submission_corpus_activation.db');
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
  return `activation-report-${counter}`;
}

async function signup(email, deviceKey) {
  resetAuthRateForTest('activation-signup-' + email);
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'activation-signup-' + email },
    body: JSON.stringify({ email, password: 'activation-password-1', username: email.split('@')[0], deviceKey }),
  });
  const res = await signupRoute.POST(req);
  return { res, cookie: extractCookie(res) };
}

async function postReport(deviceKey, { cookie, id, title = 'activation.pdf', text, score = 12, archiveScore = 9 } = {}) {
  resetRateForTest('activation-post');
  const reportId = id ?? nextId();
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': 'activation-post' };
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
      wordCount: 100,
      archiveScore,
      scoreBand: 'Low',
      aiScore: null,
      aiTone: null,
      payload: { version: 11, id: Date.now(), submissionId: 'sub-' + reportId, title, author: '', assignment: '', created: new Date().toISOString(), score, archiveScore, text, wordCount: 100, characterCount: 500, pageCount: 1, fileSize: '1 KB', databaseSize: 230, corpusVersion: 'test', scoreBand: 'Low' },
    }),
  });
  const res = await reportsRoute.POST(req);
  return { res, id: reportId };
}

async function getReport(id, { deviceKey, cookie } = {}) {
  resetRateForTest('activation-get');
  const headers = { 'x-forwarded-for': 'activation-get' };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const url = deviceKey ? `http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}` : `http://localhost/api/reports/${id}`;
  const req = new Request(url, { headers });
  return reportIdRoute.GET(req, { params: Promise.resolve({ id }) });
}

async function deleteReport(id, { deviceKey, cookie } = {}) {
  resetRateForTest('activation-delete');
  const headers = { 'x-forwarded-for': 'activation-delete' };
  if (cookie) headers['cookie'] = `tp_session_v1=${cookie}`;
  const url = deviceKey ? `http://localhost/api/reports/${id}?deviceKey=${encodeURIComponent(deviceKey)}` : `http://localhost/api/reports/${id}`;
  const req = new Request(url, { method: 'DELETE', headers });
  return reportIdRoute.DELETE(req, { params: Promise.resolve({ id }) });
}

/** Strips block and line comments before running forbidden-pattern checks, so a file's own explanatory comment mentioning a banned table name (as route.ts's E8D comment does, describing what it deliberately does not query) can't cause a false positive — the recurring self-referential structural-test bug documented in every prior E7/E8 phase report. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** Returns the source slice of a brace-delimited block starting at the `{` found at or after fromIndex, matching braces so a literal `}` inside a template-literal interpolation (e.g. `${x}`) can't truncate it early. */
function balancedBraceBlock(source, fromIndex) {
  const openIndex = source.indexOf('{', fromIndex);
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  throw new Error('balancedBraceBlock: no matching close brace found');
}

async function representationForText(client, text) {
  const hash = canonicalSha256(text);
  const result = await client.execute({
    sql: 'SELECT id, canonical_sha256 FROM corpus_document_representations WHERE canonical_sha256 = ?',
    args: [hash],
  });
  return result.rows[0] ? { id: String(result.rows[0].id), canonicalSha256: String(result.rows[0].canonical_sha256) } : null;
}

async function referencesForRepresentation(client, representationId) {
  const result = await client.execute({
    sql: 'SELECT id, document_identity_id, link_type FROM corpus_submission_references WHERE representation_id = ?',
    args: [representationId],
  });
  return result.rows;
}

// --- SCENARIOS A-C / ACTIVATION + DEDUPLICATION -------------------------------

test('SCENARIO A-C / ACTIVATION + DEDUPLICATION: signed-in save indexes new content; repeat by same account adds a reference not a representation; a different account reuses the same representation', async () => {
  const text = 'Marine biologists tracking a migratory pod of humpback whales along the continental shelf documented an unusual deviation in acoustic call patterns during this observation cycle, prompting a targeted hydrophone deployment across three subsequent field seasons with satellite telemetry data supporting every recorded surfacing event.';

  const { cookie: cookieA } = await signup('activation-a@example.test', 'activation-device-a');
  const { cookie: cookieB } = await signup('activation-b@example.test', 'activation-device-b');

  // Scenario A: A uploads X -> a representation now exists, one reference.
  const { res: firstRes } = await postReport('activation-device-a', { cookie: cookieA, text });
  assert.equal(firstRes.status, 200, 'save must succeed');

  const client = createClient({ url: `file:${dbFile}` });
  const representation = await representationForText(client, text);
  assert.ok(representation, 'SCENARIO A: a corpus representation must exist after a signed-in save of new content');
  let refs = await referencesForRepresentation(client, representation.id);
  assert.equal(refs.length, 1, 'SCENARIO A: exactly one submission reference after the first indexed save');

  // Scenario B: A uploads X again (a second, distinct submission event) ->
  // same representation, a second reference — this is the corpus tracking
  // submission events, not report rows, matching Scenario B's own framing.
  const { res: secondRes } = await postReport('activation-device-a', { cookie: cookieA, text, title: 'activation-again.pdf' });
  assert.equal(secondRes.status, 200);
  const representationAfterRepeat = await representationForText(client, text);
  assert.equal(representationAfterRepeat.id, representation.id, 'SCENARIO B: repeating the same content must not create a second representation');
  refs = await referencesForRepresentation(client, representation.id);
  assert.equal(refs.length, 2, 'SCENARIO B: a second submission reference must be recorded for the repeat');
  assert.equal(new Set(refs.map((r) => r.document_identity_id)).size, 2, 'the two references must point at two distinct document identities');

  // Scenario C: B (a different account) uploads X -> still the same
  // representation, a third, cross-account reference.
  const { res: thirdRes } = await postReport('activation-device-b', { cookie: cookieB, text, title: 'activation-b.pdf' });
  assert.equal(thirdRes.status, 200);
  const representationAfterCrossAccount = await representationForText(client, text);
  assert.equal(representationAfterCrossAccount.id, representation.id, 'SCENARIO C: a different account submitting identical content must reuse the same representation, not create a new one');
  refs = await referencesForRepresentation(client, representation.id);
  assert.equal(refs.length, 3, 'SCENARIO C: a third submission reference must be recorded, this one cross-account');

  client.close();
});

// --- SCENARIO D / REVISIONS ----------------------------------------------------

test('SCENARIO D / REVISIONS: a signed-in account uploading materially revised content creates a new, distinct representation', async () => {
  const original = 'Paleoclimatologists drilling a lakebed sediment core in a formerly glaciated valley identified alternating varve bands that preserve an annual record of meltwater discharge across the early Holocene transition.';
  const revised = original + ' A supplementary appendix revises the original discharge-rate table after a reviewer identified a transcription error affecting the third sampled interval.';

  const { cookie } = await signup('activation-d@example.test', 'activation-device-d');
  await postReport('activation-device-d', { cookie, text: original });
  await postReport('activation-device-d', { cookie, text: revised, title: 'activation-d-revised.pdf' });

  const client = createClient({ url: `file:${dbFile}` });
  const originalRepresentation = await representationForText(client, original);
  const revisedRepresentation = await representationForText(client, revised);
  assert.ok(originalRepresentation, 'the original content must still have its own representation');
  assert.ok(revisedRepresentation, 'the revised content must have been indexed into its own representation');
  assert.notEqual(revisedRepresentation.id, originalRepresentation.id, 'REVISIONS: materially different content must not collapse into the original representation');
  client.close();
});

// --- SCENARIO E / ANONYMOUS -----------------------------------------------------

test('SCENARIO E / ACTIVATION (anonymous skip): an anonymous submission is never indexed into the corpus', async () => {
  const text = 'Glaciologists surveying an alpine ice core extracted a two hundred meter sample revealing distinct annual layering that correlates with regional temperature reconstructions spanning several centuries of overlapping instrumental and proxy record.';

  const { res } = await postReport('activation-device-anonymous', { text });
  assert.equal(res.status, 200, 'anonymous save must still succeed');

  const client = createClient({ url: `file:${dbFile}` });
  const representation = await representationForText(client, text);
  assert.equal(representation, null, 'SCENARIO E: an anonymous submission must never create a corpus representation');
  client.close();
});

// --- SCENARIO F / FAILURE -------------------------------------------------------

test('SCENARIO F / FAILURE (lib-level): indexDocumentSubmissionIntoCorpus really can throw on a canonical-hash mismatch', async () => {
  const client = createClient({ url: `file:${dbFile}` });
  await client.execute({ sql: 'INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: ['activation-f-owner', 'activation-f-owner@example.test', 'activation-f-owner', 'x'] });
  const original = 'Astronomers analyzing spectroscopic data from a distant exoplanet transit reported a tentative detection of atmospheric water vapor absorption lines requiring confirmation from an independent observing run next season.';
  const identity = await createDocumentIdentity(client, { accountId: 'activation-f-owner', title: 'T', author: null, rawText: original });

  const mismatched = 'Completely unrelated content used only to force a canonical hash mismatch for this deliberate failure test.';
  await assert.rejects(
    () => indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText: mismatched }),
    /does not match/,
    'a genuine hash mismatch must throw, proving the route\'s try/catch around this call is protecting against a real failure mode',
  );

  // The orphan signal this phase's report documents as the recoverable state
  // a future reconciliation pass could query for: the identity row exists,
  // but no submission reference was ever recorded for it.
  const refs = await client.execute({ sql: 'SELECT COUNT(*) AS cnt FROM corpus_submission_references WHERE document_identity_id = ?', args: [identity.id] });
  assert.equal(Number(refs.rows[0].cnt), 0, 'a failed indexing attempt must leave no submission reference — the identity row alone is the recoverable signal');
  client.close();
});

test('SCENARIO F / FAILURE (structural): the route only ever calls indexDocumentSubmissionIntoCorpus inside its own non-rethrowing try/catch, inside the deferred callback', () => {
  const source = fs.readFileSync(path.join(repo, 'app/api/reports/route.ts'), 'utf8');
  const callIndex = source.indexOf('await indexDocumentSubmissionIntoCorpus(');
  assert.ok(callIndex > -1, 'the route must call indexDocumentSubmissionIntoCorpus');

  const deferredOpen = source.indexOf('runAfterResponse(async () => {');
  assert.ok(deferredOpen > -1);
  assert.ok(callIndex > deferredOpen, 'indexing must happen inside the deferred runAfterResponse callback, not before it');

  const tryIndex = source.lastIndexOf('try {', callIndex);
  const catchIndex = source.indexOf('} catch (err) {', callIndex);
  assert.ok(tryIndex > -1 && catchIndex > tryIndex && catchIndex < callIndex + 2000, 'the indexing call must be wrapped in its own try/catch');
  const catchBody = balancedBraceBlock(source, catchIndex);
  assert.doesNotMatch(catchBody, /\bthrow\b/, 'the indexing failure catch block must never rethrow — a failure here must not fail the save');
});

test('SCENARIO F / FAILURE (behavioral, concurrent real load): two concurrent first-time saves of identical brand-new content both succeed regardless of any internal indexing race', async () => {
  const text = 'Seismologists deploying a temporary array of broadband sensors near a dormant caldera detected a swarm of low magnitude tremors clustered at unusually shallow depth over a single reporting week.';
  const { cookie: cookieA } = await signup('activation-race-a@example.test', 'activation-device-race-a');
  const { cookie: cookieB } = await signup('activation-race-b@example.test', 'activation-device-race-b');

  const [resA, resB] = await Promise.all([
    postReport('activation-device-race-a', { cookie: cookieA, text, title: 'race-a.pdf' }),
    postReport('activation-device-race-b', { cookie: cookieB, text, title: 'race-b.pdf' }),
  ]);
  assert.equal(resA.res.status, 200, 'concurrent save A must still succeed even if it races another indexing attempt for the same new content');
  assert.equal(resB.res.status, 200, 'concurrent save B must still succeed even if it races another indexing attempt for the same new content');
});

// --- SCENARIO G / IDEMPOTENCY ---------------------------------------------------

test('SCENARIO G / IDEMPOTENCY: invoking indexDocumentSubmissionIntoCorpus twice for the same document identity does not duplicate corpus data', async () => {
  const client = createClient({ url: `file:${dbFile}` });
  await client.execute({ sql: 'INSERT OR IGNORE INTO users (id, email, username, password_hash) VALUES (?,?,?,?)', args: ['activation-g-owner', 'activation-g-owner@example.test', 'activation-g-owner', 'x'] });
  const text = 'Botanists cataloguing an isolated montane cloud forest reserve documented an epiphyte assemblage with an unusually high proportion of range-restricted orchid species relative to nearby lowland plots.';
  const identity = await createDocumentIdentity(client, { accountId: 'activation-g-owner', title: 'T', author: null, rawText: text });

  const first = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText: text });
  assert.equal(first.status, 'INDEXED');
  const second = await indexDocumentSubmissionIntoCorpus(client, { documentIdentityId: identity.id, rawText: text });
  assert.equal(second.status, 'SKIPPED_ALREADY_INDEXED', 'a second call for the same identity must be recognized as already indexed');
  assert.equal(second.representationId, first.representationId);

  const refs = await client.execute({ sql: 'SELECT COUNT(*) AS cnt FROM corpus_submission_references WHERE document_identity_id = ?', args: [identity.id] });
  assert.equal(Number(refs.rows[0].cnt), 1, 'exactly one submission reference must exist no matter how many times indexing is invoked for the same identity');
  client.close();
});

// --- PERFORMANCE ------------------------------------------------------------

test('PERFORMANCE (structural): indexDocumentSubmissionIntoCorpus is never awaited on the POST handler\'s synchronous critical path outside the deferred callback', () => {
  const source = fs.readFileSync(path.join(repo, 'app/api/reports/route.ts'), 'utf8');
  const deferredOpen = source.indexOf('await runAfterResponse(async () => {');
  const deferredCloseMarker = source.indexOf('});', source.indexOf('deferredClient.close();'));
  const callIndex = source.indexOf('await indexDocumentSubmissionIntoCorpus(');
  assert.ok(deferredOpen > -1 && deferredCloseMarker > -1 && callIndex > -1);
  assert.ok(callIndex > deferredOpen && callIndex < deferredCloseMarker, 'the only call site must sit inside the runAfterResponse callback body');

  const occurrences = source.split('indexDocumentSubmissionIntoCorpus(').length - 1;
  assert.equal(occurrences, 1, 'indexDocumentSubmissionIntoCorpus must be called exactly once in the route, from inside the deferred callback');
});

test('PERFORMANCE (smoke): a signed-in save with indexing completes within a generous bound', async () => {
  const text = 'Hydrologists monitoring a regulated river reach below a mid-sized dam recorded a measurable shift in downstream sediment transport following a scheduled high-flow release event this operating year.';
  const { cookie } = await signup('activation-perf@example.test', 'activation-device-perf');
  const startedAt = Date.now();
  const { res } = await postReport('activation-device-perf', { cookie, text });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(res.status, 200);
  assert.ok(elapsedMs < 5000, `save (including inline-fallback indexing under the test harness) took ${elapsedMs}ms, expected under 5000ms`);
});

// --- REPORT (end-to-end) ---------------------------------------------------

test('REPORT end-to-end: B sees PRIOR_SUBMISSION after A and B both upload the same content; A sees SELF on repeat; verified score is unaffected throughout', async () => {
  const text = 'Entomologists cataloguing a previously undescribed beetle population in a lowland rainforest reserve recorded distinctive elytra patterning consistent with a proposed new subspecies pending further genomic barcoding confirmation across multiple collection sites.';

  const { cookie: cookieA } = await signup('activation-report-a@example.test', 'activation-device-report-a');
  const { cookie: cookieB } = await signup('activation-report-b@example.test', 'activation-device-report-b');

  const { id: aFirstId } = await postReport('activation-device-report-a', { cookie: cookieA, text, score: 15, archiveScore: 8 });
  const { id: bId } = await postReport('activation-device-report-b', { cookie: cookieB, text, score: 21, archiveScore: 11, title: 'b-upload.pdf' });

  const bGet = await getReport(bId, { cookie: cookieB });
  assert.equal(bGet.status, 200);
  const bBody = await bGet.json();
  assert.equal(bBody.payload.historicalSubmissionMatch?.status, 'MATCHED', 'B\'s report must show a historical match now that A already indexed the same content');
  const bMatch = bBody.payload.historicalSubmissionMatch.matches[0];
  assert.equal(bMatch.relationshipType, 'PRIOR_SUBMISSION', 'B is not the same account as the prior uploader, so this must be PRIOR_SUBMISSION, not SELF');
  assert.equal(bBody.payload.score, 21, 'verified score must remain exactly what B saved, unaffected by the historical match');
  assert.equal(bBody.payload.archiveScore, 11, 'archive overlap must remain exactly what B saved');

  const bBodyText = JSON.stringify(bBody);
  assert.doesNotMatch(bBodyText, /activation-report-a@example\.test/, 'A\'s email must never appear anywhere in B\'s report response');
  assert.doesNotMatch(bBodyText, /accountId/i, 'no raw account identifier field name should ever appear in the report response');

  const { id: aSecondId } = await postReport('activation-device-report-a', { cookie: cookieA, text, score: 15, archiveScore: 8, title: 'a-repeat.pdf' });
  const aGet = await getReport(aSecondId, { cookie: cookieA });
  const aBody = await aGet.json();
  assert.equal(aBody.payload.historicalSubmissionMatch?.status, 'MATCHED');
  assert.equal(aBody.payload.historicalSubmissionMatch.matches[0].relationshipType, 'SELF', 'A repeating its own prior upload must be classified SELF');
  assert.equal(aBody.payload.score, 15, 'verified score must remain exactly what was saved even for a SELF match');

  void aFirstId;
});

// --- PRIVACY -----------------------------------------------------------------

test('PRIVACY: no full submitted text ever appears in console log output from a signed-in indexed save', async () => {
  const text = 'Climatologists comparing decadal rainfall anomalies across a semi-arid basin identified a statistically significant shift coinciding with a documented change in regional atmospheric circulation patterns.';
  const { cookie } = await signup('activation-privacy@example.test', 'activation-device-privacy');

  const originalLog = console.log;
  const originalError = console.error;
  const captured = [];
  console.log = (...args) => { captured.push(args.map(String).join(' ')); };
  console.error = (...args) => { captured.push(args.map(String).join(' ')); };
  try {
    const { res } = await postReport('activation-device-privacy', { cookie, text });
    assert.equal(res.status, 200);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  const joined = captured.join('\n');
  assert.doesNotMatch(joined, /semi-arid basin/, 'the raw submitted text must never be logged');
  assert.doesNotMatch(joined, /activation-privacy@example\.test/, 'the account email must never be logged by the indexing path');
});

test('PRIVACY (structural): no app/api route queries corpus representation text directly', () => {
  const apiDir = path.join(repo, 'app', 'api');
  const routeFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'route.ts') routeFiles.push(full);
    }
  };
  walk(apiDir);
  assert.ok(routeFiles.length > 0);
  for (const file of routeFiles) {
    const source = stripComments(fs.readFileSync(file, 'utf8'));
    assert.doesNotMatch(source, /corpus_document_representations|corpus_submission_references|corpus_document_shingles/, `${file} must never query corpus tables directly — only through the lib/ bridge layer's bounded, privacy-safe functions`);
  }
});

// --- AUTH ----------------------------------------------------------------------

test('AUTH: B cannot fetch A\'s report at all, even though B\'s own upload now cross-references A\'s content in the corpus', async () => {
  const text = 'Volcanologists monitoring a stratovolcano recorded a sustained increase in sulfur dioxide flux preceding a minor phreatic eruption event this activation-auth test cycle only.';
  const { cookie: cookieA } = await signup('activation-auth-a@example.test', 'activation-device-auth-a');
  const { cookie: cookieB } = await signup('activation-auth-b@example.test', 'activation-device-auth-b');

  const { id: aId } = await postReport('activation-device-auth-a', { cookie: cookieA, text });
  await postReport('activation-device-auth-b', { cookie: cookieB, text, title: 'auth-b.pdf' });

  const asOwner = await getReport(aId, { cookie: cookieA });
  assert.equal(asOwner.status, 200);

  const asOther = await getReport(aId, { cookie: cookieB });
  assert.equal(asOther.status, 404, 'account B must get 404 for account A\'s report id, regardless of the corpus cross-reference between their accounts');
});

// --- REGRESSION ------------------------------------------------------------

test('REGRESSION: anonymous save -> get -> delete round trip still works exactly as before', async () => {
  const deviceKey = 'activation-device-regression';
  const { res: postRes, id } = await postReport(deviceKey, { title: 'regression.pdf', text: 'regression fixture text for the activation phase, unrelated to any other fixture in this file.' });
  assert.equal(postRes.status, 200);

  const getRes = await getReport(id, { deviceKey });
  assert.equal(getRes.status, 200);
  const body = await getRes.json();
  assert.equal(body.payload.title, 'regression.pdf');

  const deleteRes = await deleteReport(id, { deviceKey });
  assert.equal(deleteRes.status, 200);

  const getAfterDelete = await getReport(id, { deviceKey });
  assert.equal(getAfterDelete.status, 404);
});

test('REGRESSION: 404 remains 404 for a nonexistent report id', async () => {
  const res = await getReport('activation-does-not-exist', { deviceKey: 'activation-device-nonexistent' });
  assert.equal(res.status, 404);
});
