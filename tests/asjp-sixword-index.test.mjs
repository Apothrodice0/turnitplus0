import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';
import { corpusEngineScratch, inventedText, prng, removeScratch } from './helpers/corpus-engine-fixtures.mjs';
import { buildLaneTokens } from '../lib/asjp-lane-tokens.ts';
import { tokensForScoringNormalization } from '../lib/similarity-core.ts';
import { SixwordIndex, buildSixwordIndex, gramKeysOf, hashTokenBytes } from '../lib/asjp-sixword-index.ts';
import { bruteForceRuns, findSixwordRuns } from '../lib/asjp-sixword-match.ts';

/** Six-word index: exhaustive exact runs equal brute force, positions exact, takedowns, common grams, refusals. */
const scratch = corpusEngineScratch('asjp-sixword-index');
test.after(() => removeScratch(scratch));
const COMMON = 'the results of this study show that';
const docs = Array.from({ length: 40 }, (_, k) => ({ docId: String(1000 + k), text: `${inventedText(k + 1, 300 + 37 * k)} ${k % 4 === 0 ? COMMON : ''} ${inventedText(k + 101, 120)}` }));
// two articles that share a passage verbatim, one that repeats a passage inside itself
docs[5].text += ` ${inventedText(999, 40)} closing words of five`;
docs[6].text += ` ${inventedText(999, 40)} different closing words here`;
docs[7].text += ` ${inventedText(777, 12)} filler ${inventedText(777, 12)}`;
async function* source(list) { for (const d of list) yield d; }

let tokensDir, indexDir, index;
test('builds a lane-token store and an index from it', async () => {
  tokensDir = path.join(scratch, 'tokens');
  indexDir = path.join(scratch, 'six');
  await buildLaneTokens(tokensDir, 2, source(docs));
  const identity = await buildSixwordIndex({ laneTokensDir: tokensDir, outDir: indexDir, tmpDir: path.join(scratch, 'tmp'), partitions: 4 });
  const total = docs.reduce((t, d) => t + tokensForScoringNormalization(d.text, 2).length, 0);
  assert.equal(identity.documents, docs.length);
  assert.equal(identity.tokens, total);
  assert.equal(identity.postings, total - 5 * docs.length);
  await assert.rejects(buildSixwordIndex({ laneTokensDir: tokensDir, outDir: indexDir, tmpDir: path.join(scratch, 'tmp') }), /immutable/);
  index = SixwordIndex.open(indexDir, { verifyTokensDigest: true, verifyFiles: true });
});

test('token hashing agrees between the build (bytes) and the query (strings)', () => {
  const words = ['naïve', 'l', 'état', '1', '234', 'σ', 'x'];
  const viaBytes = hashTokenBytes(Buffer.from(words.join('\n'), 'utf8'));
  assert.equal(viaBytes.count, words.length);
  const keys = gramKeysOf(words);
  assert.equal(keys.h1.length, 2);
  assert.throws(() => gramKeysOf(['a\nb', 'c', 'd', 'e', 'f', 'g']), /newline/);
});

test('every maximal run equals brute force over every article (random manuscripts)', () => {
  const rand = prng(42);
  for (let trial = 0; trial < 12; trial += 1) {
    // a manuscript made of windows of 1..40 words from random articles and invented filler
    const words = [];
    while (words.length < 900) {
      if (rand() < 0.4) { words.push(...tokensForScoringNormalization(inventedText(5000 + trial * 100 + words.length, 3 + Math.floor(rand() * 20)), 2)); continue; }
      const d = docs[Math.floor(rand() * docs.length)];
      const t = tokensForScoringNormalization(d.text, 2);
      const n = 1 + Math.floor(rand() * 40), at = Math.floor(rand() * (t.length - n));
      words.push(...t.slice(at, at + n));
    }
    words.push(...tokensForScoringNormalization(COMMON, 2));
    const found = findSixwordRuns(index, words);
    const expected = [];
    docs.forEach((d, ord) => { for (const r of bruteForceRuns(words, index.readAll(ord))) expected.push(`${d.docId}:${r.s}:${r.e}:${r.p}:${r.q}`); });
    const got = found.runs.map((r) => `${r.docId}:${r.s}:${r.e}:${r.p}:${r.q}`);
    assert.deepEqual([...got].sort(), [...expected].sort(), `trial ${trial}`);
    for (const r of found.runs) assert.deepEqual(index.readTokens(r.ord, r.p, r.q + 1), words.slice(r.s, r.e + 1));
  }
});

test('a gram above the chain cap is bridged, counted, and a run made only of such grams is reported as common text', () => {
  const d = tokensForScoringNormalization(docs[3].text, 2);
  const words = [...tokensForScoringNormalization(inventedText(31337, 30), 2), ...d.slice(50, 80), ...tokensForScoringNormalization(inventedText(31338, 30), 2), ...tokensForScoringNormalization(COMMON, 2), ...tokensForScoringNormalization(inventedText(31339, 30), 2)];
  const all = findSixwordRuns(index, words);
  const capped = findSixwordRuns(index, words, { chainCap: 1 });
  const key = (r) => `${r.docId}:${r.s}:${r.e}:${r.p}`;
  // the run unique to docs[3] (whose grams each have one posting) is found identically
  assert.ok(all.runs.some((r) => r.docId === docs[3].docId && r.e - r.s + 1 >= 30));
  assert.ok(capped.runs.some((r) => r.docId === docs[3].docId && r.e - r.s + 1 >= 30));
  // the common sentence (held by 10 articles) is enumerated without a cap and counted as a common region with one
  const common = all.runs.filter((r) => r.s === 90 && r.e === 96);
  assert.equal(new Set(common.map((r) => r.docId)).size, 10);
  assert.ok(capped.commonRegions.some((c) => c.s === 90 && c.e === 96 && c.minHolders === 10));
  assert.ok(!capped.runs.some((r) => r.s === 90 && r.e === 96));
  for (const r of capped.runs) assert.ok(all.runs.some((x) => key(x) === key(r)));
});

test('repeated text inside an article and a passage two articles share are all reported, positions exact', () => {
  const shared = tokensForScoringNormalization(inventedText(999, 40), 2);
  const found = findSixwordRuns(index, [...tokensForScoringNormalization(inventedText(4242, 20), 2), ...shared]);
  const holders = new Set(found.runs.filter((r) => r.s === 20 && r.e - r.s + 1 >= 40).map((r) => r.docId));
  assert.deepEqual([...holders].sort(), [docs[5].docId, docs[6].docId]);
  const rep = tokensForScoringNormalization(inventedText(777, 12), 2);
  const inSeven = findSixwordRuns(index, rep).runs.filter((r) => r.docId === docs[7].docId);
  assert.equal(inSeven.length, 2);
  assert.notEqual(inSeven[0].p, inSeven[1].p);
});

test('a takedown (tombstone) removes the article from every lookup; clearing it restores the answer', () => {
  const words = tokensForScoringNormalization(inventedText(999, 40), 2);
  index.setTombstones([docs[5].docId]);
  assert.deepEqual([...new Set(findSixwordRuns(index, words).runs.map((r) => r.docId))], [docs[6].docId]);
  index.setTombstones([]);
  assert.equal(new Set(findSixwordRuns(index, words).runs.map((r) => r.docId)).size, 2);
});

test('refuses a token store that changed after the build', () => {
  index.close();
  const copy = path.join(scratch, 'six-copy');
  fs.cpSync(indexDir, copy, { recursive: true });
  const id = JSON.parse(fs.readFileSync(path.join(copy, 'identity.json'), 'utf8'));
  id.laneTokens.tokensBinBytes += 1;
  fs.writeFileSync(path.join(copy, 'identity.json'), JSON.stringify(id));
  assert.throws(() => SixwordIndex.open(copy), /changed size/);
  id.laneTokens.tokensBinBytes -= 1; id.laneTokens.indexJsonSha256 = '0'.repeat(64);
  fs.writeFileSync(path.join(copy, 'identity.json'), JSON.stringify(id));
  assert.throws(() => SixwordIndex.open(copy), /index.json changed/);
});

test('evidence: every holder of a shared sequence is listed, shared text is never eligible, scoring is off by default', async () => {
  const { sixwordMatches, shortEligibility, isSixwordShortScoringEnabled, P15_STRICT, sixwordClusters } = await import('../lib/asjp-sixword-evidence.ts');
  const { tokenSpans } = await import('../lib/similarity-core.ts');
  const idx = SixwordIndex.open(indexDir);
  const text = `${inventedText(4242, 30)} ${inventedText(999, 18)} ${inventedText(4243, 30)} ${tokensForScoringNormalization(docs[9].text, 2).slice(40, 57).join(' ')} ${inventedText(4244, 30)}`;
  const words = tokensForScoringNormalization(text, 2);
  const matches = sixwordMatches(idx, words, findSixwordRuns(idx, words), { original: text, spans: tokenSpans(text, 2), wordDf: { documents: 40, df: {} } });
  const shared = matches.find((m) => m.s === 30);
  assert.equal(shared.holderCount, 2);
  assert.deepEqual(shared.holders.map((h) => h.docId).sort(), [docs[5].docId, docs[6].docId]);
  assert.equal(shared.commonness, 'SHARED');
  assert.match(shortEligibility(shared, P15_STRICT).reason, /origin not established/);
  const unique = matches.find((m) => m.s === 78);
  assert.equal(unique.holderCount, 1);
  assert.equal(unique.words, 17);
  assert.deepEqual(idx.readTokens(unique.holders[0].ord, unique.holders[0].p, unique.holders[0].q + 1), words.slice(78, 95));
  assert.equal(shortEligibility(unique, P15_STRICT).eligible, true);
  assert.equal(isSixwordShortScoringEnabled({}), false);
  assert.equal(isSixwordShortScoringEnabled({ ASJP_SIXWORD_SHORT_SCORING_ENABLED: 'true' }), true);
  assert.deepEqual(sixwordClusters(matches), []);
  idx.close();
});

test('evidence: an ineligible holder (gate) is never scored; an all-eligible gate changes nothing', async () => {
  const { sixwordMatches, shortEligibility, applyHolderGates, P15_STRICT } = await import('../lib/asjp-sixword-evidence.ts');
  const { tokenSpans } = await import('../lib/similarity-core.ts');
  const idx = SixwordIndex.open(indexDir);
  const text = `${inventedText(4245, 30)} ${tokensForScoringNormalization(docs[9].text, 2).slice(40, 57).join(' ')} ${inventedText(4246, 30)}`;
  const words = tokensForScoringNormalization(text, 2);
  const make = () => sixwordMatches(idx, words, findSixwordRuns(idx, words), { original: text, spans: tokenSpans(text, 2), wordDf: { documents: 40, df: {} } });
  const open = applyHolderGates(make(), () => ({ eligible: true, reason: null }));
  const unique = open.find((m) => m.s === 30);
  assert.equal(shortEligibility(unique, P15_STRICT).eligible, true);
  const later = applyHolderGates(make(), () => ({ eligible: false, reason: 'PUBLISHED_AFTER_REFERENCE_DATE' })).find((m) => m.s === 30);
  assert.deepEqual(shortEligibility(later, P15_STRICT), { eligible: false, reason: 'holder not eligible: PUBLISHED_AFTER_REFERENCE_DATE' });
  assert.equal(later.holderCount, 1);
  idx.close();
});
