// ASJP matching service (LOCAL PROTOTYPE, not deployed). A localhost-only HTTP service in front of a pool of worker
// processes. It never stores a manuscript.
//   POST /match           {text, title?, referenceDate?} -> the worker's answer + queueMs / totalMs; 503 ASJP_BUSY
//                         when the bounded queue is full, 504 ASJP_TIMEOUT past the deadline (that worker is killed and
//                         replaced: a stuck query cannot hold a slot), 413 when the manuscript is too long
//   GET  /health          readiness: every worker ready, golden answers reproduced, pins, queue depth, counters
//   POST /admin/refresh   reloads the catalog snapshot in every worker (takedown), asynchronously
//   POST /admin/switch    {generation config} blue/green: a new pool starts beside the old one, must reproduce the new
//                         golden answers, then replaces it atomically; on any failure the old pool stays
// Enabled only with ASJP_SERVICE_ENABLED=true; every request needs the bearer token ASJP_SERVICE_TOKEN.
import http from "node:http";
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AsjpWorkerConfig } from "./worker";

export type AsjpServiceConfig = {
  port: number; token: string; workers: number; queueLimit: number; deadlineMs: number; maxWords: number;
  generation: AsjpWorkerConfig; golden?: Array<{ text: string; title?: string | null; digest: string }>;
};
type Pending = { id: number; message: any; resolve: (r: any) => void; enqueuedAt: number; timer?: NodeJS.Timeout };
type Worker = { child: ChildProcess; ready: boolean; busy: Pending | null; info?: any };

const here = path.dirname(fileURLToPath(import.meta.url));
class Pool {
  workers: Worker[] = [];
  queue: Pending[] = [];
  counters = { served: 0, failed: 0, timeouts: 0, busy: 0, restarts: 0 };
  goldenOk = false;
  constructor(readonly config: AsjpServiceConfig, readonly generation: AsjpWorkerConfig) {}
  private spawn(): Worker {
    const child = fork(path.join(here, "worker.ts"), [], { execArgv: ["--import", "tsx", "--max-old-space-size=4096"], env: { ...process.env, ASJP_WORKER_CONFIG: JSON.stringify(this.generation) }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const w: Worker = { child, ready: false, busy: null };
    child.on("message", (m: any) => {
      if (m?.type === "ready") { w.ready = true; w.info = m; this.dispatch(); return; }
      if (m?.type === "result" && w.busy && m.id === w.busy.id) { const p = w.busy; w.busy = null; clearTimeout(p.timer); p.resolve(m); this.dispatch(); return; }
      if (m?.type === "refreshed") this.refreshWaiters.get(m.id)?.(m);
    });
    child.on("exit", () => {
      const p = w.busy; w.busy = null;
      if (p) { clearTimeout(p.timer); p.resolve({ state: "FAILED", failureCode: "WORKER_EXIT" }); }
      if (this.closed) return;
      const i = this.workers.indexOf(w);
      if (i >= 0) { this.workers[i] = this.spawn(); this.counters.restarts += 1; }
    });
    return w;
  }
  closed = false;
  refreshWaiters = new Map<number, (m: any) => void>();
  async start(timeoutMs = 120_000): Promise<void> {
    this.workers = Array.from({ length: this.config.workers }, () => this.spawn());
    const t0 = Date.now();
    while (!this.workers.every((w) => w.ready)) { if (Date.now() - t0 > timeoutMs) throw new Error("workers did not become ready"); await new Promise((r) => setTimeout(r, 50)); }
    // golden answers: every worker must reproduce each recorded digest
    const golden = this.config.golden ?? [];
    let ok = true;
    for (const w of this.workers) for (const g of golden) { const r = await this.runOn(w, { text: g.text, title: g.title ?? null }); if (r.digest !== g.digest) ok = false; }
    this.goldenOk = ok;
  }
  private runOn(w: Worker, message: any): Promise<any> {
    return new Promise((resolve) => { const p: Pending = { id: ++seq, message, resolve, enqueuedAt: Date.now() }; w.busy = p; w.child.send({ type: "match", id: p.id, ...message }); });
  }
  submit(message: any): Promise<any> {
    if (this.queue.length >= this.config.queueLimit) { this.counters.busy += 1; return Promise.resolve({ state: "BUSY", failureCode: "ASJP_BUSY" }); }
    return new Promise((resolve) => { this.queue.push({ id: ++seq, message, resolve, enqueuedAt: Date.now() }); this.dispatch(); });
  }
  private dispatch() {
    for (const w of this.workers) {
      if (!w.ready || w.busy || this.queue.length === 0) continue;
      const p = this.queue.shift()!;
      w.busy = p;
      const queueMs = Date.now() - p.enqueuedAt;
      const done = p.resolve;
      p.resolve = (r) => done({ ...r, queueMs });
      p.timer = setTimeout(() => { if (w.busy !== p) return; this.counters.timeouts += 1; w.busy = null; done({ state: "TIMEOUT", failureCode: "ASJP_TIMEOUT", queueMs }); w.child.kill(); }, this.config.deadlineMs);
      w.child.send({ type: "match", id: p.id, ...p.message });
    }
  }
  async refresh(): Promise<any[]> {
    return Promise.all(this.workers.map((w) => new Promise((resolve) => { const id = ++seq; this.refreshWaiters.set(id, (m) => { this.refreshWaiters.delete(id); resolve(m); }); w.child.send({ type: "refresh-catalog", id }); })));
  }
  close() { this.closed = true; for (const w of this.workers) w.child.kill(); for (const p of this.queue) p.resolve({ state: "FAILED", failureCode: "SERVICE_CLOSED" }); this.queue = []; }
}
let seq = 0;

export async function startAsjpService(config: AsjpServiceConfig): Promise<{ server: http.Server; close: () => void; pool: () => Pool }> {
  if (process.env.ASJP_SERVICE_ENABLED !== "true") throw new Error("ASJP matching service is disabled (ASJP_SERVICE_ENABLED is not \"true\")");
  if (!config.token) throw new Error("a service token is required");
  let pool = new Pool(config, config.generation);
  await pool.start();
  const json = (res: http.ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const read = (req: http.IncomingMessage) => new Promise<string>((resolve, reject) => { let b = ""; req.setEncoding("utf8"); req.on("data", (c) => { b += c; if (b.length > 4_000_000) reject(new Error("too large")); }); req.on("end", () => resolve(b)); req.on("error", reject); });
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${config.token}`) return json(res, 401, { error: "unauthorized" });
      if (req.method === "GET" && req.url === "/health") {
        const ready = pool.workers.filter((w) => w.ready).length;
        return json(res, ready === pool.workers.length && pool.goldenOk ? 200 : 503, { ok: ready === pool.workers.length && pool.goldenOk, workersReady: ready, workers: pool.workers.length, goldenOk: pool.goldenOk, generationId: pool.generation.generationId, logicalManifestSha256: pool.generation.logicalManifestSha256, queue: pool.queue.length, counters: pool.counters, workerInfo: pool.workers.map((w) => w.info ?? null) });
      }
      if (req.method === "POST" && req.url === "/match") {
        if (!pool.goldenOk) return json(res, 503, { state: "UNAVAILABLE", failureCode: "GOLDEN_MISMATCH" });
        const body = JSON.parse(await read(req));
        if (typeof body.text !== "string") return json(res, 400, { error: "text required" });
        if (body.text.split(/\s+/).length > config.maxWords) return json(res, 413, { state: "REJECTED", failureCode: "TOO_LONG" });
        const t0 = Date.now();
        const r = await pool.submit({ text: body.text, title: body.title ?? null, referenceDate: body.referenceDate ?? null });
        if (r.state === "COMPLETE") pool.counters.served += 1; else pool.counters.failed += 1;
        return json(res, r.state === "BUSY" ? 503 : r.state === "TIMEOUT" ? 504 : 200, { ...r, totalMs: Date.now() - t0 });
      }
      if (req.method === "POST" && req.url === "/admin/refresh") return json(res, 200, { workers: await pool.refresh() });
      if (req.method === "POST" && req.url === "/admin/switch") {
        const next = JSON.parse(await read(req));
        const candidate = new Pool({ ...config, golden: next.golden ?? config.golden }, next.generation);
        try { await candidate.start(); } catch (error) { candidate.close(); return json(res, 500, { switched: false, error: String((error as Error).message) }); }
        if (!candidate.goldenOk) { candidate.close(); return json(res, 409, { switched: false, error: "the new generation does not reproduce its golden answers" }); }
        const old = pool; pool = candidate; setTimeout(() => old.close(), 1000);
        return json(res, 200, { switched: true, generationId: next.generation.generationId });
      }
      return json(res, 404, { error: "not found" });
    } catch (error) { return json(res, 500, { error: String((error as Error).message) }); }
  });
  await new Promise<void>((resolve) => server.listen(config.port, "127.0.0.1", resolve));
  return { server, close: () => { server.close(); pool.close(); }, pool: () => pool };
}
