import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";

const root = new URL("../", import.meta.url);
const metadata = JSON.parse(readFileSync(new URL("public/data/document-index.meta.json", root), "utf8"));
const canonical = JSON.parse(
  gunzipSync(readFileSync(new URL("public/data/document-index.json.gz", root))).toString("utf8"),
);

function packedArray(asset) {
  const bytes = readFileSync(new URL(`public/data/${asset}`, root));
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Uint32Array.BYTES_PER_ELEMENT);
}

test("packed browser index matches canonical calibration index", () => {
  assert.equal(metadata.schema, "tplus-packed-search-index");
  assert.equal(metadata.version, 1);
  assert.equal(metadata.corpusVersion, canonical.corpusVersion);
  assert.equal(metadata.documentCount, canonical.documentCount);

  const hashes = packedArray(metadata.assets.hashes);
  const offsets = packedArray(metadata.assets.offsets);
  const postings = packedArray(metadata.assets.postings);
  assert.equal(hashes.length, metadata.keyCount * 2);
  assert.equal(offsets.length, metadata.keyCount + 1);
  assert.equal(postings.length, metadata.postingCount);
  assert.equal(offsets[offsets.length - 1], postings.length);

  const entries = Object.entries(canonical.invertedIndex).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  );
  assert.equal(entries.length, metadata.keyCount);
  const sampleStep = Math.max(1, Math.floor(entries.length / 257));
  for (let index = 0; index < entries.length; index += sampleStep) {
    const [hash, expectedPostings] = entries[index];
    assert.equal(hashes[index * 2], Number.parseInt(hash.slice(0, 8), 16) >>> 0);
    assert.equal(hashes[index * 2 + 1], Number.parseInt(hash.slice(8), 16) >>> 0);
    assert.deepEqual(
      [...postings.subarray(offsets[index], offsets[index + 1])],
      expectedPostings,
    );
  }
});
