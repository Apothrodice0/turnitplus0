import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { gramHash, grams, tokens } from "../lib/similarity-core";
import { loadCorpus } from "./calibration-utils";

const SHINGLE_SIZE = 5;
const documents = loadCorpus("index-source");
const tokenized = documents.map((document) => tokens(document.text));
const postings = new Map<string, number[]>();

tokenized.forEach((words, documentIndex) => {
  new Set(grams(words, SHINGLE_SIZE)).forEach((gram) => {
    const key = gramHash(gram);
    const sourceIndexes = postings.get(key) ?? [];
    sourceIndexes.push(documentIndex);
    postings.set(key, sourceIndexes);
  });
});

const maximumDocumentFrequency = Math.max(2, Math.min(12, Math.ceil(Math.sqrt(Math.max(1, documents.length)))));
const invertedIndex = Object.fromEntries(
  [...postings.entries()].filter(([, sourceIndexes]) => sourceIndexes.length <= maximumDocumentFrequency),
);
const searchableCounts = Array.from({ length: documents.length }, () => 0);
Object.values(invertedIndex).forEach((sourceIndexes) => sourceIndexes.forEach((index) => { searchableCounts[index] += 1; }));
const fingerprint = createHash("sha256").update(
  documents.map((document) => `${document.id}:${document.provenance.sha256}`).sort().join("\n"),
).digest("hex").slice(0, 10);
const corpusVersion = `archive-v4-${documents.length}-${fingerprint}`;
const output = {
  schema: "tplus-search-index",
  version: 3,
  keyEncoding: "fnv1a32-djb2-hex",
  shingleSize: SHINGLE_SIZE,
  documentCount: documents.length,
  totalWords: tokenized.reduce((total, words) => total + words.length, 0),
  corpusVersion,
  maximumDocumentFrequency,
  scoreBands: [
    { label: "Low", minimum: 0, maximum: 5 },
    { label: "Moderate", minimum: 6, maximum: 15 },
    { label: "High", minimum: 16, maximum: 100 },
  ],
  articles: documents.map((document, index) => ({
    id: document.id,
    title: document.title ?? document.id,
    sourceType: "Publication",
    originalSimilarity: document.turnitinScore,
    wordCount: tokenized[index].length,
    uniqueShingleCount: searchableCounts[index],
  })),
  invertedIndex,
};
const serialized = JSON.stringify(output);
mkdirSync("data", { recursive: true });
mkdirSync("public/data", { recursive: true });
writeFileSync("data/document-index.json", serialized);
writeFileSync("public/data/document-index.json.gz", gzipSync(Buffer.from(serialized), { level: 9 }));

// The JSON index remains the canonical, auditable calibration artifact. The
// browser loads a packed representation instead: parsing an object with more
// than a million properties creates a much larger transient heap than the
// compressed file size suggests and can fail on otherwise capable devices.
for (const fileName of readdirSync("public/data")) {
  if (/^document-index\.(?:hashes|offsets|postings)\..+\.bin$/.test(fileName)) {
    rmSync(`public/data/${fileName}`);
  }
}

const sortedEntries = Object.entries(invertedIndex).sort(
  ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
);
const hashes = new Uint32Array(sortedEntries.length * 2);
const offsets = new Uint32Array(sortedEntries.length + 1);
const packedPostings = new Uint32Array(
  sortedEntries.reduce((total, [, sourceIndexes]) => total + sourceIndexes.length, 0),
);
let postingCursor = 0;
sortedEntries.forEach(([hash, sourceIndexes], entryIndex) => {
  hashes[entryIndex * 2] = Number.parseInt(hash.slice(0, 8), 16) >>> 0;
  hashes[entryIndex * 2 + 1] = Number.parseInt(hash.slice(8, 16), 16) >>> 0;
  offsets[entryIndex] = postingCursor;
  packedPostings.set(sourceIndexes, postingCursor);
  postingCursor += sourceIndexes.length;
});
offsets[sortedEntries.length] = postingCursor;

const packedStem = corpusVersion.replace(/[^a-z0-9-]/gi, "-");
const packedAssets = {
  hashes: `document-index.hashes.${packedStem}.bin`,
  offsets: `document-index.offsets.${packedStem}.bin`,
  postings: `document-index.postings.${packedStem}.bin`,
};
writeFileSync(`public/data/${packedAssets.hashes}`, Buffer.from(hashes.buffer));
writeFileSync(`public/data/${packedAssets.offsets}`, Buffer.from(offsets.buffer));
writeFileSync(`public/data/${packedAssets.postings}`, Buffer.from(packedPostings.buffer));
writeFileSync("public/data/document-index.meta.json", JSON.stringify({
  schema: "tplus-packed-search-index",
  version: 1,
  keyEncoding: output.keyEncoding,
  shingleSize: output.shingleSize,
  documentCount: output.documentCount,
  totalWords: output.totalWords,
  corpusVersion: output.corpusVersion,
  maximumDocumentFrequency: output.maximumDocumentFrequency,
  scoreBands: output.scoreBands,
  articles: output.articles,
  keyCount: sortedEntries.length,
  postingCount: packedPostings.length,
  assets: packedAssets,
}));

console.log(
  `${documents.length} index sources · ${sortedEntries.length} searchable shingles · ${corpusVersion}`
  + ` · ${(hashes.byteLength + offsets.byteLength + packedPostings.byteLength).toLocaleString()} packed browser bytes`,
);
