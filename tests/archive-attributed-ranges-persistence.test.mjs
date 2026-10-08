import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { applyMigrationsLibsql } from '../lib/ingest.ts';
import { tokenSpans } from '../lib/similarity-core.ts';
import { findHighlightRanges } from '../components/report/similarity-report-papers.tsx';
import * as reportsRoute from '../app/api/reports/route.ts';
import * as reportIdRoute from '../app/api/reports/[id]/route.ts';
import * as signupRoute from '../app/api/auth/signup/route.ts';
import { resetRateForTest, resetAuthRateForTest } from '../lib/rate-limit.ts';
import { withTestIdentity } from './helpers/test-signup.mjs';

/**
 * Archive attributedRanges ride the real save/read path: report.sources is
 * stored in payload_json as the client sent it, so a report saved with the
 * scorer's attributed ranges is served with them, and the served report
 * highlights exactly its scored words under their owners. A report saved
 * without them (every report before the scorer listed them) is served without
 * them and keeps phrase highlighting. Same DB-backed route harness as
 * tests/report-academic-evidence-persistence.test.mjs.
 */

const repo = path.resolve('.');
const dbFile = path.join(repo, 'test_archive_attributed_ranges_persistence.db');
for (const suffix of ['', '-wal', '-shm']) {
  const candidate = `${dbFile}${suffix}`;
  if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
const setupClient = createClient({ url: `file:${dbFile}` });
await applyMigrationsLibsql(setupClient, path.join(repo, 'drizzle'));
setupClient.close();
test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbFile}${suffix}`); } catch { /* ignore */ }
  }
});

const TEXT = [
  'Municipal libraries in coastal towns expanded evening opening hours after volunteers organised reading circles.',
  'Groundwater recharge beneath the Saharan piedmont was reconstructed from chloride profiles along twelve boreholes,',
  'and fossil aquifer layers remained hydraulically isolated from the shallow alluvial system near the oasis.',
  'Meanwhile a travelling puppet theatre toured village schools with adaptations of folk tales.',
].join(' ');
const A_RANGES = [[14, 29]];
const B_RANGES = [[30, 31]];
const SCORED = Array.from({ length: 18 }, (_, k) => 14 + k);
const archiveSource = (name, attributedRanges) => ({
  name,
  type: 'Publication',
  color: '#d7263d',
  matches: 1,
  matchedWords: attributedRanges[0][1] - attributedRanges[0][0] + 1,
  percent: 0,
  phrases: name === 'Source A' ? ['groundwater recharge beneath the saharan piedmont was reconstructed from chloride profiles along twelve boreholes and fossil'] : [],
  ...(attributedRanges ? { attributedRanges } : {}),
});
const SOURCES = [archiveSource('Source A', A_RANGES), archiveSource('Source B', B_RANGES)];

async function signupFor(deviceKey, clientTag) {
  await resetAuthRateForTest(clientTag + '-signup');
  const req = new Request('http://localhost/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': clientTag + '-signup' },
    body: JSON.stringify(withTestIdentity({ email: `${clientTag}@example.test`, password: 'attributed-ranges-fixture-pw', username: clientTag.replace(/[^a-z0-9]/gi, '').slice(0, 24), deviceKey })),
  });
  const res = await signupRoute.POST(req);
  return res.headers.get('set-cookie')?.match(/tp_session_v1=([^;]*)/)?.[1] ?? null;
}

async function saveAndRead(clientTag, sources) {
  const deviceKey = `device-${clientTag}`;
  await resetRateForTest(clientTag);
  const cookie = await signupFor(deviceKey, clientTag);
  const payload = {
    version: 11,
    id: Date.now() + Math.floor(Math.random() * 1000),
    submissionId: '9876543210',
    title: 'attributed.pdf',
    created: new Date().toISOString(),
    score: 31,
    archiveScore: 31,
    wordCount: 58,
    scoreBand: 'High',
    matchedWordCount: SCORED.length,
    archiveMatchedPositions: SCORED,
    scoringNormalizationVersion: 2,
    sources,
    repeats: [],
    text: TEXT,
  };
  const saved = await reportsRoute.POST(new Request('http://localhost/api/reports', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': clientTag, cookie: `tp_session_v1=${cookie}` },
    body: JSON.stringify({ deviceKey, id: String(payload.id), submissionId: payload.submissionId, title: payload.title, createdAt: payload.created, wordCount: payload.wordCount, archiveScore: payload.score, scoreBand: 'High', aiScore: null, aiTone: null, room: 0, payload }),
  }));
  assert.equal(saved.status, 200, await saved.clone().text());
  await resetRateForTest(`${clientTag}-get`);
  const read = await reportIdRoute.GET(
    new Request(`http://localhost/api/reports/${payload.id}`, { headers: { 'x-forwarded-for': `${clientTag}-get`, cookie: `tp_session_v1=${cookie}` } }),
    { params: Promise.resolve({ id: String(payload.id) }) },
  );
  assert.equal(read.status, 200);
  return (await read.json()).payload;
}

function highlighted(report) {
  const spans = tokenSpans(report.text, 2);
  const ranges = findHighlightRanges(report, { includeWikipedia: false });
  const owners = new Map();
  spans.forEach((span, position) => {
    const range = ranges.find((candidate) => span.start >= candidate.start && span.end <= candidate.end);
    if (range) owners.set(position, range.label);
  });
  return owners;
}

test('precondition: the fixture ranges sit on real words of the text', () => {
  assert.ok(tokenSpans(TEXT, 2).length > 31);
});

test('a report saved with attributedRanges is served with them, and highlights exactly its scored words under their owners', async () => {
  const served = await saveAndRead('with-ranges', SOURCES);
  assert.deepEqual(served.sources.map((s) => s.attributedRanges), [A_RANGES, B_RANGES]);
  assert.deepEqual(served.archiveMatchedPositions, SCORED);
  const owners = highlighted(served);
  assert.deepEqual([...owners.keys()].sort((a, b) => a - b), SCORED);
  for (const p of SCORED) assert.equal(owners.get(p), p <= 29 ? 'Source A' : 'Source B', `position ${p}`);
});

test('a report saved without attributedRanges (the older shape) is served without them and keeps phrase highlighting', async () => {
  const served = await saveAndRead('without-ranges', SOURCES.map(({ attributedRanges: _r, ...s }) => s));
  assert.ok(served.sources.every((s) => !('attributedRanges' in s)));
  const owners = highlighted(served);
  assert.ok(!owners.has(30) && !owners.has(31), 'the phrase-less 2-word run stays unhighlighted, as before');
});
