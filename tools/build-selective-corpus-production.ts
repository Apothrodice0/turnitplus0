import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tokens, grams, gramHash } from "../lib/similarity-core";
import { winnow } from "../lib/archive-fingerprint";
import { canonicalSha256 } from "../lib/document-identity";
import {
  SELECTIVE_CORPUS_VERSION,
  SELECTIVE_CORPUS_WINNOW_WINDOW,
  SELECTIVE_CORPUS_SHINGLE_SIZE,
  SELECTIVE_CORPUS_STOP_DF,
} from "../lib/selective-corpus/constants";
import { cleanSourceDocument, MIN_ANALYZABLE_WORD_COUNT } from "../lib/selective-corpus/corpus-cleaning";

/**
 * Selective Corpus PRODUCTION packer — builds a fixture-free artifact from the
 * ORIGINAL pre-dedup bulk population (bulk-source-manifest.jsonl), reusing the
 * exact tracked fingerprint/tokenization primitives the dev/regression
 * "bulk-v1" build already uses (lib/similarity-core.ts, lib/archive-fingerprint.ts,
 * lib/document-identity.ts, lib/selective-corpus/constants.ts).
 *
 * WHY A NEW BUILD (not a filter of the existing frozen artifact): the existing
 * "bulk-v1" artifact folds 232 Track_C regression fixtures into the SAME
 * document population BEFORE dedup and BEFORE document-frequency (DF) tally.
 * This provably (not theoretically) does two things a simple ordinal-range
 * filter can never undo:
 *   1. At least 23 bulk documents were dropped as "mirror" duplicates of a
 *      fixture document during dedup -- they never received an ordinal at
 *      all, so no amount of filtering can restore them.
 *   2. 40 of the current 468 stop-hashes only crossed the DF>=13 threshold
 *      because fixtures inflated their combined document frequency -- their
 *      postings were never written to any shard for genuine bulk documents,
 *      so that search signal cannot be recovered by filtering either.
 * A correct fixture-free artifact therefore requires fresh dedup + fresh DF
 * tally over ONLY the original bulk population -- this tool.
 *
 * HARD FIXTURE EXCLUSION IS STRUCTURAL, NOT A FLAG: this file has no
 * "--include-fixtures" option and never reads from any fixture-shaped path
 * (a Track_C "families/<family>/<id>.txt" fixture directory, or a docmap
 * "fixture:" rawId). The ONLY input this tool reads is
 * "<sourceArtifactDir>/bulk-source-manifest.jsonl" + "<sourceArtifactDir>/raw/",
 * which never contain fixture records (bulk-source-manifest.jsonl is
 * populated only by the bulk ingest step, before any Track_C fold-in).
 * assertNoFixtureContamination() is an additional fail-closed check applied
 * to every loaded record before any dedup/pack/write happens, so even a
 * corrupted or mislabeled input record cannot silently reach the output.
 *
 * NEVER modifies the frozen source artifact -- every write goes to a brand
 * new output directory; the source is only ever read from.
 */

const W = SELECTIVE_CORPUS_WINNOW_WINDOW; // 15
const SH = SELECTIVE_CORPUS_SHINGLE_SIZE; // 5
const DF_STOP = SELECTIVE_CORPUS_STOP_DF; // 13
const N_SHARDS = 256;

export type BulkManifestRecord = {
  docId: string;
  status: string;
  family: string;
  subtype?: string;
  title?: string;
  url?: string;
  canonicalId?: string;
  language?: string;
  acquisitionSource?: string;
  pageid?: string;
  license?: string;
  interpretationLabel?: string;
  contentHash?: string;
  canonicalTextHash?: string;
};

export type ProductionDoc = {
  rawId: string; // "bulk:<docId>" -- ALWAYS "bulk:", never "fixture:"
  family: string;
  subtype?: string;
  title?: string;
  url?: string;
  canonicalId?: string;
  language?: string;
  acquisitionSource?: string;
  workVersionId: string | null;
  license?: string;
  interpretationLabel: string;
  contentHash: string;
  canonicalTextHash: string;
  text: string;
  words: string[];
  wordCount: number;
  sourceId?: string;
  dupOf?: string;
  dupType?: "exact_canonical" | "curation_overlap" | "work_version" | "mirror";
  fp?: Set<string>;
};

/**
 * FAIL CLOSED: throws immediately if any record looks fixture-shaped, before
 * any dedup/fingerprint/write work happens. Checked against the rawId/docId
 * string itself (must never contain "fixture", case-insensitive) -- the one
 * marker every fixture record in this codebase carries (docmap "fixture:"
 * prefix, source-loader.ts's own kind switch, bareId()).
 */
export function assertNoFixtureContamination(records: Array<{ rawId?: string; docId?: string }>): void {
  for (const r of records) {
    const id = String(r.rawId ?? r.docId ?? "");
    if (/fixture/i.test(id)) {
      throw new Error(
        `FAIL CLOSED: a fixture-shaped record reached the production packer's input population (${id}). ` +
          "The production packer must never index Track_C regression fixtures.",
      );
    }
  }
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export type CleaningReport = {
  totalRecordsConsidered: number;
  unchangedCount: number;
  cleanedCount: number;
  excludedCount: number;
  cleanedByRule: Record<string, number>;
  excludedByReason: Record<string, number>;
};

function emptyCleaningReport(): CleaningReport {
  return { totalRecordsConsidered: 0, unchangedCount: 0, cleanedCount: 0, excludedCount: 0, cleanedByRule: {}, excludedByReason: {} };
}

/** Reads ONLY bulk-source-manifest.jsonl (never packed/docmap.tsv, which may
 *  carry fixture rows in the dev/regression artifact) -- the pre-dedup bulk
 *  population, exactly mirroring the historical bulk-ingest Phase 2 load
 *  (status "OK", raw text present, >=250 words after cleaning) with the
 *  Track_C fold-in block simply never present in this file at all.
 *
 *  Applies the deterministic, source-family-aware corpus-cleaning policy
 *  (lib/selective-corpus/corpus-cleaning.ts) to every candidate's raw text
 *  BEFORE tokenizing/hashing: a document the policy excludes never reaches
 *  the output population, and a document the policy cleans gets its
 *  contentHash/canonicalTextHash recomputed fresh from the cleaned text
 *  (the original manifest's hash fields, computed over the UNCLEANED text,
 *  would otherwise silently misdescribe the indexed content). */
export function loadBulkRecords(sourceArtifactDir: string): { docs: ProductionDoc[]; cleaningReport: CleaningReport } {
  const manifestPath = join(sourceArtifactDir, "bulk-source-manifest.jsonl");
  const lines = readFileSync(manifestPath, "utf8").split("\n").filter(Boolean);
  const docs: ProductionDoc[] = [];
  const cleaningReport = emptyCleaningReport();
  for (const line of lines) {
    let r: BulkManifestRecord;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.status !== "OK") continue;
    const rawPath = join(sourceArtifactDir, "raw", `${r.docId}.txt`);
    if (!existsSync(rawPath)) continue;
    const rawText = readFileSync(rawPath, "utf8");

    cleaningReport.totalRecordsConsidered++;
    const cleaning = cleanSourceDocument(rawText, { family: r.family, title: r.title });
    if (cleaning.action === "excluded") {
      cleaningReport.excludedCount++;
      const reasonKey = cleaning.reason ?? "unknown";
      cleaningReport.excludedByReason[reasonKey] = (cleaningReport.excludedByReason[reasonKey] ?? 0) + 1;
      continue;
    }
    if (cleaning.action === "cleaned") {
      cleaningReport.cleanedCount++;
      const ruleKey = cleaning.rule ?? "unknown";
      cleaningReport.cleanedByRule[ruleKey] = (cleaningReport.cleanedByRule[ruleKey] ?? 0) + 1;
    } else {
      cleaningReport.unchangedCount++;
    }

    const text = cleaning.text;
    const words = tokens(text);
    if (words.length < MIN_ANALYZABLE_WORD_COUNT) continue; // safety net for "unchanged" docs already short pre-cleaning

    const textChanged = cleaning.action === "cleaned";
    docs.push({
      rawId: `bulk:${r.docId}`,
      family: r.family,
      subtype: r.subtype,
      title: r.title,
      url: r.url,
      canonicalId: r.canonicalId,
      language: r.language,
      acquisitionSource: r.acquisitionSource,
      workVersionId: r.pageid ? `pageid:${r.pageid}` : null,
      license: r.license,
      interpretationLabel: r.interpretationLabel || "ORDINARY_REFERENCE",
      contentHash: textChanged ? sha256Hex(text) : r.contentHash || sha256Hex(text),
      canonicalTextHash: textChanged ? canonicalSha256(text) : r.canonicalTextHash || canonicalSha256(text),
      text,
      words,
      wordCount: words.length,
    });
  }
  assertNoFixtureContamination(docs);
  return { docs, cleaningReport };
}

export type DedupResult = {
  kept: ProductionDoc[];
  dropped: ProductionDoc[];
  exactCount: number;
  curationCount: number;
  workVersionCount: number;
  mirrorCount: number;
  workClusters: Array<{ keep: string; drop: string; jaccard: number }>;
  mirrorClusters: Array<{ keep: string; drop: string; jaccard: number; family: string }>;
};

function jaccard(a: Set<string>, b: Set<string>): number {
  let n = 0;
  const [s, l] = a.size < b.size ? [a, b] : [b, a];
  for (const x of s) if (l.has(x)) n++;
  return n / (a.size + b.size - n);
}

/**
 * EXACT reproduction of the historical packer's dedup semantics (exact/curation
 * canonical-hash grouping, work-version Jaccard>=0.6, mirror Jaccard>=0.85
 * bounded 30-doc window), operating ONLY on the docs passed in -- this
 * function never reads any prior artifact's dupOf decisions, and Track_C
 * fixtures are structurally never present in `docs` (assertNoFixtureContamination
 * already ran in loadBulkRecords()), so there is nothing for a fixture to bias.
 * Mutates `docs` in place (sets dupOf/dupType/fp/sourceId), matching the
 * historical script's own approach; always call with a fresh array per build.
 */
export function dedupBulkDocuments(docs: ProductionDoc[]): DedupResult {
  assertNoFixtureContamination(docs);

  const byCanon = new Map<string, ProductionDoc[]>();
  for (const d of docs) {
    const k = d.canonicalTextHash;
    if (!byCanon.has(k)) byCanon.set(k, []);
    byCanon.get(k)!.push(d);
  }
  for (const g of [...byCanon.values()].filter((g) => g.length > 1)) {
    g.sort((a, b) => (a.rawId < b.rawId ? -1 : 1));
    const crossFam = new Set(g.map((d) => d.family)).size > 1;
    for (let i = 1; i < g.length; i++) {
      g[i].dupOf = g[0].rawId;
      g[i].dupType = crossFam ? "curation_overlap" : "exact_canonical";
    }
  }

  const live1 = docs.filter((d) => !d.dupOf);
  for (const d of live1) d.fp = new Set(winnow(grams(d.words, SH).map((x) => gramHash(x)), W).map((s) => s.hash));

  const byWork = new Map<string, ProductionDoc[]>();
  for (const d of live1) {
    if (!d.workVersionId) continue;
    const k = `${d.family}|${d.workVersionId}`;
    if (!byWork.has(k)) byWork.set(k, []);
    byWork.get(k)!.push(d);
  }
  const workClusters: DedupResult["workClusters"] = [];
  for (const g of byWork.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => b.wordCount - a.wordCount);
    for (let i = 1; i < g.length; i++) {
      if (!g[i].dupOf && jaccard(g[0].fp!, g[i].fp!) >= 0.6) {
        g[i].dupOf = g[0].rawId;
        g[i].dupType = "work_version";
        workClusters.push({ keep: g[0].rawId, drop: g[i].rawId, jaccard: +jaccard(g[0].fp!, g[i].fp!).toFixed(3) });
      }
    }
  }

  const live2 = docs.filter((d) => !d.dupOf);
  const mirrorClusters: DedupResult["mirrorClusters"] = [];
  for (const fam of new Set(live2.map((d) => d.family))) {
    const fd = live2.filter((d) => d.family === fam).sort((a, b) => b.wordCount - a.wordCount);
    for (let i = 0; i < fd.length; i++) {
      if (fd[i].dupOf) continue;
      for (let j = i + 1; j < fd.length && j < i + 30; j++) {
        if (fd[j].dupOf) continue;
        if (fd[j].wordCount < fd[i].wordCount * 0.4) break;
        const jc = jaccard(fd[i].fp!, fd[j].fp!);
        if (jc >= 0.85) {
          fd[j].dupOf = fd[i].rawId;
          fd[j].dupType = "mirror";
          mirrorClusters.push({ keep: fd[i].rawId, drop: fd[j].rawId, jaccard: +jc.toFixed(3), family: fam });
        }
      }
    }
  }

  const kept = docs.filter((d) => !d.dupOf).sort((a, b) => (a.rawId < b.rawId ? -1 : a.rawId > b.rawId ? 1 : 0));
  kept.forEach((d, i) => {
    d.sourceId = `scb-${String(i + 1).padStart(6, "0")}`;
  });
  const dropped = docs.filter((d) => d.dupOf);

  return {
    kept,
    dropped,
    exactCount: dropped.filter((d) => d.dupType === "exact_canonical").length,
    curationCount: dropped.filter((d) => d.dupType === "curation_overlap").length,
    workVersionCount: dropped.filter((d) => d.dupType === "work_version").length,
    mirrorCount: dropped.filter((d) => d.dupType === "mirror").length,
    workClusters,
    mirrorClusters,
  };
}

function pushVarint(arr: number[], n: number): void {
  n = n >>> 0;
  while (n > 0x7f) {
    arr.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  arr.push(n & 0x7f);
}

export type PackedIndexResult = {
  shardBuffers: Buffer[];
  stopsetBuffer: Buffer;
  docmapText: string;
  distinctHashes: number;
  totalPostings: number;
  postingsKept: number;
  stopHashes: string[];
};

/**
 * EXACT reproduction of the historical packer's Phase 4 (fingerprint tally,
 * DF-based stop-hash exclusion, sharded posting encoding, docmap generation)
 * over ONLY `kept` -- the fresh, fixture-free dedup survivors. DF is computed
 * fresh from `kept` every call; nothing is inherited from any other artifact.
 */
export function buildPackedIndex(kept: ProductionDoc[]): PackedIndexResult {
  assertNoFixtureContamination(kept);
  const ord = new Map(kept.map((d, i) => [d.sourceId!, i]));
  const acc: Array<Map<string, number[]>> = Array.from({ length: N_SHARDS }, () => new Map());
  for (const d of kept) {
    const distinct = d.fp ? [...d.fp] : [...new Set(winnow(grams(d.words, SH).map((g) => gramHash(g)), W).map((s) => s.hash))];
    const o = ord.get(d.sourceId!)!;
    for (const h of distinct) {
      const sid = parseInt(h.slice(0, 2), 16);
      let a = acc[sid].get(h);
      if (!a) {
        a = [];
        acc[sid].set(h, a);
      }
      a.push(o);
    }
  }

  let distinctHashes = 0;
  let totalPostings = 0;
  const stopHashes: string[] = [];
  for (let s = 0; s < N_SHARDS; s++) {
    for (const [h, os] of acc[s]) {
      distinctHashes++;
      totalPostings += os.length;
      if (os.length >= DF_STOP) stopHashes.push(h);
    }
  }
  stopHashes.sort();

  const shardBuffers: Buffer[] = [];
  let postingsKept = 0;
  for (let s = 0; s < N_SHARDS; s++) {
    const entries = [...acc[s].entries()].filter(([, o]) => o.length < DF_STOP).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const bytes: number[] = [];
    const cnt = Buffer.alloc(4);
    cnt.writeUInt32LE(entries.length, 0);
    for (const b of cnt) bytes.push(b);
    for (const [h, oraw] of entries) {
      const os = [...new Set(oraw)].sort((a, b) => a - b);
      postingsKept += os.length;
      for (const b of Buffer.from(h.padStart(16, "0"), "hex")) bytes.push(b);
      pushVarint(bytes, os.length);
      let prev = 0;
      for (const o of os) {
        pushVarint(bytes, o - prev);
        prev = o;
      }
    }
    shardBuffers.push(Buffer.from(bytes));
  }

  const stopsetBuffer = Buffer.concat(stopHashes.map((h) => Buffer.from(h.padStart(16, "0"), "hex")));
  const docmapText = kept
    .map((d) => `${ord.get(d.sourceId!)}\t${d.sourceId}\t${d.family}\t${d.rawId}\t${d.wordCount}\t${d.interpretationLabel}`)
    .join("\n");

  return { shardBuffers, stopsetBuffer, docmapText, distinctHashes, totalPostings, postingsKept, stopHashes };
}

/** EXACT existing contract (lib/selective-corpus): sha256 of "sourceId:canonicalTextHash"
 *  joined by "|", over kept docs in their rawId-sorted / sourceId-assigned order. */
export function computeCorpusIdentityDigest(kept: ProductionDoc[]): string {
  return sha256Hex(kept.map((d) => `${d.sourceId}:${d.canonicalTextHash}`).join("|"));
}

export type ProductionCorpusVersionJson = {
  corpusVersion: string;
  buildLine: string;
  runId: string;
  generatedAt: string;
  corpusIdentityDigest: string;
  fingerprintVersion: string;
  winnowWindow: number;
  shingleSize: number;
  stopPolicy: string;
  documentCount: number;
  categoryDistribution: Record<string, number>;
  trackCRegressionFixtures: number;
  sourceArtifact: string;
  deterministic: string;
};

export function buildCorpusVersionJson(
  kept: ProductionDoc[],
  digest: string,
  runId: string,
  sourceArtifactDir: string,
): ProductionCorpusVersionJson {
  const categoryDistribution: Record<string, number> = {};
  for (const d of kept) categoryDistribution[d.family] = (categoryDistribution[d.family] ?? 0) + 1;
  return {
    corpusVersion: SELECTIVE_CORPUS_VERSION,
    buildLine: "production-v2-cleaned",
    runId,
    generatedAt: new Date().toISOString(),
    corpusIdentityDigest: digest,
    fingerprintVersion: `mixed-fp-w${W}-s${SH}`,
    winnowWindow: W,
    shingleSize: SH,
    stopPolicy: `global DF>=${DF_STOP}`,
    documentCount: kept.length,
    categoryDistribution,
    trackCRegressionFixtures: 0,
    sourceArtifact: sourceArtifactDir,
    deterministic:
      "same bulk-source-manifest.jsonl + same raw text + same primitives => identical sourceId order, canonicalTextHash, corpusIdentityDigest, packed shards. Fixture-free by construction (no Track_C fold-in exists in this packer).",
  };
}

export type ProductionPackResult = {
  dedup: DedupResult;
  packed: PackedIndexResult;
  digest: string;
  corpusVersionJson: ProductionCorpusVersionJson;
};

/** Pure orchestration (no file I/O): fixture guard -> dedup -> pack -> digest
 *  -> corpus-version.json object. Used directly by tests with small synthetic
 *  inputs, and by main() for the real build. */
export function runProductionPacker(records: ProductionDoc[], runId: string, sourceArtifactDir: string): ProductionPackResult {
  assertNoFixtureContamination(records);
  const dedup = dedupBulkDocuments(records);
  const packed = buildPackedIndex(dedup.kept);
  const digest = computeCorpusIdentityDigest(dedup.kept);
  const corpusVersionJson = buildCorpusVersionJson(dedup.kept, digest, runId, sourceArtifactDir);
  return { dedup, packed, digest, corpusVersionJson };
}

/** Writes the artifact to a BRAND NEW output directory. Never touches
 *  sourceArtifactDir except (historically) to read raw text -- as of the
 *  corpus-cleaning integration, raw/<id>.txt is written from each kept
 *  doc's OWN in-memory `text` field (the text actually indexed/hashed/
 *  fingerprinted), never copied from sourceArtifactDir. Copying from disk
 *  would silently re-introduce the UNCLEANED source text into the artifact
 *  that lib/selective-corpus/source-loader.ts serves at runtime for
 *  candidate/verification text -- a real mismatch between what was indexed
 *  and what gets compared during admission, not merely a cosmetic one. */
export function writeProductionArtifact(sourceArtifactDir: string, outputDir: string, result: ProductionPackResult): void {
  const packedDir = join(outputDir, "packed");
  const rawDir = join(outputDir, "raw");
  mkdirSync(packedDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });

  for (let s = 0; s < N_SHARDS; s++) {
    writeFileSync(join(packedDir, `shard-${String(s).padStart(3, "0")}.bin`), result.packed.shardBuffers[s]);
  }
  writeFileSync(join(packedDir, "docmap.tsv"), result.packed.docmapText);
  writeFileSync(join(packedDir, "stopset.bin"), result.packed.stopsetBuffer);
  writeFileSync(join(outputDir, "corpus-version.json"), JSON.stringify(result.corpusVersionJson, null, 2));

  for (const d of result.dedup.kept) {
    const id = d.rawId.slice(5); // strip "bulk:"
    writeFileSync(join(rawDir, `${id}.txt`), d.text, "utf8");
  }

  const report = {
    generatedAt: new Date().toISOString(),
    runId: result.corpusVersionJson.runId,
    sourceArtifactDir,
    inputBulkCount: result.dedup.kept.length + result.dedup.dropped.length,
    keptCount: result.dedup.kept.length,
    droppedCount: result.dedup.dropped.length,
    exactDuplicates: result.dedup.exactCount,
    curationOverlapDuplicates: result.dedup.curationCount,
    workVersionDuplicates: result.dedup.workVersionCount,
    mirrorDuplicates: result.dedup.mirrorCount,
    distinctHashes: result.packed.distinctHashes,
    totalPostings: result.packed.totalPostings,
    postingsKept: result.packed.postingsKept,
    stopHashCount: result.packed.stopHashes.length,
    corpusIdentityDigest: result.digest,
  };
  writeFileSync(join(outputDir, "build-report.json"), JSON.stringify(report, null, 2));
}

async function main(): Promise<void> {
  const sourceArtifactDir = process.env.SELECTIVE_CORPUS_PRODUCTION_SOURCE ?? "D:/TurnitPlusTemp/selective-corpus-bulk-v1/run-20260909-224038";
  const outputRoot = process.env.SELECTIVE_CORPUS_PRODUCTION_OUTPUT_ROOT ?? "D:/TurnitPlusTemp/selective-corpus-production-v1";
  const runId = `run-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")}`;
  const outputDir = join(outputRoot, runId);

  console.log(`[production-packer] source: ${sourceArtifactDir}`);
  console.log(`[production-packer] output: ${outputDir}`);

  const t0 = Date.now();
  const { docs: records, cleaningReport } = loadBulkRecords(sourceArtifactDir);
  console.log(
    `[production-packer] loaded ${records.length} pre-dedup bulk records ` +
      `(cleaning: ${cleaningReport.unchangedCount} unchanged, ${cleaningReport.cleanedCount} cleaned, ${cleaningReport.excludedCount} excluded) ` +
      `(${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  const result = runProductionPacker(records, runId, sourceArtifactDir);
  console.log(
    `[production-packer] dedup: ${records.length} -> ${result.dedup.kept.length} kept ` +
      `(${result.dedup.exactCount} exact, ${result.dedup.curationCount} curation, ${result.dedup.workVersionCount} work-version, ${result.dedup.mirrorCount} mirror)`,
  );
  console.log(
    `[production-packer] packed: ${result.packed.distinctHashes} distinct hashes, ${result.packed.totalPostings} postings ` +
      `(${result.packed.postingsKept} kept), ${result.packed.stopHashes.length} stop`,
  );
  console.log(`[production-packer] corpusIdentityDigest: ${result.digest}`);

  writeProductionArtifact(sourceArtifactDir, outputDir, result);
  writeFileSync(join(outputDir, "cleaning-report.json"), JSON.stringify(cleaningReport, null, 2));
  console.log(`[production-packer] BUILD DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${outputDir}`);
}

const isMainModule = (() => {
  try {
    return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (isMainModule) {
  main().catch((err) => {
    console.error("[production-packer] FAILED:", err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}
