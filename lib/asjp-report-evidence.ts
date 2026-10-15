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
 * UNAVAILABLE record (retryUnavailableAsjpRecord) writes a new record, once, by compare-and-set.
 *
 * Acceptance (asjpEvidenceRecordFromAnswer) refuses anything it cannot trust, as an UNAVAILABLE record with a reason:
 *   - only state COMPLETE from the PINNED generation (generationId + logicalManifestSha256 the report path expects)
 *   - only the permitted-only licence policy (local research is refused unless explicitly allowed), normalization 2,
 *     and the report's own word count (positions index the report's words; nothing is ever moved)
 *   - well-formed cards: integer positions inside the manuscript, exact source offsets, and the scored cards' passages
 *     equal to the answer's asjpPublicationEvidence position for position (the evidence is derived from the cards)
 * Union scoring is computeUnifiedSimilarity's own: a word ASJP shares with another channel counts once, and
 * asjpPublicationPositions lists only the words no other channel holds, so a highlight is never double counted.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const ASJP_REPORT_EVIDENCE_SCHEMA = "asjp-report-evidence-v1";

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
};
export type AsjpEvidencePins = {
  generationId: string; logicalManifestSha256: string; catalogDigest: string | null; catalogLoadedAt: string | null; laneVersion: string | null;
  licencePolicy: string; normalization: 2; features: { numericTables: boolean; shortSignal: boolean };
};
export type AsjpPersistedEvidence = {
  schema: typeof ASJP_REPORT_EVIDENCE_SCHEMA;
  status: "ACCEPTED" | "UNAVAILABLE";
  /** UNAVAILABLE only: why (NO_ANSWER, CLIENT_TIMEOUT, ASJP_BUSY, GENERATION_MISMATCH, WORD_COUNT_MISMATCH, …). */
  reason: string | null;
  checkedAt: string;
  /** The report's word count and manuscript digest the answer was computed for (a record never applies elsewhere). */
  wordCount: number;
  textSha256: string;
  pins: AsjpEvidencePins | null;
  /** ACCEPTED only: the shown cards (scored + same-work-not-scored), each with passages + labels. */
  cards: AsjpPersistedCard[];
  /** UNSCORED research signal (ASJP_SHORT_SIGNAL_ENABLED services only) — never a scored highlight, never shown to an ordinary user. */
  research?: { shortPassages?: unknown };
  /** Retries of an UNAVAILABLE record so far. */
  attempts: number;
};
export type AsjpChannel = Array<{ sourceId: string; matchedPassages: Array<{ submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number }> }>;

export function asjpReportEvidenceEnabled(env: Record<string, string | undefined> = process.env): boolean { return env.ASJP_REPORT_EVIDENCE_ENABLED === "true"; }

/** sha256 of the manuscript text exactly as the report holds it (the record is bound to it). */
export function asjpTextSha256(text: string): string { return createHash("sha256").update(text ?? "").digest("hex"); }

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

function wellFormedCard(card: any, wordCount: number): card is AsjpPersistedCard {
  if (!card || typeof card.sourceId !== "string" || !/^asjp:\d+$/.test(card.sourceId) || typeof card.url !== "string" || typeof card.scored !== "boolean") return false;
  if (!Array.isArray(card.passages) || !Array.isArray(card.labels)) return false;
  for (const p of card.passages) {
    if (![p?.submittedWordStart, p?.submittedWordEnd, p?.sourceWordStart, p?.sourceWordEnd, p?.sourceCharStart, p?.sourceCharEnd].every(isInt)) return false;
    if (p.submittedWordStart < 0 || p.submittedWordEnd < p.submittedWordStart || p.submittedWordEnd >= wordCount) return false;
    if (p.sourceCharStart < 0 || p.sourceCharEnd <= p.sourceCharStart || p.sourceWordEnd < p.sourceWordStart) return false;
  }
  return card.passages.length > 0 || !card.scored;
}

/**
 * An answer -> the record to persist: ACCEPTED (pinned, cards with passages + labels) or UNAVAILABLE with a reason.
 * Never throws. `enabled` false -> null (nothing is recorded for a report checked while ASJP was off).
 */
export function asjpEvidenceRecordFromAnswer(
  answer: AsjpServiceAnswer | null | undefined,
  expected: { generationId: string; logicalManifestSha256: string; wordCount: number; text: string; normalization?: number; allowLocalResearchPolicy?: boolean },
  enabled = asjpReportEvidenceEnabled(),
  attempts = 0,
): AsjpPersistedEvidence | null {
  if (!enabled) return null;
  if (!answer) return unavailable("NO_ANSWER", expected, attempts);
  if (answer.state !== "COMPLETE") return unavailable(String(answer.failureCode ?? answer.state ?? "UNKNOWN"), expected, attempts);
  if (answer.generationId !== expected.generationId || answer.logicalManifestSha256 !== expected.logicalManifestSha256) return unavailable("GENERATION_MISMATCH", expected, attempts);
  if (answer.licencePolicy !== "permitted-only" && !(expected.allowLocalResearchPolicy && answer.licencePolicy === "local-research-all")) return unavailable("LICENCE_POLICY_NOT_ALLOWED", expected, attempts);
  if (answer.normalization !== (expected.normalization ?? 2)) return unavailable("NORMALIZATION_MISMATCH", expected, attempts);
  if (answer.wordCount == null || answer.wordCount !== expected.wordCount) return unavailable("WORD_COUNT_MISMATCH", expected, attempts);
  const cards = answer.cards ?? [];
  if (!Array.isArray(cards) || !cards.every((c) => wellFormedCard(c, expected.wordCount))) return unavailable("MALFORMED_EVIDENCE", expected, attempts);
  if (!Array.isArray(answer.asjpPublicationEvidence) || answer.asjpPublicationEvidence.some((x) => typeof x?.sourceId !== "string" || !Array.isArray(x.matchedPassages) || x.matchedPassages.some((p) => !isInt(p?.submittedWordStart) || !isInt(p?.submittedWordEnd)))) return unavailable("MALFORMED_EVIDENCE", expected, attempts);
  // the channel is DERIVED from the cards; the answer's own channel must say exactly the same, position for position
  const derived = positionsOf(asjpChannelFromCards(cards as AsjpPersistedCard[])), stated = positionsOf(answer.asjpPublicationEvidence);
  if (derived.size !== stated.size || [...derived].some(([id, pos]) => stated.get(id) !== pos)) return unavailable("EVIDENCE_CARD_MISMATCH", expected, attempts);
  return {
    schema: ASJP_REPORT_EVIDENCE_SCHEMA, status: "ACCEPTED", reason: null, checkedAt: new Date().toISOString(), wordCount: expected.wordCount, textSha256: asjpTextSha256(expected.text),
    pins: { generationId: answer.generationId!, logicalManifestSha256: answer.logicalManifestSha256!, catalogDigest: answer.catalogDigest ?? null, catalogLoadedAt: answer.catalogLoadedAt ?? null, laneVersion: answer.laneVersion ?? null, licencePolicy: answer.licencePolicy!, normalization: 2, features: { numericTables: answer.features?.numericTables === true, shortSignal: answer.features?.shortSignal === true } },
    cards: cards as AsjpPersistedCard[],
    ...(answer.research ? { research: answer.research } : {}),
    attempts,
  };
}

/** A persisted value -> a record, or null when it is absent or not a record this code understands. */
export function parseAsjpEvidenceRecord(value: unknown): AsjpPersistedEvidence | null {
  const v = typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { return null; } })() : value;
  if (!v || typeof v !== "object" || (v as any).schema !== ASJP_REPORT_EVIDENCE_SCHEMA) return null;
  const r = v as AsjpPersistedEvidence;
  if ((r.status !== "ACCEPTED" && r.status !== "UNAVAILABLE") || !isInt(r.wordCount) || typeof r.textSha256 !== "string" || !Array.isArray(r.cards)) return null;
  return r;
}

/**
 * THE ONE way a report computation obtains its ASJP channel: from the report's persisted record, never from the
 * service. Applies only an ACCEPTED record for THIS report (same word count, same manuscript digest when the text is
 * known, normalization-2 report) whose cards are still well formed; anything else -> no channel, with a reason.
 */
export function asjpChannelOf(record: unknown, report: { wordCount: number; scoringNormalizationVersion: number; text?: string | null }): { channel: AsjpChannel | null; reason: string | null } {
  if (record == null) return { channel: null, reason: null };
  const r = parseAsjpEvidenceRecord(record);
  if (!r) return { channel: null, reason: "UNREADABLE_RECORD" };
  if (r.status !== "ACCEPTED") return { channel: null, reason: r.reason ?? "UNAVAILABLE" };
  if (report.scoringNormalizationVersion !== 2) return { channel: null, reason: "REPORT_NOT_NORMALIZATION_2" };
  if (r.wordCount !== report.wordCount) return { channel: null, reason: "WORD_COUNT_MISMATCH" };
  if (typeof report.text === "string" && report.text.length > 0 && r.textSha256 !== asjpTextSha256(report.text)) return { channel: null, reason: "TEXT_MISMATCH" };
  if (!r.cards.every((c) => wellFormedCard(c, r.wordCount))) return { channel: null, reason: "MALFORMED_EVIDENCE" };
  const channel = asjpChannelFromCards(r.cards);
  return { channel: channel.length ? channel : null, reason: null };
}

/** The client-safe projection an ordinary report response carries instead of the record (no pins, offsets or research). */
export function asjpCheckOf(record: unknown): { status: "INCLUDED" | "UNAVAILABLE"; sources: number } | null {
  const r = parseAsjpEvidenceRecord(record);
  if (!r) return null;
  return { status: r.status === "ACCEPTED" ? "INCLUDED" : "UNAVAILABLE", sources: r.cards.filter((c) => c.scored).length };
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
 *   ASJP_PINNED_GENERATION_ID, ASJP_PINNED_MANIFEST_SHA256, ASJP_SERVICE_TIMEOUT_MS (default 8000)
 * null when ASJP is off or any of them is missing (a report is then saved exactly as without ASJP).
 */
export type AsjpReportClientConfig = { url: string; token: string; generationId: string; logicalManifestSha256: string; timeoutMs: number; allowLocalResearchPolicy: boolean };
export function asjpReportClientConfig(env: Record<string, string | undefined> = process.env): AsjpReportClientConfig | null {
  if (!asjpReportEvidenceEnabled(env)) return null;
  let token = (env.ASJP_SERVICE_TOKEN ?? "").trim();
  if (env.ASJP_SERVICE_TOKEN_FILE) { try { token = readFileSync(env.ASJP_SERVICE_TOKEN_FILE, "utf8").trim(); } catch { return null; } }
  if (!env.ASJP_SERVICE_URL || !token || !env.ASJP_PINNED_GENERATION_ID || !env.ASJP_PINNED_MANIFEST_SHA256) return null;
  return { url: env.ASJP_SERVICE_URL, token, generationId: env.ASJP_PINNED_GENERATION_ID, logicalManifestSha256: env.ASJP_PINNED_MANIFEST_SHA256, timeoutMs: Number(env.ASJP_SERVICE_TIMEOUT_MS ?? 8000), allowLocalResearchPolicy: env.ASJP_ALLOW_LOCAL_RESEARCH_POLICY === "true" };
}

/** Query the service once for a report and return the record to persist (never throws; null when ASJP is off). */
export async function checkAsjpForReport(
  input: { text: string; wordCount: number; title?: string | null },
  config: AsjpReportClientConfig | null = asjpReportClientConfig(),
  fetchAnswer: (config: AsjpReportClientConfig, body: { text: string; title?: string | null }) => Promise<AsjpServiceAnswer> = (c, body) => requestAsjpAnswer(c.url, c.token, body, c.timeoutMs),
  attempts = 0,
): Promise<AsjpPersistedEvidence | null> {
  if (!config) return null;
  let answer: AsjpServiceAnswer | null = null;
  try { answer = await fetchAnswer(config, { text: input.text, title: input.title ?? null }); } catch { answer = null; }
  return asjpEvidenceRecordFromAnswer(answer, { generationId: config.generationId, logicalManifestSha256: config.logicalManifestSha256, wordCount: input.wordCount, text: input.text, allowLocalResearchPolicy: config.allowLocalResearchPolicy }, true, attempts);
}

/**
 * The record a SAVE persists: on a resave of the SAME manuscript the persisted record is carried forward unchanged
 * (never re-queried); otherwise (first save, or the manuscript changed) a fresh check when ASJP is on.
 */
export async function asjpEvidenceForSave(
  input: { text: string; wordCount: number; scoringNormalizationVersion: number; persistedRecord: unknown; persistedText: string | null },
  check: () => Promise<AsjpPersistedEvidence | null>,
): Promise<AsjpPersistedEvidence | null> {
  const persisted = parseAsjpEvidenceRecord(input.persistedRecord);
  if (persisted && input.persistedText === input.text && persisted.textSha256 === asjpTextSha256(input.text)) return persisted;
  if (input.scoringNormalizationVersion !== 2 || !input.text) return null;
  return check();
}

/** Retry an UNAVAILABLE record: a fresh check, kept only if it is ACCEPTED (an UNAVAILABLE retry bumps `attempts`). */
export async function retryUnavailableAsjpRecord(record: unknown, report: { text: string; wordCount: number }, check: (attempts: number) => Promise<AsjpPersistedEvidence | null>, maxAttempts = 3): Promise<AsjpPersistedEvidence | null> {
  const r = parseAsjpEvidenceRecord(record);
  if (!r || r.status !== "UNAVAILABLE" || r.attempts >= maxAttempts || r.textSha256 !== asjpTextSha256(report.text) || r.wordCount !== report.wordCount) return null;
  const next = await check(r.attempts + 1);
  if (!next) return null;
  return next.status === "ACCEPTED" ? next : { ...r, attempts: r.attempts + 1, reason: next.reason, checkedAt: next.checkedAt };
}
