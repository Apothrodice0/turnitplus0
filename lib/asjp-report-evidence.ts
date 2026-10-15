/**
 * ASJP evidence for a TurnitPlus report (LOCAL PROTOTYPE; behind ASJP_REPORT_EVIDENCE_ENABLED, default off).
 *
 * The matching service answers with the lane's verified passages (`asjpPublicationEvidence`, the exact shape
 * computeUnifiedSimilarity's ASJP channel takes) and the source cards (title, journal, date, DOI, canonical ASJP URL,
 * licence, attribution, labels, and — lane v5 — every credited passage with its exact source offsets).
 *
 * Phase 6.5 — GENERATION-PINNED PERSISTENCE. An answer is turned ONCE into a persisted record (payload_json
 * `$.asjpEvidence`, server-owned like `$.userSuppliedReferenceEvidence`), and every later computation of the report
 * — reload, self-heal, Selective finalization, the admin decision trace, a resave of the same manuscript — derives
 * the ASJP channel FROM THAT RECORD (asjpChannelOf). The service is never re-queried for a saved report, so a new
 * index generation, catalog refresh or lane version can never silently change it. Only an explicit retry of an
 * UNAVAILABLE record, or an explicit retraction, writes a new record, by compare-and-set (lib/report-asjp-evidence.ts).
 *
 * INTEGRITY (review finding 1): payload_json can carry client-written keys (older builds persisted unknown keys), so a
 * record is trusted only with the server's HMAC (ASJP_EVIDENCE_SIGNING_KEY / _FILE) over the record AND the report it
 * belongs to (device key + report id). An unsigned, forged or moved record is never applied, never carried forward,
 * never shown. Without a signing key no record applies at all (fail closed).
 *
 * Acceptance (asjpEvidenceRecordFromAnswer) refuses anything it cannot trust, as an UNAVAILABLE record with a reason:
 *   - only state COMPLETE from the PINNED generation (generationId + logicalManifestSha256, and the lane version when
 *     pinned) the report path expects
 *   - only the permitted-only licence policy (local research is refused unless explicitly allowed), normalization 2,
 *     and the report's own word count (positions index the report's words; nothing is ever moved)
 *   - well-formed cards: canonical https ASJP URL, known attribution, integer positions inside the manuscript, source
 *     spans of exactly the submitted length with exact offsets, labels inside their card's words, and the scored cards'
 *     passages equal to the answer's asjpPublicationEvidence position for position (the evidence is derived from them)
 *   - bounded size: the research signal capped, the record capped (RECORD_TOO_LARGE otherwise)
 * Union scoring is computeUnifiedSimilarity's own: a word ASJP shares with another channel counts once, and
 * asjpPublicationPositions lists only the words no other channel holds, so a highlight is never double counted.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export const ASJP_REPORT_EVIDENCE_SCHEMA = "asjp-report-evidence-v1";
/** A persisted record (cards + capped research) above this many bytes is refused: the 2 MB report ceiling stays the report's. */
export const ASJP_RECORD_MAX_BYTES = 256 * 1024;
export const ASJP_RESEARCH_MAX_PASSAGES = 100;
const ASJP_URL = /^https:\/\/(www\.)?asjp\.cerist\.dz\//;
const ATTRIBUTIONS = new Set(["PREVIOUSLY_PUBLISHED_WORK", "SELF_OVERLAP_SAME_AUTHORS", "QUOTES_PRIMARY_SOURCE", "SHARED_TEXT_ORIGIN_NOT_ESTABLISHED", "PUBLISHED_SOURCE"]);
const LABEL_KINDS = new Set(["LEGAL_PRIMARY_TEXT", "RELIGIOUS_TEXT", "SHARED_QUOTATION", "SHARED_ACADEMIC_TEXT", "STRUCTURAL_FORM", "REPEATED_FORM"]);

export type AsjpServiceAnswer = {
  state: string; failureCode?: string | null; wordCount?: number | null; generationId?: string; logicalManifestSha256?: string; laneVersion?: string; catalogLoadedAt?: string;
  catalogDigest?: string; licencePolicy?: string; normalization?: number; features?: { numericTables?: boolean; shortSignal?: boolean };
  asjpPublicationEvidence?: Array<{ sourceId: string; matchedPassages: Array<{ submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number }> }>;
  cards?: Array<Record<string, unknown>>;
  research?: { shortPassages?: unknown };
  digest?: string;
};

export type AsjpPersistedPassage = { submittedWordStart: number; submittedWordEnd: number; sourceWordStart: number; sourceWordEnd: number; sourceCharStart: number; sourceCharEnd: number };
export type AsjpPersistedLabel = { kind: string; submittedWordStart: number; submittedWordEnd: number; words: number; otherArticles?: number; namedSource?: string | null; category?: string; quoted?: boolean };
export type AsjpPersistedCard = {
  sourceId: string; title: string | null; journal: string | null; publicationDate: string | null; doi: string | null; url: string; authors: string[] | null;
  license: string | null; licenceStatus: string; relationship: string; attribution: string; scored: boolean; matchedWordCount: number;
  admittedBy: string | null; candidateBy?: string; passages: AsjpPersistedPassage[]; labels: AsjpPersistedLabel[];
  /** Phase 7: observations only (see AsjpSourceCard.evidence); never shown as an established relationship. */
  evidence?: { documentShare: number; titleMatch: boolean; authorNamesInByline: number };
};
export type AsjpEvidencePins = {
  generationId: string; logicalManifestSha256: string; catalogDigest: string | null; catalogLoadedAt: string | null; laneVersion: string | null;
  licencePolicy: string; normalization: 2; features: { numericTables: boolean; shortSignal: boolean };
};
export type AsjpShortSignalPassage = { sourceId: string; band: string; words: number; submittedWordStart: number; submittedWordEnd: number; sourceWordStart: number; sourceWordEnd: number; sourceCharStart: number; sourceCharEnd: number; title: string | null; url: string | null };
export type AsjpPersistedEvidence = {
  schema: typeof ASJP_REPORT_EVIDENCE_SCHEMA;
  /** RETRACTED: an ACCEPTED record withdrawn by an explicit retraction (rollback / takedown); never applied again. */
  status: "ACCEPTED" | "UNAVAILABLE" | "RETRACTED";
  /** UNAVAILABLE / RETRACTED: why (NO_ANSWER, CLIENT_TIMEOUT, ASJP_BUSY, GENERATION_MISMATCH, CLIENT_MISCONFIGURED, …). */
  reason: string | null;
  checkedAt: string;
  /** The report's word count and manuscript digest the answer was computed for (a record never applies elsewhere). */
  wordCount: number;
  textSha256: string;
  pins: AsjpEvidencePins | null;
  /** ACCEPTED only: the shown cards (scored + same-work-not-scored), each with passages + labels. */
  cards: AsjpPersistedCard[];
  /** UNSCORED research signal (ASJP_SHORT_SIGNAL_ENABLED services only, capped) — never a scored highlight, never shown to an ordinary user. */
  research?: { shortPassages: { scored: false; label: "UNSCORED_RESEARCH_SIGNAL"; passages: AsjpShortSignalPassage[]; truncated: boolean } };
  /** Retries of an UNAVAILABLE record so far. */
  attempts: number;
  /** The server's HMAC over the record and the report it belongs to (signAsjpRecord). */
  signature?: string;
};
export type AsjpChannel = Array<{ sourceId: string; matchedPassages: Array<{ submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number }> }>;
/**
 * Phase 7 (review C): what a signed record is bound to — the report (device key + report id) AND its owner (the account
 * id; null only for a legacy anonymous report). The manuscript (textSha256, wordCount), the index generation, manifest,
 * catalog digest, lane version, licence policy, normalization and features are inside the signed body. A record copied
 * to another report, another owner, another manuscript or edited in any field never verifies.
 */
export type AsjpRecordBinding = { reportDeviceKey: string; reportId: string; accountId: string | null };

export function asjpReportEvidenceEnabled(env: Record<string, string | undefined> = process.env): boolean { return env.ASJP_REPORT_EVIDENCE_ENABLED === "true"; }

/** sha256 of the manuscript text exactly as the report holds it (the record is bound to it). */
export function asjpTextSha256(text: string): string { return createHash("sha256").update(text ?? "").digest("hex"); }

// ── integrity ─────────────────────────────────────────────────────────────
/** The record-signing key (ASJP_EVIDENCE_SIGNING_KEY or _FILE, >= 32 characters), or null. */
export function asjpSigningKey(env: Record<string, string | undefined> = process.env): string | null {
  let key = (env.ASJP_EVIDENCE_SIGNING_KEY ?? "").trim();
  if (env.ASJP_EVIDENCE_SIGNING_KEY_FILE) { try { key = readFileSync(env.ASJP_EVIDENCE_SIGNING_KEY_FILE, "utf8").trim(); } catch { return null; } }
  return key.length >= 32 ? key : null;
}
/** JSON with keys sorted at every level (undefined dropped): the signed form never depends on key order. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : stableJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}
const macOf = (record: AsjpPersistedEvidence, binding: AsjpRecordBinding, key: string) => {
  const { signature: _ignored, ...body } = record;
  return createHmac("sha256", key).update(stableJson([ASJP_REPORT_EVIDENCE_SCHEMA, binding.reportDeviceKey, binding.reportId, binding.accountId ?? null, body])).digest("hex");
};
export function signAsjpRecord(record: AsjpPersistedEvidence, binding: AsjpRecordBinding, key: string | null = asjpSigningKey()): AsjpPersistedEvidence {
  if (!key) return { ...record, signature: undefined };
  return { ...record, signature: macOf(record, binding, key) };
}
export function verifyAsjpRecord(record: AsjpPersistedEvidence, binding: AsjpRecordBinding, key: string | null = asjpSigningKey()): boolean {
  if (!key || typeof record.signature !== "string" || !/^[0-9a-f]{64}$/.test(record.signature)) return false;
  return timingSafeEqual(Buffer.from(record.signature, "hex"), Buffer.from(macOf(record, binding, key), "hex"));
}

// ── shape ─────────────────────────────────────────────────────────────────
const isInt = (v: unknown): v is number => Number.isInteger(v);
const unavailable = (reason: string, expected: { wordCount: number; text: string }, attempts = 0): AsjpPersistedEvidence => ({ schema: ASJP_REPORT_EVIDENCE_SCHEMA, status: "UNAVAILABLE", reason, checkedAt: new Date().toISOString(), wordCount: expected.wordCount, textSha256: asjpTextSha256(expected.text), pins: null, cards: [], attempts });

/** The scored cards' passages in the union channel's shape: one entry per source, passages in manuscript order. */
export function asjpChannelFromCards(cards: readonly AsjpPersistedCard[]): AsjpChannel {
  const bySource = new Map<string, AsjpChannel[number]["matchedPassages"]>();
  for (const card of cards) {
    if (!card.scored) continue;
    const list = bySource.get(card.sourceId) ?? [];
    for (const p of card.passages) list.push({ submittedWordStart: p.submittedWordStart, submittedWordEnd: p.submittedWordEnd, matchedWordCount: p.submittedWordEnd - p.submittedWordStart + 1 });
    bySource.set(card.sourceId, list);
  }
  return [...bySource].map(([sourceId, matchedPassages]) => ({ sourceId, matchedPassages: matchedPassages.sort((a, b) => a.submittedWordStart - b.submittedWordStart) }));
}
const positionsOf = (channel: AsjpChannel) => new Map(channel.map((s) => [s.sourceId, s.matchedPassages.flatMap((p) => Array.from({ length: p.submittedWordEnd - p.submittedWordStart + 1 }, (_, i) => p.submittedWordStart + i)).sort((a, b) => a - b).join(",")]));

/** Review finding 8: everything the report renders or scores from a card is checked. */
function wellFormedCard(card: any, wordCount: number): card is AsjpPersistedCard {
  if (!card || typeof card.sourceId !== "string" || !/^asjp:\d+$/.test(card.sourceId) || typeof card.url !== "string" || !ASJP_URL.test(card.url) || typeof card.scored !== "boolean") return false;
  if (!ATTRIBUTIONS.has(card.attribution)) return false;
  for (const k of ["title", "journal", "publicationDate", "doi", "license"]) if (card[k] != null && typeof card[k] !== "string") return false;
  if (!Array.isArray(card.passages) || !Array.isArray(card.labels)) return false;
  const words = new Set<number>();
  for (const p of card.passages) {
    if (![p?.submittedWordStart, p?.submittedWordEnd, p?.sourceWordStart, p?.sourceWordEnd, p?.sourceCharStart, p?.sourceCharEnd].every(isInt)) return false;
    if (p.submittedWordStart < 0 || p.submittedWordEnd < p.submittedWordStart || p.submittedWordEnd >= wordCount) return false;
    if (p.sourceWordStart < 0 || p.sourceWordEnd - p.sourceWordStart !== p.submittedWordEnd - p.submittedWordStart) return false;
    if (p.sourceCharStart < 0 || p.sourceCharEnd <= p.sourceCharStart) return false;
    for (let q = p.submittedWordStart; q <= p.submittedWordEnd; q += 1) words.add(q);
  }
  for (const l of card.labels) {
    if (!l || !LABEL_KINDS.has(l.kind) || !isInt(l.submittedWordStart) || !isInt(l.submittedWordEnd) || !isInt(l.words)) return false;
    if (l.submittedWordStart < 0 || l.submittedWordEnd < l.submittedWordStart || l.submittedWordEnd >= wordCount) return false;
    if (l.otherArticles !== undefined && !(isInt(l.otherArticles) && l.otherArticles >= 0)) return false;
  }
  if (card.evidence !== undefined) {
    const e = card.evidence;
    if (!e || typeof e.documentShare !== "number" || !(e.documentShare >= 0 && e.documentShare <= 1) || typeof e.titleMatch !== "boolean" || !(isInt(e.authorNamesInByline) && e.authorNamesInByline >= 0)) return false;
  }
  return card.passages.length > 0 || !card.scored;
}

/** Review finding 6: the research signal is reduced to known fields and capped. */
function cappedResearch(research: unknown, wordCount: number): AsjpPersistedEvidence["research"] | undefined {
  const passages = (research as any)?.shortPassages?.passages;
  if (!Array.isArray(passages)) return undefined;
  const kept: AsjpShortSignalPassage[] = [];
  for (const p of passages) {
    if (kept.length >= ASJP_RESEARCH_MAX_PASSAGES) break;
    if (typeof p?.sourceId !== "string" || !/^asjp:\d+$/.test(p.sourceId) || ![p.submittedWordStart, p.submittedWordEnd, p.sourceWordStart, p.sourceWordEnd, p.sourceCharStart, p.sourceCharEnd].every(isInt)) continue;
    if (p.submittedWordStart < 0 || p.submittedWordEnd >= wordCount || p.submittedWordEnd < p.submittedWordStart) continue;
    kept.push({ sourceId: p.sourceId, band: p.band === "40-59" ? "40-59" : "25-39", words: p.submittedWordEnd - p.submittedWordStart + 1, submittedWordStart: p.submittedWordStart, submittedWordEnd: p.submittedWordEnd, sourceWordStart: p.sourceWordStart, sourceWordEnd: p.sourceWordEnd, sourceCharStart: p.sourceCharStart, sourceCharEnd: p.sourceCharEnd, title: typeof p.title === "string" ? p.title.slice(0, 500) : null, url: typeof p.url === "string" && ASJP_URL.test(p.url) ? p.url : null });
  }
  return { shortPassages: { scored: false, label: "UNSCORED_RESEARCH_SIGNAL", passages: kept, truncated: passages.length > kept.length } };
}

/**
 * An answer -> the (unsigned) record to persist: ACCEPTED (pinned, cards with passages + labels) or UNAVAILABLE with a
 * reason. Never throws. `enabled` false -> null (nothing is recorded for a report checked while ASJP was off). The
 * caller signs it for its report (signAsjpRecord) before persisting.
 */
export function asjpEvidenceRecordFromAnswer(
  answer: AsjpServiceAnswer | null | undefined,
  expected: { generationId: string; logicalManifestSha256: string; laneVersion?: string | null; wordCount: number; text: string; normalization?: number; allowLocalResearchPolicy?: boolean },
  enabled = asjpReportEvidenceEnabled(),
  attempts = 0,
): AsjpPersistedEvidence | null {
  if (!enabled) return null;
  if (!answer) return unavailable("NO_ANSWER", expected, attempts);
  if (answer.state !== "COMPLETE") return unavailable(String(answer.failureCode ?? answer.state ?? "UNKNOWN").slice(0, 64), expected, attempts);
  if (answer.generationId !== expected.generationId || answer.logicalManifestSha256 !== expected.logicalManifestSha256) return unavailable("GENERATION_MISMATCH", expected, attempts);
  if (expected.laneVersion && answer.laneVersion !== expected.laneVersion) return unavailable("LANE_VERSION_MISMATCH", expected, attempts);
  if (answer.licencePolicy !== "permitted-only" && !(expected.allowLocalResearchPolicy && answer.licencePolicy === "local-research-all")) return unavailable("LICENCE_POLICY_NOT_ALLOWED", expected, attempts);
  if (answer.normalization !== (expected.normalization ?? 2)) return unavailable("NORMALIZATION_MISMATCH", expected, attempts);
  if (answer.wordCount == null || answer.wordCount !== expected.wordCount) return unavailable("WORD_COUNT_MISMATCH", expected, attempts);
  const cards = answer.cards ?? [];
  if (!Array.isArray(cards) || !cards.every((c) => wellFormedCard(c, expected.wordCount))) return unavailable("MALFORMED_EVIDENCE", expected, attempts);
  if (!Array.isArray(answer.asjpPublicationEvidence) || answer.asjpPublicationEvidence.some((x) => typeof x?.sourceId !== "string" || !Array.isArray(x.matchedPassages) || x.matchedPassages.some((p) => !isInt(p?.submittedWordStart) || !isInt(p?.submittedWordEnd)))) return unavailable("MALFORMED_EVIDENCE", expected, attempts);
  // the channel is DERIVED from the cards; the answer's own channel must say exactly the same, position for position
  const derived = positionsOf(asjpChannelFromCards(cards as AsjpPersistedCard[])), stated = positionsOf(answer.asjpPublicationEvidence);
  if (derived.size !== stated.size || [...derived].some(([id, pos]) => stated.get(id) !== pos)) return unavailable("EVIDENCE_CARD_MISMATCH", expected, attempts);
  const research = cappedResearch(answer.research, expected.wordCount);
  const record: AsjpPersistedEvidence = {
    schema: ASJP_REPORT_EVIDENCE_SCHEMA, status: "ACCEPTED", reason: null, checkedAt: new Date().toISOString(), wordCount: expected.wordCount, textSha256: asjpTextSha256(expected.text),
    pins: { generationId: answer.generationId!, logicalManifestSha256: answer.logicalManifestSha256!, catalogDigest: answer.catalogDigest ?? null, catalogLoadedAt: answer.catalogLoadedAt ?? null, laneVersion: answer.laneVersion ?? null, licencePolicy: answer.licencePolicy!, normalization: 2, features: { numericTables: answer.features?.numericTables === true, shortSignal: answer.features?.shortSignal === true } },
    cards: cards as AsjpPersistedCard[],
    ...(research ? { research } : {}),
    attempts,
  };
  if (Buffer.byteLength(JSON.stringify(record)) > ASJP_RECORD_MAX_BYTES) return unavailable("RECORD_TOO_LARGE", expected, attempts);
  return record;
}

/** A persisted value -> a record of this schema, or null. Does NOT check the signature (see trustedAsjpRecord). */
export function parseAsjpEvidenceRecord(value: unknown): AsjpPersistedEvidence | null {
  const v = typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
  if (!v || typeof v !== "object" || (v as any).schema !== ASJP_REPORT_EVIDENCE_SCHEMA) return null;
  const r = v as AsjpPersistedEvidence;
  if ((r.status !== "ACCEPTED" && r.status !== "UNAVAILABLE" && r.status !== "RETRACTED") || !isInt(r.wordCount) || typeof r.textSha256 !== "string" || !Array.isArray(r.cards)) return null;
  return r;
}
/** The record, only when it is this schema AND carries the server's signature for THIS report; otherwise null. */
export function trustedAsjpRecord(value: unknown, binding: AsjpRecordBinding, key: string | null = asjpSigningKey()): AsjpPersistedEvidence | null {
  const r = parseAsjpEvidenceRecord(value);
  return r && verifyAsjpRecord(r, binding, key) ? r : null;
}

/**
 * THE ONE way a report computation obtains its ASJP channel: from the report's persisted record, never from the
 * service. Applies only a SIGNED, ACCEPTED record for THIS report (binding, word count, manuscript digest when the text
 * is known, normalization-2 report) whose cards are still well formed; anything else -> no channel, with a reason.
 */
export function asjpChannelOf(record: unknown, report: { wordCount: number; scoringNormalizationVersion: number; text?: string | null; binding: AsjpRecordBinding }, key: string | null = asjpSigningKey()): { channel: AsjpChannel | null; reason: string | null } {
  if (record == null) return { channel: null, reason: null };
  const r = parseAsjpEvidenceRecord(record);
  if (!r) return { channel: null, reason: "UNREADABLE_RECORD" };
  if (!key) return { channel: null, reason: "NO_SIGNING_KEY" };
  if (!verifyAsjpRecord(r, report.binding, key)) return { channel: null, reason: "UNVERIFIED_RECORD" };
  if (r.status !== "ACCEPTED") return { channel: null, reason: r.reason ?? r.status };
  if (report.scoringNormalizationVersion !== 2) return { channel: null, reason: "REPORT_NOT_NORMALIZATION_2" };
  if (r.wordCount !== report.wordCount) return { channel: null, reason: "WORD_COUNT_MISMATCH" };
  if (typeof report.text === "string" && report.text.length > 0 && r.textSha256 !== asjpTextSha256(report.text)) return { channel: null, reason: "TEXT_MISMATCH" };
  if (!r.cards.every((c) => wellFormedCard(c, r.wordCount))) return { channel: null, reason: "MALFORMED_EVIDENCE" };
  const channel = asjpChannelFromCards(r.cards);
  return { channel: channel.length ? channel : null, reason: null };
}

/** Back-compat (Phase 6 tests / benchmark): the decision shape, now built on the record. */
export type AsjpReportEvidenceDecision = { evidence: { asjpPublicationEvidence: AsjpChannel; cards: AsjpPersistedCard[]; pins: AsjpEvidencePins } | null; status: "INCLUDED" | "DISABLED" | "UNAVAILABLE"; reason: string | null };
export function acceptAsjpAnswer(answer: AsjpServiceAnswer | null | undefined, expected: { generationId: string; logicalManifestSha256: string; wordCount: number; text?: string; normalization?: number; allowLocalResearchPolicy?: boolean }, enabled = asjpReportEvidenceEnabled()): AsjpReportEvidenceDecision {
  const record = asjpEvidenceRecordFromAnswer(answer, { ...expected, text: expected.text ?? "" }, enabled);
  if (!record) return { evidence: null, status: "DISABLED", reason: null };
  if (record.status !== "ACCEPTED") return { evidence: null, status: "UNAVAILABLE", reason: record.reason };
  return { evidence: { asjpPublicationEvidence: asjpChannelFromCards(record.cards), cards: record.cards, pins: record.pins! }, status: "INCLUDED", reason: null };
}

/** The service call, with a client-side deadline; never throws (a failure is an UNAVAILABLE answer). */
export async function requestAsjpAnswer(url: string, token: string, body: { text: string; title?: string | null; referenceDate?: string | null }, timeoutMs = 8000): Promise<AsjpServiceAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/match`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: controller.signal });
    return (await res.json()) as AsjpServiceAnswer;
  } catch (error) {
    return { state: "UNAVAILABLE", failureCode: (error as Error)?.name === "AbortError" ? "CLIENT_TIMEOUT" : "SERVICE_UNREACHABLE" };
  } finally { clearTimeout(timer); }
}

/**
 * The report path's client configuration — environment only (never source code):
 *   ASJP_REPORT_EVIDENCE_ENABLED=true, ASJP_SERVICE_URL, ASJP_SERVICE_TOKEN / ASJP_SERVICE_TOKEN_FILE,
 *   ASJP_PINNED_GENERATION_ID, ASJP_PINNED_MANIFEST_SHA256, optional ASJP_PINNED_LANE_VERSION,
 *   ASJP_EVIDENCE_SIGNING_KEY / _FILE, ASJP_SERVICE_TIMEOUT_MS (1000–30000, default 8000; keep the service's own
 *   deadline below it so abandoned work does not hold workers)
 * Review finding 12: with ASJP on, an incomplete configuration is reported (asjpReportClientConfigProblem) and recorded
 * as UNAVAILABLE("CLIENT_MISCONFIGURED") — never silently skipped.
 */
export type AsjpReportClientConfig = { url: string; token: string; generationId: string; logicalManifestSha256: string; laneVersion: string | null; timeoutMs: number; allowLocalResearchPolicy: boolean };
export function asjpReportClientConfigProblem(env: Record<string, string | undefined> = process.env): string | null {
  if (!asjpReportEvidenceEnabled(env)) return null;
  if (!env.ASJP_SERVICE_URL || !/^https?:\/\//.test(env.ASJP_SERVICE_URL)) return "ASJP_SERVICE_URL";
  if (env.ASJP_SERVICE_TOKEN_FILE) { try { if (!readFileSync(env.ASJP_SERVICE_TOKEN_FILE, "utf8").trim()) return "ASJP_SERVICE_TOKEN_FILE"; } catch { return "ASJP_SERVICE_TOKEN_FILE"; } }
  else if (!(env.ASJP_SERVICE_TOKEN ?? "").trim()) return "ASJP_SERVICE_TOKEN";
  if (!env.ASJP_PINNED_GENERATION_ID || !env.ASJP_PINNED_MANIFEST_SHA256) return "ASJP_PINNED_GENERATION";
  if (!asjpSigningKey(env)) return "ASJP_EVIDENCE_SIGNING_KEY";
  return null;
}
export function asjpReportClientConfig(env: Record<string, string | undefined> = process.env): AsjpReportClientConfig | null {
  if (!asjpReportEvidenceEnabled(env) || asjpReportClientConfigProblem(env)) return null;
  const token = env.ASJP_SERVICE_TOKEN_FILE ? readFileSync(env.ASJP_SERVICE_TOKEN_FILE, "utf8").trim() : (env.ASJP_SERVICE_TOKEN ?? "").trim();
  const timeout = Number(env.ASJP_SERVICE_TIMEOUT_MS ?? 8000);
  return { url: env.ASJP_SERVICE_URL!, token, generationId: env.ASJP_PINNED_GENERATION_ID!, logicalManifestSha256: env.ASJP_PINNED_MANIFEST_SHA256!, laneVersion: env.ASJP_PINNED_LANE_VERSION || null, timeoutMs: Number.isFinite(timeout) ? Math.min(30_000, Math.max(1_000, timeout)) : 8_000, allowLocalResearchPolicy: env.ASJP_ALLOW_LOCAL_RESEARCH_POLICY === "true" };
}

/** Query the service once for a report and return the (unsigned) record to persist (never throws; null when ASJP is off). */
export async function checkAsjpForReport(
  input: { text: string; wordCount: number; title?: string | null },
  config: AsjpReportClientConfig | null = asjpReportClientConfig(),
  fetchAnswer: (config: AsjpReportClientConfig, body: { text: string; title?: string | null }) => Promise<AsjpServiceAnswer> = (c, body) => requestAsjpAnswer(c.url, c.token, body, c.timeoutMs),
  attempts = 0,
  env: Record<string, string | undefined> = process.env,
): Promise<AsjpPersistedEvidence | null> {
  if (!config) return asjpReportEvidenceEnabled(env) ? unavailable("CLIENT_MISCONFIGURED", input, attempts) : null;
  let answer: AsjpServiceAnswer | null = null;
  try { answer = await fetchAnswer(config, { text: input.text, title: input.title ?? null }); } catch { answer = null; }
  return asjpEvidenceRecordFromAnswer(answer, { generationId: config.generationId, logicalManifestSha256: config.logicalManifestSha256, laneVersion: config.laneVersion, wordCount: input.wordCount, text: input.text, allowLocalResearchPolicy: config.allowLocalResearchPolicy }, true, attempts);
}

/**
 * The record a SAVE persists (signed for this report). Review finding 5: the service is asked ONLY on a first save or
 * when the manuscript text changed. A resave of the same manuscript carries the persisted record forward when it is
 * this report's signed record, and otherwise persists none — a report saved without ASJP (flag off, legacy, unreadable
 * or forged record) never gains ASJP evidence on a later resave.
 */
export async function asjpEvidenceForSave(
  input: { text: string; wordCount: number; scoringNormalizationVersion: number; isFirstSave: boolean; persistedRecord: unknown; persistedText: string | null; binding: AsjpRecordBinding },
  check: () => Promise<AsjpPersistedEvidence | null>,
  key: string | null = asjpSigningKey(),
): Promise<AsjpPersistedEvidence | null> {
  const sameManuscript = !input.isFirstSave && input.persistedText === input.text;
  if (sameManuscript) {
    const persisted = trustedAsjpRecord(input.persistedRecord, input.binding, key);
    return persisted && persisted.textSha256 === asjpTextSha256(input.text) ? persisted : null;
  }
  if (input.scoringNormalizationVersion !== 2 || !input.text) return null;
  const fresh = await check();
  return fresh ? signAsjpRecord(fresh, input.binding, key) : null;
}

/** Retry an UNAVAILABLE record: a fresh check, kept only if ACCEPTED (an UNAVAILABLE retry bumps `attempts`). Unsigned result. */
export async function retryUnavailableAsjpRecord(record: AsjpPersistedEvidence, report: { text: string; wordCount: number }, check: (attempts: number) => Promise<AsjpPersistedEvidence | null>, maxAttempts = 3): Promise<AsjpPersistedEvidence | null> {
  if (record.status !== "UNAVAILABLE" || record.attempts >= maxAttempts || record.textSha256 !== asjpTextSha256(report.text) || record.wordCount !== report.wordCount) return null;
  const next = await check(record.attempts + 1);
  if (!next) return null;
  const { signature: _old, ...base } = record;
  return next.status === "ACCEPTED" ? next : { ...base, attempts: record.attempts + 1, reason: next.reason, checkedAt: next.checkedAt };
}
