// Test-only child-process entry point (spawned by
// tests/pdfjs-missing-worker-regression.test.mjs, never imported by
// production code). Faithfully reproduces the exact Vercel production
// condition confirmed live via a temporary diagnostic probe (since
// removed): pdfjs-dist's pdf.mjs is present in the deployed serverless
// bundle, but its pdf.worker.mjs companion file is not — only pdf.mjs
// itself gets traced into the bundle, since pdfjs-dist's own fake-worker
// fallback loads it via a runtime `import(this.workerSrc)` a bundler's
// static dependency tracer cannot follow (see pdf.mjs's own
// _setupFakeWorkerGlobal).
//
// Reproduced here WITHOUT touching this project's real, shared
// node_modules: pdf.mjs has no relative imports of its own (it is a single
// fully self-contained bundled file — confirmed by inspecting it directly),
// so copying just that one file into an isolated temp directory with no
// pdf.worker.mjs alongside it, then importing pdfjs from that copy, produces
// a real, unfaked "Cannot find module '.../pdf.worker.mjs'" failure — not a
// simulation of one — with zero risk of racing any other test that uses the
// real, shared pdfjs-dist package concurrently.
//
// mode "none"/"workerFetchOptions" deliberately leave @napi-rs/canvas
// resolvable (it genuinely is, in this dev environment) so the worker bug
// reproduces in isolation, uncomplicated by the separate DOMMatrix problem
// — that one already has its own dedicated coverage in
// tests/pdfjs-node-polyfill.test.mjs, using the same
// napi-rs-canvas-hidden-child.mjs hiding technique this file also uses for
// mode "fix" below (to prove the real fix handles the full real Vercel
// environment, not an easier one).
//
// Usage: node [--import tsx] pdfjs-missing-worker-hidden-child.mjs
//          <mode: "none"|"workerFetchOptions"|"fix"> <pdfPath>
import Module from "node:module";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const mode = process.argv[2];
const pdfPath = process.argv[3];

if (mode === "fix") {
  const original = Module._resolveFilename;
  Module._resolveFilename = function resolveFilenamePatched(request, ...rest) {
    if (request === "@napi-rs/canvas") {
      const err = new Error("Cannot find module '@napi-rs/canvas' (simulated for test — mirrors the real Vercel environment)");
      err.code = "MODULE_NOT_FOUND";
      throw err;
    }
    return original.call(this, request, ...rest);
  };
}

let isolatedDir;
try {
  const realPdfMjs = path.resolve(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.mjs");
  isolatedDir = await mkdtemp(path.join(tmpdir(), "pdfjs-no-worker-"));
  const isolatedPdfMjs = path.join(isolatedDir, "pdf.mjs");
  await copyFile(realPdfMjs, isolatedPdfMjs);
  // Deliberately NOT copying pdf.worker.mjs alongside it — that omission
  // is the entire point of this fixture.

  if (mode === "fix") {
    // The REAL, shipped fix — not a reimplementation of it.
    const { ensurePdfjsNodePolyfills } = await import("../../lib/pdfjs-node-polyfill.ts");
    await ensurePdfjsNodePolyfills();
  } else if (typeof globalThis.DOMMatrix === "undefined") {
    // "none"/"workerFetchOptions" isolate the WORKER problem specifically —
    // apply just the DOMMatrix half inline (not the shared
    // ensurePdfjsNodePolyfills(), which now also carries the worker fix
    // this test is trying to prove is still broken without it) so a
    // DOMMatrix failure in this dev environment can never masquerade as a
    // worker-bug reproduction.
    const DOMMatrixPolyfill = (await import("dommatrix")).default;
    globalThis.DOMMatrix = DOMMatrixPolyfill;
  }

  const { readFile } = await import("node:fs/promises");
  const pdfjs = await import(pathToFileURL(isolatedPdfMjs).href);
  const data = await readFile(pdfPath);
  const getDocumentOptions = mode === "workerFetchOptions"
    ? { data: new Uint8Array(data), useWorkerFetch: false, isEvalSupported: false }
    : { data: new Uint8Array(data) };
  const document = await pdfjs.getDocument(getDocumentOptions).promise;
  const { extractPdfTextDocument } = await import("../../lib/pdf-text-extraction.ts");
  const text = await extractPdfTextDocument(document);
  console.log(JSON.stringify({ ok: true, numPages: document.numPages, textLength: text.length, hasAttentionTitle: /Attention Is All You Need/.test(text) }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, errorMessage: error instanceof Error ? error.message : String(error) }));
} finally {
  if (isolatedDir) await rm(isolatedDir, { recursive: true, force: true });
}
