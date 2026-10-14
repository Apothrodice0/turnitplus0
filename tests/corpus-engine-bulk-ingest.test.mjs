import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { corpusEngineScratch, inventedText, removeScratch } from './helpers/corpus-engine-fixtures.mjs';
import { runCorpusBuild } from '../lib/corpus-engine/builder.ts';
import { BuildLedger, newBuildStartRecord } from '../lib/corpus-engine/ledger.ts';
import { BUNDLE_EXTRACTORS, JsonLinesBundleSourceAdapter } from '../lib/corpus-engine/source-adapter.ts';

/**
 * Corpus Engine v1 — what the 100k checkpoint added to ingestion: the
 * streamed JSON-lines bundle adapter with its named text extractors, and a
 * build ledger that is replayed as a stream instead of being read whole.
 */

const scratch = corpusEngineScratch('bulk');

const row = (externalId, raw, extraction = 'utf8-text-v1', extra = {}) => JSON.stringify({
  provider: 'bundle-provider', dataset: 'bundle-set', datasetVersion: 'v1', externalId, canonicalUrl: `https://example.test/${externalId}`, title: `Title ${externalId}`,
  authors: null, publishedDate: null, sourceType: 'test-article', language: 'en',
  rights: { license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', usage: 'test', attribution: 'test' },
  provenance: { acquisitionSource: 'unit-test', retrievedAt: null, sourceVersion: 'r1', notes: null },
  extraction, raw, ...extra,
});
const writeBundle = (name, rows) => {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, `${rows.join('\n')}\n`);
  return file;
};
const collect = async (adapter) => {
  const documents = [];
  for await (const document of adapter.documents()) documents.push(document);
  return documents;
};

const pmcRaw = (body) => [
  '', 'JOURNAL INFORMATION', '==============================', 'Journal ID: test', '',
  'ARTICLE INFORMATION', '==============================', 'PMCID: PMC1', 'License: CC BY', 'License URL: https://creativecommons.org/licenses/by/4.0/', '',
  '\u009f==============================\u009f', body,
].join('\n');

test('bundle adapter: rows become source documents; the provider bytes are kept verbatim and the named extractor makes the text', async () => {
  const body = inventedText(1, 300);
  const bundle = writeBundle('mixed.jsonl', [
    row('a-plain', inventedText(2, 200)),
    row('b-pmc', pmcRaw(body), 'pmc-oa-txt-body-v1'),
    row('c-fr', '<NOTICE><PREAMB><AGENCY TYPE="S">DEPARTMENT OF TESTING</AGENCY><SUBJECT>Notice &amp; Comment</SUBJECT><P>First paragraph &#x201C;quoted&#x201D;.</P><P>Second&lt;2&gt; paragraph.</P></PREAMB><FRDOC>[FR Doc. 2024-1 Filed]</FRDOC></NOTICE>', 'govinfo-fr-xml-text-v1'),
  ]);
  const documents = await collect(new JsonLinesBundleSourceAdapter(bundle));
  assert.deepEqual(documents.map((document) => document.externalId), ['a-plain', 'b-pmc', 'c-fr']);
  assert.equal(documents[0].text, documents[0].rawContent.toString('utf8'));
  assert.equal(documents[1].text, body, 'the PMC header blocks are not part of the text');
  assert.equal(documents[1].rawContent.toString('utf8'), pmcRaw(body), 'the raw content is exactly what the provider supplied');
  assert.equal(documents[1].extractionVersion, 'pmc-oa-txt-body-v1');
  assert.equal(documents[2].text, 'DEPARTMENT OF TESTING\nNotice & Comment\nFirst paragraph “quoted”.\nSecond<2> paragraph.\n[FR Doc. 2024-1 Filed]');
  assert.equal(documents[2].rights.license, 'CC BY 4.0');
  assert.equal(documents[2].authors, null, 'a field the row does not supply stays null');
  assert.equal(documents[2].syntheticLoadOnly, false);
});

test('bundle adapter: an unordered bundle, a repeated id, an unknown extractor and an unextractable row are refused', async () => {
  await assert.rejects(collect(new JsonLinesBundleSourceAdapter(writeBundle('unordered.jsonl', [row('b', 'x y z'), row('a', 'x y z')]))), /not strictly ascending/);
  await assert.rejects(collect(new JsonLinesBundleSourceAdapter(writeBundle('repeated.jsonl', [row('a', 'x y z'), row('a', 'x y z')]))), /not strictly ascending/);
  await assert.rejects(collect(new JsonLinesBundleSourceAdapter(writeBundle('unknown.jsonl', [row('a', 'x y z', 'made-up-extractor')]))), /unknown extraction/);
  await assert.rejects(collect(new JsonLinesBundleSourceAdapter(writeBundle('layout.jsonl', [row('a', 'no header rules at all', 'pmc-oa-txt-body-v1')]))), /could not be extracted/);
  assert.equal(BUNDLE_EXTRACTORS['pmc-oa-txt-body-v1']('only\n==============================\none rule'), null);
});

test('bundle adapter: a build from a bundle equals a build from the same documents supplied in memory', async () => {
  const texts = Array.from({ length: 12 }, (_, index) => inventedText(50 + index, 240 + index * 20));
  const bundle = writeBundle('build.jsonl', texts.map((text, index) => row(`doc-${String(index).padStart(2, '0')}`, text)));
  const fromBundle = await runCorpusBuild({ corpusRoot: path.join(scratch, 'root-bundle'), buildId: 'b', parentGenerationId: null, partitionBits: 1, runBufferTuples: 400 }, [new JsonLinesBundleSourceAdapter(bundle)]);
  const documents = await collect(new JsonLinesBundleSourceAdapter(bundle));
  const fromMemory = await runCorpusBuild({ corpusRoot: path.join(scratch, 'root-memory'), buildId: 'another-name', parentGenerationId: null, partitionBits: 1, runBufferTuples: 5000 }, [{ adapterId: 'memory', async *documents() { yield* [...documents].reverse(); } }]);
  assert.equal(fromBundle.generationId, fromMemory.generationId);
  assert.equal(fromBundle.counts.newDocuments, 12);
  assert.ok(fromBundle.metrics.ledger.fileBytes > 0 && fromBundle.metrics.ledger.sourceEntries === 12 && fromBundle.metrics.ledger.documentTableEntries === 12);
});

test('ledger: a file larger than one replay chunk, with lines that straddle chunk boundaries, replays to the same state', () => {
  const file = path.join(scratch, 'big-ledger.jsonl');
  const ledger = BuildLedger.open(file);
  ledger.append([newBuildStartRecord({ buildId: 'big', parentGenerationId: null, partitionBits: 1, normalizationProbeSha256: 'n', fingerprintProbeSha256: 'f' })]);
  const expected = [];
  // 60 sources of ~160 KB each in 6 commits: ~9.6 MB, more than two 4 MiB replay chunks.
  for (let commit = 1; commit <= 6; commit += 1) {
    const batch = [];
    for (let index = 0; index < 10; index += 1) {
      const sourceKey = `p\u001fd\u001fsource-${commit}-${index}`;
      const padding = `${commit}-${index}-éا`.repeat(20000);
      batch.push({ type: 'source', sourceKey, state: 'REJECTED_EMPTY', synthetic: index % 2 === 0, rawContentSha256: 'r', tokenCount: 1, alias: { externalId: sourceKey, padding } });
      expected.push({ sourceKey, padding });
    }
    ledger.append([...batch, { type: 'commit', sequence: commit, sourcesCommitted: 10, stagingBytes: commit * 100, runs: [{ partition: 0, file: `c${commit}.run`, tuples: 1, bytes: 16, sha256: 's' }] }]);
  }
  const before = [...ledger.sources.entries()];
  const durableBytes = ledger.byteLength;
  ledger.close();
  assert.ok(fs.statSync(file).size > 8 * 1024 * 1024);

  // a torn tail: source lines with no commit, then half a line
  fs.appendFileSync(file, `${JSON.stringify({ type: 'source', sourceKey: 'p\u001fd\u001funcommitted', state: 'REJECTED_EMPTY', synthetic: false, rawContentSha256: 'r', alias: {} })}\n{"type":"sour`);
  const reopened = BuildLedger.open(file);
  try {
    assert.equal(reopened.commitCount, 6);
    assert.equal(reopened.stagingBytes, 600);
    assert.equal(reopened.runs.length, 6);
    assert.equal(reopened.byteLength, durableBytes);
    assert.ok(reopened.discardedTailBytes > 0);
    assert.equal(fs.statSync(file).size, durableBytes, 'the uncommitted tail is cut off');
    assert.deepEqual([...reopened.sources.entries()], before, 'every source has the same state and the same line position');
    assert.equal(reopened.sources.has('p\u001fd\u001funcommitted'), false);
    for (const item of [expected[0], expected[27], expected[59]]) {
      const record = reopened.readSourceRecord(reopened.sources.get(item.sourceKey));
      assert.equal(record.sourceKey, item.sourceKey);
      assert.equal(record.alias.padding, item.padding, 'the line re-read from its recorded position is the original line');
    }
    assert.equal(reopened.committedSourceRecords.length, 60);
    assert.deepEqual(reopened.committedSourceRecords[0].alias, {}, 'replay keeps no provenance payload in memory');
  } finally {
    reopened.close();
  }
});

test.after(() => removeScratch(scratch));
