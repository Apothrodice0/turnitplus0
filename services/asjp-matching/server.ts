// ASJP matching service (LOCAL PROTOTYPE, not deployed). A localhost-only HTTP service in front of a pool of worker
// processes. It never stores a manuscript.
//   POST /attest          (request signing on) a signed, manuscript-free, bearer-free request answered with a response
//                         signature: the report client proves it reached the key holder BEFORE sending a manuscript
//   POST /match           {text, title?, referenceDate?, excludeSourceIds?} -> the worker's answer + queueMs / totalMs;
//                         503 ASJP_BUSY when the bounded queue is full, 504 ASJP_TIMEOUT when no answer within the
//                         deadline (counted from ARRIVAL, queue wait included), 413 when too long
//   GET  /health          readiness: every worker ready, golden answers reproduced, not degraded, pins, counters
//   POST /admin/refresh   reloads the catalog snapshot in every worker (takedown); each worker has a deadline
//   POST /admin/switch    {generation, golden?} blue/green: a new pool starts beside the old one, must reproduce its
//                         golden answers, then takes new requests; the old pool drains in-flight work, then closes
// Enabled only with ASJP_SERVICE_ENABLED=true. /match and /health need the service token; /admin/* the admin token.
// A switch is accepted only for generation roots / catalogs under config.allowedRoots and the service's own licence
// policy (a serving service refuses the local-research policy unless config.allowLocalResearchPolicy).
// Credentials (Phase 6.5): tokens come from the caller or asjpServiceConfigFromEnv (environment / token files), are
// compared in constant time, are never logged or echoed, and are removed from the workers' environment. Phase 7
// remediation: every credential must be >= 32 characters with >= 12 distinct characters (asjpCredentialProblem).
import http from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual, createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AsjpWorkerConfig } from "./worker";
import { ASJP_PROTOCOL_VERSION, asjpCredentialProblem, asjpRequestMac, asjpResponseMac, macEquals, sha256Hex } from "../../lib/asjp-service-protocol";

export type AsjpServiceConfig = {
  port: number; token: string; adminToken: string; workers: number; queueLimit: number; deadlineMs: number; maxWords: number;
  maxBodyBytes?: number; generation: AsjpWorkerConfig; golden?: Array<{ text: string; title?: string | null; digest: string }>;
  /**
   * Phase 7 (PC / quick-tunnel hosting): when set, every /attest and /match request must carry the protocol-v2 request
   * signature (lib/asjp-service-protocol.ts: method, path, Host, timestamp, single-use nonce, sha256 of the raw body)
   * with a timestamp within ±requestMaxSkewMs (default 120 s) and not older than this process (a request captured
   * before a restart is never accepted again), and every answer is signed back. The bearer token is still required on
   * /match. adminLocalOnly refuses /admin/* for any request carrying a proxy header (cloudflared adds cf-connecting-ip).
   */
  requestSigningKey?: string; requestMaxSkewMs?: number; adminLocalOnly?: boolean;
  allowedRoots: string[]; allowLocalResearchPolicy?: boolean; maxRestartsPerMinute?: number; refreshDeadlineMs?: number; drainMs?: number;
  /** E1: after RESTART_LIMIT the pool tries to recover (fresh workers, golden answers re-checked) after this cooldown, at most maxRecoveriesPerHour times. */
  recoveryCooldownMs?: number; maxRecoveriesPerHour?: number;
};
type Pending = { id: number; message: any; resolve: (r: any) => void; enqueuedAt: number; timer?: NodeJS.Timeout; workerTimer?: NodeJS.Timeout; settled?: boolean; dispatched?: boolean };
type Worker = { child: ChildProcess; ready: boolean; busy: Pending | null; info?: any; refresh: Map<number, (m: any) => void>; exited?: boolean };

const here = path.dirname(fileURLToPath(import.meta.url));
/** Environment variables a worker never receives (credentials). */
export const ASJP_SECRET_ENV = ["ASJP_SERVICE_TOKEN", "ASJP_ADMIN_TOKEN", "ASJP_SERVICE_TOKEN_FILE", "ASJP_ADMIN_TOKEN_FILE", "ASJP_REQUEST_SIGNING_KEY", "ASJP_REQUEST_SIGNING_KEY_FILE"];
/**
 * Review finding 13: a worker gets an ALLOWLISTED environment (what Node / tsx / the OS need) — never the service's
 * other variables, whatever secrets they hold. Its configuration travels in ASJP_WORKER_CONFIG (no credential in it).
 */
const WORKER_ENV_ALLOW = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG", "LC_ALL", "TZ", "NODE_OPTIONS", "NODE_NO_WARNINGS", "NODE_ENV", "TSX_TSCONFIG_PATH"]);
export function workerEnv(): NodeJS.ProcessEnv { const env = {} as NodeJS.ProcessEnv; for (const [k, v] of Object.entries(process.env)) if (WORKER_ENV_ALLOW.has(k.toUpperCase()) && !ASJP_SECRET_ENV.includes(k)) env[k] = v; return env; }
/** Constant-time bearer check (hash first, so lengths never leak). */
function bearerMatches(header: string | undefined, token: string): boolean {
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${token}`));
}
let seq = 0;
const settle = (p: Pending, r: any) => { if (p.settled) return; p.settled = true; clearTimeout(p.timer); p.resolve(r); };

class Pool {
  workers: Worker[] = [];
  queue: Pending[] = [];
  counters = { served: 0, failed: 0, timeouts: 0, queueTimeouts: 0, busy: 0, restarts: 0, sendErrors: 0, cancelled: 0, recoveries: 0 };
  goldenOk = false;
  degraded: string | null = null;
  closed = false;
  accepting = true;
  private restartTimes: number[] = [];
  private recoveryTimes: number[] = [];
  private recoveryTimer?: NodeJS.Timeout;
  constructor(readonly config: AsjpServiceConfig, readonly generation: AsjpWorkerConfig) {}
  private spawn(): Worker {
    const child = fork(path.join(here, "worker.ts"), [], { execArgv: ["--import", "tsx", "--max-old-space-size=4096"], env: { ...workerEnv(), ASJP_WORKER_CONFIG: JSON.stringify(this.generation) }, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const w: Worker = { child, ready: false, busy: null, refresh: new Map() };
    child.on("error", () => { this.counters.sendErrors += 1; w.ready = false; });
    child.on("message", (m: any) => {
      if (m?.type === "ready") { w.ready = true; w.info = m; this.dispatch(); return; }
      // a late answer for a request whose response deadline already passed frees the worker; settle() ignores it
      if (m?.type === "result" && w.busy && m.id === w.busy.id) { const p = w.busy; w.busy = null; clearTimeout(p.workerTimer); settle(p, m); this.dispatch(); return; }
      if (m?.type === "refreshed") { w.refresh.get(m.id)?.(m); w.refresh.delete(m.id); }
    });
    child.on("exit", () => {
      w.ready = false; w.exited = true;
      const p = w.busy; w.busy = null;
      if (p) { clearTimeout(p.workerTimer); settle(p, { state: "FAILED", failureCode: "WORKER_EXIT" }); }
      for (const [, done] of w.refresh) done({ ok: false, error: "WORKER_EXIT" });
      w.refresh.clear();
      if (this.closed || this.degraded) return;
      const i = this.workers.indexOf(w);
      if (i < 0) return;
      const now = Date.now();
      this.restartTimes = this.restartTimes.filter((t) => now - t < 60_000);
      if (this.restartTimes.length >= (this.config.maxRestartsPerMinute ?? 5)) { this.degrade("RESTART_LIMIT"); return; }
      this.restartTimes.push(now);
      const delay = 250 * 2 ** (this.restartTimes.length - 1);
      setTimeout(() => { if (!this.closed && !this.degraded) { this.workers[i] = this.spawn(); this.counters.restarts += 1; } }, delay);
    });
    return w;
  }
  /** E1: degraded settles every queued request at once (nothing waits for a pool that will not serve) and schedules a bounded recovery. */
  private degrade(reason: string) {
    this.degraded = reason;
    for (const p of this.queue) settle(p, { state: "UNAVAILABLE", failureCode: reason });
    this.queue = [];
    this.scheduleRecovery();
  }
  private scheduleRecovery() {
    if (this.closed || this.recoveryTimer) return;
    const now = Date.now();
    this.recoveryTimes = this.recoveryTimes.filter((t) => now - t < 3_600_000);
    if (this.recoveryTimes.length >= (this.config.maxRecoveriesPerHour ?? 3)) { this.degraded = "RESTART_LIMIT_EXHAUSTED"; return; }
    this.recoveryTimer = setTimeout(() => { this.recoveryTimer = undefined; void this.recover(); }, this.config.recoveryCooldownMs ?? 60_000);
  }
  /** Replace every dead or unready worker, wait for them, re-check the golden answers on them; serve again only if all pass. */
  private async recover() {
    if (this.closed) return;
    this.recoveryTimes.push(Date.now());
    const fresh: Worker[] = [];
    this.workers = this.workers.map((w) => { if (w.ready && !w.exited) return w; if (!w.exited) w.child.kill(); const n = this.spawn(); fresh.push(n); return n; });
    const t0 = Date.now();
    while (!fresh.every((w) => w.ready) && Date.now() - t0 < 180_000 && !this.closed) {
      if (fresh.some((w) => w.exited)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    let ok = fresh.every((w) => w.ready && !w.exited);
    if (ok) for (const w of fresh) for (const g of this.config.golden ?? []) { const r = await this.runOn(w, { text: g.text, title: g.title ?? null }); if (r.digest !== g.digest) ok = false; }
    if (this.closed) return;
    if (ok) { this.restartTimes = []; this.degraded = null; this.counters.recoveries += 1; this.dispatch(); return; }
    this.degraded = "RESTART_LIMIT";
    this.scheduleRecovery();
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
      const p: Pending = { id: ++seq, message, resolve, enqueuedAt: Date.now(), dispatched: true };
      w.busy = p;
      p.timer = setTimeout(() => { if (w.busy === p) w.busy = null; settle(p, { state: "TIMEOUT", digest: null }); }, this.config.deadlineMs);
      this.send(w, { type: "match", id: p.id, ...message }, () => { if (w.busy === p) w.busy = null; settle(p, { state: "FAILED", digest: null }); });
    });
  }
  /**
   * E1: the RESPONSE deadline runs from arrival (queue wait included): a request still queued then is removed and
   * answered ASJP_TIMEOUT, one already dispatched is answered ASJP_TIMEOUT while its worker finishes (only a worker
   * still busy deadlineMs after ITS dispatch is considered stuck, killed and replaced). cancel() drops a request whose
   * client went away before it was dispatched.
   */
  submit(message: any): { promise: Promise<any>; cancel: () => void } {
    if (!this.accepting) return { promise: Promise.resolve({ state: "FAILED", failureCode: "POOL_DRAINING" }), cancel: () => {} };
    if (this.degraded) return { promise: Promise.resolve({ state: "UNAVAILABLE", failureCode: this.degraded }), cancel: () => {} };
    if (this.queue.length >= this.config.queueLimit) { this.counters.busy += 1; return { promise: Promise.resolve({ state: "BUSY", failureCode: "ASJP_BUSY" }), cancel: () => {} }; }
    let pending!: Pending;
    const promise = new Promise<any>((resolve) => {
      pending = { id: ++seq, message, resolve, enqueuedAt: Date.now() };
      pending.timer = setTimeout(() => {
        const i = this.queue.indexOf(pending);
        if (i >= 0) { this.queue.splice(i, 1); this.counters.queueTimeouts += 1; } else this.counters.timeouts += 1;
        settle(pending, { state: "TIMEOUT", failureCode: "ASJP_TIMEOUT", queueMs: pending.dispatched ? undefined : Date.now() - pending.enqueuedAt });
      }, this.config.deadlineMs);
      this.queue.push(pending);
      this.dispatch();
    });
    const cancel = () => { const i = this.queue.indexOf(pending); if (i >= 0) { this.queue.splice(i, 1); this.counters.cancelled += 1; settle(pending, { state: "FAILED", failureCode: "CLIENT_GONE" }); } };
    return { promise, cancel };
  }
  private dispatch() {
    if (this.degraded) return;
    for (const w of this.workers) {
      if (!w.ready || w.busy || this.queue.length === 0) continue;
      const p = this.queue.shift()!;
      if (p.settled) continue;
      p.dispatched = true;
      const queueMs = Date.now() - p.enqueuedAt;
      const done = p.resolve;
      p.resolve = (r) => done({ ...r, queueMs });
      w.busy = p;
      p.workerTimer = setTimeout(() => {
        if (w.busy !== p) return;
        w.busy = null; w.ready = false; // stuck: out of rotation before the kill, nothing new is sent to a dying worker
        settle(p, { state: "TIMEOUT", failureCode: "ASJP_TIMEOUT" });
        w.child.kill();
      }, this.config.deadlineMs);
      this.send(w, { type: "match", id: p.id, ...p.message }, () => { if (w.busy === p) w.busy = null; clearTimeout(p.workerTimer); settle(p, { state: "FAILED", failureCode: "WORKER_SEND_FAILED" }); w.child.kill(); });
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
    clearTimeout(this.recoveryTimer);
    for (const w of this.workers) { w.ready = false; w.child.kill(); }
    for (const p of this.queue) settle(p, { state: "FAILED", failureCode: "SERVICE_CLOSED" });
    this.queue = [];
  }
}

/** A switch config must stay inside the allowed roots and keep the service's licence policy. */
function validGeneration(config: AsjpServiceConfig, g: AsjpWorkerConfig): string | null {
  if (!g || typeof g.root !== "string" || typeof g.catalogPath !== "string" || !g.generationId || !g.logicalManifestSha256) return "incomplete generation config";
  const inside = (p: string) => config.allowedRoots.some((r) => path.resolve(p).toLowerCase().startsWith(path.resolve(r).toLowerCase() + path.sep));
  if (!inside(g.root) || !inside(g.catalogPath) || (g.laneTokensDir && !inside(g.laneTokensDir)) || (g.numericIndexDir && !inside(g.numericIndexDir)) || (g.features?.shortSignal?.wordDfPath && !inside(g.features.shortSignal.wordDfPath))) return "a path is outside the allowed roots";
  // six-word overlap: the index, the word-frequency table and the token store the index reads must stay inside too
  const six = g.features?.sixwordOverlap;
  if (six) {
    if (!inside(six.indexDir) || !inside(six.wordDfPath)) return "a path is outside the allowed roots";
    let tokensDir: string | null = null;
    try { tokensDir = JSON.parse(readFileSync(path.join(six.indexDir, "identity.json"), "utf8"))?.laneTokens?.dir ?? null; } catch { /* unreadable: the worker reports the feature UNAVAILABLE */ }
    if (tokensDir && !inside(tokensDir)) return "a path is outside the allowed roots";
  }
  if (g.licencePolicy !== config.generation.licencePolicy) return "the licence policy differs from the service's";
  return null;
}

/** What a verified request is bound to; every answer to it is signed over the same values. */
export type AsjpRequestContext = { nonce: string; host: string; requestBodySha256: string };
/**
 * A protocol-v2 request verifier with its OWN single-use nonce memory (one per service instance). Refuses: missing /
 * malformed headers, a timestamp outside ±maxSkewMs, a timestamp older than notBefore (the service's start: a request
 * signed before a restart is never accepted again), a nonce already seen, and any MAC mismatch (method, path, Host,
 * timestamp, nonce or the raw body bytes changed).
 */
export function asjpRequestVerifier(key: string, maxSkewMs = 120_000, notBefore = 0) {
  const seen = new Map<string, number>();
  return (req: { method?: string; url?: string; headers: http.IncomingHttpHeaders }, rawBody: Buffer | string, now = Date.now()): AsjpRequestContext | null => {
    const ts = String(req.headers["x-asjp-timestamp"] ?? ""), nonce = String(req.headers["x-asjp-nonce"] ?? ""), sig = String(req.headers["x-asjp-signature"] ?? "");
    if (!/^\d{13}$/.test(ts) || !/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return null;
    const t = Number(ts);
    if (Math.abs(now - t) > maxSkewMs || t < notBefore) return null;
    for (const [n, at] of seen) if (now - at > 2 * maxSkewMs) seen.delete(n);
    if (seen.has(nonce)) return null;
    const host = String(req.headers.host ?? "");
    const requestBodySha256 = sha256Hex(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody);
    if (!macEquals(asjpRequestMac(key, { method: req.method ?? "", path: req.url ?? "", host, ts, nonce, bodySha256: requestBodySha256 }), sig)) return null;
    seen.set(nonce, now);
    return { nonce, host, requestBodySha256 };
  };
}

const SOURCE_ID = /^asjp:\d{1,12}$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export async function startAsjpService(config: AsjpServiceConfig): Promise<{ server: http.Server; close: () => void; pool: () => Pool }> {
  if (process.env.ASJP_SERVICE_ENABLED !== "true") throw new Error("ASJP matching service is disabled (ASJP_SERVICE_ENABLED is not \"true\")");
  if (!config.token || !config.adminToken || config.token === config.adminToken) throw new Error("distinct service and admin tokens are required");
  for (const [name, value] of [["service token", config.token], ["admin token", config.adminToken], ...(config.requestSigningKey !== undefined ? [["request-signing key", config.requestSigningKey]] : [])] as const) {
    const weak = asjpCredentialProblem(value);
    if (weak) throw new Error(`the ${name} is too weak (${weak}): use >= 32 random characters`);
  }
  if (config.generation.licencePolicy === "local-research-all" && !config.allowLocalResearchPolicy) throw new Error("the local-research licence policy is refused unless allowLocalResearchPolicy is set (local research only)");
  const invalid = validGeneration(config, config.generation);
  if (invalid) throw new Error(`generation config refused: ${invalid}`);
  const startedAt = Date.now();
  const verifyRequest = config.requestSigningKey ? asjpRequestVerifier(config.requestSigningKey, config.requestMaxSkewMs ?? 120_000, startedAt) : null;
  let pool = new Pool(config, config.generation);
  try { await pool.start(); } catch (error) { pool.close(); throw error; }
  const maxBody = config.maxBodyBytes ?? 4_000_000;
  const json = (res: http.ServerResponse, code: number, body: unknown) => { if (res.headersSent) return; res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  /** A1: the answer to a verified request, signed over (request nonce, Host, request body digest, status, the exact response bytes). */
  const signedJson = (res: http.ServerResponse, code: number, body: unknown, ctx: AsjpRequestContext) => {
    if (res.headersSent) return;
    const bytes = Buffer.from(JSON.stringify(body), "utf8");
    const signature = asjpResponseMac(config.requestSigningKey!, { nonce: ctx.nonce, host: ctx.host, requestBodySha256: ctx.requestBodySha256, status: code, responseBodySha256: sha256Hex(bytes) });
    res.writeHead(code, { "content-type": "application/json", "x-asjp-response-signature": signature, "x-asjp-protocol": ASJP_PROTOCOL_VERSION });
    res.end(bytes);
  };
  const read = (req: http.IncomingMessage) => new Promise<Buffer>((resolve, reject) => {
    if (Number(req.headers["content-length"] ?? 0) > maxBody) { req.destroy(); return reject(Object.assign(new Error("too large"), { code: 413 })); }
    const chunks: Buffer[] = []; let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size > maxBody) { req.destroy(); reject(Object.assign(new Error("too large"), { code: 413 })); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/attest") {
        // A1: proof of key possession for THIS hostname, before the client sends a manuscript or its bearer token
        if (!verifyRequest) return json(res, 404, { error: "not found" });
        const ctx = verifyRequest(req, await read(req));
        if (!ctx) return json(res, 401, { error: "unauthorized" });
        return signedJson(res, 200, { ok: true, protocol: ASJP_PROTOCOL_VERSION }, ctx);
      }
      const admin = req.url?.startsWith("/admin/");
      // A3: the PRESENCE of any proxy header (even empty) marks a request that did not originate on this host
      if (admin && config.adminLocalOnly && (req.headers["cf-connecting-ip"] !== undefined || req.headers["x-forwarded-for"] !== undefined || req.headers["forwarded"] !== undefined || req.headers["cf-ray"] !== undefined)) return json(res, 403, { error: "forbidden" });
      if (!bearerMatches(req.headers.authorization, admin ? config.adminToken : config.token)) return json(res, 401, { error: "unauthorized" });
      if (req.method === "GET" && req.url === "/health") {
        const ready = pool.workers.filter((w) => w.ready).length;
        const ok = ready === pool.workers.length && pool.goldenOk && !pool.degraded;
        return json(res, ok ? 200 : 503, { ok, workersReady: ready, workers: pool.workers.length, goldenOk: pool.goldenOk, degraded: pool.degraded, generationId: pool.generation.generationId, logicalManifestSha256: pool.generation.logicalManifestSha256, licencePolicy: pool.generation.licencePolicy, features: pool.workers[0]?.info?.features ?? null, queue: pool.queue.length, counters: pool.counters, workerInfo: pool.workers.map((w) => w.info ?? null), protocol: ASJP_PROTOCOL_VERSION, requestSigning: !!verifyRequest });
      }
      if (req.method === "POST" && req.url === "/match") {
        const raw = await read(req);
        let ctx: AsjpRequestContext | null = null;
        if (verifyRequest) { ctx = verifyRequest(req, raw); if (!ctx) return json(res, 401, { error: "unauthorized" }); }
        const reply = (code: number, body: unknown) => (ctx ? signedJson(res, code, body, ctx) : json(res, code, body));
        if (!pool.goldenOk) return reply(503, { state: "UNAVAILABLE", failureCode: "GOLDEN_MISMATCH" });
        if (pool.degraded) return reply(503, { state: "UNAVAILABLE", failureCode: pool.degraded });
        let body: any;
        try { body = JSON.parse(utf8.decode(raw)); } catch { return reply(400, { error: "bad request" }); }
        if (!body || typeof body.text !== "string") return reply(400, { error: "text required" });
        if (body.referenceDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.referenceDate))) return reply(400, { error: "referenceDate must be YYYY-MM-DD" });
        // B3: the report's withdrawn articles are excluded by the lane itself (treated as withdrawn), never credited
        const exclude = body.excludeSourceIds ?? [];
        if (!Array.isArray(exclude) || exclude.length > 1000 || !exclude.every((s: unknown) => typeof s === "string" && SOURCE_ID.test(s))) return reply(400, { error: "excludeSourceIds must be up to 1000 asjp:<id> values" });
        if (body.text.split(/\s+/).length > config.maxWords) return reply(413, { state: "REJECTED", failureCode: "TOO_LONG" });
        const t0 = Date.now();
        const current = pool;
        const job = current.submit({ text: body.text, title: body.title ?? null, referenceDate: body.referenceDate ?? null, excludeSourceIds: exclude });
        res.on("close", () => { if (!res.writableFinished) job.cancel(); });
        const r = await job.promise;
        if (r.state === "COMPLETE") current.counters.served += 1; else current.counters.failed += 1;
        return reply(r.state === "BUSY" || r.state === "UNAVAILABLE" ? 503 : r.state === "TIMEOUT" ? 504 : 200, { ...r, totalMs: Date.now() - t0 });
      }
      // INFORMATIONAL six-word overlap (contract asjp-sixword-overlap-contract-v1): an explicit developer request only. The
      // same protocol-v2 verification and signed answers, golden / degraded gates, body, word and takedown limits as
      // /match; absent (404) unless the service was started with the feature. Never scored, never part of /match.
      if (req.method === "POST" && req.url === "/sixword") {
        if (!pool.generation.features?.sixwordOverlap) return json(res, 404, { error: "not found" });
        const raw = await read(req);
        let ctx: AsjpRequestContext | null = null;
        if (verifyRequest) { ctx = verifyRequest(req, raw); if (!ctx) return json(res, 401, { error: "unauthorized" }); }
        const reply = (code: number, body: unknown) => (ctx ? signedJson(res, code, body, ctx) : json(res, code, body));
        if (!pool.goldenOk) return reply(503, { state: "UNAVAILABLE", failureCode: "GOLDEN_MISMATCH" });
        if (pool.degraded) return reply(503, { state: "UNAVAILABLE", failureCode: pool.degraded });
        let body: any;
        try { body = JSON.parse(utf8.decode(raw)); } catch { return reply(400, { error: "bad request" }); }
        if (!body || typeof body.text !== "string") return reply(400, { error: "text required" });
        if (body.referenceDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.referenceDate))) return reply(400, { error: "referenceDate must be YYYY-MM-DD" });
        const exclude = body.excludeSourceIds ?? [];
        if (!Array.isArray(exclude) || exclude.length > 1000 || !exclude.every((x: unknown) => typeof x === "string" && SOURCE_ID.test(x))) return reply(400, { error: "excludeSourceIds must be up to 1000 asjp:<id> values" });
        const credited = body.creditedPositions ?? [];
        if (!Array.isArray(credited) || credited.length > config.maxWords || !credited.every((q: unknown) => Number.isInteger(q) && (q as number) >= 0)) return reply(400, { error: "creditedPositions must be word positions" });
        if (body.text.split(/\s+/).length > config.maxWords) return reply(413, { state: "REJECTED", failureCode: "TOO_LONG" });
        const t0 = Date.now();
        const job = pool.submit({ type: "sixword", text: body.text, referenceDate: body.referenceDate ?? null, excludeSourceIds: exclude, creditedPositions: credited });
        res.on("close", () => { if (!res.writableFinished) job.cancel(); });
        const r = await job.promise;
        return reply(r.state === "BUSY" || (r.state === "UNAVAILABLE" && !r.contract) ? 503 : r.state === "TIMEOUT" ? 504 : 200, { ...r, totalMs: Date.now() - t0 });
      }
      if (req.method === "POST" && req.url === "/admin/refresh") return json(res, 200, { workers: await pool.refresh() });
      if (req.method === "POST" && req.url === "/admin/switch") {
        const rawSwitch = await read(req);
        let next: any;
        try { next = JSON.parse(utf8.decode(rawSwitch)); } catch { return json(res, 400, { error: "bad request" }); }
        const why = validGeneration(config, next.generation);
        if (why) return json(res, 400, { switched: false, error: why });
        // review finding 9: a switch changes the GENERATION only — features and corrections stay the service's own (set
        // from its environment), never a request's
        const candidate = new Pool({ ...config, golden: next.golden ?? config.golden }, { ...next.generation, features: config.generation.features, corrections: config.generation.corrections });
        try { await candidate.start(); } catch { candidate.close(); return json(res, 500, { switched: false, error: "the new generation did not start" }); }
        if (!candidate.goldenOk) { candidate.close(); return json(res, 409, { switched: false, error: "the new generation does not reproduce its golden answers" }); }
        const old = pool; pool = candidate;
        void old.drainAndClose(config.drainMs ?? 60_000);
        return json(res, 200, { switched: true, generationId: next.generation.generationId });
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      // Phase 7 (no-leak): never echo an error message — a JSON parse error quotes the request body (manuscript text)
      if ((error as any)?.code === 413) return json(res, 413, { error: "too large" });
      if (error instanceof SyntaxError) return json(res, 400, { error: "bad request" });
      return json(res, 500, { error: "internal error" });
    }
  });
  await new Promise<void>((resolve) => server.listen(config.port, "127.0.0.1", resolve));
  return { server, close: () => { server.close(); pool.close(); }, pool: () => pool };
}

/**
 * The service configuration from the environment — the only place credentials enter (never source code):
 *   ASJP_SERVICE_TOKEN / ASJP_SERVICE_TOKEN_FILE, ASJP_ADMIN_TOKEN / ASJP_ADMIN_TOKEN_FILE   (a file wins; trimmed)
 *   ASJP_REQUEST_SIGNING_KEY / _FILE   protocol-v2 request + response signing (required for any tunnel / remote use)
 *   ASJP_REQUEST_MAX_SKEW_MS           signed-request clock tolerance (default 120000)
 *   ASJP_ADMIN_LOCAL_ONLY=true         /admin/* refused when any proxy header is present
 *   ASJP_GENERATION_CONFIG   path of a JSON AsjpWorkerConfig (generation, catalog, token store, licence policy)
 *   ASJP_ALLOWED_ROOTS       ";"-separated roots every path must stay inside
 *   ASJP_SERVICE_PORT, ASJP_SERVICE_WORKERS, ASJP_SERVICE_QUEUE, ASJP_SERVICE_DEADLINE_MS
 *   ASJP_RECOVERY_COOLDOWN_MS, ASJP_MAX_RECOVERIES_PER_HOUR   bounded recovery after RESTART_LIMIT (60000, 3)
 *   ASJP_NUMERIC_TABLES_ENABLED=true (+ numericIndexDir in the generation config)   number-table path
 *   ASJP_SHORT_SIGNAL_ENABLED=true + ASJP_WORD_DF_PATH                               UNSCORED short-passage signal
 *   ASJP_SIXWORD_OVERLAP_ENABLED=true + ASJP_SIXWORD_INDEX_DIR + ASJP_WORD_DF_PATH   INFORMATIONAL six-word overlap
 *                      (POST /sixword, contract asjp-sixword-overlap-contract-v1; never scored, never part of /match)
 *   ASJP_GOLDEN_FILE   JSON [{text, title, digest}] every worker must reproduce before /health reports ready (Phase 7;
 *                      required whenever ASJP_REQUIRE_GOLDEN=true, so a serving host can never report healthy without it)
 */
export function asjpServiceConfigFromEnv(env: Record<string, string | undefined> = process.env): AsjpServiceConfig {
  const secret = (name: string): string => {
    const file = env[`${name}_FILE`];
    const value = file ? readFileSync(file, "utf8").trim() : (env[name] ?? "").trim();
    if (!value) throw new Error(`${name} (or ${name}_FILE) is required`);
    return value;
  };
  if (!env.ASJP_GENERATION_CONFIG) throw new Error("ASJP_GENERATION_CONFIG is required");
  const generation = JSON.parse(readFileSync(env.ASJP_GENERATION_CONFIG, "utf8")) as AsjpWorkerConfig;
  generation.features = {
    numericTables: env.ASJP_NUMERIC_TABLES_ENABLED === "true",
    shortSignal: env.ASJP_SHORT_SIGNAL_ENABLED === "true" && env.ASJP_WORD_DF_PATH ? { wordDfPath: env.ASJP_WORD_DF_PATH } : null,
    // informational six-word overlap (POST /sixword only); absent unless explicitly enabled, so defaults stay identical
    ...(env.ASJP_SIXWORD_OVERLAP_ENABLED === "true" && env.ASJP_SIXWORD_INDEX_DIR && env.ASJP_WORD_DF_PATH ? { sixwordOverlap: { indexDir: env.ASJP_SIXWORD_INDEX_DIR, wordDfPath: env.ASJP_WORD_DF_PATH } } : {}),
  };
  const num = (v: string | undefined, d: number) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    port: num(env.ASJP_SERVICE_PORT, 47_500), token: secret("ASJP_SERVICE_TOKEN"), adminToken: secret("ASJP_ADMIN_TOKEN"),
    ...(env.ASJP_REQUEST_SIGNING_KEY || env.ASJP_REQUEST_SIGNING_KEY_FILE ? { requestSigningKey: secret("ASJP_REQUEST_SIGNING_KEY") } : {}),
    requestMaxSkewMs: num(env.ASJP_REQUEST_MAX_SKEW_MS, 120_000),
    adminLocalOnly: env.ASJP_ADMIN_LOCAL_ONLY === "true",
    workers: num(env.ASJP_SERVICE_WORKERS, 4), queueLimit: num(env.ASJP_SERVICE_QUEUE, 32), deadlineMs: num(env.ASJP_SERVICE_DEADLINE_MS, 7_000) /* below the report client 8 s timeout: abandoned work never holds a worker */, maxWords: 60_000,
    recoveryCooldownMs: num(env.ASJP_RECOVERY_COOLDOWN_MS, 60_000), maxRecoveriesPerHour: num(env.ASJP_MAX_RECOVERIES_PER_HOUR, 3),
    generation, allowedRoots: (env.ASJP_ALLOWED_ROOTS ?? "").split(";").filter(Boolean), allowLocalResearchPolicy: env.ASJP_ALLOW_LOCAL_RESEARCH_POLICY === "true",
    ...goldenFromEnv(env),
  };
}

/** Golden answers from ASJP_GOLDEN_FILE; with ASJP_REQUIRE_GOLDEN=true a missing / empty / malformed file refuses to start. */
function goldenFromEnv(env: Record<string, string | undefined>): { golden?: AsjpServiceConfig["golden"] } {
  const required = env.ASJP_REQUIRE_GOLDEN === "true";
  if (!env.ASJP_GOLDEN_FILE) { if (required) throw new Error("ASJP_GOLDEN_FILE is required (ASJP_REQUIRE_GOLDEN=true)"); return {}; }
  const golden = JSON.parse(readFileSync(env.ASJP_GOLDEN_FILE, "utf8"));
  const valid = Array.isArray(golden) && golden.length > 0 && golden.every((g: any) => typeof g?.text === "string" && typeof g?.digest === "string" && /^[0-9a-f]{64}$/.test(g.digest));
  if (!valid) throw new Error("ASJP_GOLDEN_FILE must be a non-empty array of {text, title?, digest}");
  return { golden };
}
