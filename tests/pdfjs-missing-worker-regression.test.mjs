import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

/**
 * "Proceed with the corrected globalThis.pdfjsWorker fix" — regression
 * coverage for the real, confirmed-live Vercel production crash: candidate
 * PDF retrieval (lib/http-content-retriever.ts's loadPdfjsDocument) failed
 * with MALFORMED_CONTENT / "Setting up fake worker failed: Cannot find
 * module '.../pdf.worker.mjs'" for both real academic-search test
 * documents, discovered via a temporary production diagnostic probe
 * (since removed) and confirmed by reading pdfjs-dist's own source.
 *
 * ROOT CAUSE: pdf.mjs's PDFWorker class unconditionally takes its "fake
 * worker" path in Node.js (never attempts a real Worker at all), and that
 * path's loader does `await import(this.workerSrc)` — a RUNTIME,
 * string-path dynamic import for "./pdf.worker.mjs" — UNLESS
 * `globalThis.pdfjsWorker?.WorkerMessageHandler` is already set, in which
 * case that dynamic import is never reached.
 *
 * The FIRST fix attempted (`useWorkerFetch: false, isEvalSupported: false`)
 * was DISPROVEN by this file before being shipped — those options only
 * configure font/CMap/wasm fetching inside an already-running worker, not
 * whether one is spun up at all — see the "disproven" test below.
 *
 * The REAL fix, now shipped in lib/pdfjs-node-polyfill.ts's
 * ensurePdfjsNodePolyfills(): statically import pdf.worker.mjs's own
 * WorkerMessageHandler export and assign it to globalThis.pdfjsWorker
 * before pdfjs-dist's main module is ever imported. Two effects: (1)
 * pdfjs's own #mainThreadWorkerMessageHandler check short-circuits before
 * the broken dynamic import ever runs; (2) because it is a STATIC import in
 * our own application code (not a runtime string-path import inside a
 * third-party bundle), Vercel's serverless file tracer can see it and
 * includes pdf.worker.mjs in the deployed bundle — the actual reason it was
 * missing in the first place.
 *
 * Reproduced here WITHOUT touching this project's real, shared
 * node_modules: pdf.mjs has no relative imports of its own (a single fully
 * self-contained bundled file — confirmed by inspecting it directly), so
 * copying just that one file into an isolated temp directory with no
 * pdf.worker.mjs alongside it, then importing pdfjs from that copy,
 * produces a real, unfaked "Cannot find module '.../pdf.worker.mjs'"
 * failure — not a simulation of one — with zero risk of racing any other
 * test that uses the real, shared pdfjs-dist package concurrently. See
 * tests/fixtures/pdfjs-missing-worker-hidden-child.mjs's own header comment
 * for the full mechanics, including why the DOMMatrix problem (already
 * covered by tests/pdfjs-node-polyfill.test.mjs) is deliberately kept out
 * of the "none"/"workerFetchOptions" cases here so the worker bug
 * reproduces in isolation.
 */

const CHILD_SCRIPT = fileURLToPath(new URL("./fixtures/pdfjs-missing-worker-hidden-child.mjs", import.meta.url));
const PDF_FIXTURE = fileURLToPath(new URL("./fixtures/attention-is-all-you-need.pdf", import.meta.url));

async function runChild(mode) {
  const { stdout } = await execFileAsync("node", ["--import", "tsx", CHILD_SCRIPT, mode, PDF_FIXTURE], { timeout: 30_000 });
  const lastLine = stdout.trim().split("\n").pop();
  return JSON.parse(lastLine);
}

test("REGRESSION: with no worker fix, pdfjs's own fake-worker fallback fails to find pdf.worker.mjs when it is absent from the bundle — the exact real Vercel error", async () => {
  const result = await runChild("none");
  assert.equal(result.ok, false);
  assert.match(result.errorMessage, /Setting up fake worker failed/, "must be the exact real production error, not a different failure");
  assert.match(result.errorMessage, /pdf\.worker\.mjs/);
});

test("DISPROVEN FIX ATTEMPT: useWorkerFetch: false + isEvalSupported: false does NOT avoid the fake-worker dynamic import — these options only affect font/CMap/wasm fetching inside an already-running worker", async () => {
  const result = await runChild("workerFetchOptions");
  assert.equal(result.ok, false, "documents that this option pair does not fix the real bug, despite looking plausible");
  assert.match(result.errorMessage, /Setting up fake worker failed/);
});

test("FIX CONFIRMED: the real, shipped ensurePdfjsNodePolyfills() extracts successfully even when pdf.worker.mjs is entirely absent from the bundle AND @napi-rs/canvas is unresolvable (the full real Vercel environment)", async () => {
  const result = await runChild("fix");
  assert.equal(result.ok, true, `expected success, got: ${JSON.stringify(result)}`);
  assert.equal(result.numPages, 15);
  assert.ok(result.textLength > 10_000, "a real, substantial extraction, not an empty/near-empty result");
  assert.equal(result.hasAttentionTitle, true);
});
