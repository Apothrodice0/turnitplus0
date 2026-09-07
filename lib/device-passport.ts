/**
 * Device Passport — Phase 3 (browser client). Fully automatic, zero UI.
 *
 * One per-browser ECDSA P-256 keypair, generated once and kept as a
 * NON-EXPORTABLE `CryptoKey` in IndexedDB (a structured clone of the live
 * key object — never serialized, never in localStorage). Only the PUBLIC key
 * (SPKI DER, base64) is ever registered with the server. While a given report
 * has not yet been confirmed saved this browser session, this module requests
 * a fresh server challenge, signs the exact Phase-2 signed-message bytes (see
 * lib/device-passport-server.ts's buildDevicePassportSignedMessage), and
 * returns a `{ challengeId, nonce, publicKeySpki, signature }` attestation for
 * POST /api/reports to attach. A failed POST is retried with brand-new
 * material; once saveReportRemote confirms the save
 * (markDevicePassportReportSaved), a later AI-enrichment resave attaches
 * nothing. If a passport endpoint returns 404 (feature off) the client stops
 * asking for the rest of the page session.
 *
 * FAIL-SAFE, ALWAYS: every entry point resolves to null/undefined and never
 * throws, for ANY reason — no WebCrypto, no IndexedDB, private-browsing
 * restrictions, a corrupt stored key, a network / registration / challenge /
 * signing failure, or the feature flag being off (the endpoints answer 404).
 * The report upload always proceeds exactly as it would with no passport.
 *
 * This module imports nothing from the similarity matcher, ownership /
 * relationship classification, or scoring, and changes none of them — it only
 * produces upload-time device provenance. lib/device-key.ts (the localStorage
 * UUID used for soft report scoping) is entirely independent and untouched.
 *
 * Browser-only: every Web API access is inside a function and guarded, so the
 * module is safe to import in any (SSR / test) context — it simply produces
 * no attestation there.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Dedicated IndexedDB database — never shared with any other TurnitPlus storage. */
export const DEVICE_PASSPORT_DB_NAME = "turnitplus-device-passport-v1";
export const DEVICE_PASSPORT_STORE_NAME = "passport";
/** The single record key inside the store. */
export const DEVICE_PASSPORT_RECORD_KEY = "current";
/** Stored-record schema version (the record shape, not the IndexedDB version). */
export const DEVICE_PASSPORT_RECORD_VERSION = 1;
/** IndexedDB schema version for DEVICE_PASSPORT_DB_NAME. */
const DEVICE_PASSPORT_DB_VERSION = 1;

/**
 * MUST stay byte-identical to lib/device-passport-server.ts's
 * DEVICE_PASSPORT_SIGNED_MESSAGE_VERSION — re-declared here (not imported)
 * because that module pulls in node:crypto and must never enter the client
 * bundle. tests/device-passport-client.test.mjs locks the two together and
 * proves the full message bytes match.
 */
export const DEVICE_PASSPORT_SIGNED_MESSAGE_VERSION = "TP_DEVICE_PASSPORT_V1";

const REGISTER_ENDPOINT = "/api/device-passport/register";
const CHALLENGE_ENDPOINT = "/api/device-passport/challenge";
const REPORTS_PATH = "/api/reports";

/** P-256 ECDSA (IEEE-P1363) signatures are exactly 64 bytes. */
const P256_SIGNATURE_BYTES = 64;
/** A P-256 SPKI is 91 bytes (~124 base64 chars); this ceiling matches the server's MAX_SPKI_BASE64_LENGTH. */
const MAX_SPKI_BASE64_LENGTH = 500;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DevicePassportAttestation = {
  challengeId: string;
  nonce: string;
  publicKeySpki: string;
  signature: string;
};

type StoredPassportRecord = {
  version: number;
  /** The live, non-exportable private key. IndexedDB stores it via structured clone. */
  privateKey: CryptoKey;
  /** base64 SPKI DER of the matching public key. */
  publicKeySpki: string;
};

type LoadedPassport = { privateKey: CryptoKey; publicKeySpki: string };

/**
 * The IndexedDB persistence seam. The default implementation
 * (createIndexedDbPassportStore) is the real one; tests inject a fake via
 * __setDevicePassportStoreForTests so the key lifecycle can be exercised
 * without a browser IndexedDB.
 */
export type PassportRecordStore = {
  read(): Promise<StoredPassportRecord | null>;
  write(record: StoredPassportRecord): Promise<void>;
  /** Removes ONLY the passport record — never any other key or store. */
  clear(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

/** undefined = use real detection; null = force "unavailable"; object = use this. Test-only. */
let subtleOverride: SubtleCrypto | null | undefined;

function getCryptoSubtle(): SubtleCrypto | null {
  if (subtleOverride !== undefined) return subtleOverride;
  try {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (c && c.subtle && typeof c.subtle.generateKey === "function" && typeof c.subtle.sign === "function") {
      return c.subtle;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function getIndexedDbFactory(): IDBFactory | null {
  try {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (idb && typeof idb.open === "function") return idb;
  } catch {
    /* access itself can throw in some locked-down contexts */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Encoding helpers (manual — @cloudflare/workers-types breaks the Buffer/btoa
// typed overloads in this repo; see lib/auth-crypto.ts's own comment)
// ---------------------------------------------------------------------------

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Canonical RFC 4648 base64 (with padding) — matches the server's bytesToBase64 exactly. */
function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 0x3f] : "=";
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

// lib.dom's BufferSource resolves to ArrayBufferView<ArrayBuffer>; a plain
// `Uint8Array` annotation widens to Uint8Array<ArrayBufferLike>, which TS 5.9
// then rejects at subtle.digest/sign. This cast is the localized bridge —
// every value passed through it is a real Uint8Array over an ArrayBuffer.
function asCryptoData(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

async function sha256Hex(subtle: SubtleCrypto, text: string): Promise<string> {
  const digest = await subtle.digest("SHA-256", asCryptoData(new TextEncoder().encode(text)));
  return bytesToHex(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Signed-message contract (must match the server byte-for-byte)
// ---------------------------------------------------------------------------

/**
 * TP_DEVICE_PASSPORT_V1
 * <nonce base64>
 * <challengeId>
 * POST
 * /api/reports
 * <sha256(exact payload.text) lowercase hex>
 * <reportId>
 *
 * UTF-8, a single "\n" between fields, no trailing newline.
 */
export function buildDevicePassportSignedMessageBytes(params: {
  nonceBase64: string;
  challengeId: string;
  method: string;
  path: string;
  payloadTextSha256Hex: string;
  reportId: string;
}): Uint8Array {
  return new TextEncoder().encode(
    [
      DEVICE_PASSPORT_SIGNED_MESSAGE_VERSION,
      params.nonceBase64,
      params.challengeId,
      params.method,
      params.path,
      params.payloadTextSha256Hex,
      params.reportId,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// IndexedDB store (default PassportRecordStore implementation)
// ---------------------------------------------------------------------------

function createIndexedDbPassportStore(idb: IDBFactory): PassportRecordStore {
  function openDb(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = idb.open(DEVICE_PASSPORT_DB_NAME, DEVICE_PASSPORT_DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DEVICE_PASSPORT_STORE_NAME)) {
          db.createObjectStore(DEVICE_PASSPORT_STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
      req.onblocked = () => reject(new Error("indexedDB open blocked"));
    });
  }

  async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await openDb();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(DEVICE_PASSPORT_STORE_NAME, mode);
        let request: IDBRequest<T>;
        try {
          request = op(tx.objectStore(DEVICE_PASSPORT_STORE_NAME));
        } catch (err) {
          reject(err);
          return;
        }
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
        tx.onabort = () => reject(tx.error ?? new Error("indexedDB transaction aborted"));
      });
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }

  return {
    async read() {
      const value = await run<StoredPassportRecord | undefined>("readonly", (s) => s.get(DEVICE_PASSPORT_RECORD_KEY));
      return value ?? null;
    },
    async write(record) {
      await run("readwrite", (s) => s.put(record, DEVICE_PASSPORT_RECORD_KEY));
    },
    async clear() {
      await run("readwrite", (s) => s.delete(DEVICE_PASSPORT_RECORD_KEY));
    },
  };
}

let storeOverride: PassportRecordStore | null = null;

function resolveStore(): PassportRecordStore | null {
  if (storeOverride) return storeOverride;
  const idb = getIndexedDbFactory();
  if (!idb) return null;
  try {
    return createIndexedDbPassportStore(idb);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Record validation + key lifecycle
// ---------------------------------------------------------------------------

function isStructurallyUsableRecord(rec: unknown): rec is StoredPassportRecord {
  if (!rec || typeof rec !== "object") return false;
  const r = rec as Record<string, unknown>;
  if (r.version !== DEVICE_PASSPORT_RECORD_VERSION) return false;
  if (typeof r.publicKeySpki !== "string" || r.publicKeySpki.length === 0 || r.publicKeySpki.length > MAX_SPKI_BASE64_LENGTH) {
    return false;
  }
  const key = r.privateKey as Partial<CryptoKey> | undefined;
  if (!key || typeof key !== "object") return false;
  if (key.type !== "private") return false;
  if (key.extractable !== false) return false;
  const algo = key.algorithm as { name?: string; namedCurve?: string } | undefined;
  if (!algo || algo.name !== "ECDSA" || algo.namedCurve !== "P-256") return false;
  if (!Array.isArray(key.usages) || !key.usages.includes("sign")) return false;
  return true;
}

/** A structurally-valid record whose key nevertheless cannot sign is treated as corrupt. */
async function keyCanSign(subtle: SubtleCrypto, key: CryptoKey): Promise<boolean> {
  try {
    const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, asCryptoData(new Uint8Array([0])));
    return sig instanceof ArrayBuffer && sig.byteLength === P256_SIGNATURE_BYTES;
  } catch {
    return false;
  }
}

async function generateKeyPair(subtle: SubtleCrypto): Promise<{ privateKey: CryptoKey; publicKeySpki: string }> {
  const pair = (await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false, // extractable: false — the private key can never leave the browser
    ["sign"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle.exportKey("spki", pair.publicKey));
  return { privateKey: pair.privateKey, publicKeySpki: bytesToBase64(spki) };
}

// ---------------------------------------------------------------------------
// Registration (public key only) — session-deduped, reset-recoverable
// ---------------------------------------------------------------------------

const registeredThisSession = new Set<string>();

/**
 * Set true the first time a passport endpoint answers 404 (feature flag off /
 * not deployed). While set, no further register/challenge requests are made
 * for the rest of THIS page session — a fresh page load starts over. A
 * transient failure (network error, 5xx, 429, 400) never sets this: those
 * stay retryable on the next upload.
 */
let featureUnavailableForSession = false;

/**
 * Registers the public key. Deduped for this browser session so it is not
 * re-sent on every upload — but the "registered" mark lives only in memory,
 * never in IndexedDB/localStorage, so a fresh page load (new session) always
 * re-registers, which is how the client recovers if the server's passport
 * store was reset. A 404 disables the feature for this page session; any other
 * non-ok status leaves the key unmarked so the next upload retries. Never
 * throws.
 */
async function ensureRegistered(publicKeySpki: string, force: boolean): Promise<void> {
  if (featureUnavailableForSession) return;
  if (!force && registeredThisSession.has(publicKeySpki)) return;
  try {
    const res = await fetch(REGISTER_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ publicKeySpki }),
    });
    if (res.ok) {
      registeredThisSession.add(publicKeySpki);
      return;
    }
    if (res.status === 404) {
      featureUnavailableForSession = true;
      return;
    }
    // Any other non-ok status (400, 429, 5xx, ...) → leave unmarked; a later
    // upload this session will retry, and so will the next page load.
  } catch {
    /* network error — leave unmarked, retry later */
  }
}

// ---------------------------------------------------------------------------
// Shared, single-flight initialization (the concurrency mutex)
// ---------------------------------------------------------------------------

let initPromise: Promise<LoadedPassport | null> | null = null;

async function initPassport(): Promise<LoadedPassport | null> {
  const subtle = getCryptoSubtle();
  if (!subtle) return null;
  const store = resolveStore();
  if (!store) return null;

  try {
    let record: StoredPassportRecord | null = null;
    try {
      record = await store.read();
    } catch {
      record = null;
    }

    let corrupt = false;
    if (record) {
      if (!isStructurallyUsableRecord(record) || !(await keyCanSign(subtle, record.privateKey))) {
        corrupt = true;
      }
    }
    if (corrupt) {
      // Remove ONLY the passport record, then fall through to regeneration.
      try {
        await store.clear();
      } catch {
        /* ignore — the write below still overwrites the same key */
      }
      record = null;
    }

    let freshlyCreated = false;
    if (!record) {
      const generated = await generateKeyPair(subtle);
      const next: StoredPassportRecord = {
        version: DEVICE_PASSPORT_RECORD_VERSION,
        privateKey: generated.privateKey,
        publicKeySpki: generated.publicKeySpki,
      };
      try {
        await store.write(next);
      } catch {
        // Cannot persist (private-browsing quota, storage disabled) — without
        // a durable key there is no stable device identity to attest with.
        return null;
      }
      record = next;
      freshlyCreated = true;
    }

    const loaded: LoadedPassport = { privateKey: record.privateKey, publicKeySpki: record.publicKeySpki };
    await ensureRegistered(loaded.publicKeySpki, freshlyCreated);
    return loaded;
  } catch {
    return null;
  }
}

/**
 * Returns the one browser passport, generating + persisting + registering it
 * on first call. All concurrent callers share a single in-flight promise, so
 * two simultaneous uploads can never generate two keys.
 */
export function ensureDevicePassport(): Promise<LoadedPassport | null> {
  if (!initPromise) {
    initPromise = initPassport().catch(() => null);
  }
  return initPromise;
}

// ---------------------------------------------------------------------------
// Challenge + attestation
// ---------------------------------------------------------------------------

async function requestChallenge(): Promise<{ challengeId: string; nonce: string } | null> {
  try {
    const res = await fetch(CHALLENGE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
    });
    if (res.status === 404) {
      // Feature off / not deployed — stop asking for the rest of this page session.
      featureUnavailableForSession = true;
      return null;
    }
    if (!res.ok) return null; // transient (5xx / 429 / ...) — stays retryable
    const body = (await res.json().catch(() => null)) as { challengeId?: unknown; nonce?: unknown } | null;
    if (!body || typeof body.challengeId !== "string" || typeof body.nonce !== "string") return null;
    if (body.challengeId.length === 0 || body.nonce.length === 0) return null;
    return { challengeId: body.challengeId, nonce: body.nonce };
  } catch {
    return null; // network error — stays retryable
  }
}

/**
 * Report ids that have been CONFIRMED successfully saved (POST /api/reports
 * returned its normal success response) during this browser session. This —
 * not "an attestation was attempted" — is the "first save only" gate: a
 * failed/lost POST leaves the id absent, so a retry builds a fresh challenge +
 * signature and attaches the passport again. Once the id is here, a later
 * AI-enrichment resave makes no challenge request and attaches nothing.
 */
const savedReportIds = new Set<string>();

/**
 * Records that POST /api/reports has successfully saved this report in this
 * browser session. Called by saveReportRemote on the success response only.
 * Never throws.
 */
export function markDevicePassportReportSaved(reportId: unknown): void {
  if (typeof reportId === "string" && reportId.length > 0) savedReportIds.add(reportId);
}

/**
 * Builds a Device Passport attestation for a report that has NOT yet been
 * confirmed saved this session, binding the signature to `payloadText` (the
 * exact string the server will read back as payload.text). A fresh challenge
 * and signature are produced on every call, so a retry after a failed POST
 * gets brand-new material. Returns null for any reason at all — including a
 * report already confirmed saved, or the feature having 404'd earlier this
 * page session — and never throws.
 */
export async function buildDevicePassportAttestation(input: {
  reportId: string;
  payloadText: string;
}): Promise<DevicePassportAttestation | null> {
  try {
    if (typeof input.reportId !== "string" || input.reportId.length === 0) return null;
    if (typeof input.payloadText !== "string" || input.payloadText.length === 0) return null;
    if (savedReportIds.has(input.reportId)) return null; // already saved this session — this is a resave
    if (featureUnavailableForSession) return null; // a passport endpoint 404'd earlier this page session

    const subtle = getCryptoSubtle();
    if (!subtle) return null;

    const passport = await ensureDevicePassport();
    if (!passport) return null;
    if (featureUnavailableForSession) return null; // init's own registration call may have just 404'd

    // Retry registration if a prior attempt failed transiently (no-op once the
    // key is known registered this session); a 404 here also disables it.
    await ensureRegistered(passport.publicKeySpki, false);
    if (featureUnavailableForSession) return null;

    const challenge = await requestChallenge();
    if (!challenge) return null;

    const message = buildDevicePassportSignedMessageBytes({
      nonceBase64: challenge.nonce,
      challengeId: challenge.challengeId,
      method: "POST",
      path: REPORTS_PATH,
      payloadTextSha256Hex: await sha256Hex(subtle, input.payloadText),
      reportId: input.reportId,
    });

    let signature: Uint8Array;
    try {
      const raw = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, passport.privateKey, asCryptoData(message));
      signature = new Uint8Array(raw);
    } catch {
      return null;
    }
    if (signature.length !== P256_SIGNATURE_BYTES) return null;

    return {
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      publicKeySpki: passport.publicKeySpki,
      signature: bytesToBase64(signature),
    };
  } catch {
    return null;
  }
}

/**
 * saveReportRemote's entry point: extracts the report's own text and returns
 * an attestation to attach, or undefined for absolutely any reason (feature
 * off, unsupported browser, a resave, no text, any error). Never throws.
 */
export async function maybeAttestReportUpload(
  reportId: unknown,
  report: unknown,
): Promise<DevicePassportAttestation | undefined> {
  try {
    if (typeof reportId !== "string" || reportId.length === 0) return undefined;
    const text = report && typeof report === "object" ? (report as { text?: unknown }).text : undefined;
    if (typeof text !== "string" || text.length === 0) return undefined;
    const attestation = await buildDevicePassportAttestation({ reportId, payloadText: text });
    return attestation ?? undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Test-only hooks (no-ops in normal use; never imported by app code)
// ---------------------------------------------------------------------------

/** Swap the IndexedDB persistence for a fake. Pass null to restore the real store. */
export function __setDevicePassportStoreForTests(store: PassportRecordStore | null): void {
  storeOverride = store;
}

/** Force the WebCrypto layer: null = "unavailable", an object = use it, undefined = real detection. */
export function __setDevicePassportCryptoForTests(subtle: SubtleCrypto | null | undefined): void {
  subtleOverride = subtle;
}

/** Simulate a fresh page load: drop the in-memory init promise + session state. */
export function __resetDevicePassportStateForTests(): void {
  initPromise = null;
  registeredThisSession.clear();
  savedReportIds.clear();
  featureUnavailableForSession = false;
}
