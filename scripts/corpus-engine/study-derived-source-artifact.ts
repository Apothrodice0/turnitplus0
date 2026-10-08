import { closeSync, mkdirSync, openSync, readSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import zlib from "node:zlib";
import { nodeBytes, sha256Hex, type Bytes } from "../../lib/corpus-engine/bytes";
import { prepareSubmissionForVerification } from "../../lib/corpus-engine/prepared-verifier";
import { documentShingleHashes } from "../../lib/document-family";
import { DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS, DOCUMENT_CORRESPONDENCE_THRESHOLDS_VERSION } from "../../lib/document-correspondence";
import { canonicalSha256 } from "../../lib/document-identity";
import { tokens } from "../../lib/similarity-core";
import { openGeneration, type BenchmarkQuery } from "./benchmark-common";
import { logLine, mean, parseArguments, percentile, readJson, requireArgument, round, writeJson } from "./common";

/**
 * A BOUNDED DECISION STUDY — not an engine feature. Nothing here is read by
 * the engine, and nothing is stored for the corpus.
 *
 *   study-derived-source-artifact.ts --root R --generation G --queries queries.json --work D:\...\study --out study.json [--sample 600]
 *
 * With the submission prepared once per query, what is left of a candidate's
 * verification cost is deriving three things from the SOURCE text, every time:
 *
 *   tokens(source).length                 the word count
 *   canonicalSha256(source)               for the exact-document test
 *   documentShingleHashes(source, 5)      the set of informative 5-gram hashes
 *
 * This measures what it would cost to store exactly those three per document
 * (a "derived source artifact"), and what verification would then cost. For a
 * sample of real documents it builds the sidecar, proves the decoded sidecar
 * equal to what the verifier derives from the text (so any verifier fed from
 * it would compute the same result), and times: deriving from text, loading
 * and decoding the sidecar, and the submission-side match loop over each.
 *
 * The sidecar's identity lists every contract its content depends on. A
 * reader would have to refuse a sidecar whose identity hash differs from the
 * running code's — the study shows that refusal on a deliberately altered one.
 */

const SIDECAR_MAGIC = "TPDS";
const SIDECAR_HEADER_BYTES = 4 + 32 + 4 + 32 + 4;

function sidecarIdentity(reader: { manifest: { processing: { normalization: { contract: string; version: number; probeSha256: string }; fingerprint: { hash: string } } } }) {
  return {
    artifactFormat: "derived-source-artifact-prototype-v1",
    normalizationContract: reader.manifest.processing.normalization.contract,
    normalizationVersion: reader.manifest.processing.normalization.version,
    // The probe covers normalize(), the reference-section strip and canonicalization as the running code performs them.
    normalizationProbeSha256: reader.manifest.processing.normalization.probeSha256,
    referenceStrip: "lib/reference-section.ts stripReferenceSection (inside tokens())",
    shingleSize: DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS.shingleSize,
    gramHash: reader.manifest.processing.fingerprint.hash,
    informativeGramPolicy: "lib/similarity-core.ts informativeGram + COMMON_WORDS",
    canonicalization: "lib/document-identity.ts canonicalizeText",
    thresholdsVersion: DOCUMENT_CORRESPONDENCE_THRESHOLDS_VERSION,
    sourceContentIdentity: "sha256 of the stored source text (the text-pack record hash)",
  };
}

function encodeSidecar(identitySha256: string, wordCount: number, canonical: string, shingles: Set<string>): Bytes {
  const keys = [...shingles].sort();
  const bytes: Bytes = nodeBytes(Buffer.alloc(SIDECAR_HEADER_BYTES + keys.length * 8));
  bytes.write(SIDECAR_MAGIC, 0, "latin1");
  Buffer.from(identitySha256, "hex").copy(bytes, 4);
  bytes.writeUInt32BE(wordCount, 36);
  Buffer.from(canonical, "hex").copy(bytes, 40);
  bytes.writeUInt32BE(keys.length, 72);
  keys.forEach((hex, index) => {
    bytes.writeUInt32BE(parseInt(hex.slice(0, 8), 16), SIDECAR_HEADER_BYTES + index * 8);
    bytes.writeUInt32BE(parseInt(hex.slice(8), 16), SIDECAR_HEADER_BYTES + index * 8 + 4);
  });
  return bytes;
}

/** zstd is in node:zlib from Node 22.15; the type package here predates it (see lib/corpus-engine/record-pack.ts). */
function zstdLevel9(input: Uint8Array): Uint8Array {
  const api = zlib as unknown as { zstdCompressSync(input: Uint8Array, options?: { params?: Record<number, number> }): Uint8Array; constants: Record<string, number> };
  return api.zstdCompressSync(input, { params: { [api.constants.ZSTD_c_compressionLevel]: 9 } });
}

type DecodedSidecar = { wordCount: number; canonical: string; hi: Uint32Array; lo: Uint32Array };

function decodeSidecar(bytes: Bytes, expectedIdentitySha256: string): DecodedSidecar {
  if (bytes.toString("latin1", 0, 4) !== SIDECAR_MAGIC) throw new Error("not a derived source artifact");
  if (bytes.toString("hex", 4, 36) !== expectedIdentitySha256) throw new Error("DERIVED_ARTIFACT_IDENTITY_MISMATCH");
  const count = bytes.readUInt32BE(72);
  const hi = new Uint32Array(count);
  const lo = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    hi[index] = bytes.readUInt32BE(SIDECAR_HEADER_BYTES + index * 8);
    lo[index] = bytes.readUInt32BE(SIDECAR_HEADER_BYTES + index * 8 + 4);
  }
  return { wordCount: bytes.readUInt32BE(36), canonical: bytes.toString("hex", 40, 72), hi, lo };
}

function holds(sidecar: DecodedSidecar, hi: number, lo: number): boolean {
  let low = 0;
  let high = sidecar.hi.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (sidecar.hi[middle] === hi && sidecar.lo[middle] === lo) return true;
    if (sidecar.hi[middle] < hi || (sidecar.hi[middle] === hi && sidecar.lo[middle] < lo)) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const work = requireArgument(args, "work");
  const sampleSize = Number(args.sample ?? 600);
  const { queries } = readJson<{ queries: BenchmarkQuery[] }>(requireArgument(args, "queries"));
  mkdirSync(work, { recursive: true });
  const { store, reader } = await openGeneration(requireArgument(args, "root"), requireArgument(args, "generation"));
  try {
    const identity = sidecarIdentity(reader);
    const identitySha256 = sha256Hex(JSON.stringify(identity));
    const all = [...reader.allDocumentIds()];
    const step = Math.floor(all.length / sampleSize);
    const sample = Array.from({ length: sampleSize }, (_, index) => all[index * step]);
    const shingleSize = DEFAULT_DOCUMENT_CORRESPONDENCE_THRESHOLDS.shingleSize;

    // submissions of three sizes, prepared once each; their informative hashes also as numbers for the typed lookup
    const submissions = ["passage-en-600", "mosaic-en-25x80", "long-en-12k"].map((id) => {
      const query = queries.find((candidate) => candidate.id === id);
      if (!query) throw new Error(`the query file has no ${id}`);
      const prepared = prepareSubmissionForVerification(query.text);
      const numeric = prepared.informativeHashes.map((hex) => (hex === null ? null : [parseInt(hex.slice(0, 8), 16), parseInt(hex.slice(8), 16)] as const));
      return { id, prepared, numeric };
    });

    const file = path.join(work, "derived-source-artifact.sample.bin");
    const descriptor = openSync(file, "w+");
    const rows: Array<{ offset: number; length: number; words: number; shingles: number; textCompressedBytes: number; textBytes: number; zstdBytes: number }> = [];
    const timing = { textFetchMs: [] as number[], deriveFromTextMs: [] as number[], sidecarReadMs: [] as number[], sidecarDecodeMs: [] as number[], sidecarToStringSetMs: [] as number[] };
    const matchFromText: number[][] = submissions.map(() => []);
    const matchFromSidecar: number[][] = submissions.map(() => []);
    let offset = 0;
    let mismatches = 0;
    let matchDisagreements = 0;

    for (const docId of sample) {
      const fetchStarted = performance.now();
      const fetched = await reader.fetchText(docId);
      timing.textFetchMs.push(performance.now() - fetchStarted);
      if (fetched.state !== "OK") throw new Error(`cannot read ${docId}`);

      // what the verifier derives from the source text today, per candidate
      const deriveStarted = performance.now();
      const wordCount = tokens(fetched.text).length;
      const canonical = canonicalSha256(fetched.text);
      const shingles = documentShingleHashes(fetched.text, shingleSize);
      timing.deriveFromTextMs.push(performance.now() - deriveStarted);

      const encoded = encodeSidecar(identitySha256, wordCount, canonical, shingles);
      writeSync(descriptor, encoded, 0, encoded.length, offset);
      rows.push({ offset, length: encoded.length, words: wordCount, shingles: shingles.size, textCompressedBytes: fetched.metrics.compressedBytesRead, textBytes: fetched.metrics.decompressedBytes, zstdBytes: zstdLevel9(encoded).length });
      offset += encoded.length;

      // the same three values back out of the sidecar
      const readStarted = performance.now();
      const bytes: Bytes = nodeBytes(Buffer.allocUnsafe(encoded.length));
      readSync(descriptor, bytes, 0, encoded.length, offset - encoded.length);
      timing.sidecarReadMs.push(performance.now() - readStarted);
      const decodeStarted = performance.now();
      const decoded = decodeSidecar(bytes, identitySha256);
      timing.sidecarDecodeMs.push(performance.now() - decodeStarted);
      const setStarted = performance.now();
      const asStrings = new Set<string>();
      for (let index = 0; index < decoded.hi.length; index += 1) asStrings.add(`${decoded.hi[index].toString(16).padStart(8, "0")}${decoded.lo[index].toString(16).padStart(8, "0")}`);
      timing.sidecarToStringSetMs.push(performance.now() - setStarted);

      let equal = decoded.wordCount === wordCount && decoded.canonical === canonical && asStrings.size === shingles.size;
      if (equal) for (const hex of shingles) if (!asStrings.has(hex)) equal = false;
      if (!equal) mismatches += 1;

      // the submission-side loop of the verifier (shared count + matched positions), over the text-derived set and over the sidecar
      submissions.forEach((submission, index) => {
        const fromTextStarted = performance.now();
        let sharedText = 0;
        for (const hash of submission.prepared.shingles) if (shingles.has(hash)) sharedText += 1;
        let positionsText = 0;
        for (const hash of submission.prepared.informativeHashes) if (hash !== null && shingles.has(hash)) positionsText += 1;
        matchFromText[index].push(performance.now() - fromTextStarted);
        const fromSidecarStarted = performance.now();
        let positionsSidecar = 0;
        for (const pair of submission.numeric) if (pair !== null && holds(decoded, pair[0], pair[1])) positionsSidecar += 1;
        matchFromSidecar[index].push(performance.now() - fromSidecarStarted);
        if (positionsSidecar !== positionsText) matchDisagreements += 1;
        void sharedText;
      });
    }
    closeSync(descriptor);

    // a sidecar built under another identity must be refused
    let refusal = "not refused";
    try {
      decodeSidecar(encodeSidecar(sha256Hex(JSON.stringify({ ...identity, normalizationVersion: 1 })), 1, "00".repeat(32), new Set(["0000000100000002"])), identitySha256);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }

    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
    const stats = (values: number[]) => ({ mean: round(mean(values), 4), p50: round(percentile(values, 0.5), 4), p95: round(percentile(values, 0.95), 4) });
    const sidecarBytes = sum(rows.map((row) => row.length));
    const textCompressed = sum(rows.map((row) => row.textCompressedBytes));
    const documents = reader.manifest.documentCount;
    const report = {
      identity: reader.identity(),
      sidecarIdentity: identity,
      sidecarIdentitySha256: identitySha256,
      sample: { documents: rows.length, wordsMean: round(mean(rows.map((row) => row.words))), wordsP50: percentile(rows.map((row) => row.words), 0.5), wordsP95: percentile(rows.map((row) => row.words), 0.95) },
      equality: { documentsWhereSidecarDiffersFromTextDerivation: mismatches, matchLoopDisagreements: matchDisagreements },
      identityMismatchRefusal: refusal,
      bytes: {
        sidecarBytesPerDocument: round(sidecarBytes / rows.length),
        sidecarZstdBytesPerDocument: round(sum(rows.map((row) => row.zstdBytes)) / rows.length),
        compressedTextBytesPerDocument: round(textCompressed / rows.length),
        sidecarOverCompressedText: round(sidecarBytes / textCompressed, 2),
        sidecarBytesPerSourceWord: round(sidecarBytes / sum(rows.map((row) => row.words)), 2),
        projectedBytesForThisGeneration: Math.round((sidecarBytes / rows.length) * documents),
        projectedBytesFor1MDocuments: Math.round((sidecarBytes / rows.length) * 1_000_000),
        sampleFileBytes: statSync(file).size,
      },
      perCandidateMs: {
        today: { textFetchAndDecompress: stats(timing.textFetchMs), deriveFromText: stats(timing.deriveFromTextMs) },
        withSidecar: { read: stats(timing.sidecarReadMs), decodeToTypedArrays: stats(timing.sidecarDecodeMs), decodeToStringSetForTheUnmodifiedLoop: stats(timing.sidecarToStringSetMs) },
        matchLoop: submissions.map((submission, index) => ({ submission: submission.id, submissionWords: submission.prepared.words.length, overTextDerivedSet: stats(matchFromText[index]), overSidecarBinarySearch: stats(matchFromSidecar[index]) })),
      },
      note: "read timings are from a file written moments earlier, so the operating system has it cached; a first read from cold storage is not measured here",
    };
    writeJson(requireArgument(args, "out"), report);
    logLine(`${rows.length} documents (mean ${report.sample.wordsMean} words): sidecar ${report.bytes.sidecarBytesPerDocument} B/doc (${report.bytes.sidecarOverCompressedText}x the compressed text; zstd ${report.bytes.sidecarZstdBytesPerDocument}), projected ${round(report.bytes.projectedBytesForThisGeneration / 2 ** 20)} MiB for this generation`);
    logLine(`per candidate today: fetch+decompress ${report.perCandidateMs.today.textFetchAndDecompress.mean} ms + derive ${report.perCandidateMs.today.deriveFromText.mean} ms; with sidecar: read ${report.perCandidateMs.withSidecar.read.mean} ms + decode ${report.perCandidateMs.withSidecar.decodeToTypedArrays.mean} ms (string set: ${report.perCandidateMs.withSidecar.decodeToStringSetForTheUnmodifiedLoop.mean} ms)`);
    for (const row of report.perCandidateMs.matchLoop) logLine(`match loop, ${row.submission} (${row.submissionWords} words): ${row.overTextDerivedSet.mean} ms over the text-derived set, ${row.overSidecarBinarySearch.mean} ms over the sidecar`);
    logLine(`equality: ${mismatches} differing documents, ${matchDisagreements} match-loop disagreements; altered identity -> ${refusal}`);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
