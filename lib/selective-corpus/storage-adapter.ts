import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * Selective Corpus V1 SHADOW slice — minimal object-storage abstraction.
 *
 * FIRST step toward external storage (see the storage-readiness audit this
 * slice's own header comments reference): every filesystem assumption in
 * artifact.ts / shard-reader.ts / source-loader.ts is threaded through this
 * one narrow interface instead of calling node:fs directly. This file adds
 * ONLY a local-filesystem implementation — no network code, no vendor SDK,
 * no credentials, no remote-storage concept of any kind. A future task can
 * add a second implementation of the SAME interface without touching
 * Stage A / verify.ts / shadow.ts at all, which is the entire point of
 * putting the boundary here rather than deeper in the call chain.
 *
 * Keys are always ARTIFACT-RELATIVE (e.g. "corpus-version.json",
 * "packed/shard-000.bin", "raw/A-000001.txt") — never an absolute path, never
 * user/candidate-controlled input. The local adapter resolves a key against
 * its own fixed root and rejects anything that would resolve outside it, so
 * a malformed docmap rawId can never read outside the configured artifact
 * directory.
 */

/** Thrown by readObject() when the object does not exist — lets every caller
 *  distinguish "missing" from "exists but unreadable/corrupt" without any
 *  adapter-specific error-code sniffing, the same distinction
 *  artifact.ts / shard-reader.ts already made against existsSync/ENOENT. */
export class SelectiveCorpusObjectNotFoundError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`selective-corpus object not found: ${key}`);
    this.name = "SelectiveCorpusObjectNotFoundError";
    this.key = key;
  }
}

export interface SelectiveCorpusStorageAdapter {
  /** Reads one object's complete, exact bytes. Throws
   *  SelectiveCorpusObjectNotFoundError if the object does not exist; throws
   *  a plain Error for any other read failure (permission, I/O error, etc.). */
  readObject(key: string): Promise<Uint8Array>;
  /** True iff the object exists and is readable-in-principle. Never throws
   *  for an ORDINARY missing object (any stat/read error there resolves to
   *  "false", the same catch-all semantics the prior existsSync() call sites
   *  relied on) — but DOES throw/reject for an invalid or traversal-attempt
   *  key, the same as readObject(): that is a rejected key, not an honest
   *  existence question, and must never be silently reported as "false". */
  objectExists(key: string): Promise<boolean>;
}

function fsErrCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}

/** Rejects an absolute path, a Windows drive-letter path, or any segment
 *  that would climb above the artifact root — BEFORE the key ever reaches
 *  node:path/node:fs, so a traversal attempt fails the same way regardless
 *  of the host OS's own path-separator quirks. */
function assertArtifactRelativeKey(key: string): void {
  if (typeof key !== "string" || key.length === 0 || key.includes("\0")) {
    throw new Error(`invalid selective-corpus object key: ${JSON.stringify(key)}`);
  }
  const normalized = key.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`selective-corpus object key must be artifact-relative, got an absolute path: ${key}`);
  }
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new Error(`selective-corpus object key must not contain "..": ${key}`);
  }
}

/**
 * Local-filesystem implementation — the ONLY implementation this task adds.
 * Every read is anchored to `rootDir` (resolved once at construction) and
 * re-verified per call to stay inside it even after resolution, a
 * belt-and-suspenders check against the segment-level guard above. Performs
 * NO writes — the interface has no write method, and neither function below
 * ever opens a file for anything but reading.
 */
export function createLocalFilesystemStorageAdapter(rootDir: string): SelectiveCorpusStorageAdapter {
  const root = resolve(rootDir);

  function resolveWithinRoot(key: string): string {
    assertArtifactRelativeKey(key);
    const full = resolve(root, key);
    const rel = relative(root, full);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`selective-corpus object key escapes the artifact root: ${key}`);
    }
    return full;
  }

  return {
    async readObject(key: string): Promise<Uint8Array> {
      const path = resolveWithinRoot(key);
      try {
        return await readFile(path);
      } catch (err) {
        if (fsErrCode(err) === "ENOENT") throw new SelectiveCorpusObjectNotFoundError(key);
        throw err;
      }
    },
    async objectExists(key: string): Promise<boolean> {
      const path = resolveWithinRoot(key);
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}
