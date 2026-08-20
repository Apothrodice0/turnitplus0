import DOMMatrixPolyfill from "dommatrix";

/**
 * "Investigate remaining production PDF parsing problem" (Vercel): fixes a
 * real, confirmed-live production crash distinct from the earlier
 * serverExternalPackages fix (next.config.ts) — that fix made sure
 * pdfjs-dist's own module code reaches the server runtime unbundled; this
 * fixes a crash INSIDE that code once it runs there.
 *
 * ROOT CAUSE, confirmed by reading pdfjs-dist's own bundled source and
 * reproducing live: `pdfjs-dist/legacy/build/pdf.mjs` contains a
 * MODULE-TOP-LEVEL statement, `const SCALE_MATRIX = new DOMMatrix();`,
 * that executes unconditionally the instant the module is imported —
 * before getDocument(), before getTextContent(), before anything we
 * actually call. In a Node/serverless environment with no browser
 * `DOMMatrix` global, pdfjs's own preceding fallback tries
 * `require("@napi-rs/canvas")` and uses ITS `DOMMatrix` — but
 * `@napi-rs/canvas` is an OPTIONAL, native (Rust/napi) dependency of
 * pdfjs-dist; if the platform-specific native binary for wherever this
 * actually runs was never installed (confirmed: Vercel's real runtime
 * logs show "Cannot find module '@napi-rs/canvas'" — a real, live
 * production error, not local-only), that fallback fails too, pdfjs warns
 * "Cannot polyfill DOMMatrix, rendering may be broken" (a message that
 * reads as non-fatal but is NOT: the very next module-level line
 * unconditionally calls `new DOMMatrix()` regardless of whether the
 * polyfill actually succeeded) and throws `ReferenceError: DOMMatrix is
 * not defined` — which aborts the ENTIRE module import, so no PDF
 * candidate belonging to this environment can ever be parsed, from ANY
 * call site, for ANY document.
 *
 * FIX: define `globalThis.DOMMatrix` OURSELVES, before pdfjs-dist is ever
 * imported, using `dommatrix` — a small, pure-JS, dependency-free,
 * non-native polyfill (no native binary, so no platform-specific install
 * step that can fail on a given serverless runtime the way
 * `@napi-rs/canvas` just did). pdfjs-dist's own `if (!globalThis.DOMMatrix)`
 * check (see its bundled source) then finds one already present and skips
 * its own broken attempt entirely — no more warning, no more crash.
 * Confirmed live: reproduced the exact Vercel failure by making
 * `@napi-rs/canvas` genuinely unresolvable in this environment, and
 * confirmed this polyfill alone (no `@napi-rs/canvas`, no `Path2D`
 * polyfill) is sufficient for real PDF text extraction to succeed
 * end-to-end against a real downloaded PDF.
 *
 * Deliberately does NOT also polyfill `Path2D`: pdfjs-dist's own
 * `Path2D`-related warning path never crashes anything — confirmed live,
 * text extraction (getTextContent(), the only pdfjs API this project's
 * server-side code ever calls) succeeds correctly with only `DOMMatrix`
 * polyfilled. Path2D is a rendering-only concern (drawing vector paths to
 * an actual canvas), which this project's server-side PDF handling never
 * does — see lib/pdf-text-extraction.ts's own header comment on why no
 * safe server-side PDF *rendering* path exists in this project at all.
 * Adding an unused polyfill "to be safe" would be an unrelated, unproven
 * change this investigation has no evidence requires.
 *
 * Idempotent and side-effect-free beyond the one global assignment; safe
 * to call from every server-side call site that imports pdfjs-dist
 * (currently lib/http-content-retriever.ts and lib/e7-asjp-client.ts) —
 * a single shared function rather than duplicating this polyfill logic
 * (or, worse, forgetting it) at each new call site.
 *
 * SECOND, SEPARATE fix bundled into this same shared function ("proceed
 * with the corrected globalThis.pdfjsWorker fix" investigation): a real,
 * confirmed-live Vercel production crash distinct from the DOMMatrix one
 * above — candidate PDF retrieval failed with MALFORMED_CONTENT /
 * "Setting up fake worker failed: Cannot find module '.../pdf.worker.mjs'"
 * for real academic-search candidates, discovered via a temporary
 * production diagnostic probe (removed once this investigation concluded).
 *
 * ROOT CAUSE, confirmed by reading pdfjs-dist's own source
 * (pdf.mjs's PDFWorker class): in Node.js, PDFWorker unconditionally takes
 * its "fake worker" path (never attempts a real Worker at all), and that
 * path's loader does `await import(this.workerSrc)` — a RUNTIME,
 * string-path dynamic import for "./pdf.worker.mjs" — UNLESS
 * `globalThis.pdfjsWorker?.WorkerMessageHandler` is already set, in which
 * case that dynamic import is never reached. `useWorkerFetch`/
 * `isEvalSupported` getDocument() options do NOT affect this path at all
 * (they only configure font/CMap/wasm fetching inside an already-running
 * worker) — disproven empirically by
 * tests/pdfjs-missing-worker-regression.test.mjs before this fix was
 * written, not assumed.
 *
 * FIX: statically import pdf.worker.mjs's own WorkerMessageHandler export
 * ourselves and assign it to globalThis.pdfjsWorker before pdfjs-dist's
 * main module is ever imported. This has two effects: (1) pdfjs's own
 * #mainThreadWorkerMessageHandler check short-circuits before the broken
 * dynamic import ever runs; (2) because this is a STATIC import in our own
 * application code (not a runtime string-path import inside a third-party
 * bundle), Vercel's serverless file tracer can see it and includes
 * pdf.worker.mjs in the deployed bundle — the actual reason it was missing
 * in the first place. Confirmed live: reproduced the exact Vercel failure
 * against an isolated copy of pdf.mjs with no pdf.worker.mjs alongside it,
 * and confirmed this fix alone (no useWorkerFetch/isEvalSupported) is
 * sufficient for real PDF text extraction to succeed even then.
 *
 * Deliberately async (the caller now awaits ensurePdfjsNodePolyfills()) —
 * the worker module import must complete before pdfjs-dist's own main
 * module is imported, or the #mainThreadWorkerMessageHandler check would
 * run before globalThis.pdfjsWorker is set.
 */
declare global {
  // eslint-disable-next-line no-var
  var pdfjsWorker: { WorkerMessageHandler: unknown } | undefined;
}

let workerHandlerReady: Promise<void> | null = null;

export async function ensurePdfjsNodePolyfills(): Promise<void> {
  if (typeof globalThis.DOMMatrix === "undefined") {
    globalThis.DOMMatrix = DOMMatrixPolyfill as unknown as typeof DOMMatrix;
  }

  if (!globalThis.pdfjsWorker) {
    workerHandlerReady ??= import("pdfjs-dist/legacy/build/pdf.worker.mjs").then(({ WorkerMessageHandler }) => {
      globalThis.pdfjsWorker = { WorkerMessageHandler };
    });
    await workerHandlerReady;
  }
}
