import {
  get as vercelBlobGet,
  head as vercelBlobHead,
  BlobError,
  BlobNotFoundError,
  BlobAccessError,
  BlobStoreNotFoundError,
  BlobStoreSuspendedError,
  BlobServiceNotAvailable,
  BlobServiceRateLimited,
  BlobRequestAbortedError,
  type GetBlobResult,
  type HeadBlobResult,
} from "@vercel/blob";
import {
  SelectiveCorpusObjectNotFoundError,
  SelectiveCorpusTransientStorageError,
  assertArtifactRelativeKey,
  type SelectiveCorpusStorageAdapter,
} from "./storage-adapter";

/**
 * Selective Corpus V1 — production READ-ONLY storage adapter over Vercel
 * Private Blob, implementing the SAME SelectiveCorpusStorageAdapter interface
 * as the local-filesystem adapter (storage-adapter.ts). CODE ONLY: this file
 * never creates a Blob store, never uploads anything, and — with no
 * SELECTIVE_CORPUS_STORAGE_MODE=vercel-blob configured anywhere — is never
 * imported by the running orchestrator (see config.ts / shadow.ts).
 *
 * SERVER-SIDE ONLY. Reads use the SDK's `access: "private"` mode; there is no
 * signed-URL generation, no raw Blob URL is ever exposed to a caller, and
 * this module has no write method of any kind (no put/upload/del/copy) —
 * objects are treated as immutable, published once outside this codebase.
 *
 * AUTHENTICATION: deliberately does not pass `token`/`oidcToken`/`storeId` to
 * either SDK call. The installed @vercel/blob resolves credentials itself,
 * in order, from: an explicit `token`/`oidcToken` option (never supplied
 * here), `process.env.VERCEL_OIDC_TOKEN` + `BLOB_STORE_ID` (Vercel's normal
 * OIDC runtime identity), or `process.env.BLOB_READ_WRITE_TOKEN`. No
 * credential is read, minted, or hard-coded by this file.
 *
 * KEY MODEL: every object key stays artifact-relative (e.g.
 * "packed/shard-042.bin"), exactly like the local adapter — this module only
 * additionally prepends a fixed, server-configured `prefix`
 * (conceptually "selective-corpus/<artifact-version>/") to form the Blob
 * pathname. A key is rejected (thrown, before any SDK call) if it is
 * absolute, contains a Windows drive letter, contains "..", contains a
 * backslash, or looks like a URL — a candidate/manuscript-derived string can
 * never determine a Blob pathname, because no call site in this codebase
 * ever constructs a key from anything but a fixed literal or a docmap-derived
 * rawId (see source-loader.ts).
 *
 * ERROR MAPPING — what each SDK read path can and cannot structurally tell
 * us apart, exactly (this is the "small conservative mapper" the remote
 * cold-start task called for):
 *
 *   head() (objectExists) routes through the SDK's shared control-plane
 *   request helper, which already retries transport-level failures
 *   internally and then throws clearly TYPED subclasses of BlobError for
 *   everything else: BlobNotFoundError (ordinary absence -> `false`),
 *   BlobServiceNotAvailable / BlobServiceRateLimited / BlobRequestAbortedError
 *   (5xx / 429 / aborted-or-timed-out -> SelectiveCorpusTransientStorageError,
 *   since these are the SDK's own "retry later" signals), and
 *   BlobAccessError / BlobStoreNotFoundError / BlobStoreSuspendedError
 *   (auth/store/config failures -> a thrown, PERSISTENT plain Error — NEVER
 *   `false`, NEVER transient). Any other BlobError subtype the SDK might add
 *   (e.g. BlobUnknownError for a genuinely unrecognized provider response) is
 *   ambiguous by construction and fails closed as persistent too.
 *
 *   get() (readObject) is a much coarser signal: its only STRUCTURED outcome
 *   is a `null` return for HTTP 404 (-> SelectiveCorpusObjectNotFoundError).
 *   Every other non-2xx response is collapsed into ONE generic `BlobError`
 *   whose message embeds the HTTP status as free text ("Failed to fetch
 *   blob: 429 Too Many Requests") rather than as a typed/structured field —
 *   parsing that string would be fragile across SDK versions, so it is NOT
 *   done here; any such generic BlobError (this also covers a missing/invalid
 *   credential, which the SDK reports exactly the same way) is conservatively
 *   classified PERSISTENT/unreadable rather than guessed transient. A raw,
 *   non-BlobError failure reaching this adapter (an undici-level network
 *   fault, or an aborted request if a caller-supplied AbortSignal were ever
 *   wired in) IS classified transient — that is the one category safely
 *   inferable without any structured status at all: it is not a typed Blob
 *   failure of any kind, so it cannot be the well-classified persistent cases
 *   above, and "the transport didn't complete" is exactly the shape of thing
 *   a later attempt may resolve.
 *
 * TESTABILITY: the real `get`/`head` SDK functions are injected as a narrow
 * `VercelBlobReadClient` (default: the real functions). Tests supply
 * deterministic fakes and never reach a real store; the error CLASSES
 * (BlobNotFoundError, BlobServiceRateLimited, ...) are imported directly from
 * the real, installed @vercel/blob package and are plain in-memory Error
 * subclasses — constructing/throwing them performs no I/O.
 */

/** Narrow injectable seam over the two @vercel/blob functions this adapter
 *  calls. Production uses the real SDK exports; tests inject deterministic
 *  fakes that make zero network calls. Intentionally excludes every write
 *  operation (put/upload/del/copy/rename) — there is no seam through which
 *  this adapter could perform one. */
export interface VercelBlobReadClient {
  get(pathname: string, options: { access: "private" }): Promise<GetBlobResult | null>;
  head(pathname: string): Promise<HeadBlobResult>;
}

const defaultVercelBlobReadClient: VercelBlobReadClient = {
  get: (pathname, options) => vercelBlobGet(pathname, options),
  head: (pathname) => vercelBlobHead(pathname),
};

export type CreateVercelBlobStorageAdapterOptions = {
  /** Fixed, server-configured corpus prefix, e.g. "selective-corpus/v1".
   *  Never derived from user/manuscript input. Validated at construction
   *  time — an absolute path, a drive letter, "..", a backslash, or an empty
   *  value fails closed immediately (throws), before any SDK call. */
  prefix: string;
  /** Test seam: inject a fake client instead of the real @vercel/blob
   *  functions. Defaults to the real SDK. */
  client?: VercelBlobReadClient;
};

const URL_SHAPED_KEY = /^[a-z][a-z0-9+.-]*:\/\//i;

function normalizePrefix(prefix: string): string {
  if (typeof prefix !== "string" || prefix.trim().length === 0) {
    throw new Error("selective-corpus vercel-blob adapter: prefix must be a non-empty string");
  }
  if (prefix.includes("\\")) {
    throw new Error(`selective-corpus vercel-blob adapter: prefix must not contain a backslash: ${prefix}`);
  }
  if (URL_SHAPED_KEY.test(prefix)) {
    throw new Error(`selective-corpus vercel-blob adapter: prefix must not look like a URL: ${prefix}`);
  }
  const trimmed = prefix.replace(/\/+$/, "");
  // Reuses the SAME artifact-relative-key guard as every other selective-corpus
  // key (rejects absolute paths, drive letters, ".." segments, NUL bytes). The
  // prefix is server-configured, never user input, but a misconfigured prefix
  // must fail closed rather than silently resolve somewhere unintended.
  assertArtifactRelativeKey(trimmed);
  if (trimmed.length === 0) {
    throw new Error("selective-corpus vercel-blob adapter: prefix must not be empty after normalization");
  }
  return trimmed;
}

/** Rejects an invalid/traversal/URL-shaped key BEFORE any SDK call — the one
 *  normalization performed is joining onto the fixed prefix; nothing here can
 *  ever let a key escape it. */
function resolvePathname(prefix: string, key: string): string {
  if (typeof key !== "string" || key.includes("\\")) {
    throw new Error(`selective-corpus object key must not contain a backslash: ${JSON.stringify(key)}`);
  }
  if (URL_SHAPED_KEY.test(key)) {
    throw new Error(`selective-corpus object key must not look like a URL: ${key}`);
  }
  assertArtifactRelativeKey(key);
  return `${prefix}/${key}`;
}

async function readStreamToUint8Array(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
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

/** The SDK's own clearly-typed "retry later" signals — see the module doc's
 *  error-mapping section. head() can throw these directly; get() cannot
 *  today (it never routes through the control-plane retry helper), but the
 *  check is shared because the classification is correct regardless of which
 *  call path produced it. */
function isTransientBlobError(err: unknown): boolean {
  return (
    err instanceof BlobServiceNotAvailable ||
    err instanceof BlobServiceRateLimited ||
    err instanceof BlobRequestAbortedError
  );
}

/** Auth/store/config failures that must NEVER be reported as "object does
 *  not exist" (false) or silently retried forever. */
function isPersistentAuthOrConfigBlobError(err: unknown): boolean {
  return (
    err instanceof BlobAccessError ||
    err instanceof BlobStoreNotFoundError ||
    err instanceof BlobStoreSuspendedError
  );
}

export function createVercelBlobStorageAdapter(
  options: CreateVercelBlobStorageAdapterOptions,
): SelectiveCorpusStorageAdapter {
  const prefix = normalizePrefix(options.prefix);
  const client = options.client ?? defaultVercelBlobReadClient;

  return {
    async readObject(key: string): Promise<Uint8Array> {
      const pathname = resolvePathname(prefix, key);
      let result: GetBlobResult | null;
      try {
        result = await client.get(pathname, { access: "private" });
      } catch (err) {
        if (isTransientBlobError(err)) {
          throw new SelectiveCorpusTransientStorageError(
            key,
            err instanceof Error ? err.message : "vercel blob transient failure",
          );
        }
        if (err instanceof BlobError) {
          // get()'s one generic, untyped failure shape — see the module doc.
          // Covers auth/config failures too (a missing credential reports the
          // same generic BlobError); conservatively persistent, never guessed
          // transient, never mistaken for not-found.
          throw new Error(`vercel blob object unreadable: ${key} (${err.message})`);
        }
        // Raw, non-BlobError failure: an undici-level network fault (or an
        // aborted request, if a caller-supplied AbortSignal is ever wired in
        // later) — genuinely retryable, and not any of the well-classified
        // persistent cases above.
        throw new SelectiveCorpusTransientStorageError(key, err instanceof Error ? err.message : String(err));
      }
      if (result === null) {
        throw new SelectiveCorpusObjectNotFoundError(key);
      }
      if (result.statusCode !== 200) {
        // Only reachable for a 304 Not-Modified, which requires this adapter
        // to send `ifNoneMatch` — it never does. Fail closed rather than
        // silently return an incomplete/empty body if that ever changes.
        throw new Error(`vercel blob object unreadable: ${key} (unexpected statusCode ${result.statusCode})`);
      }
      return readStreamToUint8Array(result.stream);
    },

    async objectExists(key: string): Promise<boolean> {
      const pathname = resolvePathname(prefix, key);
      try {
        await client.head(pathname);
        return true;
      } catch (err) {
        if (err instanceof BlobNotFoundError) return false;
        if (isTransientBlobError(err)) {
          throw new SelectiveCorpusTransientStorageError(
            key,
            err instanceof Error ? err.message : "vercel blob transient failure",
          );
        }
        if (isPersistentAuthOrConfigBlobError(err)) {
          throw new Error(
            `vercel blob authorization/configuration failure while checking ${key}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (err instanceof BlobError) {
          // Any other BlobError subtype (e.g. BlobUnknownError,
          // BlobPreconditionFailedError) is ambiguous by construction — fail
          // closed as persistent rather than guess "not found" or "transient".
          throw new Error(`vercel blob head failed for ${key}: ${err.message}`);
        }
        // Raw, non-BlobError failure — see readObject()'s matching comment.
        throw new SelectiveCorpusTransientStorageError(key, err instanceof Error ? err.message : String(err));
      }
    },
  };
}
