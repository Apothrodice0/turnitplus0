// One engine case of tests/ai-webgpu-engine-check.test.mjs, in its own process: the worker's classifier is a module
// singleton, so each case needs a fresh worker module. usage: node --import tsx ai-worker-engine-case.mjs <gpu|nogpu> [webgpuLogOdds]
import { register } from "node:module";

register("./ai-worker-transformers-hooks.mjs", import.meta.url);

const [mode, constantLogOdds] = process.argv.slice(2);
const core = await import("../../lib/ai-core.ts");
const { synthProse } = await import("./real-ai-windows.mjs");
const { stubState } = await import("./ai-worker-transformers-stub.mjs");
stubState.webgpuLogOdds = constantLogOdds === undefined ? null : Number(constantLogOdds);
const posted = [];
const scope = {
  navigator: mode === "gpu" ? { gpu: {} } : {},
  listeners: [],
  addEventListener(type, handler) { if (type === "message") this.listeners.push(handler); },
  postMessage(data) { posted.push(data); },
};
globalThis.__AI_WORKER_SCOPE__ = scope;
await import("../../app/ai-detector-worker.ts");
await scope.listeners[0]({ data: { id: 1, text: synthProse(12_000, { seed: 41 }), detectedLanguage: "English" } });
const answer = posted.find((message) => message.id === 1 && "ok" in message);
process.stdout.write(JSON.stringify({
  ok: answer?.ok ?? false,
  error: answer?.error ?? null,
  status: answer?.result?.status,
  engine: answer?.result?.engine,
  medianLogOdds: answer?.result?.medianLogOdds,
  passageCount: answer?.result?.passages?.length,
  loads: stubState.loads,
  cpuSignalCount: stubState.signals.length,
  cpuMedian: core.medianLogOdds(stubState.signals),
}));
