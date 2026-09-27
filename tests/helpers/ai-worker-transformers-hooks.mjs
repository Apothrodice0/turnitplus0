// Module hooks that let a test run the REAL app/ai-detector-worker.ts under plain Node:
//  - only that worker's own import of `@huggingface/transformers` is redirected to ./ai-worker-transformers-stub.mjs (a
//    deterministic tokenizer + model stand-in — no download, no ONNX);
//  - the worker's `self` (its DedicatedWorkerGlobalScope) is bound, for that one module only, to
//    `globalThis.__AI_WORKER_SCOPE__`, which the test provides. A process-wide `self` global is deliberately NOT used:
//    UMD dependencies (pdf-lib) read `typeof self` to pick a browser build and then break under Node.
// Every other module the worker uses (lib/ai-core.ts, lib/ai-model-prep.ts, lib/similarity-core.ts) is the real code, unmodified.
//
// Register it BEFORE importing the worker:
//   import { register } from "node:module";
//   register("./helpers/ai-worker-transformers-hooks.mjs", import.meta.url);
const STUB_URL = new URL("./ai-worker-transformers-stub.mjs", import.meta.url).href;
const WORKER = /\/app\/ai-detector-worker\.ts$/;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@huggingface/transformers" && WORKER.test(context.parentURL ?? "")) {
    return { url: STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!WORKER.test(url) || result.source == null) return result;
  return { ...result, source: `const self = globalThis.__AI_WORKER_SCOPE__;${String(result.source)}` };
}
