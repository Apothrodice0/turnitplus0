import { closeSync, existsSync, fstatSync, fsyncSync, openSync, readSync, truncateSync, writeSync } from "node:fs";
import type { Bytes } from "./bytes";
import { BUILD_LEDGER_VERSION } from "./versions";

/**
 * Corpus Engine v1 — build-ledger-v1: the durable record of one build.
 *
 * Ingestion is a state machine whose state is THIS FILE, not process memory:
 *
 *   source  discovered -> fetched -> extracted -> normalized -> deduplicated
 *           -> fingerprinted -> packed (staged)            ... one "source" line,
 *                                                              durable at COMMIT
 *   batch   committed (runs spilled + staging fsync'd)     ... one "commit" line
 *   segment indexed                                        ... "segment-committed"
 *   build   generation built                               ... "generation-built"
 *
 * (Validation and publication are recorded in the corpus root's activation
 * log — they are properties of a generation, not of the build that made it.)
 *
 * A batch is ATOMIC: its source lines and its commit line are appended in one
 * write and fsync'd, after the batch's staged text and spilled runs are
 * already durable. On restart, everything up to the last commit line is
 * trusted and everything after it is discarded and truncated away, the
 * staging file is cut back to the committed length, and unreferenced run
 * files are deleted. So a crash after source N never restarts the build, a
 * committed source is never ingested twice, and no posting can be emitted
 * twice. A JSON-lines file on D: is deliberately all this is — the production
 * database is never used for build state.
 */

export type LedgerSourceState = "NEW" | "ALIAS_IN_BUILD" | "ALIAS_OF_EXISTING" | "REJECTED_EMPTY" | "REJECTED_REVOKED";

export type LedgerStagedText = {
  offset: number;
  spanLength: number;
  uncompressedLength: number;
  chunkCount: number;
  sha256: string;
  codec: number;
};

/** One supplied source and what became of it. `alias` is the provenance record stored in metadata. */
export type LedgerSourceRecord = {
  type: "source";
  sourceKey: string;
  state: LedgerSourceState;
  synthetic: boolean;
  rawContentSha256: string;
  /** Absent for a rejected-empty source. */
  docId?: string;
  normalizedContentSha256?: string;
  tokenCount?: number;
  fingerprintCount?: number;
  partition?: number;
  /** Present when this source's text is (now) the stored text of its document. */
  staged?: LedgerStagedText;
  alias: Record<string, unknown>;
};

export type LedgerRunRecord = { partition: number; file: string; tuples: number; bytes: number; sha256: string };

export type LedgerCommitRecord = {
  type: "commit";
  sequence: number;
  sourcesCommitted: number;
  stagingBytes: number;
  runs: LedgerRunRecord[];
};

export type LedgerStartRecord = {
  type: "build-start";
  ledgerVersion: string;
  buildId: string;
  parentGenerationId: string | null;
  partitionBits: number;
  normalizationProbeSha256: string;
  fingerprintProbeSha256: string;
};

export type LedgerSegmentRecord = {
  type: "segment-committed";
  partition: number;
  segmentId: string;
  manifestSha256: string;
  documentCount: number;
  keyCount: number;
  postingsCount: number;
  fileCount: number;
  bytes: number;
  aliasAddendumCount: number;
};

export type LedgerGenerationRecord = { type: "generation-built"; generationId: string; logicalManifestSha256: string };

export type LedgerRecord = LedgerStartRecord | LedgerSourceRecord | LedgerCommitRecord | LedgerSegmentRecord | LedgerGenerationRecord;

/** What the builder keeps resident per source: its outcome and where its ledger line is, not the line itself. */
export type LedgerSourceEntry = {
  state: LedgerSourceState;
  docId: string | null;
  synthetic: boolean;
  lineOffset: number;
  lineLength: number;
};

/** How much of the ledger file is read at a time when it is replayed. */
const LEDGER_REPLAY_CHUNK_BYTES = 4 << 20;

export class BuildLedger {
  start: LedgerStartRecord | null = null;
  readonly sources = new Map<string, LedgerSourceEntry>();
  /** Source records in commit order, WITHOUT their alias payload — replayed on resume to rebuild the document table. */
  readonly committedSourceRecords: LedgerSourceRecord[] = [];
  readonly runs: LedgerRunRecord[] = [];
  readonly segments = new Map<number, LedgerSegmentRecord>();
  generation: LedgerGenerationRecord | null = null;
  commitCount = 0;
  stagingBytes = 0;
  /** Bytes of trailing, uncommitted ledger content dropped when the ledger was opened. */
  discardedTailBytes = 0;
  private length = 0;
  private descriptor = -1;

  private constructor(readonly file: string) {}

  /** Opens (or creates) the ledger, replays it, and cuts off anything after the last durable record. */
  static open(file: string, options: { keepSourceRecords?: boolean } = {}): BuildLedger {
    const ledger = new BuildLedger(file);
    let durableEnd = 0;
    let fileBytes = 0;
    let pending: Array<{ record: LedgerSourceRecord; offset: number; length: number }> = [];
    // Returns false when replay must stop: nothing after a torn or misplaced record is trusted.
    const replayLine = (line: Bytes, offset: number): boolean => {
      let record: LedgerRecord;
      try {
        record = JSON.parse(line.toString("utf8", 0, line.length - 1)) as LedgerRecord;
      } catch {
        return false;
      }
      if (record.type === "source") {
        // The alias/provenance payload stays on disk; it is re-read per document at finalize.
        pending.push({ record: { ...record, alias: {} }, offset, length: line.length });
      } else if (record.type === "commit") {
        for (const item of pending) {
          ledger.sources.set(item.record.sourceKey, {
            state: item.record.state,
            docId: item.record.docId ?? null,
            synthetic: item.record.synthetic,
            lineOffset: item.offset,
            lineLength: item.length,
          });
          if (options.keepSourceRecords !== false) ledger.committedSourceRecords.push(item.record);
        }
        pending = [];
        ledger.runs.push(...record.runs);
        ledger.commitCount = record.sequence;
        ledger.stagingBytes = record.stagingBytes;
        durableEnd = offset + line.length;
      } else {
        if (pending.length > 0) return false; // a non-source record can only follow a commit
        if (record.type === "build-start") ledger.start = record;
        else if (record.type === "segment-committed") ledger.segments.set(record.partition, record);
        else if (record.type === "generation-built") ledger.generation = record;
        durableEnd = offset + line.length;
      }
      return true;
    };
    if (existsSync(file)) {
      // Streamed: the file is never held whole, so its size is not bounded by what one buffer can hold.
      const descriptor = openSync(file, "r");
      try {
        const chunk: Bytes = Buffer.allocUnsafe(LEDGER_REPLAY_CHUNK_BYTES);
        let carry: Bytes = Buffer.alloc(0);
        let carryOffset = 0;
        let position = 0;
        replay: for (;;) {
          const read = readSync(descriptor, chunk, 0, chunk.length, position);
          if (read === 0) break; // whatever is left in `carry` is a torn final line
          let start = 0;
          for (;;) {
            const newline = chunk.indexOf(0x0a, start);
            if (newline < 0 || newline >= read) break;
            const piece = chunk.subarray(start, newline + 1);
            const line: Bytes = carry.length > 0 ? Buffer.concat([carry, piece]) : piece;
            const lineOffset = carry.length > 0 ? carryOffset : position + start;
            carry = Buffer.alloc(0);
            if (!replayLine(line, lineOffset)) break replay;
            start = newline + 1;
          }
          if (start < read) {
            if (carry.length === 0) carryOffset = position + start;
            carry = Buffer.concat([carry, chunk.subarray(start, read)]);
          }
          position += read;
        }
        fileBytes = fstatSync(descriptor).size;
      } finally {
        closeSync(descriptor);
      }
    }
    ledger.discardedTailBytes = fileBytes - durableEnd;
    if (ledger.discardedTailBytes > 0) truncateSync(file, durableEnd);
    ledger.length = durableEnd;
    ledger.descriptor = openSync(file, "a");
    return ledger;
  }

  /** Durable bytes of the ledger file. */
  get byteLength() {
    return this.length;
  }

  /** Appends records as one write and makes them durable before returning. */
  append(records: LedgerRecord[]) {
    if (records.length === 0) return;
    const lines = records.map((record) => `${JSON.stringify(record)}\n`);
    const bytes = Buffer.from(lines.join(""), "utf8");
    writeSync(this.descriptor, bytes);
    fsyncSync(this.descriptor);
    let offset = this.length;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const lineLength = Buffer.byteLength(lines[index], "utf8");
      if (record.type === "source") {
        this.sources.set(record.sourceKey, { state: record.state, docId: record.docId ?? null, synthetic: record.synthetic, lineOffset: offset, lineLength });
      } else if (record.type === "commit") {
        this.runs.push(...record.runs);
        this.commitCount = record.sequence;
        this.stagingBytes = record.stagingBytes;
      } else if (record.type === "build-start") this.start = record;
      else if (record.type === "segment-committed") this.segments.set(record.partition, record);
      else if (record.type === "generation-built") this.generation = record;
      offset += lineLength;
    }
    this.length = offset;
  }

  /** Re-reads one committed source line (its alias/provenance record is not kept in memory). */
  readSourceRecord(entry: LedgerSourceEntry): LedgerSourceRecord {
    if (this.readDescriptor < 0) this.readDescriptor = openSync(this.file, "r");
    const bytes: Bytes = Buffer.allocUnsafe(entry.lineLength);
    readSync(this.readDescriptor, bytes, 0, entry.lineLength, entry.lineOffset);
    return JSON.parse(bytes.toString("utf8")) as LedgerSourceRecord;
  }

  private readDescriptor = -1;

  close() {
    if (this.descriptor >= 0) closeSync(this.descriptor);
    if (this.readDescriptor >= 0) closeSync(this.readDescriptor);
    this.descriptor = -1;
    this.readDescriptor = -1;
  }
}

export function newBuildStartRecord(fields: Omit<LedgerStartRecord, "type" | "ledgerVersion">): LedgerStartRecord {
  return { type: "build-start", ledgerVersion: BUILD_LEDGER_VERSION, ...fields };
}
