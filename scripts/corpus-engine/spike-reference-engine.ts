import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createClient, type Client } from "@libsql/client";
import { computeQueryFingerprints } from "../../lib/corpus-engine/fingerprints";
import { fingerprintToHex } from "../../lib/corpus-engine/ids";
import { retrieveCandidates } from "../../lib/corpus-engine/retrieval";
import type { DictionaryHit } from "../../lib/corpus-engine/segment";
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
 *   spike-reference-engine.ts --root R --generation G --queries queries.json --work D:\...\spike --out spike.json
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

async function loadPostings(root: string, generationId: string) {
  const { store, reader } = await openGeneration(root, generationId, { dictionaryBlockCacheBlocks: 0 });
  const postings: Array<{ fingerprint: bigint; documents: number[] }> = [];
  const byFingerprint = new Map<bigint, number[]>();
  let base = 0;
  const bases: number[] = [];
  try {
    for (const slot of reader.slots) {
      if (!slot.reader) throw new Error(`segment ${slot.segmentId} unavailable`);
      bases.push(base);
      let batch: DictionaryHit[] = [];
      const flush = async () => {
        const lists = await slot.reader!.readPostings(batch);
        batch.forEach((hit, index) => {
          let documents = byFingerprint.get(hit.fingerprint);
          if (!documents) {
            documents = [];
            byFingerprint.set(hit.fingerprint, documents);
          }
          for (const ordinal of lists[index]) documents.push(base + ordinal);
        });
        batch = [];
      };
      for await (const hit of slot.reader.iterateDictionary()) {
        batch.push(hit);
        if (batch.length >= 4096) await flush();
      }
      if (batch.length > 0) await flush();
      base += slot.reader.documentCount;
    }
    for (const fingerprint of [...byFingerprint.keys()].sort((left, right) => (left < right ? -1 : 1))) {
      postings.push({ fingerprint, documents: (byFingerprint.get(fingerprint) as number[]).sort((left, right) => left - right) });
    }
    return { postings, documentCount: base, identity: reader.identity() };
  } finally {
    await store.close();
  }
}

function databaseBytes(file: string) {
  return [file, `${file}-wal`, `${file}-shm`].reduce((total, candidate) => total + (existsSync(candidate) ? statSync(candidate).size : 0), 0);
}

async function buildBtree(file: string, postings: Array<{ fingerprint: bigint; documents: number[] }>): Promise<{ client: Client; buildMs: number; rows: number }> {
  const client = createClient({ url: `file:${file.replace(/\\/g, "/")}` });
  const started = performance.now();
  await client.execute("PRAGMA journal_mode = OFF");
  await client.execute("PRAGMA synchronous = OFF");
  await client.execute("CREATE TABLE postings (fp BLOB NOT NULL, doc INTEGER NOT NULL, PRIMARY KEY (fp, doc)) WITHOUT ROWID");
  let rows = 0;
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
  for (const entry of postings) {
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
  return { client, buildMs: performance.now() - started, rows };
}

async function buildFts(file: string, postings: Array<{ fingerprint: bigint; documents: number[] }>, documentCount: number): Promise<{ client: Client; buildMs: number }> {
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

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const work = requireArgument(args, "work");
  const { queries } = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries"));
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const loadStarted = performance.now();
  const { postings, documentCount, identity } = await loadPostings(requireArgument(args, "root"), requireArgument(args, "generation"));
  const rowCount = postings.reduce((total, entry) => total + entry.documents.length, 0);
  logLine(`loaded ${postings.length} fingerprints / ${rowCount} postings for ${documentCount} documents from the generation in ${round((performance.now() - loadStarted) / 1000)} s`);

  const btreeFile = path.join(work, "btree.db");
  const btree = await buildBtree(btreeFile, postings);
  logLine(`B-tree: built in ${round(btree.buildMs / 1000)} s, ${databaseBytes(btreeFile)} bytes`);
  const ftsFile = path.join(work, "fts5.db");
  const fts = await buildFts(ftsFile, postings, documentCount);
  logLine(`FTS5: built in ${round(fts.buildMs / 1000)} s, ${databaseBytes(ftsFile)} bytes`);

  // The engine's own answer to the same question: every touched document with its hit count.
  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"));
  const bases: number[] = [];
  let base = 0;
  for (const slot of reader.slots) {
    bases.push(base);
    base += slot.reader?.documentCount ?? 0;
  }
  const rows: Array<Record<string, unknown>> = [];
  const timings = { engine: [] as number[], btree: [] as number[], fts: [] as number[] };
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      for (const query of queries) {
        const hexes = computeQueryFingerprints(query.text, 200).fingerprints.map((fingerprint) => fingerprint.hex);
        const engineStarted = performance.now();
        const engine = await retrieveCandidates(reader, query.text, { candidateBudget: 1_000_000, regionAware: false });
        const engineMs = performance.now() - engineStarted - engine.stats.timingsMs.fingerprint;
        const btreeStarted = performance.now();
        const fromBtree = await btreeCandidates(btree.client, hexes);
        const btreeMs = performance.now() - btreeStarted;
        const ftsStarted = performance.now();
        const fromFts = await ftsCandidates(fts.client, hexes);
        const ftsMs = performance.now() - ftsStarted;
        if (pass === 0) continue; // first pass warms all three
        timings.engine.push(engineMs);
        timings.btree.push(btreeMs);
        timings.fts.push(ftsMs);
        const engineHits = new Map<number, number>();
        for (const candidate of engine.candidates) {
          const slotIndex = reader.slots.findIndex((slot) => slot.segmentId === candidate.segmentId);
          engineHits.set(bases[slotIndex] + candidate.ordinal, candidate.fingerprintHits);
        }
        let btreeSame = engineHits.size === fromBtree.size;
        for (const [document, hits] of engineHits) if (fromBtree.get(document) !== hits) btreeSame = false;
        let ftsSame = engineHits.size === fromFts.size;
        for (const document of engineHits.keys()) if (!fromFts.has(document)) ftsSame = false;
        rows.push({ queryId: query.id, fingerprints: hexes.length, touchedDocuments: engineHits.size, btreeIdenticalDocumentsAndHitCounts: btreeSame, ftsIdenticalDocumentSet: ftsSame, engineMs: round(engineMs, 3), btreeMs: round(btreeMs, 3), ftsMs: round(ftsMs, 3) });
      }
    }
  } finally {
    await store.close();
  }

  const engineIndexBytes = Object.keys(reader.manifest.segments).reduce((total, segmentId) => {
    const directory = path.join(requireArgument(args, "root"), "segments", segmentId);
    return total + ["dict.bin", "dict.idx", "postings.bin", "docs.bin"].reduce((sum, file) => sum + statSync(path.join(directory, file)).size, 0);
  }, 0);
  const summarize = (values: number[]) => ({ p50: round(percentile(values, 0.5), 3), p95: round(percentile(values, 0.95), 3), mean: round(mean(values), 3) });
  const report = {
    identity,
    documents: documentCount,
    distinctFingerprints: postings.length,
    postings: rowCount,
    engine: { indexBytes: engineIndexBytes, bytesPerPosting: round(engineIndexBytes / rowCount, 2), candidateLookupMs: summarize(timings.engine), note: "dict.bin + dict.idx + postings.bin + docs.bin; lookup + accumulation only, fingerprinting excluded" },
    sqliteBtree: { indexBytes: databaseBytes(btreeFile), bytesPerPosting: round(databaseBytes(btreeFile) / rowCount, 2), buildSeconds: round(btree.buildMs / 1000), candidateLookupMs: summarize(timings.btree), identicalDocumentsAndHitCounts: rows.every((row) => row.btreeIdenticalDocumentsAndHitCounts) },
    sqliteFts5: { indexBytes: databaseBytes(ftsFile), bytesPerPosting: round(databaseBytes(ftsFile) / rowCount, 2), buildSeconds: round(fts.buildMs / 1000), candidateLookupMs: summarize(timings.fts), identicalDocumentSet: rows.every((row) => row.ftsIdenticalDocumentSet), note: "document set only: FTS5 does not return how many OR terms a document matched" },
    perQuery: rows,
  };
  writeJson(requireArgument(args, "out"), report);
  logLine(`engine   ${engineIndexBytes} bytes (${report.engine.bytesPerPosting} B/posting)  lookup p50 ${report.engine.candidateLookupMs.p50} ms  p95 ${report.engine.candidateLookupMs.p95} ms`);
  logLine(`B-tree   ${report.sqliteBtree.indexBytes} bytes (${report.sqliteBtree.bytesPerPosting} B/posting)  lookup p50 ${report.sqliteBtree.candidateLookupMs.p50} ms  p95 ${report.sqliteBtree.candidateLookupMs.p95} ms  identical=${report.sqliteBtree.identicalDocumentsAndHitCounts}`);
  logLine(`FTS5     ${report.sqliteFts5.indexBytes} bytes (${report.sqliteFts5.bytesPerPosting} B/posting)  lookup p50 ${report.sqliteFts5.candidateLookupMs.p50} ms  p95 ${report.sqliteFts5.candidateLookupMs.p95} ms  identical set=${report.sqliteFts5.identicalDocumentSet}`);
  btree.client.close();
  fts.client.close();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
