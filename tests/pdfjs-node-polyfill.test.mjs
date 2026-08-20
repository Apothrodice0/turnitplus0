import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { ensurePdfjsNodePolyfills } from "../lib/pdfjs-node-polyfill.ts";

const execFileAsync = promisify(execFile);

/**
 * "Investigate remaining production PDF parsing problem" (Vercel) —
 * regression coverage for the real, confirmed-live crash: see
 * lib/pdfjs-node-polyfill.ts's own header comment for the full root-cause
 * account. Real Vercel runtime log evidence this investigation started
 * from: "Cannot load '@napi-rs/canvas' package: Cannot find module
 * '@napi-rs/canvas'" followed by every real candidate PDF retrieval
 * failing with MALFORMED_CONTENT / "DOMMatrix is not defined".
 */

test("UNIT: ensurePdfjsNodePolyfills defines globalThis.DOMMatrix when absent", async () => {
  const original = globalThis.DOMMatrix;
  // @ts-expect-error deliberately removing a global for the test
  delete globalThis.DOMMatrix;
  try {
    await ensurePdfjsNodePolyfills();
    assert.notEqual(typeof globalThis.DOMMatrix, "undefined");
  } finally {
    if (original === undefined) {
      // @ts-expect-error restoring the deliberately-removed global
      delete globalThis.DOMMatrix;
    } else {
      globalThis.DOMMatrix = original;
    }
  }
});

test("UNIT: ensurePdfjsNodePolyfills never overwrites an existing DOMMatrix (e.g. a real browser global)", async () => {
  const original = globalThis.DOMMatrix;
  function SentinelDOMMatrix() {}
  // @ts-expect-error assigning a test sentinel, not a real DOMMatrix
  globalThis.DOMMatrix = SentinelDOMMatrix;
  try {
    await ensurePdfjsNodePolyfills();
    assert.equal(globalThis.DOMMatrix, SentinelDOMMatrix);
  } finally {
    if (original === undefined) {
      // @ts-expect-error restoring the deliberately-removed global
      delete globalThis.DOMMatrix;
    } else {
      globalThis.DOMMatrix = original;
    }
  }
});

// --- REAL, isolated-process reproduction of the exact Vercel failure ---

const CHILD_SCRIPT = fileURLToPath(new URL("./fixtures/napi-rs-canvas-hidden-child.mjs", import.meta.url));
const PDF_FIXTURE = fileURLToPath(new URL("./fixtures/attention-is-all-you-need.pdf", import.meta.url));

async function runChild(withPolyfill) {
  const { stdout } = await execFileAsync("node", ["--import", "tsx", CHILD_SCRIPT, withPolyfill ? "1" : "0", PDF_FIXTURE], {
    timeout: 30_000,
  });
  const lastLine = stdout.trim().split("\n").pop();
  return JSON.parse(lastLine);
}

test("REGRESSION: reproduces the real Vercel failure — WITHOUT the polyfill, pdfjs-dist's own module load crashes when @napi-rs/canvas is unresolvable", async () => {
  const result = await runChild(false);
  assert.equal(result.ok, false);
  assert.match(result.errorMessage, /DOMMatrix is not defined/, "must be the exact real production error, not a different failure");
});

test("FIX CONFIRMED: WITH the polyfill applied first, the exact same PDF extracts successfully even with @napi-rs/canvas unresolvable", async () => {
  const result = await runChild(true);
  assert.equal(result.ok, true, `expected success, got: ${JSON.stringify(result)}`);
  assert.equal(result.numPages, 15);
  assert.ok(result.textLength > 10_000, "a real, substantial extraction, not an empty/near-empty result");
  assert.equal(result.hasAttentionTitle, true);
});
