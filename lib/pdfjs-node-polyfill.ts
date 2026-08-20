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
 */
export function ensurePdfjsNodePolyfills(): void {
  if (typeof globalThis.DOMMatrix === "undefined") {
    globalThis.DOMMatrix = DOMMatrixPolyfill as unknown as typeof DOMMatrix;
  }
}
