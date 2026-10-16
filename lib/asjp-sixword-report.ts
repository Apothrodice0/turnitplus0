import type { Client } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { tryDecodeReportFromPersistence } from "./report-persistence";
import type { SimilarityReport } from "./report-types";
import {
  asjpChannelFromCards, asjpGlobalWithdrawn, asjpKeyring, asjpReportClientConfig, asjpWithdrawnOf, normalizeWithdrawn, trustedAsjpRecord,
  type AsjpKeyMaterial, type AsjpRecordBinding, type AsjpReportClientConfig,
} from "./asjp-report-evidence";
import { ASJP_RESPONSE_MAX_BYTES, asjpRequestMac, asjpResponseMac, macEquals, sha256Hex } from "./asjp-service-protocol";
import { ASJP_SIXWORD_CONTRACT_VERSION, ASJP_SIXWORD_OVERLAP_LABEL } from "./asjp-sixword-contract";
import { asjpSixwordOverlapDisplayEnabled, retractSixwordRecord, signSixwordRecord, sixwordAdminView, sixwordRecordFromAnswer, trustedSixwordRecord } from "./report-asjp-sixword-evidence";
import { readSixwordRecord, writeSixwordRecord } from "./asjp-sixword-report-store";

/**
 * Developer-only six-word overlap for a SAVED report (experiment; ASJP_SIXWORD_OVERLAP_DISPLAY_ENABLED, default off).
 * Runs only on an explicit developer request, never during upload or save. It READS the saved report (text, word count,
 * owner, creation date, its signed scored ASJP record) and WRITES only its own record (asjp-sixword-report-store);
 * the saved report row, its score and its highlights are never written.
 *
 *   referenceDate        the report's creation date: an article published later is never a holder
 *   creditedPositions    the scored ASJP lane's credited words, from the report's own VERIFIED record (reported per match;
 *                        those words count once, through the lane)
 *   excludeSourceIds     takedowns (Phase 7 B3): the deployment list ASJP_WITHDRAWN_SOURCE_IDS and the report's own
 *                        withdrawn articles; sent to the service (gated as withdrawn) AND re-applied at display time
 *   binding              the report's own owner (device key, report id, account), never the caller's claim
 */
export type SixwordReportKey = { deviceKey: string; reportId: string };
type Loaded = { text: string; wordCount: number; binding: AsjpRecordBinding; referenceDate: string | null; creditedPositions: number[]; withdrawn: string[] };

async function loadReport(client: Client, key: SixwordReportKey, keys: AsjpKeyMaterial, env: Record<string, string | undefined>): Promise<Loaded | { failure: string }> {
  const row = await client.execute({ sql: "SELECT payload_json, user_id, report_created_at FROM saved_reports WHERE device_key = ? AND id = ?", args: [key.deviceKey, key.reportId] });
  const raw = row.rows[0] as unknown as { payload_json: string; user_id: string | null; report_created_at: string | null } | undefined;
  if (!raw) return { failure: "NO_REPORT" };
  const binding: AsjpRecordBinding = { reportDeviceKey: key.deviceKey, reportId: key.reportId, accountId: raw.user_id ?? null };
  let decoded;
  try { decoded = tryDecodeReportFromPersistence(JSON.parse(String(raw.payload_json)), { requireContributions: false }); } catch { return { failure: "UNREADABLE_REPORT" }; }
  if (!decoded.ok) return { failure: "UNREADABLE_REPORT" };
  const payload = decoded.report as SimilarityReport;
  if (typeof payload.text !== "string" || !payload.text || !Number.isInteger(payload.wordCount)) return { failure: "NO_TEXT" };
  const scored = trustedAsjpRecord(payload.asjpEvidence, binding, keys);
  const creditedPositions: number[] = [];
  for (const source of scored && scored.status === "ACCEPTED" ? asjpChannelFromCards(scored.cards) : []) for (const p of source.matchedPassages) for (let q = p.submittedWordStart; q <= p.submittedWordEnd; q += 1) creditedPositions.push(q);
  const created = String(raw.report_created_at ?? "").slice(0, 10);
  return { text: payload.text, wordCount: payload.wordCount, binding, referenceDate: /^\d{4}-\d{2}-\d{2}$/.test(created) ? created : null, creditedPositions, withdrawn: normalizeWithdrawn([...asjpGlobalWithdrawn(env), ...asjpWithdrawnOf(scored)]) };
}

async function readCapped(res: Response, cap: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > cap) { try { await res.body?.cancel(); } catch { /* ignore */ } return null; }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * The /sixword call over the service wire protocol v2 (lib/asjp-service-protocol.ts), exactly as the report client calls
 * /match: with a request-signing key, POST /attest first (signed, no manuscript, no bearer) must return a valid response
 * signature for THIS hostname, then the signed request, whose answer must carry a valid response signature bound to the
 * request nonce, body digest, hostname, status and bytes; answers over 2 MB are refused unread. Never throws.
 */
export async function requestSixwordOverlap(config: AsjpReportClientConfig, body: { text: string; referenceDate: string | null; creditedPositions: number[]; excludeSourceIds: string[] }): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const key = config.requestSigningKey;
  try {
    const host = new URL(config.url).host;
    const base = config.url.replace(/\/+$/, "");
    const signed = (path: string, raw: Buffer) => {
      if (!key) return { headers: {} as Record<string, string>, nonce: "", bodySha: "" };
      const ts = String(Date.now()), nonce = randomUUID().replace(/-/g, ""), bodySha = sha256Hex(raw);
      return { headers: { "x-asjp-timestamp": ts, "x-asjp-nonce": nonce, "x-asjp-signature": asjpRequestMac(key, { method: "POST", path, host, ts, nonce, bodySha256: bodySha }) }, nonce, bodySha };
    };
    const verified = (res: Response, bytes: Buffer, nonce: string, bodySha: string) => macEquals(asjpResponseMac(key!, { nonce, host, requestBodySha256: bodySha, status: res.status, responseBodySha256: sha256Hex(bytes) }), res.headers.get("x-asjp-response-signature"));
    if (key) {
      const raw = Buffer.from("{}", "utf8"), s = signed("/attest", raw);
      const res = await fetch(`${base}/attest`, { method: "POST", headers: { ...config.accessHeaders, ...s.headers, "content-type": "application/json" }, body: raw, signal: controller.signal });
      const bytes = await readCapped(res, 4096);
      if (!bytes || res.status !== 200 || !verified(res, bytes, s.nonce, s.bodySha)) return { state: "UNAVAILABLE", failureCode: "SERVICE_NOT_AUTHENTICATED" };
    }
    const raw = Buffer.from(JSON.stringify(body), "utf8"), s = signed("/sixword", raw);
    const res = await fetch(`${base}/sixword`, { method: "POST", headers: { ...config.accessHeaders, ...s.headers, "content-type": "application/json", authorization: `Bearer ${config.token}` }, body: raw, signal: controller.signal });
    const bytes = await readCapped(res, ASJP_RESPONSE_MAX_BYTES);
    if (!bytes) return { state: "UNAVAILABLE", failureCode: "RESPONSE_TOO_LARGE" };
    if (res.status === 404) return { state: "UNAVAILABLE", failureCode: "SIXWORD_NOT_ENABLED_ON_SERVICE" };
    if (key && !verified(res, bytes, s.nonce, s.bodySha)) return { state: "UNAVAILABLE", failureCode: "UNAUTHENTICATED_ANSWER" };
    try { return JSON.parse(new TextDecoder("utf-8").decode(bytes)); } catch { return { state: "UNAVAILABLE", failureCode: "MALFORMED_ANSWER" }; }
  } catch (error) {
    return { state: "UNAVAILABLE", failureCode: (error as Error)?.name === "AbortError" ? "CLIENT_TIMEOUT" : "SERVICE_UNREACHABLE" };
  } finally { clearTimeout(timer); }
}

export type SixwordDeps = {
  config?: AsjpReportClientConfig | null;
  fetchSixword?: (config: AsjpReportClientConfig, body: { text: string; referenceDate: string | null; creditedPositions: number[]; excludeSourceIds: string[] }) => Promise<unknown>;
  keys?: AsjpKeyMaterial;
  env?: Record<string, string | undefined>;
};
const resolveDeps = (deps: SixwordDeps) => {
  const env = deps.env ?? process.env;
  return { env, keys: deps.keys === undefined ? asjpKeyring(env) : deps.keys, config: deps.config === undefined ? asjpReportClientConfig(env) : deps.config };
};
const hasSigningKey = (keys: AsjpKeyMaterial) => (typeof keys === "string" ? keys.length >= 32 : !!keys?.current);

/** Run the search for a saved report, store the signed record, return the admin view. Never writes the report. */
export async function runSixwordForReport(client: Client, key: SixwordReportKey, deps: SixwordDeps = {}) {
  const { env, keys, config } = resolveDeps(deps);
  if (!asjpSixwordOverlapDisplayEnabled(env)) return { outcome: "DISABLED" as const };
  if (!hasSigningKey(keys)) return { outcome: "NO_SIGNING_KEY" as const };
  const loaded = await loadReport(client, key, keys, env);
  if ("failure" in loaded) return { outcome: "NOT_ELIGIBLE" as const, reason: loaded.failure };
  const expected = { text: loaded.text, wordCount: loaded.wordCount, generationId: config?.generationId ?? "", logicalManifestSha256: config?.logicalManifestSha256 ?? "", allowLocalResearchPolicy: config?.allowLocalResearchPolicy ?? false };
  let answer: unknown;
  if (!config) answer = { state: "UNAVAILABLE", failureCode: "CLIENT_MISCONFIGURED" };
  else {
    try { answer = await (deps.fetchSixword ?? requestSixwordOverlap)(config, { text: loaded.text, referenceDate: loaded.referenceDate, creditedPositions: loaded.creditedPositions, excludeSourceIds: loaded.withdrawn }); }
    catch { answer = { state: "UNAVAILABLE", failureCode: "SERVICE_UNREACHABLE" }; }
  }
  // a service-level refusal (busy, timeout, disabled, unauthenticated, …) is not a contract block: UNAVAILABLE with its code
  const block = answer && typeof answer === "object" && (answer as { contract?: unknown }).contract === ASJP_SIXWORD_CONTRACT_VERSION ? answer
    : { contract: ASJP_SIXWORD_CONTRACT_VERSION, state: "UNAVAILABLE", reason: String((answer as { failureCode?: unknown })?.failureCode ?? (answer as { state?: unknown })?.state ?? "NO_ANSWER").replace(/[^A-Z0-9_]/gi, "").slice(0, 64), scored: false, label: ASJP_SIXWORD_OVERLAP_LABEL, pins: null, wordCount: null, summary: null, matches: [], sources: {}, truncation: { matchesOmitted: 0, commonOmitted: 0, matchesWithHoldersOmitted: 0, holdersWithoutCharOffsets: 0 }, timings: null };
  const record = signSixwordRecord(sixwordRecordFromAnswer(block, expected), loaded.binding, keys);
  await writeSixwordRecord(client, key, record);
  return { outcome: "STORED" as const, view: viewOf(record, loaded, env, keys, config) };
}

/** Rollback: the stored record becomes RETRACTED (nothing shown). Never writes the report. */
export async function retractSixwordForReport(client: Client, key: SixwordReportKey, reason: string, deps: SixwordDeps = {}) {
  const { env, keys, config } = resolveDeps(deps);
  if (!asjpSixwordOverlapDisplayEnabled(env)) return { outcome: "DISABLED" as const };
  if (!hasSigningKey(keys)) return { outcome: "NO_SIGNING_KEY" as const };
  const loaded = await loadReport(client, key, keys, env);
  if ("failure" in loaded) return { outcome: "NOT_ELIGIBLE" as const, reason: loaded.failure };
  const current = trustedSixwordRecord(await readSixwordRecord(client, key), loaded.binding, keys);
  if (!current) return { outcome: "NO_RECORD" as const };
  const record = signSixwordRecord(retractSixwordRecord(current, reason.slice(0, 64)), loaded.binding, keys);
  await writeSixwordRecord(client, key, record);
  return { outcome: "RETRACTED" as const, view: viewOf(record, loaded, env, keys, config) };
}

/** The developer view of the stored record (verified for THIS report and its owner), or null when not visible. */
export async function sixwordViewForReport(client: Client, key: SixwordReportKey, deps: SixwordDeps = {}) {
  const { env, keys, config } = resolveDeps(deps);
  if (!asjpSixwordOverlapDisplayEnabled(env)) return null;
  const loaded = await loadReport(client, key, keys, env);
  if ("failure" in loaded) return null;
  const stored = await readSixwordRecord(client, key);
  if (stored == null) return { outcome: "NOT_RUN" as const };
  return viewOf(stored, loaded, env, keys, config);
}

function viewOf(record: unknown, loaded: Loaded, env: Record<string, string | undefined>, keys: AsjpKeyMaterial, config: AsjpReportClientConfig | null) {
  const view = sixwordAdminView(record, loaded.binding, env, keys, new Set(loaded.withdrawn));
  if (!view) return { outcome: "UNTRUSTED_RECORD" as const };
  const pins = (view as { pins?: { generationId: string; logicalManifestSha256: string } | null }).pins ?? null;
  const stale = !!(config && pins && (pins.generationId !== config.generationId || pins.logicalManifestSha256 !== config.logicalManifestSha256));
  return { ...view, staleGeneration: stale, currentGenerationId: config?.generationId ?? null };
}
