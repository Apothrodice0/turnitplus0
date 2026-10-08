import { fork } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createClient, type Client } from "@libsql/client";
import { computeQueryFingerprints } from "../../lib/corpus-engine/fingerprints";
import { fingerprintToHex } from "../../lib/corpus-engine/ids";
import { retrieveCandidates } from "../../lib/corpus-engine/retrieval";
import type { CorpusGenerationReader } from "../../lib/corpus-engine/reader";
import type { DictionaryHit, SegmentReader } from "../../lib/corpus-engine/segment";
import { openGeneration, type BenchmarkQuery } from "./benchmark-common";
import { logLine, mean, parseArguments, percentile, readJson, requireArgument, round, writeJson } from "./common";

/**
 * ONE time-boxed comparison with a mature existing index: SQLite (libSQL),
 * which this project already ships, used two ways.
 *
 *   A. a clustered B-tree  postings(fp BLOB(8), doc INTEGER) WITHOUT ROWID
 *      — the textbook relational inverted index;
 *   B. FTS5 with each fingerprint as an exact term (detail=none)
 *      — a real search-engine posting store.
 *
 *   spike-reference-engine.ts --root R --generation G --queries queries.json --work D:\...\spike --out spike.json [--fts5]
 *
 * The question is only: can it represent the workload, how large is it, how
 * hard is it to build, how fast does it answer, and does it return the same
 * candidates. It loads the SAME postings the engine holds (read back out of
 * the generation's segments), so any difference is the store, not the data.
 * This is not a technology contest and nothing here is wired into anything.
 */

const INSERT_ROWS = 800;
const TRANSACTION_ROWS = 80_000;
const IN_CHUNK = 400;

type PostingsEntry = { fingerprint: bigint; documents: number[] };

/** One segment's (fingerprint, documents) in key order; documents are numbered from `base`. */
async function* segmentPostings(segment: SegmentReader, base: number): AsyncGenerator<PostingsEntry> {
  let batch: DictionaryHit[] = [];
  const flush = async (): Promise<PostingsEntry[]> => {
    const lists = await segment.readPostings(batch);
    const entries = batch.map((hit, index) => ({ fingerprint: hit.fingerprint, documents: Array.from(lists[index], (ordinal) => base + ordinal) }));
    batch = [];
    return entries;
  };
  for await (const hit of segment.iterateDictionary()) {
    batch.push(hit);
    if (batch.length >= 4096) yield* await flush();
  }
  if (batch.length > 0) yield* await flush();
}

/**
 * Every (fingerprint, documents) of the generation in ascending fingerprint
 * order, merged across its segments as a stream — the index is never held in
 * memory, so this works at any corpus size.
 */
async function* mergedPostings(reader: CorpusGenerationReader): AsyncGenerator<PostingsEntry> {
  const cursors: Array<{ iterator: AsyncGenerator<PostingsEntry>; current: PostingsEntry }> = [];
  let base = 0;
  for (const slot of reader.slots) {
    if (!slot.reader) throw new Error(`segment ${slot.segmentId} unavailable`);
    const iterator = segmentPostings(slot.reader, base);
    const first = await iterator.next();
    if (!first.done) cursors.push({ iterator, current: first.value });
    base += slot.reader.documentCount;
  }
  while (cursors.length > 0) {
    let lowest = cursors[0].current.fingerprint;
    for (const cursor of cursors) if (cursor.current.fingerprint < lowest) lowest = cursor.current.fingerprint;
    const documents: number[] = [];
    for (let index = cursors.length - 1; index >= 0; index -= 1) {
      const cursor = cursors[index];
      if (cursor.current.fingerprint !== lowest) continue;
      for (const document of cursor.current.documents) documents.push(document);
      const next = await cursor.iterator.next();
      if (next.done) cursors.splice(index, 1);
      else cursor.current = next.value;
    }
    yield { fingerprint: lowest, documents: documents.sort((left, right) => left - right) };
  }
}

function databaseBytes(file: string) {
  return [file, `${file}-wal`, `${file}-shm`].reduce((total, candidate) => total + (existsSync(candidate) ? statSync(candidate).size : 0), 0);
}

async function buildBtree(file: string, postings: AsyncIterable<PostingsEntry> | Iterable<PostingsEntry>): Promise<{ client: Client; buildMs: number; rows: number; fingerprints: number }> {
  const client = createClient({ url: `file:${file.replace(/\\/g, "/")}` });
  const started = performance.now();
  await client.execute("PRAGMA journal_mode = OFF");
  await client.execute("PRAGMA synchronous = OFF");
  await client.execute("CREATE TABLE postings (fp BLOB NOT NULL, doc INTEGER NOT NULL, PRIMARY KEY (fp, doc)) WITHOUT ROWID");
  let rows = 0;
  let fingerprints = 0;
  let values: string[] = [];
  let statements: string[] = [];
  let inTransaction = 0;
  const flushStatements = async () => {
    if (values.length > 0) {
      statements.push(`INSERT INTO postings (fp, doc) VALUES ${values.join(",")};`);
      values = [];
    }
    if (statements.length > 0) {
      await client.executeMultiple(`BEGIN;\n${statements.join("\n")}\nCOMMIT;`);
      statements = [];
      inTransaction = 0;
    }
  };
  for await (const entry of postings) {
    fingerprints += 1;
    const hex = fingerprintToHex(entry.fingerprint);
    for (const document of entry.documents) {
      values.push(`(X'${hex}',${document})`);
      rows += 1;
      inTransaction += 1;
      if (values.length >= INSERT_ROWS) {
        statements.push(`INSERT INTO postings (fp, doc) VALUES ${values.join(",")};`);
        values = [];
      }
      if (inTransaction >= TRANSACTION_ROWS) await flushStatements();
    }
  }
  await flushStatements();
  return { client, buildMs: performance.now() - started, rows, fingerprints };
}

async function buildFts(file: string, postings: PostingsEntry[], documentCount: number): Promise<{ client: Client; buildMs: number }> {
  // FTS5 indexes documents, so the postings are inverted back into one term list per document.
  const terms: string[][] = Array.from({ length: documentCount }, () => []);
  for (const entry of postings) {
    const hex = fingerprintToHex(entry.fingerprint);
    for (const document of entry.documents) terms[document].push(hex);
  }
  const client = createClient({ url: `file:${file.replace(/\\/g, "/")}` });
  const started = performance.now();
  await client.execute("PRAGMA journal_mode = OFF");
  await client.execute("PRAGMA synchronous = OFF");
  await client.execute("CREATE VIRTUAL TABLE fingerprints USING fts5(terms, content='', detail=none, columnsize=0)");
  let statements: string[] = [];
  for (let document = 0; document < documentCount; document += 1) {
    statements.push(`INSERT INTO fingerprints (rowid, terms) VALUES (${document + 1}, '${terms[document].join(" ")}');`);
    if (statements.length >= 200) {
      await client.executeMultiple(`BEGIN;\n${statements.join("\n")}\nCOMMIT;`);
      statements = [];
    }
  }
  if (statements.length > 0) await client.executeMultiple(`BEGIN;\n${statements.join("\n")}\nCOMMIT;`);
  await client.execute("INSERT INTO fingerprints (fingerprints) VALUES ('optimize')");
  return { client, buildMs: performance.now() - started };
}

async function btreeCandidates(client: Client, hexes: string[]): Promise<Map<number, number>> {
  const hits = new Map<number, number>();
  for (let start = 0; start < hexes.length; start += IN_CHUNK) {
    const chunk = hexes.slice(start, start + IN_CHUNK);
    const result = await client.execute(`SELECT doc, COUNT(*) AS hits FROM postings WHERE fp IN (${chunk.map((hex) => `X'${hex}'`).join(",")}) GROUP BY doc`);
    for (const row of result.rows) hits.set(Number(row.doc), (hits.get(Number(row.doc)) ?? 0) + Number(row.hits));
  }
  return hits;
}

async function ftsCandidates(client: Client, hexes: string[]): Promise<Set<number>> {
  const documents = new Set<number>();
  for (let start = 0; start < hexes.length; start += 200) {
    const result = await client.execute({ sql: "SELECT rowid FROM fingerprints WHERE fingerprints MATCH ?", args: [hexes.slice(start, start + 200).join(" OR ")] });
    for (const row of result.rows) documents.add(Number(row.rowid) - 1);
  }
  return documents;
}

type ColdReply = { kind: string; openMs: number; lookupMs: number[]; rssBytes: number };

/** A fresh process: open one store, answer every query once. Its own caches start empty; the OS file cache is whatever it is. */
async function coldChild(args: Record<string, string>) {
  const kind = args["cold-child"];
  const { queries } = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries"));
  const lookupMs: number[] = [];
  const opening = performance.now();
  if (kind === "btree") {
    const client = createClient({ url: `file:${path.join(requireArgument(args, "work"), "btree.db").replace(/\\/g, "/")}` });
    await client.execute("SELECT 1");
    const openMs = performance.now() - opening;
    for (const query of queries) {
      const hexes = computeQueryFingerprints(query.text, 200).fingerprints.map((fingerprint) => fingerprint.hex);
      const started = performance.now();
      await btreeCandidates(client, hexes);
      lookupMs.push(performance.now() - started);
    }
    client.close();
    process.send?.({ kind, openMs, lookupMs, rssBytes: process.resourceUsage().maxRSS * 1024 } satisfies ColdReply);
    return;
  }
  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"), kind === "engine-resident" ? { dictionaryBlockCacheBlocks: 1 << 30 } : {});
  const openMs = performance.now() - opening;
  for (const query of queries) {
    const retrieval = await retrieveCandidates(reader, query.text, { candidateBudget: 100_000_000, regionAware: false });
    lookupMs.push(retrieval.stats.timingsMs.total - retrieval.stats.timingsMs.fingerprint);
  }
  await store.close();
  process.send?.({ kind, openMs, lookupMs, rssBytes: process.resourceUsage().maxRSS * 1024 } satisfies ColdReply);
}

function runCold(kind: string): Promise<ColdReply> {
  return new Promise((resolve, reject) => {
    const child = fork(process.argv[1], [...process.argv.slice(2), "--cold-child", kind], { execArgv: process.execArgv });
    let reply: ColdReply | null = null;
    child.on("message", (value) => {
      reply = value as ColdReply;
    });
    child.on("exit", (code) => (reply ? resolve(reply) : reject(new Error(`cold ${kind} run exited with code ${code} and no result`))));
    child.on("error", reject);
  });
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args["cold-child"]) return coldChild(args);
  const work = requireArgument(args, "work");
  const withFts = args.fts5 === "true";
  const { queries } = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries"));
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"));
  const identity = reader.identity();
  const documentCount = reader.slots.reduce((total, slot) => total + (slot.reader?.documentCount ?? 0), 0);

  const btreeFile = path.join(work, "btree.db");
  // FTS5 indexes documents, so it needs every posting inverted in memory first; that is only affordable on a small corpus.
  const held: PostingsEntry[] = [];
  if (withFts) for await (const entry of mergedPostings(reader)) held.push(entry);
  const btree = await buildBtree(btreeFile, withFts ? held : mergedPostings(reader));
  const rowCount = btree.rows;
  logLine(`B-tree: ${btree.fingerprints} fingerprints / ${rowCount} postings for ${documentCount} documents built in ${round(btree.buildMs / 1000)} s, ${databaseBytes(btreeFile)} bytes (build peak RSS ${round((process.resourceUsage().maxRSS * 1024) / 2 ** 20)} MiB)`);
  const buildPeakRssBytes = process.resourceUsage().maxRSS * 1024;
  const ftsFile = path.join(work, "fts5.db");
  const fts = withFts ? await buildFts(ftsFile, held, documentCount) : null;
  if (fts) logLine(`FTS5: built in ${round(fts.buildMs / 1000)} s, ${databaseBytes(ftsFile)} bytes`);
  held.length = 0;

  // The engine's own answer to the same question: every touched document with its hit count.
  const bases: number[] = [];
  let base = 0;
  for (const slot of reader.slots) {
    bases.push(base);
    base += slot.reader?.documentCount ?? 0;
  }
  const slotIndexOf = new Map(reader.slots.map((slot, index) => [slot.segmentId, index]));
  const rows: Array<Record<string, unknown>> = [];
  const timings = { engine: [] as number[], engineResident: [] as number[], btree: [] as number[], fts: [] as number[] };
  // The same reader with no limit on decoded dictionary blocks: after the warming pass every block a query needs is in memory.
  const resident = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"), { dictionaryBlockCacheBlocks: 1 << 30 });
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      for (const query of queries) {
        const hexes = computeQueryFingerprints(query.text, 200).fingerprints.map((fingerprint) => fingerprint.hex);
        const engineStarted = performance.now();
        const engine = await retrieveCandidates(reader, query.text, { candidateBudget: 100_000_000, regionAware: false });
        const engineMs = performance.now() - engineStarted - engine.stats.timingsMs.fingerprint;
        const residentRun = await retrieveCandidates(resident.reader, query.text, { candidateBudget: 100_000_000, regionAware: false });
        const residentMs = residentRun.stats.timingsMs.total - residentRun.stats.timingsMs.fingerprint;
        const btreeStarted = performance.now();
        const fromBtree = await btreeCandidates(btree.client, hexes);
        const btreeMs = performance.now() - btreeStarted;
        const ftsStarted = performance.now();
        const fromFts = fts ? await ftsCandidates(fts.client, hexes) : null;
        const ftsMs = performance.now() - ftsStarted;
        if (pass === 0) continue; // first pass warms all of them
        timings.engine.push(engineMs);
        timings.engineResident.push(residentMs);
        timings.btree.push(btreeMs);
        if (fts) timings.fts.push(ftsMs);
        const engineHits = new Map<number, number>();
        for (const candidate of engine.candidates) engineHits.set(bases[slotIndexOf.get(candidate.segmentId) as number] + candidate.ordinal, candidate.fingerprintHits);
        let btreeSame = engineHits.size === fromBtree.size;
        for (const [document, hits] of engineHits) if (fromBtree.get(document) !== hits) btreeSame = false;
        let ftsSame: boolean | null = null;
        if (fromFts) {
          ftsSame = engineHits.size === fromFts.size;
          for (const document of engineHits.keys()) if (!fromFts.has(document)) ftsSame = false;
        }
        rows.push({ queryId: query.id, fingerprints: hexes.length, touchedDocuments: engineHits.size, btreeIdenticalDocumentsAndHitCounts: btreeSame, ftsIdenticalDocumentSet: ftsSame, engineMs: round(engineMs, 3), btreeMs: round(btreeMs, 3), ftsMs: fts ? round(ftsMs, 3) : null });
      }
    }
  } finally {
    await store.close();
    await resident.store.close();
  }
  btree.client.close();
  fts?.client.close();

  const cold = [await runCold("engine"), await runCold("engine-resident"), await runCold("btree")];

  const engineIndexBytes = Object.keys(reader.manifest.segments).reduce((total, segmentId) => {
    const directory = path.join(requireArgument(args, "root"), "segments", segmentId);
    return total + ["dict.bin", "dict.idx", "postings.bin", "docs.bin"].reduce((sum, file) => sum + statSync(path.join(directory, file)).size, 0);
  }, 0);
  const summarize = (values: number[]) => ({ p50: round(percentile(values, 0.5), 3), p95: round(percentile(values, 0.95), 3), mean: round(mean(values), 3), max: round(Math.max(...values), 3) });
  const coldOf = (kind: string) => {
    const reply = cold.find((item) => item.kind === kind) as ColdReply;
    return { openMs: round(reply.openMs, 2), firstQueryMs: round(reply.lookupMs[0], 3), lookupMs: summarize(reply.lookupMs), peakRssBytes: reply.rssBytes };
  };
  const report = {
    identity,
    documents: documentCount,
    activeSegments: reader.slots.length,
    distinctFingerprints: btree.fingerprints,
    postings: rowCount,
    engine: { indexBytes: engineIndexBytes, bytesPerPosting: round(engineIndexBytes / rowCount, 2), candidateLookupMs: summarize(timings.engine), candidateLookupMsWithUnboundedBlockCache: summarize(timings.engineResident), cold: coldOf("engine"), coldWithUnboundedBlockCache: coldOf("engine-resident"), note: "dict.bin + dict.idx + postings.bin + docs.bin; lookup + accumulation only, fingerprinting excluded; cold = a fresh process answering every query once" },
    sqliteBtree: { indexBytes: databaseBytes(btreeFile), bytesPerPosting: round(databaseBytes(btreeFile) / rowCount, 2), buildSeconds: round(btree.buildMs / 1000), buildPeakRssBytes, candidateLookupMs: summarize(timings.btree), cold: coldOf("btree"), identicalDocumentsAndHitCounts: rows.every((row) => row.btreeIdenticalDocumentsAndHitCounts) },
    sqliteFts5: fts
      ? { indexBytes: databaseBytes(ftsFile), bytesPerPosting: round(databaseBytes(ftsFile) / rowCount, 2), buildSeconds: round(fts.buildMs / 1000), candidateLookupMs: summarize(timings.fts), identicalDocumentSet: rows.every((row) => row.ftsIdenticalDocumentSet), note: "document set only: FTS5 does not return how many OR terms a document matched" }
      : { skipped: "not requested (--fts5): it cannot return hit counts, and building it needs every posting inverted in memory" },
    perQuery: rows,
  };
  writeJson(requireArgument(args, "out"), report);
  logLine(`engine   ${engineIndexBytes} bytes (${report.engine.bytesPerPosting} B/posting)  warm lookup p50 ${report.engine.candidateLookupMs.p50} ms  p95 ${report.engine.candidateLookupMs.p95} ms (blocks resident: ${report.engine.candidateLookupMsWithUnboundedBlockCache.p50} / ${report.engine.candidateLookupMsWithUnboundedBlockCache.p95}) | cold p50 ${report.engine.cold.lookupMs.p50} p95 ${report.engine.cold.lookupMs.p95} first ${report.engine.cold.firstQueryMs} RSS ${round(report.engine.cold.peakRssBytes / 2 ** 20)} MiB`);
  logLine(`B-tree   ${report.sqliteBtree.indexBytes} bytes (${report.sqliteBtree.bytesPerPosting} B/posting)  warm lookup p50 ${report.sqliteBtree.candidateLookupMs.p50} ms  p95 ${report.sqliteBtree.candidateLookupMs.p95} ms | cold p50 ${report.sqliteBtree.cold.lookupMs.p50} p95 ${report.sqliteBtree.cold.lookupMs.p95} first ${report.sqliteBtree.cold.firstQueryMs} RSS ${round(report.sqliteBtree.cold.peakRssBytes / 2 ** 20)} MiB  identical=${report.sqliteBtree.identicalDocumentsAndHitCounts}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
