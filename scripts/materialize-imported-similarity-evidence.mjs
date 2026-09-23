import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { get as vercelBlobGet } from "@vercel/blob";
import { IMPORTED_SIMILARITY_EVIDENCE_MATERIALIZED_PACKAGE_PATH } from "../lib/imported-similarity-evidence/materialized-path.ts";

/**
 * BUILD-TIME-ONLY materializer for the imported-similarity-evidence package
 * (see D:\Github\turnitplus-work\tmp\imported-evidence-hosted-delivery-audit\
 * 20260922-224528\recommendation.md — PRIVATE_OBJECT_STORAGE_BUILD_TIME_MATERIALIZATION).
 *
 * Runs as this project's "prebuild" npm lifecycle script, i.e. BEFORE `next
 * build`. With IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY and
 * IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_SHA256 both unset (today's default,
 * everywhere) this is a fast no-op — existing build behavior is byte-for-byte
 * unchanged. When both are set, it fetches ONE private Blob object, verifies
 * its raw file bytes' SHA256 against the pinned value, and atomically
 * materializes it to a fixed, gitignored, server-only path
 * (../lib/imported-similarity-evidence/materialized-path.ts) that
 * lib/imported-similarity-evidence/config.ts's existing, UNCHANGED runtime
 * loader already knows how to fall back to.
 *
 * CRITICAL HASH DISTINCTION (do not conflate): this module verifies the
 * SHA256 of the raw downloaded FILE BYTES against
 * IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_SHA256 — a deployment-time "is this
 * the exact file I meant to activate" check. This is a DIFFERENT hash from
 * the package's own internal `metadata.contentSha256` (a canonical,
 * stable-key-order hash over evidenceSets+units only, computed by
 * lib/imported-similarity-evidence/package.ts and re-verified there, at load
 * time, independently of anything in this file). Both checks run; neither
 * substitutes for the other.
 *
 * PRIVATE ACCESS ONLY: uses @vercel/blob's `get(key, { access: "private" })`
 * — no signed URL, no public URL is ever generated or logged. Never logs
 * package content — only configuration state, byte counts, and hex digests.
 *
 * FAIL-CLOSED, two distinct classes (see the audit's failure-semantics.md):
 *   - BOTH env vars unset -> not configured -> exit 0, no-op, existing
 *     no-package application behavior (contribution 0) is unaffected.
 *   - Configured but unverifiable (missing one var, malformed SHA, fetch
 *     failure, hash mismatch, write failure) -> exit 1 -> the BUILD fails
 *     loudly. A stale destination file from a PRIOR successful build is
 *     always removed as soon as this run is found to be "configured" —
 *     before any fetch is attempted — so a failed run can never leave an
 *     old, unverified-for-THIS-build package looking valid.
 */

const BLOB_KEY_VAR = "IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY";
const SHA_VAR = "IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_SHA256";
const SHA256_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;
/** Build-time only; generous relative to the runtime 4000ms per-call budget
 *  lib/selective-corpus/vercel-blob-storage-adapter.ts uses for LIVE request
 *  traffic — this runs once, off the request path, with no retry loop to
 *  protect (a build failure here is simply re-triggered by a human/CI). */
const BLOB_FETCH_TIMEOUT_MS = 30_000;
const LOG_PREFIX = "[materialize-imported-similarity-evidence]";

function readEnvString(env, key) {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Exactly 64 hex characters; returns the lowercase-normalized digest, or
 *  null if the input is not a syntactically valid SHA256 hex digest. */
function normalizeShaPin(raw) {
  return SHA256_HEX_PATTERN.test(raw) ? raw.toLowerCase() : null;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function removeIfExists(path) {
  rmSync(path, { force: true });
}

async function readStreamToUint8Array(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Narrow injectable seam — same shape as the `get` half of
 *  lib/selective-corpus/vercel-blob-storage-adapter.ts's VercelBlobReadClient.
 *  Production default calls the real @vercel/blob SDK; tests inject a
 *  deterministic fake and make zero network calls. */
const defaultBlobClient = {
  get: (pathname, options) => vercelBlobGet(pathname, options),
};

/**
 * Fetches ONE private Blob object's raw bytes. Returns null for "object does
 * not exist" (mirrors the SDK's own get() contract — a 404 GetBlobResult is
 * `null`). Throws for any other failure (network, auth, unexpected status) —
 * the caller treats any throw as a hard build failure; there is no
 * transient/persistent distinction here (see module header: no retry loop to
 * protect at build time).
 */
async function fetchPrivateBlobBytes(blobKey, client) {
  const result = await client.get(blobKey, {
    access: "private",
    abortSignal: AbortSignal.timeout(BLOB_FETCH_TIMEOUT_MS),
  });
  if (result === null) return null;
  if (result.statusCode !== 200) {
    throw new Error(`unexpected Blob statusCode ${result.statusCode}`);
  }
  return readStreamToUint8Array(result.stream);
}

/**
 * The whole materialization run. Never throws — every failure path returns a
 * typed, non-"materialized"/"not_configured" status; the CLI entry point
 * below is the only place that turns a failing status into process exit 1.
 * Fully injectable (env/destPath/client/log/logError) for deterministic unit
 * tests with zero real I/O.
 */
export async function materializeImportedSimilarityEvidencePackage(options = {}) {
  const env = options.env ?? process.env;
  const destPath = options.destPath ?? IMPORTED_SIMILARITY_EVIDENCE_MATERIALIZED_PACKAGE_PATH;
  const client = options.client ?? defaultBlobClient;
  const log = options.log ?? ((msg) => console.log(`${LOG_PREFIX} ${msg}`));
  const logError = options.logError ?? ((msg) => console.error(`${LOG_PREFIX} ${msg}`));

  const blobKey = readEnvString(env, BLOB_KEY_VAR);
  const shaPinRaw = readEnvString(env, SHA_VAR);

  if (blobKey === null && shaPinRaw === null) {
    log("not configured (both IMPORTED_SIMILARITY_EVIDENCE_PACKAGE_BLOB_KEY and _SHA256 are unset) -- no-op, existing no-package behavior applies.");
    return { status: "not_configured" };
  }

  if (blobKey === null || shaPinRaw === null) {
    const missing = blobKey === null ? BLOB_KEY_VAR : SHA_VAR;
    const present = blobKey === null ? SHA_VAR : BLOB_KEY_VAR;
    logError(`configuration error: ${present} is set but ${missing} is not -- both must be set together, or both left unset. Failing the build.`);
    return { status: "configuration_error", reason: `missing_${missing}` };
  }

  const shaPin = normalizeShaPin(shaPinRaw);
  if (shaPin === null) {
    logError(`configuration error: ${SHA_VAR} is not a valid 64-character hexadecimal SHA256 digest. Failing the build.`);
    return { status: "configuration_error", reason: "malformed_sha256_pin" };
  }

  const destRel = relative(process.cwd(), destPath) || destPath;
  log(`configured: blobKey="${blobKey}", pinnedSha256=${shaPin}, destination=${destRel}`);

  // Clear any stale prior-build output the moment this run is known to be
  // "configured" — BEFORE any fetch is attempted — so a failure below can
  // never leave an old, unverified-for-this-build file in place.
  removeIfExists(destPath);

  let bytes;
  try {
    bytes = await fetchPrivateBlobBytes(blobKey, client);
  } catch (err) {
    logError(`Blob fetch failed for key "${blobKey}": ${err instanceof Error ? err.message : String(err)} -- failing the build.`);
    return { status: "fetch_failed", reason: err instanceof Error ? err.message : String(err) };
  }
  if (bytes === null) {
    logError(`Blob object not found for key "${blobKey}" -- failing the build.`);
    return { status: "fetch_failed", reason: "not_found" };
  }

  const actualSha = sha256Hex(bytes);
  if (actualSha !== shaPin) {
    logError(`SHA256 mismatch for key "${blobKey}": expected ${shaPin}, got ${actualSha} -- failing the build. (Package content is never logged.)`);
    return { status: "hash_mismatch", expected: shaPin, actual: actualSha };
  }

  mkdirSync(dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(tmpPath, bytes);
    renameSync(tmpPath, destPath);
  } catch (err) {
    removeIfExists(tmpPath);
    removeIfExists(destPath);
    logError(`failed to write materialized package: ${err instanceof Error ? err.message : String(err)} -- failing the build.`);
    return { status: "write_failed" };
  }

  // Re-verify the bytes actually on disk (defense in depth against a
  // disk-level write corruption the in-memory check above cannot see).
  let writtenSha;
  try {
    writtenSha = sha256Hex(readFileSync(destPath));
  } catch (err) {
    removeIfExists(destPath);
    logError(`failed to re-read materialized package for verification: ${err instanceof Error ? err.message : String(err)} -- failing the build.`);
    return { status: "write_verify_failed" };
  }
  if (writtenSha !== shaPin) {
    removeIfExists(destPath);
    logError(`materialized file hash mismatch after write: expected ${shaPin}, got ${writtenSha} -- failing the build.`);
    return { status: "write_verify_failed" };
  }

  log(`materialized ${bytes.length} bytes, verified SHA256=${writtenSha}, destination=${destRel}`);
  return { status: "materialized", byteLength: bytes.length, sha256: writtenSha, destPath };
}

const FAILING_STATUSES = new Set(["configuration_error", "fetch_failed", "hash_mismatch", "write_failed", "write_verify_failed"]);

function isRunAsCliEntryPoint() {
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
}

if (isRunAsCliEntryPoint()) {
  const result = await materializeImportedSimilarityEvidencePackage();
  if (FAILING_STATUSES.has(result.status)) {
    process.exitCode = 1;
  }
}
