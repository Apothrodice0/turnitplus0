import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { asjpPublicationEvidenceOf, asjpSourceCards, maximalVerbatimRuns, rescueCanAdmit, rescueSubmissionIndex, runAsjpAcademicLane } from '../lib/asjp-academic-lane.ts';
import { openAsjpCatalog } from '../lib/asjp-catalog-store.ts';
import { loadAsjpCatalogSnapshot } from '../lib/asjp-catalog-snapshot.ts';

/** Phase-6 review fixes: the rescue bound property, multi-version catalog entries, per-article evidence, dates, cards. */
const scratch = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'asjp-p6-fixes-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
let state = 12345;
const rand = (n) => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state % n; };
const gramStarts = (w, k = 6) => { const m = new Map(); for (let i = 0; i + k <= w.length; i += 1) { const key = w.slice(i, i + k).join(' '); const l = m.get(key); if (l) l.push(i); else m.set(key, [i]); } return m; };
// the full search's decision (as the lane takes it): kept runs >= 6, total >= 60 and longest >= 25
const fullAdmits = (sub, src) => { const runs = maximalVerbatimRuns(sub, src, gramStarts(src), 6); const len = (r) => r.submittedWordEnd - r.submittedWordStart + 1; return runs.reduce((t, r) => t + len(r), 0) >= 60 && runs.reduce((m, r) => Math.max(m, len(r)), 0) >= 25; };

test('rescueCanAdmit never rejects a candidate the full search admits (2,000 random cases, boundary lengths included)', () => {
  let admitted = 0, rejectedByBound = 0;
  for (let c = 0; c < 2000; c += 1) {
    const vocab = 3 + rand(40);
    const src = Array.from({ length: 300 + rand(300) }, () => `w${rand(vocab)}`);
    const sub = Array.from({ length: 200 + rand(300) }, () => `w${rand(vocab)}`);
    // splice 0–3 copied runs of boundary lengths (24, 25, 26, 34, 35, 60 …)
    for (let k = 1 + rand(5); k > 0; k -= 1) { const n = [6, 12, 24, 25, 26, 34, 35, 59, 60, 61, 70][rand(11)]; const at = rand(src.length - n); const to = rand(Math.max(1, sub.length - n)); sub.splice(to, n, ...src.slice(at, at + n)); }
    const full = fullAdmits(sub, src);
    const bound = rescueCanAdmit(rescueSubmissionIndex(sub), src);
    if (full) { admitted += 1; assert.equal(bound, true, `case ${c}: the bound rejected an admissible candidate`); }
    if (!bound) rejectedByBound += 1;
  }
  assert.ok(admitted > 50, `admissible cases exercised (${admitted})`);
  assert.ok(rejectedByBound > 100, `the bound rejects cases too (${rejectedByBound})`);
});

test('catalog: an article with several indexed versions — withdrawn if any is, the most restrictive licence; store = snapshot', async () => {
  const file = path.join(scratch, 'multi.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE journals (journal_id INTEGER PRIMARY KEY, name TEXT, eissn TEXT);
    CREATE TABLE articles (article_id INTEGER PRIMARY KEY, journal_id INTEGER, canonical_url TEXT, title TEXT, authors_json TEXT, publication_date TEXT, doi TEXT);
    CREATE TABLE article_versions (article_id INTEGER, indexed INTEGER, licence TEXT, licence_version TEXT, licence_basis TEXT, licence_status TEXT, reuse_permitted INTEGER, withdrawn INTEGER);
    INSERT INTO journals VALUES (1, 'J', NULL);
    INSERT INTO articles VALUES (1, 1, 'u1', 't1', NULL, '2024-01-01', NULL), (2, 1, 'u2', 't2', NULL, '2024-01-01', NULL);
    INSERT INTO article_versions VALUES (1, 1, 'CC BY', '4.0', 'PDF', 'PERMITTED', 1, 0), (1, 1, 'CC BY-NC', '4.0', 'PDF', 'RESTRICTED', 0, 0);
    INSERT INTO article_versions VALUES (2, 1, 'CC BY', '4.0', 'PDF', 'PERMITTED', 1, 0), (2, 1, 'CC BY', '4.0', 'PDF', 'PERMITTED', 1, 1);`);
  db.close();
  const store = openAsjpCatalog(file);
  const snap = await loadAsjpCatalogSnapshot(file);
  assert.equal(store.entry('1').licenceStatus, 'RESTRICTED');
  assert.equal(store.entry('1').reusePermitted, false);
  assert.equal(store.entry('2').withdrawn, true);
  for (const id of ['1', '2']) assert.deepEqual(snap.entries.get(id), store.entry(id));
  store.close();
});

test('evidence: two credited versions of one article become one entry with every passage; untitled sources keep a card', () => {
  const pub = { articleId: '7', canonicalUrl: 'u', title: null, authors: null, journal: 'J', issn: null, publicationDate: '2024-01-01', doi: null, license: 'CC BY', licenseBasis: null, licenceStatus: 'PERMITTED', reusePermitted: true, withdrawn: false };
  const src = (docId, start) => ({ sourceId: 'asjp:7', docId, credited: true, relationship: 'INDEPENDENT_PUBLICATION', publication: pub, matchedPassages: [{ submittedWordStart: start, submittedWordEnd: start + 29, matchedWordCount: 30 }], matchedWordCount: 30, annotations: [] });
  const result = { state: 'COMPLETE', sources: [src('1', 100), src('2', 10)], creditedPositions: [] };
  const ev = asjpPublicationEvidenceOf(result);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].matchedPassages.map((p) => p.submittedWordStart), [10, 100]);
  const cards = asjpSourceCards(result);
  assert.ok(cards.length >= 1 && cards.every((c) => c.title === null), 'shown, with no invented title');
});

test('a malformed reference date fails the request', async () => {
  const r = await runAsjpAcademicLane({ store: null, generationId: 'gen-x', submissionText: 'x', catalog: () => null, ignoreFlag: true, referenceDate: '2024-1-5' }).catch((e) => ({ state: 'THREW', e }));
  assert.equal(r.state, 'FAILED');
});
