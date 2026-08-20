// Test-only child-process entry point (spawned by
// tests/pdfjs-node-polyfill.test.mjs, never imported by production code).
// Patches node:module's CJS resolution — the exact mechanism
// pdfjs-dist's own `process.getBuiltinModule("module").createRequire(...)`
// -based `require("@napi-rs/canvas")` call goes through — to make that one
// specifier throw MODULE_NOT_FOUND, faithfully reproducing the real,
// confirmed-live condition on Vercel (that platform's native binary for
// `@napi-rs/canvas` absent) without touching this project's real, shared
// node_modules on disk. Runs in its own process specifically because
// pdfjs-dist/legacy/build/pdf.mjs's module-top-level `new DOMMatrix()`
// statement only ever executes once per process (Node's ESM module cache),
// so "does importing it crash" can only be observed on a fresh import.
//
// Usage: node [--import tsx] napi-rs-canvas-hidden-child.mjs <withPolyfill: "1"|"0"> <pdfPath>
import Module from "node:module";

const original = Module._resolveFilename;
Module._resolveFilename = function resolveFilenamePatched(request, ...rest) {
  if (request === "@napi-rs/canvas") {
    const err = new Error("Cannot find module '@napi-rs/canvas' (simulated for test — see this file's own header comment)");
    err.code = "MODULE_NOT_FOUND";
    throw err;
  }
  return original.call(this, request, ...rest);
};

const withPolyfill = process.argv[2] === "1";
const pdfPath = process.argv[3];

if (withPolyfill) {
  const { ensurePdfjsNodePolyfills } = await import("../../lib/pdfjs-node-polyfill.ts");
  await ensurePdfjsNodePolyfills();
}

try {
  const { readFile } = await import("node:fs/promises");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = await readFile(pdfPath);
  const document = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  const { extractPdfTextDocument } = await import("../../lib/pdf-text-extraction.ts");
  const text = await extractPdfTextDocument(document);
  console.log(JSON.stringify({ ok: true, numPages: document.numPages, textLength: text.length, hasAttentionTitle: /Attention Is All You Need/.test(text) }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, errorMessage: error instanceof Error ? error.message : String(error) }));
}
