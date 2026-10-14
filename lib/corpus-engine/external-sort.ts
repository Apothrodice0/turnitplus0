import { closeSync, fsyncSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Bytes } from "./bytes";

/**
 * Corpus Engine v1 — bounded-memory construction of (fingerprint, document id)
 * postings by external sort.
 *
 * The builder never holds every tuple. It fills a fixed-capacity buffer, sorts
 * it, and spills it to disk as a RUN: a file of 16-byte records
 * (fingerprint u64 BE, document id u64 BE) in ascending order, exact duplicates
 * removed. Runs are then merged k-way with one small read buffer per run, and
 * the merged stream is handed to the segment writer one fingerprint group at a
 * time. Peak memory is the run buffer plus `fanIn` read buffers plus the
 * largest single postings list — none of which grows with the total number of
 * postings. When there are more runs than `maxFanIn`, groups of runs are first
 * merged into longer intermediate runs (a multi-pass merge), so the open-file
 * count is bounded too.
 *
 * Tuples are kept as four uint32 columns and compared as numbers: no BigInt is
 * allocated per tuple anywhere on this path.
 */

export const RUN_RECORD_BYTES = 16;

export type RunFile = { path: string; tuples: number; bytes: number; sha256: string };

/** Fixed-capacity tuple buffer. `add` returns false when full — the caller spills and retries. */
export class RunBuffer {
  private readonly fingerprintHi: Uint32Array;
  private readonly fingerprintLo: Uint32Array;
  private readonly docHi: Uint32Array;
  private readonly docLo: Uint32Array;
  count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("run buffer capacity must be a positive integer");
    this.fingerprintHi = new Uint32Array(capacity);
    this.fingerprintLo = new Uint32Array(capacity);
    this.docHi = new Uint32Array(capacity);
    this.docLo = new Uint32Array(capacity);
  }

  get bytes() {
    return this.capacity * 16;
  }

  add(fingerprintHi: number, fingerprintLo: number, docHi: number, docLo: number): boolean {
    if (this.count >= this.capacity) return false;
    this.fingerprintHi[this.count] = fingerprintHi;
    this.fingerprintLo[this.count] = fingerprintLo;
    this.docHi[this.count] = docHi;
    this.docLo[this.count] = docLo;
    this.count += 1;
    return true;
  }

  clear() {
    this.count = 0;
  }

  /**
   * Sorts and writes the buffer as a run (temp name, fsync, rename), dropping
   * exact duplicate tuples, then clears it. Returns null for an empty buffer.
   */
  spill(targetPath: string): RunFile | null {
    if (this.count === 0) return null;
    const { fingerprintHi, fingerprintLo, docHi, docLo } = this;
    const order = new Uint32Array(this.count);
    for (let index = 0; index < this.count; index += 1) order[index] = index;
    order.sort((left, right) =>
      fingerprintHi[left] - fingerprintHi[right]
      || fingerprintLo[left] - fingerprintLo[right]
      || docHi[left] - docHi[right]
      || docLo[left] - docLo[right]);

    const temporary = `${targetPath}.tmp`;
    const descriptor = openSync(temporary, "w");
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(RUN_RECORD_BYTES * 4096);
    let filled = 0;
    let written = 0;
    let previous = -1;
    for (let position = 0; position < order.length; position += 1) {
      const index = order[position];
      if (
        previous >= 0
        && fingerprintHi[index] === fingerprintHi[previous] && fingerprintLo[index] === fingerprintLo[previous]
        && docHi[index] === docHi[previous] && docLo[index] === docLo[previous]
      ) continue;
      previous = index;
      chunk.writeUInt32BE(fingerprintHi[index], filled);
      chunk.writeUInt32BE(fingerprintLo[index], filled + 4);
      chunk.writeUInt32BE(docHi[index], filled + 8);
      chunk.writeUInt32BE(docLo[index], filled + 12);
      filled += RUN_RECORD_BYTES;
      written += 1;
      if (filled === chunk.length) {
        writeSync(descriptor, chunk, 0, filled);
        hash.update(chunk.subarray(0, filled));
        filled = 0;
      }
    }
    if (filled > 0) {
      writeSync(descriptor, chunk, 0, filled);
      hash.update(chunk.subarray(0, filled));
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    renameSync(temporary, targetPath);
    this.clear();
    return { path: targetPath, tuples: written, bytes: written * RUN_RECORD_BYTES, sha256: hash.digest("hex") };
  }
}

class RunCursor {
  fingerprintHi = 0;
  fingerprintLo = 0;
  docHi = 0;
  docLo = 0;
  done = false;
  private readonly descriptor: number;
  private readonly buffer: Bytes;
  private filled = 0;
  private position = 0;
  private fileOffset = 0;

  constructor(readonly file: string, readBufferBytes: number) {
    this.descriptor = openSync(file, "r");
    this.buffer = Buffer.allocUnsafe(Math.max(RUN_RECORD_BYTES, Math.floor(readBufferBytes / RUN_RECORD_BYTES) * RUN_RECORD_BYTES));
    this.advance();
  }

  advance() {
    if (this.position >= this.filled) {
      this.filled = readSync(this.descriptor, this.buffer, 0, this.buffer.length, this.fileOffset);
      this.fileOffset += this.filled;
      this.position = 0;
      if (this.filled === 0) {
        this.done = true;
        return;
      }
      if (this.filled % RUN_RECORD_BYTES !== 0) throw new Error(`run file ${this.file} is not a whole number of ${RUN_RECORD_BYTES}-byte records`);
    }
    this.fingerprintHi = this.buffer.readUInt32BE(this.position);
    this.fingerprintLo = this.buffer.readUInt32BE(this.position + 4);
    this.docHi = this.buffer.readUInt32BE(this.position + 8);
    this.docLo = this.buffer.readUInt32BE(this.position + 12);
    this.position += RUN_RECORD_BYTES;
  }

  close() {
    closeSync(this.descriptor);
  }
}

function cursorLess(left: RunCursor, right: RunCursor) {
  if (left.fingerprintHi !== right.fingerprintHi) return left.fingerprintHi < right.fingerprintHi;
  if (left.fingerprintLo !== right.fingerprintLo) return left.fingerprintLo < right.fingerprintLo;
  if (left.docHi !== right.docHi) return left.docHi < right.docHi;
  return left.docLo < right.docLo;
}

/** Binary min-heap of run cursors, ordered by their current tuple. */
class CursorHeap {
  private readonly items: RunCursor[] = [];

  get size() {
    return this.items.length;
  }

  push(cursor: RunCursor) {
    this.items.push(cursor);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!cursorLess(this.items[index], this.items[parent])) break;
      [this.items[index], this.items[parent]] = [this.items[parent], this.items[index]];
      index = parent;
    }
  }

  top() {
    return this.items[0];
  }

  /** Re-sinks the top after its cursor advanced, or drops it when exhausted. */
  settle() {
    if (this.items[0].done) {
      const last = this.items.pop() as RunCursor;
      if (this.items.length === 0) return;
      this.items[0] = last;
    }
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.items.length && cursorLess(this.items[left], this.items[smallest])) smallest = left;
      if (right < this.items.length && cursorLess(this.items[right], this.items[smallest])) smallest = right;
      if (smallest === index) return;
      [this.items[index], this.items[smallest]] = [this.items[smallest], this.items[index]];
      index = smallest;
    }
  }
}

/** Visits every distinct tuple of `files` in ascending order. Duplicates across runs are emitted once. */
function mergeOnce(
  files: readonly string[],
  readBufferBytes: number,
  visit: (fingerprintHi: number, fingerprintLo: number, docHi: number, docLo: number) => void,
) {
  const heap = new CursorHeap();
  const cursors = files.map((file) => new RunCursor(file, readBufferBytes));
  try {
    for (const cursor of cursors) if (!cursor.done) heap.push(cursor);
    let hasPrevious = false;
    let previousFingerprintHi = 0;
    let previousFingerprintLo = 0;
    let previousDocHi = 0;
    let previousDocLo = 0;
    while (heap.size > 0) {
      const cursor = heap.top();
      const { fingerprintHi, fingerprintLo, docHi, docLo } = cursor;
      if (
        !hasPrevious
        || fingerprintHi !== previousFingerprintHi || fingerprintLo !== previousFingerprintLo
        || docHi !== previousDocHi || docLo !== previousDocLo
      ) {
        visit(fingerprintHi, fingerprintLo, docHi, docLo);
        hasPrevious = true;
        previousFingerprintHi = fingerprintHi;
        previousFingerprintLo = fingerprintLo;
        previousDocHi = docHi;
        previousDocLo = docLo;
      }
      cursor.advance();
      heap.settle();
    }
  } finally {
    for (const cursor of cursors) cursor.close();
  }
}

export type MergeStats = {
  inputRuns: number;
  passes: number;
  intermediateRuns: number;
  /** Bytes of intermediate runs written by the extra passes (temporary, deleted before returning). */
  intermediateBytes: number;
  /** The most intermediate bytes on disk at once. */
  peakIntermediateBytes: number;
  maxFanInUsed: number;
  tuplesOut: number;
};

/**
 * Merges `files` and calls `visit` once per distinct tuple, ascending. With
 * more than `maxFanIn` runs it first merges groups of `maxFanIn` into
 * intermediate runs under `scratchDirectory`, repeatedly, until one pass can
 * finish the job; intermediate runs are deleted as soon as they are consumed.
 */
export function mergeRuns(
  files: readonly string[],
  options: { maxFanIn: number; readBufferBytes: number; scratchDirectory: string; scratchPrefix: string },
  visit: (fingerprintHi: number, fingerprintLo: number, docHi: number, docLo: number) => void,
): MergeStats {
  if (!Number.isInteger(options.maxFanIn) || options.maxFanIn < 2) throw new RangeError("maxFanIn must be an integer >= 2");
  const stats: MergeStats = { inputRuns: files.length, passes: 0, intermediateRuns: 0, intermediateBytes: 0, peakIntermediateBytes: 0, maxFanInUsed: 0, tuplesOut: 0 };
  let current = [...files];
  const intermediates = new Set<string>();
  let liveIntermediateBytes = 0;
  let generation = 0;

  while (current.length > options.maxFanIn) {
    const next: string[] = [];
    for (let start = 0; start < current.length; start += options.maxFanIn) {
      const group = current.slice(start, start + options.maxFanIn);
      if (group.length === 1) {
        next.push(group[0]);
        continue;
      }
      const target = path.join(options.scratchDirectory, `${options.scratchPrefix}-pass${generation}-${String(next.length).padStart(5, "0")}.run`);
      const descriptor = openSync(target, "w");
      const chunk = Buffer.allocUnsafe(RUN_RECORD_BYTES * 4096);
      let filled = 0;
      mergeOnce(group, options.readBufferBytes, (fingerprintHi, fingerprintLo, docHi, docLo) => {
        chunk.writeUInt32BE(fingerprintHi, filled);
        chunk.writeUInt32BE(fingerprintLo, filled + 4);
        chunk.writeUInt32BE(docHi, filled + 8);
        chunk.writeUInt32BE(docLo, filled + 12);
        filled += RUN_RECORD_BYTES;
        if (filled === chunk.length) {
          writeSync(descriptor, chunk, 0, filled);
          filled = 0;
        }
      });
      if (filled > 0) writeSync(descriptor, chunk, 0, filled);
      fsyncSync(descriptor);
      closeSync(descriptor);
      const bytes = statSync(target).size;
      stats.intermediateRuns += 1;
      stats.intermediateBytes += bytes;
      liveIntermediateBytes += bytes;
      stats.peakIntermediateBytes = Math.max(stats.peakIntermediateBytes, liveIntermediateBytes);
      stats.maxFanInUsed = Math.max(stats.maxFanInUsed, group.length);
      for (const consumed of group) {
        if (intermediates.delete(consumed)) {
          liveIntermediateBytes -= statSync(consumed).size;
          unlinkSync(consumed);
        }
      }
      intermediates.add(target);
      next.push(target);
    }
    current = next;
    generation += 1;
    stats.passes += 1;
  }

  stats.maxFanInUsed = Math.max(stats.maxFanInUsed, current.length);
  stats.passes += 1;
  try {
    mergeOnce(current, options.readBufferBytes, (fingerprintHi, fingerprintLo, docHi, docLo) => {
      stats.tuplesOut += 1;
      visit(fingerprintHi, fingerprintLo, docHi, docLo);
    });
  } finally {
    for (const leftover of intermediates) {
      try {
        unlinkSync(leftover);
      } catch {
        // already gone
      }
    }
  }
  return stats;
}
