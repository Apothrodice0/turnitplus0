import { createHash } from "node:crypto";
import { assertArtifactRelativeKey } from "./storage-adapter";

/**
 * Selective Corpus V1 SHADOW slice — minimal per-object integrity contract.
 *
 * Scope is deliberately narrow: a small immutable sidecar manifest
 * ("object-integrity.json", read as an ordinary artifact-relative object
 * through the SAME SelectiveCorpusStorageAdapter as everything else) mapping
 * an artifact-relative object key to its expected SHA-256 + byte length. It
 * exists ONLY to let a future remote/object-store adapter prove — without
 * trusting the transport — that the exact bytes it returned for a packed
 * shard or a candidate source-text object are the bytes that were actually
 * published. It does NOT redesign the corpus format, does NOT content-address
 * keys, and does NOT compress anything.
 *
 * FAIL CLOSED: any malformed manifest (bad JSON, wrong shape, a duplicate
 * key, a malformed digest, a malformed byte length, a non-artifact-relative
 * key) is rejected at PARSE time, before a single object is verified against
 * it. An object read while integrity is required but which has NO manifest
 * entry is rejected at VERIFICATION time — an absent entry is never treated
 * as "verification not needed here", since that would silently reintroduce
 * exactly the trust gap this module exists to close.
 */

export type SelectiveCorpusIntegrityEntry = {
  readonly sha256: string;
  readonly byteLength: number;
};

export type SelectiveCorpusIntegrityManifestErrorCode =
  | "MALFORMED_JSON"
  | "MALFORMED_SHAPE"
  | "BAD_KEY"
  | "DUPLICATE_KEY"
  | "BAD_DIGEST"
  | "BAD_BYTE_LENGTH";

export class SelectiveCorpusIntegrityManifestError extends Error {
  readonly code: SelectiveCorpusIntegrityManifestErrorCode;
  constructor(code: SelectiveCorpusIntegrityManifestErrorCode, message: string) {
    super(message);
    this.name = "SelectiveCorpusIntegrityManifestError";
    this.code = code;
  }
}

export type SelectiveCorpusIntegrityMismatchReason = "SHA256" | "BYTE_LENGTH" | "UNKNOWN_ENTRY";

/** Thrown by verifySelectiveCorpusObjectIntegrity(). Callers (shard-reader.ts,
 *  source-loader.ts) catch this specifically to classify the failure as
 *  PERSISTENT ("INTEGRITY_MISMATCH") — a corrected retry is never assumed;
 *  see storage-adapter.ts's transient/persistent distinction. */
export class SelectiveCorpusIntegrityMismatchError extends Error {
  readonly key: string;
  readonly reason: SelectiveCorpusIntegrityMismatchReason;
  constructor(key: string, reason: SelectiveCorpusIntegrityMismatchReason, message: string) {
    super(message);
    this.name = "SelectiveCorpusIntegrityMismatchError";
    this.key = key;
    this.reason = reason;
  }
}

/** Immutable, parsed manifest — a plain lookup, deliberately without any
 *  mutation surface (no set/delete) since it represents a frozen sidecar
 *  object read once at artifact-load time. */
export interface SelectiveCorpusIntegrityManifest {
  get(key: string): SelectiveCorpusIntegrityEntry | undefined;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

type RawManifestShape = { objects: unknown[] };

/**
 * Parses "object-integrity.json" bytes into a SelectiveCorpusIntegrityManifest.
 * Deliberately an ARRAY of {key, sha256, byteLength} entries (not a JSON
 * object keyed by object key) so a duplicate key is trivially and reliably
 * detectable — a JSON object literal with a repeated key would already have
 * silently collapsed to the last occurrence by the time JSON.parse returns,
 * which would make "duplicate keys rejected" unenforceable.
 */
export function parseSelectiveCorpusIntegrityManifest(bytes: Uint8Array): SelectiveCorpusIntegrityManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new SelectiveCorpusIntegrityManifestError("MALFORMED_JSON", "object-integrity.json is not valid JSON");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as Partial<RawManifestShape>).objects)
  ) {
    throw new SelectiveCorpusIntegrityManifestError(
      "MALFORMED_SHAPE",
      'object-integrity.json must be shaped { "objects": [ { "key", "sha256", "byteLength" }, ... ] }',
    );
  }

  const entries = new Map<string, SelectiveCorpusIntegrityEntry>();
  for (const raw of (parsed as RawManifestShape).objects) {
    if (!raw || typeof raw !== "object") {
      throw new SelectiveCorpusIntegrityManifestError("MALFORMED_SHAPE", "each integrity entry must be an object");
    }
    const { key, sha256, byteLength } = raw as Record<string, unknown>;

    if (typeof key !== "string" || key.length === 0) {
      throw new SelectiveCorpusIntegrityManifestError("BAD_KEY", `integrity entry has an invalid key: ${JSON.stringify(key)}`);
    }
    try {
      assertArtifactRelativeKey(key);
    } catch {
      throw new SelectiveCorpusIntegrityManifestError("BAD_KEY", `integrity entry key is not artifact-relative: ${key}`);
    }
    if (entries.has(key)) {
      throw new SelectiveCorpusIntegrityManifestError("DUPLICATE_KEY", `duplicate integrity entry key: ${key}`);
    }
    if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) {
      throw new SelectiveCorpusIntegrityManifestError("BAD_DIGEST", `integrity entry for ${key} has a malformed sha256 digest (must be 64 lowercase hex chars)`);
    }
    if (typeof byteLength !== "number" || !Number.isInteger(byteLength) || byteLength < 0) {
      throw new SelectiveCorpusIntegrityManifestError("BAD_BYTE_LENGTH", `integrity entry for ${key} has a malformed byteLength (must be a non-negative integer)`);
    }
    entries.set(key, { sha256, byteLength });
  }

  return {
    get(key: string) {
      return entries.get(key);
    },
  };
}

/**
 * Verifies one object's exact bytes against the manifest. THROWS
 * SelectiveCorpusIntegrityMismatchError — never returns a boolean — so a
 * caller cannot accidentally forget to check a return value and use
 * unverified bytes. Order matches the task contract: byte length first (a
 * cheap, immediate signal of a truncated/wrong object) then SHA-256.
 *
 * An object with NO manifest entry is FAIL CLOSED as "UNKNOWN_ENTRY" — never
 * silently treated as "integrity not required for this one".
 */
export function verifySelectiveCorpusObjectIntegrity(
  key: string,
  bytes: Uint8Array,
  manifest: SelectiveCorpusIntegrityManifest,
): void {
  const entry = manifest.get(key);
  if (!entry) {
    throw new SelectiveCorpusIntegrityMismatchError(key, "UNKNOWN_ENTRY", `no integrity manifest entry for ${key} — fail closed`);
  }
  if (bytes.length !== entry.byteLength) {
    throw new SelectiveCorpusIntegrityMismatchError(
      key,
      "BYTE_LENGTH",
      `${key}: expected ${entry.byteLength} bytes, got ${bytes.length}`,
    );
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== entry.sha256) {
    throw new SelectiveCorpusIntegrityMismatchError(key, "SHA256", `${key}: sha256 mismatch`);
  }
}
