import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { applyMigrationsLibsql } from "../lib/ingest.js";
import { loadArchiveSourceEntries, seedArchiveCorpus } from "../lib/archive-corpus-seed.ts";
import { matchAgainstArchiveCorpus } from "../lib/archive-corpus-matching.ts";
import { scoreAgainstArchive } from "../lib/archive-similarity-scoring.ts";

const corpusRoot = path.resolve("corpus");
const metaPath = path.resolve("public/data/document-index.meta.json");
const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
console.log(`real archive: ${meta.documentCount} documents, corpusVersion=${meta.corpusVersion}, maximumDocumentFrequency=${meta.maximumDocumentFrequency}`);

function indexPostings(search, hash) {
  const first = Number.parseInt(hash.slice(0, 8), 16) >>> 0;
  const second = Number.parseInt(hash.slice(8, 16), 16) >>> 0;
  let low = 0;
  let high = search.keyCount - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const middleFirst = search.hashes[middle * 2];
    const middleSecond = search.hashes[middle * 2 + 1];
    if (middleFirst === first && middleSecond === second) {
      return search.postings.subarray(search.offsets[middle], search.offsets[middle + 1]);
    }
    if (middleFirst < first || (middleFirst === first && middleSecond < second)) low = middle + 1;
    else high = middle - 1;
  }
  return new Uint32Array(0);
}

const hashes = new Uint32Array(fs.readFileSync(path.resolve(`public/data/${meta.assets?.hashes ?? "document-index.hashes." + meta.corpusVersion + ".bin"}`)).buffer);
const offsets = new Uint32Array(fs.readFileSync(path.resolve(`public/data/${meta.assets?.offsets ?? "document-index.offsets." + meta.corpusVersion + ".bin"}`)).buffer);
const postings = new Uint32Array(fs.readFileSync(path.resolve(`public/data/${meta.assets?.postings ?? "document-index.postings." + meta.corpusVersion + ".bin"}`)).buffer);
const search = { ...meta, hashes, offsets, postings, keyCount: hashes.length / 2 };

const realIndex = {
  shingleSize: meta.shingleSize,
  documentCount: meta.documentCount,
  maximumDocumentFrequency: meta.maximumDocumentFrequency,
  articles: meta.articles,
  getPostings: (hash) => indexPostings(search, hash),
};

const risk = JSON.parse(fs.readFileSync(path.resolve("public/data/risk-calibration.json"), "utf8"));
console.log("matchingParameters:", JSON.stringify(risk.matchingParameters));

// Seed the real 321-document archive into a fresh disposable DB.
const dbFile = path.resolve("real_archive_validation.db");
for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  const p = `${dbFile}${suffix}`;
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
const client = createClient({ url: `file:${dbFile}` });
await client.execute("PRAGMA foreign_keys = ON");
await applyMigrationsLibsql(client, "drizzle");

const entries = loadArchiveSourceEntries(corpusRoot, metaPath);
console.log(`loaded ${entries.length} source entries from corpus/manifest.json (expect ${meta.documentCount})`);
const withOrder = entries.filter((e) => e.archiveOrder !== undefined).length;
console.log(`entries with a resolved archiveOrder: ${withOrder}/${entries.length}`);

const startSeed = Date.now();
const results = await seedArchiveCorpus(client, entries, { corpusVersion: meta.corpusVersion, firstSeenAt: risk.generatedAt.replace("T", " ").slice(0, 19) });
console.log(`seeded ${results.length} documents in ${Date.now() - startSeed}ms (statuses: ${JSON.stringify(results.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {}))})`);

// Pick a handful of REAL excerpts as submissions: verbatim middle chunks of
// a few real archive documents, embedded in unrelated framing text, plus
// one boilerplate-adjacent case.
function excerptFromArticle(articleIndex, wordStart, wordCount) {
  // We don't have raw text for articles keyed only by the packed index, so
  // pull from the same manifest-loaded entries by matching id.
  const id = meta.articles[articleIndex].id;
  const entry = entries.find((e) => e.archiveArticleId === id);
  if (!entry) return null;
  const words = entry.text.split(/\s+/).filter(Boolean);
  return words.slice(wordStart, wordStart + wordCount).join(" ");
}

const asOf = new Date(Date.now() + 30 * 24 * 3600 * 1000); // safely past every real document's true maturity
const cases = [];
for (const articleIndex of [0, 10, 50, 150, 300]) {
  const excerpt = excerptFromArticle(articleIndex, 40, 80);
  if (!excerpt) continue;
  cases.push({
    label: `embedded excerpt from article #${articleIndex} (${meta.articles[articleIndex].title})`,
    text: `An unrelated framing sentence about a different subject precedes this excerpt entirely. ${excerpt} A separate, unrelated closing remark about another matter follows this excerpt today.`,
  });
}

let mismatches = 0;
for (const testCase of cases) {
  const reference = scoreAgainstArchive(testCase.text, realIndex, risk.matchingParameters);
  const startDb = Date.now();
  const dbResult = await matchAgainstArchiveCorpus(client, testCase.text, {
    maximumDocumentFrequency: meta.maximumDocumentFrequency,
    matchingParameters: risk.matchingParameters,
    asOf,
  });
  const dbMs = Date.now() - startDb;
  const normalize = (s) => s.map((x) => ({ name: x.name, matches: x.matches, matchedWords: x.matchedWords, percent: x.percent })).sort((a, b) => a.name.localeCompare(b.name));
  const refSources = JSON.stringify(normalize(reference.sources));
  const dbSources = JSON.stringify(normalize(dbResult.sources));
  const ok = reference.score === dbResult.score
    && JSON.stringify(reference.archiveMatchedPositions) === JSON.stringify(dbResult.archiveMatchedPositions)
    && refSources === dbSources;
  if (!ok) mismatches += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${testCase.label} | ref score=${reference.score} db score=${dbResult.score} | ref matched=${reference.matchedWordCount} db matched=${dbResult.matchedWordCount} | db latency=${dbMs}ms`);
  if (!ok) {
    console.log("  reference sources:", refSources);
    console.log("  db sources:       ", dbSources);
    console.log("  reference positions:", reference.archiveMatchedPositions);
    console.log("  db positions:       ", dbResult.archiveMatchedPositions);
  }
}

console.log(`\n${cases.length - mismatches}/${cases.length} real-archive cases matched exactly.`);
client.close();
