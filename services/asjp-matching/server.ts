// ASJP matching service (LOCAL PROTOTYPE, not deployed). A localhost-only HTTP service in front of a pool of worker
// processes. It never stores a manuscript.
//   POST /match           {text, title?, referenceDate?} -> the worker's answer + queueMs / totalMs; 503 ASJP_BUSY
//                         when the bounded queue is full, 504 ASJP_TIMEOUT past the deadline (that worker is taken out
//                         of rotation, killed and replaced: a stuck query cannot hold a slot), 413 when too long
//   GET  /health          readiness: every worker ready, golden answers reproduced, not degraded, pins, counters
//   POST /admin/refresh   reloads the catalog snapshot in every worker (takedown); each worker has a deadline
//   POST /admin/switch    {generation, golden?} blue/green: a new pool starts beside the old one, must reproduce its
//                         golden answers, then takes new requests; the old pool drains in-flight work, then closes
// Enabled only with ASJP_SERVICE_ENABLED=true. /match and /health need the service token; /admin/* the admin token.
// A switch is accepted only for generation roots / catalogs under config.allowedRoots and the service's own licence
// policy (a serving service refuses the local-research policy unless config.allowLocalResearchPolicy).
import http from "node:http";
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AsjpWorkerConfig } from "./worker";

export type AsjpServiceConfig = {
  port: number; token: string; adminToken: string; workers: number; queueLimit: number; deadlineMs: number; maxWords: number;
  maxBodyBytes?: number; generation: AsjpWorkerConfig; golden?: Array<{ text: string; title?: string | null; digest: string }>;
  allowedRoots: string[]; allowLocalResearchPolicy?: boolean; maxRestartsPerMinute?: number; refreshDeadlineMs?: number; drainMs?: number;
};
type Pending = { id: number; message: any; resolve: (r: any) => void; enqueuedAt: number; timer?: NodeJS.Timeout; settled?: boolean };
type Worker = { child: ChildProcess; ready: boolean; busy: Pending | null; info?: any; refresh: Map<number, (m: any) => void> };

const here = path.dirname(fileURLToPath(import.meta.url));
let seq = 0;
const settle = (p: Pending, r: any) => { if (p.settled) return; p.settled = true; clearTimeout(p.timer); p.resolve(r); };

class Pool {
  workers: Worker[] = [];
  queue: Pending[] = [];
  counters = { served: 0, failed: 0, timeouts: 0, busy: 0, restarts: 0, sendErrors: 0 };
  goldenOk = false;
  degraded: string | null = null;
  closed = false;
  accepting = true;
  private restartTimes: number[] = [];
  constructor(readonly config: AsjpServiceConfig, readonly generation: AsjpWorkerConfig) {}
  private spawn(): Worker {
    const child = fork(path.join(here, "worker.ts"), [], { execArgv: ["--import", "tsx", "--max-old-space-size=4096"], env: { ...process.env, ASJP_WORKER_CONFIG: JSON.stringify(this.generation) }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const w: Worker = { child, ready: false, busy: null, refresh: new Map() };
    child.on("error", () => { this.counters.sendErrors += 1; w.ready = false; });
    child.on("message", (m: any) => {
      if (m?.type === "ready") { w.ready = true; w.info = m; this.dispatch(); return; }
      if (m?.type === "result" && w.busy && m.id === w.busy.id) { const p = w.busy; w.busy = null; settle(p, m); this.dispatch(); return; }
      if (m?.type === "refreshed") { w.refresh.get(m.id)?.(m); w.refresh.delete(m.id); }
    });
    child.on("exit", () => {
      w.ready = false;
      const p = w.busy; w.busy = null;
      if (p) settle(p, { state: "FAILED", failureCode: "WORKER_EXIT" });
      for (const [, done] of w.refresh) done({ ok: false, error: "WORKER_EXIT" });
      w.refresh.clear();
      if (this.closed) return;
      const i = this.workers.indexOf(w);
      if (i < 0) return;
      const now = Date.now();
      this.restartTimes = this.restartTimes.filter((t) => now - t < 60_000);
      if (this.restartTimes.length >= (this.config.maxRestartsPerMinute ?? 5)) { this.degraded = "RESTART_LIMIT"; return; }
      this.restartTimes.push(now);
      const delay = 250 * 2 ** (this.restartTimes.length - 1);
      setTimeout(() => { if (!this.closed) { this.workers[i] = this.spawn(); this.counters.restarts += 1; } }, delay);
    });
    return w;
  }
  private send(w: Worker, message: any, onError: () => void) {
    try { w.child.send(message, (error) => { if (error) { this.counters.sendErrors += 1; w.ready = false; onError(); } }); }
    catch { this.counters.sendErrors += 1; w.ready = false; onError(); }
  }
  async start(timeoutMs = 180_000): Promise<void> {
    this.workers = Array.from({ length: this.config.workers }, () => this.spawn());
    const t0 = Date.now();
    while (!this.workers.every((w) => w.ready)) {
      if (this.degraded || Date.now() - t0 > timeoutMs) throw new Error(`workers did not become ready (${this.degraded ?? "timeout"})`);
      await new Promise((r) => setTimeout(r, 50));
    }
    let ok = true;
    for (const w of this.workers) for (const g of this.config.golden ?? []) { const r = await this.runOn(w, { text: g.text, title: g.title ?? null }); if (r.digest !== g.digest) ok = false; }
    this.goldenOk = ok;
  }
  private runOn(w: Worker, message: any): Promise<any> {
    return new Promise((resolve) => {
      const p: Pending = { id: ++seq, message, resolve, enqueuedAt: Date.now() };
      w.busy = p;
      p.timer = setTimeout(() => { if (w.busy === p) w.busy = null; settle(p, { state: "TIMEOUT", digest: null }); }, this.config.deadlineMs);
      this.send(w, { type: "match", id: p.id, ...message }, () => { if (w.busy === p) w.busy = null; settle(p, { state: "FAILED", digest: null }); });
    });
  }
  submit(message: any): Promise<any> {
    if (!this.accepting) return Promise.resolve({ state: "FAILED", failureCode: "POOL_DRAINING" });
    if (this.queue.length >= this.config.queueLimit) { this.counters.busy += 1; return Promise.resolve({ state: "BUSY", failureCode: "ASJP_BUSY" }); }
    return new Promise((resolve) => { this.queue.push({ id: ++seq, message, resolve, enqueuedAt: Date.now() }); this.dispatch(); });
  }
  private dispatch() {
    for (const w of this.workers) {
      if (!w.ready || w.busy || this.queue.length === 0) continue;
      const p = this.queue.shift()!;
      const queueMs = Date.now() - p.enqueuedAt;
      const done = p.resolve;
      p.resolve = (r) => done({ ...r, queueMs });
      w.busy = p;
      p.timer = setTimeout(() => {
        if (w.busy !== p) return;
        this.counters.timeouts += 1;
        w.busy = null; w.ready = false; // out of rotation before the kill: nothing new is sent to a dying worker
        settle(p, { state: "TIMEOUT", failureCode: "ASJP_TIMEOUT" });
        w.child.kill();
      }, this.config.deadlineMs);
      this.send(w, { type: "match", id: p.id, ...p.message }, () => { if (w.busy === p) w.busy = null; settle(p, { state: "FAILED", failureCode: "WORKER_SEND_FAILED" }); w.child.kill(); });
    }
  }
  idle(): boolean { return this.queue.length === 0 && this.workers.every((w) => !w.busy); }
  async refresh(): Promise<any[]> {
    const deadline = this.config.refreshDeadlineMs ?? 30_000;
    return Promise.all(this.workers.map((w) => new Promise((resolve) => {
      if (!w.ready) return resolve({ ok: false, error: "WORKER_NOT_READY" });
      const id = ++seq;
      const timer = setTimeout(() => { w.refresh.delete(id); resolve({ ok: false, error: "REFRESH_TIMEOUT" }); }, deadline);
      w.refresh.set(id, (m) => { clearTimeout(timer); resolve(m); });
      this.send(w, { type: "refresh-catalog", id }, () => { clearTimeout(timer); w.refresh.delete(id); resolve({ ok: false, error: "SEND_FAILED" }); });
    })));
  }
  async drainAndClose(limitMs: number) {
    this.accepting = false;
    const t0 = Date.now();
    while (!this.idle() && Date.now() - t0 < limitMs) await new Promise((r) => setTimeout(r, 100));
    this.close();
  }
  close() {
    this.closed = true;
    for (const w of this.workers) { w.ready = false; w.child.kill(); }
    for (const p of this.queue) settle(p, { state: "FAILED", failureCode: "SERVICE_CLOSED" });
    this.queue = [];
  }
}

/** A switch config must stay inside the allowed roots and keep the service's licence policy. */
function validGeneration(config: AsjpServiceConfig, g: AsjpWorkerConfig): string | null {
  if (!g || typeof g.root !== "string" || typeof g.catalogPath !== "string" || !g.generationId || !g.logicalManifestSha256) return "incomplete generation config";
  const inside = (p: string) => config.allowedRoots.some((r) => path.resolve(p).toLowerCase().startsWith(path.resolve(r).toLowerCase() + path.sep));
  if (!inside(g.root) || !inside(g.catalogPath) || (g.laneTokensDir && !inside(g.laneTokensDir)) || (g.numericIndexDir && !inside(g.numericIndexDir))) return "a path is outside the allowed roots";
  if (g.licencePolicy !== config.generation.licencePolicy) return "the licence policy differs from the service's";
  return null;
}

export async function startAsjpService(config: AsjpServiceConfig): Promise<{ server: http.Server; close: () => void; pool: () => Pool }> {
  if (process.env.ASJP_SERVICE_ENABLED !== "true") throw new Error("ASJP matching service is disabled (ASJP_SERVICE_ENABLED is not \"true\")");
  if (!config.token || !config.adminToken || config.token === config.adminToken) throw new Error("distinct service and admin tokens are required");
  if (config.generation.licencePolicy === "local-research-all" && !config.allowLocalResearchPolicy) throw new Error("the local-research licence policy is refused unless allowLocalResearchPolicy is set (local research only)");
  const invalid = validGeneration(config, config.generation);
  if (invalid) throw new Error(`generation config refused: ${invalid}`);
  let pool = new Pool(config, config.generation);
  try { await pool.start(); } catch (error) { pool.close(); throw error; }
  const maxBody = config.maxBodyBytes ?? 4_000_000;
  const json = (res: http.ServerResponse, code: number, body: unknown) => { if (res.headersSent) return; res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const read = (req: http.IncomingMessage) => new Promise<string>((resolve, reject) => {
    if (Number(req.headers["content-length"] ?? 0) > maxBody) { req.destroy(); return reject(Object.assign(new Error("too large"), { code: 413 })); }
    const chunks: Buffer[] = []; let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size > maxBody) { req.destroy(); reject(Object.assign(new Error("too large"), { code: 413 })); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
  const server = http.createServer(async (req, res) => {
    try {
      const admin = req.url?.startsWith("/admin/");
      if (req.headers.authorization !== `Bearer ${admin ? config.adminToken : config.token}`) return json(res, 401, { error: "unauthorized" });
      if (req.method === "GET" && req.url === "/health") {
        const ready = pool.workers.filter((w) => w.ready).length;
        const ok = ready === pool.workers.length && pool.goldenOk && !pool.degraded;
        return json(res, ok ? 200 : 503, { ok, workersReady: ready, workers: pool.workers.length, goldenOk: pool.goldenOk, degraded: pool.degraded, generationId: pool.generation.generationId, logicalManifestSha256: pool.generation.logicalManifestSha256, licencePolicy: pool.generation.licencePolicy, queue: pool.queue.length, counters: pool.counters, workerInfo: pool.workers.map((w) => w.info ?? null) });
      }
      if (req.method === "POST" && req.url === "/match") {
        if (!pool.goldenOk) return json(res, 503, { state: "UNAVAILABLE", failureCode: "GOLDEN_MISMATCH" });
        if (pool.degraded) return json(res, 503, { state: "UNAVAILABLE", failureCode: pool.degraded });
        const body = JSON.parse(await read(req));
        if (typeof body.text !== "string") return json(res, 400, { error: "text required" });
        if (body.referenceDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.referenceDate))) return json(res, 400, { error: "referenceDate must be YYYY-MM-DD" });
        if (body.text.split(/\s+/).length > config.maxWords) return json(res, 413, { state: "REJECTED", failureCode: "TOO_LONG" });
        const t0 = Date.now();
        const current = pool;
        const r = await current.submit({ text: body.text, title: body.title ?? null, referenceDate: body.referenceDate ?? null });
        if (r.state === "COMPLETE") current.counters.served += 1; else current.counters.failed += 1;
        return json(res, r.state === "BUSY" ? 503 : r.state === "TIMEOUT" ? 504 : 200, { ...r, totalMs: Date.now() - t0 });
      }
      if (req.method === "POST" && req.url === "/admin/refresh") return json(res, 200, { workers: await pool.refresh() });
      if (req.method === "POST" && req.url === "/admin/switch") {
        const next = JSON.parse(await read(req));
        const why = validGeneration(config, next.generation);
        if (why) return json(res, 400, { switched: false, error: why });
        const candidate = new Pool({ ...config, golden: next.golden ?? config.golden }, next.generation);
        try { await candidate.start(); } catch (error) { candidate.close(); return json(res, 500, { switched: false, error: String((error as Error).message) }); }
        if (!candidate.goldenOk) { candidate.close(); return json(res, 409, { switched: false, error: "the new generation does not reproduce its golden answers" }); }
        const old = pool; pool = candidate;
        void old.drainAndClose(config.drainMs ?? 60_000);
        return json(res, 200, { switched: true, generationId: next.generation.generationId });
      }
      return json(res, 404, { error: "not found" });
    } catch (error) { return json(res, (error as any)?.code === 413 ? 413 : 500, { error: String((error as Error).message) }); }
  });
  await new Promise<void>((resolve) => server.listen(config.port, "127.0.0.1", resolve));
  return { server, close: () => { server.close(); pool.close(); }, pool: () => pool };
}
