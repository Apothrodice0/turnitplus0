import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as core from "../lib/ai-core.ts";

/**
 * WEBGPU ENGINE (2026-10-30). Measured in Chrome 145 on WebGPU: the fp16 graph returned the same near-zero logit pair for
 * every window (document median log-odds 0.0000378 -> a 0 display score whatever the text — every WebGPU report on Preview).
 * The worker now loads the fp32 weights on WebGPU (AI_MODEL_WEBGPU_DTYPE) and scores one fixed self-check sentence first; a
 * session whose answer is not the CPU reference is discarded and the CPU engine (fp16, unchanged) scores the document.
 *
 * The REAL app/ai-detector-worker.ts runs under Node; only `@huggingface/transformers` is the deterministic stand-in
 * (helpers/ai-worker-transformers-stub.mjs). Each case runs in its own process (helpers/ai-worker-engine-case.mjs): the
 * worker's classifier is a module singleton.
 */

const CASE_SCRIPT = fileURLToPath(new URL("./helpers/ai-worker-engine-case.mjs", import.meta.url));

function runCase(...args) {
  const out = execFileSync(process.execPath, ["--import", "tsx", CASE_SCRIPT, ...args], { encoding: "utf8", timeout: 120_000 });
  const result = JSON.parse(out.slice(out.indexOf("{")));
  assert.ok(result.ok, `worker answered: ${result.error}`);
  return result;
}

test("the self-check accepts the CPU reference and rejects a constant near-zero answer", () => {
  assert.equal(core.isAiEngineProbeConsistent(core.AI_ENGINE_PROBE_LOG_ODDS), true);
  assert.equal(core.isAiEngineProbeConsistent(3.3466), true, "the fp16 CPU engine's own answer");
  assert.equal(core.isAiEngineProbeConsistent(0.00003777563853192055), false, "the measured fp16-on-WebGPU answer");
  assert.equal(core.isAiEngineProbeConsistent(Number.NaN), false);
  assert.equal(core.AI_MODEL_WEBGPU_DTYPE, "fp32");
  assert.equal(core.AI_MODEL_DTYPE, "fp16", "the CPU engine's weights are unchanged");
});

test("a WebGPU session that answers every text with the same near-zero logits is discarded: the CPU engine scores the document", () => {
  const result = runCase("gpu", "0.00003777563853192055");
  assert.deepEqual(result.loads, [{ device: "webgpu", dtype: "fp32" }, { device: "wasm", dtype: "fp16" }]);
  assert.equal(result.status, "complete");
  assert.equal(result.engine, "CPU");
  assert.ok(result.cpuSignalCount > 3, "the CPU model scored every window");
  assert.equal(result.cpuSignalCount, result.passageCount);
  assert.equal(result.medianLogOdds, result.cpuMedian, "the score comes from the CPU engine's windows only");
});

test("a healthy WebGPU session loads the fp32 weights and scores the document", () => {
  const result = runCase("gpu");
  assert.deepEqual(result.loads, [{ device: "webgpu", dtype: "fp32" }]);
  assert.equal(result.status, "complete");
  assert.equal(result.engine, "WebGPU");
  assert.equal(result.cpuSignalCount, 0, "nothing ran on the CPU engine");
  assert.ok(result.passageCount > 3);
});

test("without WebGPU the CPU engine loads the fp16 weights, with no self-check", () => {
  const result = runCase("nogpu");
  assert.deepEqual(result.loads, [{ device: "wasm", dtype: "fp16" }]);
  assert.equal(result.engine, "CPU");
  assert.equal(result.medianLogOdds, result.cpuMedian);
});
