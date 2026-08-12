import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

// Hex encode/decode is done manually via plain Uint8Array iteration rather
// than Buffer.prototype.toString('hex')/Buffer.from(str, 'hex'): this
// project also includes @cloudflare/workers-types (for the Vite/Workers
// build path) alongside @types/node, and workers-types declares
// `declare const Buffer: any`, which shadows @types/node's properly-typed
// Buffer globally and breaks the encoding-aware overloads of those two
// methods specifically. Plain byte iteration sidesteps the conflict and
// works identically on Buffer instances, since Buffer is a Uint8Array.
function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// A manual wrapper rather than util.promisify(scryptCallback): scrypt has
// multiple overloaded signatures (with/without an options object), and
// promisify's overload resolution picks the one without options, dropping
// our N/r/p cost parameters. This wrapper always uses the 4-arg options form.
function scrypt(password: string, salt: Uint8Array, keylen: number, options: { N: number; r: number; p: number }): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err: Error | null, derivedKey: Uint8Array) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

// A placeholder hash used to run a dummy derivation when a login's email
// lookup misses, so response timing doesn't reveal whether the email exists.
const DUMMY_HASH = `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${"00".repeat(16)}$${"00".repeat(SCRYPT_KEYLEN)}`;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${bytesToHex(salt)}$${bytesToHex(derived)}`;
}

const HEX_PATTERN = /^[0-9a-f]+$/i;

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4];
  const hashHex = parts[5];
  // A malformed stored value (corrupted data, a bad migration, a
  // hand-crafted attack input) must fail closed rather than silently
  // producing a short/empty byte array from a partially-invalid hex string.
  if (
    !Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) ||
    saltHex.length === 0 || saltHex.length % 2 !== 0 || !HEX_PATTERN.test(saltHex) ||
    hashHex.length === 0 || hashHex.length % 2 !== 0 || !HEX_PATTERN.test(hashHex)
  ) {
    return false;
  }
  const salt = hexToBytes(saltHex);
  const expected = hexToBytes(hashHex);
  const derived = await scrypt(password, salt, expected.length, { N, r, p });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** Runs a dummy password derivation so a login's response timing doesn't reveal whether the email exists. */
export async function verifyAgainstDummy(password: string): Promise<void> {
  await verifyPassword(password, DUMMY_HASH);
}
