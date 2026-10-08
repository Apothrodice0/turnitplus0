import { promises as fsp, constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { nodeBytes, type Bytes } from "./bytes";

/**
 * Corpus Engine v1 — the read side of corpus storage.
 *
 * Every artifact is read through this interface and nothing else, and the
 * interface is exactly what an object store offers: whole-object reads, byte
 * RANGE reads, and a size probe. Phase 1 ships only a local-directory
 * implementation on D:, but no reader assumes a filesystem (no directory
 * listing, no mmap, no seek state), so a range-capable object store can be put
 * behind the same calls later.
 *
 * Keys are relative, forward-slash paths. There is deliberately no list
 * operation: a reader may only open what a generation manifest names.
 */

export type CorpusStorageErrorCode = "NOT_FOUND" | "UNREADABLE" | "SHORT_READ" | "INVALID_KEY";

export class CorpusStorageError extends Error {
  readonly code: CorpusStorageErrorCode;
  readonly key: string;
  constructor(code: CorpusStorageErrorCode, key: string, message: string) {
    super(message);
    this.name = "CorpusStorageError";
    this.code = code;
    this.key = key;
  }
}

export type CorpusStorageStats = {
  rangeReads: number;
  wholeReads: number;
  bytesRead: number;
  sizeProbes: number;
  /** Local store only: handles currently held open, and the most ever held. */
  openHandles: number;
  peakOpenHandles: number;
};

export interface CorpusObjectStore {
  /** Exactly `length` bytes starting at `offset`, or SHORT_READ. */
  readRange(key: string, offset: number, length: number): Promise<Bytes>;
  readAll(key: string): Promise<Bytes>;
  /** Object size in bytes; NOT_FOUND when absent. */
  size(key: string): Promise<number>;
  stats(): CorpusStorageStats;
  resetStats(): void;
  close(): Promise<void>;
}

function assertKey(key: string) {
  if (typeof key !== "string" || key.length === 0 || key.includes("\\") || key.startsWith("/") || key.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new CorpusStorageError("INVALID_KEY", String(key), `invalid storage key: ${JSON.stringify(key)}`);
  }
}

function classify(error: unknown, key: string): CorpusStorageError {
  if (error instanceof CorpusStorageError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT" || code === "ENOTDIR") return new CorpusStorageError("NOT_FOUND", key, `object not found: ${key}`);
  return new CorpusStorageError("UNREADABLE", key, `object unreadable: ${key} (${code ?? message})`);
}

/**
 * A directory as an object store. Holds at most `maxOpenHandles` file handles
 * (least-recently-used closed first), so the open-file requirement of a reader
 * is a constant of the configuration, not of the corpus size.
 */
export class LocalDirectoryObjectStore implements CorpusObjectStore {
  private readonly handles = new Map<string, Promise<FileHandle>>();
  private readonly counters: CorpusStorageStats = { rangeReads: 0, wholeReads: 0, bytesRead: 0, sizeProbes: 0, openHandles: 0, peakOpenHandles: 0 };

  constructor(readonly root: string, private readonly maxOpenHandles = 64) {}

  private resolve(key: string) {
    assertKey(key);
    return path.join(this.root, ...key.split("/"));
  }

  private async handle(key: string): Promise<FileHandle> {
    const existing = this.handles.get(key);
    if (existing) {
      this.handles.delete(key);
      this.handles.set(key, existing);
      return existing;
    }
    const opened = fsp.open(this.resolve(key), fsConstants.O_RDONLY);
    this.handles.set(key, opened);
    try {
      await opened;
    } catch (error) {
      this.handles.delete(key);
      throw classify(error, key);
    }
    this.counters.openHandles = this.handles.size;
    this.counters.peakOpenHandles = Math.max(this.counters.peakOpenHandles, this.handles.size);
    if (this.handles.size > this.maxOpenHandles) {
      // Least recently used first; a handle with a read in flight is never closed under it.
      for (const candidate of [...this.handles.keys()]) {
        if (this.handles.size <= this.maxOpenHandles) break;
        if (candidate === key || (this.inFlight.get(candidate) ?? 0) > 0) continue;
        const idle = this.handles.get(candidate);
        this.handles.delete(candidate);
        if (idle) await idle.then((fileHandle) => fileHandle.close()).catch(() => undefined);
      }
    }
    this.counters.openHandles = this.handles.size;
    return opened;
  }

  private readonly inFlight = new Map<string, number>();

  async readRange(key: string, offset: number, length: number): Promise<Bytes> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
      throw new CorpusStorageError("SHORT_READ", key, `invalid range ${offset}+${length} for ${key}`);
    }
    const target = Buffer.allocUnsafe(length);
    if (length === 0) return target;
    let filled = 0;
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    try {
      const fileHandle = await this.handle(key);
      while (filled < length) {
        const { bytesRead } = await fileHandle.read(target, filled, length - filled, offset + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
    } catch (error) {
      throw classify(error, key);
    } finally {
      const pending = (this.inFlight.get(key) ?? 1) - 1;
      if (pending > 0) this.inFlight.set(key, pending);
      else this.inFlight.delete(key);
    }
    this.counters.rangeReads += 1;
    this.counters.bytesRead += filled;
    if (filled !== length) {
      throw new CorpusStorageError("SHORT_READ", key, `short read on ${key}: wanted ${length} bytes at ${offset}, got ${filled}`);
    }
    return target;
  }

  async readAll(key: string): Promise<Bytes> {
    try {
      const bytes = nodeBytes(await fsp.readFile(this.resolve(key)));
      this.counters.wholeReads += 1;
      this.counters.bytesRead += bytes.length;
      return bytes;
    } catch (error) {
      throw classify(error, key);
    }
  }

  async size(key: string): Promise<number> {
    try {
      const info = await fsp.stat(this.resolve(key));
      this.counters.sizeProbes += 1;
      if (!info.isFile()) throw new CorpusStorageError("NOT_FOUND", key, `object not found: ${key}`);
      return info.size;
    } catch (error) {
      throw classify(error, key);
    }
  }

  stats(): CorpusStorageStats {
    return { ...this.counters };
  }

  resetStats() {
    this.counters.rangeReads = 0;
    this.counters.wholeReads = 0;
    this.counters.bytesRead = 0;
    this.counters.sizeProbes = 0;
  }

  async close() {
    const open = [...this.handles.values()];
    this.handles.clear();
    this.counters.openHandles = 0;
    await Promise.all(open.map((pending) => pending.then((fileHandle) => fileHandle.close()).catch(() => undefined)));
  }
}

/**
 * Test seam: wraps a store and makes chosen keys fail, to prove a missing,
 * unreadable or corrupted artifact is reported and never read as "no match".
 */
export class FaultInjectingObjectStore implements CorpusObjectStore {
  private readonly faults = new Map<string, { kind: "missing" | "unreadable" | "corrupt"; atByte?: number }>();

  constructor(private readonly inner: CorpusObjectStore) {}

  setFault(key: string, kind: "missing" | "unreadable" | "corrupt", atByte?: number) {
    this.faults.set(key, { kind, atByte });
  }

  clearFaults() {
    this.faults.clear();
  }

  private check(key: string) {
    const fault = this.faults.get(key);
    if (fault?.kind === "missing") throw new CorpusStorageError("NOT_FOUND", key, `object not found: ${key}`);
    if (fault?.kind === "unreadable") throw new CorpusStorageError("UNREADABLE", key, `object unreadable: ${key} (injected)`);
    return fault;
  }

  async readRange(key: string, offset: number, length: number) {
    const fault = this.check(key);
    const bytes = await this.inner.readRange(key, offset, length);
    if (fault?.kind === "corrupt") {
      const at = fault.atByte ?? offset;
      if (at >= offset && at < offset + length) bytes[at - offset] ^= 0x5a;
      else if (fault.atByte === undefined && length > 0) bytes[0] ^= 0x5a;
    }
    return bytes;
  }

  async readAll(key: string) {
    const fault = this.check(key);
    const bytes = await this.inner.readAll(key);
    if (fault?.kind === "corrupt" && bytes.length > 0) bytes[Math.min(fault.atByte ?? Math.floor(bytes.length / 2), bytes.length - 1)] ^= 0x5a;
    return bytes;
  }

  async size(key: string) {
    this.check(key);
    return this.inner.size(key);
  }

  stats() {
    return this.inner.stats();
  }

  resetStats() {
    this.inner.resetStats();
  }

  close() {
    return this.inner.close();
  }
}
