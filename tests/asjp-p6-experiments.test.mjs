import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NumericIndex, buildNumericIndex, numericGroups } from '../lib/asjp-numeric-index.ts';
import { SHORT_RULE, verbatimRuns } from '../lib/asjp-short-passages.ts';
import { tokensForScoringNormalization } from '../lib/similarity-core.ts';

/** Phase-6 experiments: number-table candidates and the short-passage run finder. */
const tok = (t) => tokensForScoringNormalization(t, 2);
const scratch = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'asjp-p6-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const table = (seed) => Array.from({ length: 12 }, (_, i) => `row ${i} ${(seed * 37 + i * 113) % 997} ${(seed * 11 + i * 71) % 89} ${(seed + i * 7) % 61}.${(i * 13) % 100}`).join(' ');

test('numericGroups: progressions, scales and single digits are not informative', () => {
  assert.equal(numericGroups(tok('1 2 3 4 5 6 7 8 9 10 11 12')).length, 0, 'a progression');
  assert.equal(numericGroups(tok('2010 2011 2012 2013 2014 2015 2016 2017 2018')).length, 0, 'years');
  assert.equal(numericGroups(tok('1 2 3 4 5 1 2 3 4 5 1 2 3 4 5')).length, 0, 'a Likert scale');
  assert.equal(numericGroups(tok('0 0 0 0 0 0 0 0 0 0')).length, 0);
  assert.ok(numericGroups(tok(table(1))).length > 0, 'a real table is informative');
});

test('a copied table nominates its article; a common layout or an unrelated table nominates nothing', async () => {
  const docs = [{ docId: '1', tokens: tok(`text ${table(1)} more text`) }, { docId: '2', tokens: tok(`other ${table(2)} words`) },
    // three articles share one layout: it is dropped as common
    ...['3', '4', '5'].map((d) => ({ docId: d, tokens: tok(`shared ${table(9)} ${table(Number(d) + 20)}`) }))];
  async function* it() { for (const d of docs) yield d; }
  const r = await buildNumericIndex(path.join(scratch, 'num'), it());
  assert.ok(r.droppedCommonKeys > 0);
  const idx = NumericIndex.open(path.join(scratch, 'num'));
  assert.deepEqual(idx.candidates(tok(`a manuscript with ${table(1)}`)).map((c) => c.docId), ['1']);
  assert.deepEqual(idx.candidates(tok(`a manuscript with ${table(9)}`)), [], 'the shared layout nominates nothing');
  assert.deepEqual(idx.candidates(tok(`a manuscript with ${table(77)}`)), []);
});

test('verbatimRuns: exact maximal runs of >= 6 words with their source positions', () => {
  const src = tok('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu');
  const sub = tok('one two gamma delta epsilon zeta eta theta three four alpha beta');
  const runs = verbatimRuns(sub, src);
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].s, runs[0].e, runs[0].j], [2, 7, 2]);
  assert.deepEqual(sub.slice(runs[0].s, runs[0].e + 1), src.slice(runs[0].j, runs[0].j + 6));
});

test('the frozen short-passage rule never reports 6–14-word runs', () => {
  assert.equal(SHORT_RULE.c, null);
  assert.equal(SHORT_RULE.a.rare, 0);
  assert.equal(SHORT_RULE.b.rare, 1);
});
