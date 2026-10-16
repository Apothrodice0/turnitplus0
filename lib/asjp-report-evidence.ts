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
 * record is trusted only with the server's HMAC over the record AND the report it belongs to (device key + report id +
 * owner). An unsigned, forged or moved record is never applied. Without a signing key no record applies at all.
 * Phase 7 remediation (A5) — KEY VERSIONS: a record names the key that signed it (`keyId`); the keyring holds the
 * current signing key and retired keys kept for verification only, so a rotation never invalidates saved reports. A
 * signed record that cannot be verified now (its key is not configured, or does not match) is never applied AND never
 * dropped: a resave keeps the stored report exactly as it was and the report shows "cannot currently be verified".
 *
 * Acceptance (asjpEvidenceRecordFromAnswer) refuses anything it cannot trust, as an UNAVAILABLE record with a reason:
 *   - only state COMPLETE from the PINNED generation (generationId + logicalManifestSha256, and the lane version when
 *     pinned) the report path expects
 *   - only the permitted-only licence policy (local research is refused unless explicitly allowed), normalization 2,
 *     and the report's own word count (positions index the report's words; nothing is ever moved)
 *   - well-formed cards (B4): canonical https ASJP URL, known attribution, bounded strings, a DOI of DOI shape, integer
 *     positions inside the manuscript, disjoint passages, source spans of exactly the submitted length with exact
 *     offsets, labels anchored in their (scored) card's words with `words` = the card words they cover, and the scored cards' passages equal
 *     to the answer's asjpPublicationEvidence position for position (the evidence is derived from them)
 *   - bounded size: the research signal capped, the record capped (RECORD_TOO_LARGE otherwise)
 * Withdrawn articles (B3): a report's withdrawn articles (an earlier retraction of this report, and the deployment-wide
 * ASJP_WITHDRAWN_SOURCE_IDS takedown list) are excluded by the service and, defensively, here; the record keeps the list,
 * so no later resave of the same report can credit them again.
 * Union scoring is computeUnifiedSimilarity's own: a word ASJP shares with another channel counts once, and
 * asjpPublicationPositions lists only the words no other channel holds, so a highlight is never double counted.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { ASJP_RESPONSE_MAX_BYTES, asjpCredentialProblem, asjpRequestMac, asjpResponseMac, isLoopbackUrl, macEquals, sha256Hex } from "./asjp-service-protocol";

export const ASJP_REPORT_EVIDENCE_SCHEMA = "asjp-report-evidence-v1";
/** A persisted record (cards + capped research) above this many bytes is refused: the 2 MB report ceiling stays the report's. */
export const ASJP_RECORD_MAX_BYTES = 256 * 1024;
export const ASJP_RESEARCH_MAX_PASSAGES = 100;
export const ASJP_WITHDRAWN_MAX = 1000;
const ASJP_URL = /^https:\/\/(www\.)?asjp\.cerist\.dz\//;
const SOURCE_ID = /^asjp:\d{1,12}$/;
const KEY_ID = /^[A-Za-z0-9._-]{1,32}$/;
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
  /** UNAVAILABLE / RETRACTED: why (NO_ANSWER, CLIENT_TIMEOUT, ASJP_BUSY, GENERATION_MISMATCH, CLIENT_MISCONFIGURED, RECORD_DOES_NOT_FIT, …). */
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
  /** B3: articles withdrawn from THIS report (retraction / takedown); never credited by any later record of it. */
  withdrawnSourceIds?: string[];
  /** Retries of an UNAVAILABLE record so far. */
  attempts: number;
  /** A5: the id of the key that signed the record (absent on records signed before key versions existed). */
  keyId?: string;
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

// ── keys (A5: versions + a verify-only keyring) ───────────────────────────
/**
 * The evidence keyring from the environment:
 *   ASJP_EVIDENCE_SIGNING_KEY / _FILE      the current signing key (>= 32 characters)
 *   ASJP_EVIDENCE_SIGNING_KEY_ID           its id (default "k1"; [A-Za-z0-9._-]{1,32})
 *   ASJP_EVIDENCE_VERIFY_KEYS / _FILE      JSON {"<id>": "<key>"} of RETIRED keys, accepted for verification only
 * A rotation = new key + new id, the old key moved to the verify-only set: every saved report still verifies.
 */
export type AsjpKeyring = { current: { id: string; key: string } | null; verify: Map<string, string> };
/** A keyring, a bare key (treated as id "k1"), or null (no key). */
export type AsjpKeyMaterial = AsjpKeyring | string | null;
export function asjpKeyring(env: Record<string, string | undefined> = process.env): AsjpKeyring {
  const verify = new Map<string, string>();
  let retired: unknown = null;
  try { retired = env.ASJP_EVIDENCE_VERIFY_KEYS_FILE ? JSON.parse(readFileSync(env.ASJP_EVIDENCE_VERIFY_KEYS_FILE, "utf8")) : env.ASJP_EVIDENCE_VERIFY_KEYS ? JSON.parse(env.ASJP_EVIDENCE_VERIFY_KEYS) : null; } catch { retired = null; }
  if (retired && typeof retired === "object") for (const [id, key] of Object.entries(retired as Record<string, unknown>)) if (KEY_ID.test(id) && typeof key === "string" && key.trim().length >= 32) verify.set(id, key.trim());
  const key = asjpSigningKey(env), id = (env.ASJP_EVIDENCE_SIGNING_KEY_ID ?? "k1").trim();
  const current = key && KEY_ID.test(id) ? { id, key } : null;
  if (current) verify.set(current.id, current.key);
  return { current, verify };
}
const ringOf = (m: AsjpKeyMaterial | undefined): AsjpKeyring => (typeof m === "string" ? { current: { id: "k1", key: m }, verify: new Map([["k1", m]]) } : m ?? { current: null, verify: new Map() });
/** The current record-signing key (ASJP_EVIDENCE_SIGNING_KEY or _FILE, >= 32 characters), or null. */
export function asjpSigningKey(env: Record<string, string | undefined> = process.env): string | null {
  let key = (env.ASJP_EVIDENCE_SIGNING_KEY ?? "").trim();
  if (env.ASJP_EVIDENCE_SIGNING_KEY_FILE) { try { key = readFileSync(env.ASJP_EVIDENCE_SIGNING_KEY_FILE, "utf8").trim(); } catch { return null; } }
  return key.length >= 32 ? key : null;
}

// ── integrity ─────────────────────────────────────────────────────────────
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
/** Signs with the CURRENT key and records its id (the id is inside the signed body). No key -> unsigned. */
export function signAsjpRecord(record: AsjpPersistedEvidence, binding: AsjpRecordBinding, keys: AsjpKeyMaterial = asjpKeyring()): AsjpPersistedEvidence {
  const { signature: _old, keyId: _oldId, ...base } = record;
  const ring = ringOf(keys);
  if (!ring.current) return { ...base };
  const unsigned: AsjpPersistedEvidence = { ...base, keyId: ring.current.id };
  return { ...unsigned, signature: macOf(unsigned, binding, ring.current.key) };
}
/** OK, or why not: UNSIGNED (no server signature at all), NO_KEY (this server has none), KEY_UNAVAILABLE (the signing key's id is not in the keyring), MISMATCH. */
export type AsjpVerification = "OK" | "UNSIGNED" | "NO_KEY" | "KEY_UNAVAILABLE" | "MISMATCH";
export function verifyAsjpRecordDetailed(record: AsjpPersistedEvidence, binding: AsjpRecordBinding, keys: AsjpKeyMaterial = asjpKeyring()): AsjpVerification {
  if (typeof record.signature !== "string" || !/^[0-9a-f]{64}$/.test(record.signature)) return "UNSIGNED";
  const ring = ringOf(keys);
  if (ring.verify.size === 0) return "NO_KEY";
  const sig = Buffer.from(record.signature, "hex");
  const matches = (key: string) => timingSafeEqual(sig, Buffer.from(macOf(record, binding, key), "hex"));
  if (record.keyId !== undefined) {
    const key = typeof record.keyId === "string" ? ring.verify.get(record.keyId) : undefined;
    if (!key) return "KEY_UNAVAILABLE";
    return matches(key) ? "OK" : "MISMATCH";
  }
  for (const key of ring.verify.values()) if (matches(key)) return "OK"; // a record signed before key versions existed
  return "MISMATCH";
}
export function verifyAsjpRecord(record: AsjpPersistedEvidence, binding: AsjpRecordBinding, keys: AsjpKeyMaterial = asjpKeyring()): boolean {
  return verifyAsjpRecordDetailed(record, binding, keys) === "OK";
}

// ── shape ─────────────────────────────────────────────────────────────────
const isInt = (v: unknown): v is number => Number.isInteger(v);
const unavailable = (reason: string, expected: { wordCount: number; text: string }, attempts = 0, withdrawn: string[] = []): AsjpPersistedEvidence => ({ schema: ASJP_REPORT_EVIDENCE_SCHEMA, status: "UNAVAILABLE", reason, checkedAt: new Date().toISOString(), wordCount: expected.wordCount, textSha256: asjpTextSha256(expected.text), pins: null, cards: [], ...(withdrawn.length ? { withdrawnSourceIds: withdrawn } : {}), attempts });

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

const optString = (v: unknown, max: number) => v == null || (typeof v === "string" && v.length <= max);
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
/**
 * Review findings 8 + B4: everything the report renders, scores or stores from a card is checked — types, bounded
 * strings (title 2000, journal 500, DOI 300 of DOI shape, licence 200, date 32), authors as up to 100 strings, enum-like
 * codes, disjoint passages, labels with an exact word count and — on a scored card — inside the card's own words.
 */
function wellFormedCard(card: any, wordCount: number): card is AsjpPersistedCard {
  if (!card || typeof card !== "object" || typeof card.sourceId !== "string" || !SOURCE_ID.test(card.sourceId) || typeof card.url !== "string" || card.url.length > 500 || !ASJP_URL.test(card.url) || typeof card.scored !== "boolean") return false;
  if (!ATTRIBUTIONS.has(card.attribution)) return false;
  if (!optString(card.title, 2000) || !optString(card.journal, 500) || !optString(card.license, 200) || !optString(card.publicationDate, 32) || !optString(card.doi, 300)) return false;
  if (typeof card.doi === "string" && !/^10\.\d{4,9}\/\S+$/.test(card.doi)) return false;
  if (card.authors != null && !(Array.isArray(card.authors) && card.authors.length <= 100 && card.authors.every((a: unknown) => typeof a === "string" && a.length <= 500))) return false;
  if (typeof card.licenceStatus !== "string" || !CODE.test(card.licenceStatus) || typeof card.relationship !== "string" || !CODE.test(card.relationship)) return false;
  if (!(card.admittedBy === null || (typeof card.admittedBy === "string" && CODE.test(card.admittedBy))) || !(card.candidateBy === undefined || (typeof card.candidateBy === "string" && CODE.test(card.candidateBy)))) return false;
  if (!isInt(card.matchedWordCount) || card.matchedWordCount < 0) return false;
  if (!Array.isArray(card.passages) || !Array.isArray(card.labels) || card.passages.length > 10_000 || card.labels.length > 10_000) return false;
  const words = new Set<number>();
  let lastEnd = -1;
  for (const p of [...card.passages].sort((a: any, b: any) => (a?.submittedWordStart ?? 0) - (b?.submittedWordStart ?? 0))) {
    if (![p?.submittedWordStart, p?.submittedWordEnd, p?.sourceWordStart, p?.sourceWordEnd, p?.sourceCharStart, p?.sourceCharEnd].every(isInt)) return false;
    if (p.submittedWordStart < 0 || p.submittedWordEnd < p.submittedWordStart || p.submittedWordEnd >= wordCount) return false;
    if (p.submittedWordStart <= lastEnd) return false; // B4: duplicate / overlapping passages
    lastEnd = p.submittedWordEnd;
    if (p.sourceWordStart < 0 || p.sourceWordEnd - p.sourceWordStart !== p.submittedWordEnd - p.submittedWordStart) return false;
    if (p.sourceCharStart < 0 || p.sourceCharEnd <= p.sourceCharStart) return false;
    for (let q = p.submittedWordStart; q <= p.submittedWordEnd; q += 1) words.add(q);
  }
  for (const l of card.labels) {
    if (!l || !LABEL_KINDS.has(l.kind) || !isInt(l.submittedWordStart) || !isInt(l.submittedWordEnd) || !isInt(l.words)) return false;
    if (l.submittedWordStart < 0 || l.submittedWordEnd < l.submittedWordStart || l.submittedWordEnd >= wordCount) return false;
    // B4: a label lies inside its card's words. Measured on all 550 Phase-6.5 hold-out answers (scripts/204): a label may
    // span gaps between the card's passages (repeated forms, shared text), so the exact rule is — both endpoints are card
    // words and `words` equals the card words inside the range (contiguous labels: the range length)
    if (l.words < 1 || l.words > l.submittedWordEnd - l.submittedWordStart + 1) return false;
    if (card.scored) {
      if (!words.has(l.submittedWordStart) || !words.has(l.submittedWordEnd)) return false;
      let inside = 0; for (let q = l.submittedWordStart; q <= l.submittedWordEnd; q += 1) if (words.has(q)) inside += 1;
      if (inside !== l.words) return false;
    }
    if (l.otherArticles !== undefined && !(isInt(l.otherArticles) && l.otherArticles >= 0)) return false;
    if (!optString(l.namedSource, 300) || !(l.category === undefined || (typeof l.category === "string" && l.category.length <= 64)) || !(l.quoted === undefined || typeof l.quoted === "boolean")) return false;
  }
  if (card.evidence !== undefined) {
    const e = card.evidence;
    if (!e || typeof e.documentShare !== "number" || !(e.documentShare >= 0 && e.documentShare <= 1) || typeof e.titleMatch !== "boolean" || !(isInt(e.authorNamesInByline) && e.authorNamesInByline >= 0)) return false;
  }
  return card.passages.length > 0 || !card.scored;
}

/** Review finding 6: the research signal is reduced to known fields and capped. */
function cappedResearch(research: unknown, wordCount: number, withdrawn: ReadonlySet<string>): AsjpPersistedEvidence["research"] | undefined {
  const passages = (research as any)?.shortPassages?.passages;
  if (!Array.isArray(passages)) return undefined;
  const kept: AsjpShortSignalPassage[] = [];
  for (const p of passages) {
    if (kept.length >= ASJP_RESEARCH_MAX_PASSAGES) break;
    if (typeof p?.sourceId !== "string" || !SOURCE_ID.test(p.sourceId) || withdrawn.has(p.sourceId) || ![p.submittedWordStart, p.submittedWordEnd, p.sourceWordStart, p.sourceWordEnd, p.sourceCharStart, p.sourceCharEnd].every(isInt)) continue;
    if (p.submittedWordStart < 0 || p.submittedWordEnd >= wordCount || p.submittedWordEnd < p.submittedWordStart) continue;
    kept.push({ sourceId: p.sourceId, band: p.band === "40-59" ? "40-59" : "25-39", words: p.submittedWordEnd - p.submittedWordStart + 1, submittedWordStart: p.submittedWordStart, submittedWordEnd: p.submittedWordEnd, sourceWordStart: p.sourceWordStart, sourceWordEnd: p.sourceWordEnd, sourceCharStart: p.sourceCharStart, sourceCharEnd: p.sourceCharEnd, title: typeof p.title === "string" ? p.title.slice(0, 500) : null, url: typeof p.url === "string" && ASJP_URL.test(p.url) ? p.url : null });
  }
  return { shortPassages: { scored: false, label: "UNSCORED_RESEARCH_SIGNAL", passages: kept, truncated: passages.length > kept.length } };
}

/** B3: a sorted, de-duplicated, bounded list of valid source ids. */
export function normalizeWithdrawn(ids: Iterable<unknown>): string[] {
  return [...new Set([...ids].filter((s): s is string => typeof s === "string" && SOURCE_ID.test(s)))].sort().slice(0, ASJP_WITHDRAWN_MAX);
}
/** B3: the deployment-wide takedown list (ASJP_WITHDRAWN_SOURCE_IDS, comma-separated asjp:<id>), applied to every NEW record. */
export function asjpGlobalWithdrawn(env: Record<string, string | undefined> = process.env): string[] {
  return normalizeWithdrawn((env.ASJP_WITHDRAWN_SOURCE_IDS ?? "").split(",").map((s) => s.trim()));
}
/** B3: what a record says is withdrawn from its report — its list, plus every card of a RETRACTED record. */
export function asjpWithdrawnOf(record: AsjpPersistedEvidence | null): string[] {
  if (!record) return [];
  return normalizeWithdrawn([...(record.withdrawnSourceIds ?? []), ...(record.status === "RETRACTED" ? record.cards.map((c) => c.sourceId) : [])]);
}

/**
 * An answer -> the (unsigned) record to persist: ACCEPTED (pinned, cards with passages + labels) or UNAVAILABLE with a
 * reason. Never throws. `enabled` false -> null (nothing is recorded for a report checked while ASJP was off). The
 * caller signs it for its report (signAsjpRecord) before persisting. `withdrawn` (B3): never credited; carried in the record.
 */
export function asjpEvidenceRecordFromAnswer(
  answer: AsjpServiceAnswer | null | undefined,
  expected: { generationId: string; logicalManifestSha256: string; laneVersion?: string | null; wordCount: number; text: string; normalization?: number; allowLocalResearchPolicy?: boolean; withdrawn?: readonly string[] },
  enabled = asjpReportEvidenceEnabled(),
  attempts = 0,
): AsjpPersistedEvidence | null {
  if (!enabled) return null;
  const withdrawnList = normalizeWithdrawn(expected.withdrawn ?? []);
  const fail = (reason: string) => unavailable(reason, expected, attempts, withdrawnList);
  if (!answer) return fail("NO_ANSWER");
  if (answer.state !== "COMPLETE") return fail(String(answer.failureCode ?? answer.state ?? "UNKNOWN").replace(/[^A-Z0-9_]/gi, "").slice(0, 64) || "UNKNOWN");
  if (answer.generationId !== expected.generationId || answer.logicalManifestSha256 !== expected.logicalManifestSha256) return fail("GENERATION_MISMATCH");
  if (expected.laneVersion && answer.laneVersion !== expected.laneVersion) return fail("LANE_VERSION_MISMATCH");
  if (answer.licencePolicy !== "permitted-only" && !(expected.allowLocalResearchPolicy && answer.licencePolicy === "local-research-all")) return fail("LICENCE_POLICY_NOT_ALLOWED");
  if (answer.normalization !== (expected.normalization ?? 2)) return fail("NORMALIZATION_MISMATCH");
  if (answer.wordCount == null || answer.wordCount !== expected.wordCount) return fail("WORD_COUNT_MISMATCH");
  const cards = answer.cards ?? [];
  if (!Array.isArray(cards) || cards.length > 1000 || !cards.every((c) => wellFormedCard(c, expected.wordCount))) return fail("MALFORMED_EVIDENCE");
  if (!Array.isArray(answer.asjpPublicationEvidence) || answer.asjpPublicationEvidence.some((x) => typeof x?.sourceId !== "string" || !Array.isArray(x.matchedPassages) || x.matchedPassages.some((p) => !isInt(p?.submittedWordStart) || !isInt(p?.submittedWordEnd)))) return fail("MALFORMED_EVIDENCE");
  // the channel is DERIVED from the cards; the answer's own channel must say exactly the same, position for position
  const derived = positionsOf(asjpChannelFromCards(cards as AsjpPersistedCard[])), stated = positionsOf(answer.asjpPublicationEvidence);
  if (derived.size !== stated.size || [...derived].some(([id, pos]) => stated.get(id) !== pos)) return fail("EVIDENCE_CARD_MISMATCH");
  // B3 (defence in depth — the service already excluded them): a withdrawn article's card is never kept
  const withdrawn = new Set(withdrawnList);
  const kept = (cards as AsjpPersistedCard[]).filter((c) => !withdrawn.has(c.sourceId));
  const research = cappedResearch(answer.research, expected.wordCount, withdrawn);
  const record: AsjpPersistedEvidence = {
    schema: ASJP_REPORT_EVIDENCE_SCHEMA, status: "ACCEPTED", reason: null, checkedAt: new Date().toISOString(), wordCount: expected.wordCount, textSha256: asjpTextSha256(expected.text),
    pins: { generationId: answer.generationId!, logicalManifestSha256: answer.logicalManifestSha256!, catalogDigest: answer.catalogDigest ?? null, catalogLoadedAt: answer.catalogLoadedAt ?? null, laneVersion: answer.laneVersion ?? null, licencePolicy: answer.licencePolicy!, normalization: 2, features: { numericTables: answer.features?.numericTables === true, shortSignal: answer.features?.shortSignal === true } },
    cards: kept,
    ...(research ? { research } : {}),
    ...(withdrawnList.length ? { withdrawnSourceIds: withdrawnList } : {}),
    attempts,
  };
  if (Buffer.byteLength(JSON.stringify(record)) > ASJP_RECORD_MAX_BYTES) return fail("RECORD_TOO_LARGE");
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
export function trustedAsjpRecord(value: unknown, binding: AsjpRecordBinding, keys: AsjpKeyMaterial = asjpKeyring()): AsjpPersistedEvidence | null {
  const r = parseAsjpEvidenceRecord(value);
  return r && verifyAsjpRecord(r, binding, keys) ? r : null;
}

/**
 * THE ONE way a report computation obtains its ASJP channel: from the report's persisted record, never from the
 * service. Applies only a SIGNED, ACCEPTED record for THIS report (binding, word count, manuscript digest when the text
 * is known, normalization-2 report) whose cards are still well formed; anything else -> no channel, with a reason.
 */
export function asjpChannelOf(record: unknown, report: { wordCount: number; scoringNormalizationVersion: number; text?: string | null; binding: AsjpRecordBinding }, keys: AsjpKeyMaterial = asjpKeyring()): { channel: AsjpChannel | null; reason: string | null } {
  if (record == null) return { channel: null, reason: null };
  const r = parseAsjpEvidenceRecord(record);
  if (!r) return { channel: null, reason: "UNREADABLE_RECORD" };
  const verification = verifyAsjpRecordDetailed(r, report.binding, keys);
  if (verification === "NO_KEY") return { channel: null, reason: "NO_SIGNING_KEY" };
  if (verification === "KEY_UNAVAILABLE") return { channel: null, reason: "KEY_UNAVAILABLE" };
  if (verification !== "OK") return { channel: null, reason: "UNVERIFIED_RECORD" };
  if (r.status !== "ACCEPTED") return { channel: null, reason: r.reason ?? r.status };
  if (report.scoringNormalizationVersion !== 2) return { channel: null, reason: "REPORT_NOT_NORMALIZATION_2" };
  if (r.wordCount !== report.wordCount) return { channel: null, reason: "WORD_COUNT_MISMATCH" };
  if (typeof report.text === "string" && report.text.length > 0 && r.textSha256 !== asjpTextSha256(report.text)) return { channel: null, reason: "TEXT_MISMATCH" };
  if (!r.cards.every((c) => wellFormedCard(c, r.wordCount))) return { channel: null, reason: "MALFORMED_EVIDENCE" };
  const withdrawn = new Set(r.withdrawnSourceIds ?? []);
  const channel = asjpChannelFromCards(r.cards.filter((c) => !withdrawn.has(c.sourceId)));
  return { channel: channel.length ? channel : null, reason: null };
}

/**
 * A4 / A6 — the client-safe projection of a stored record for an OUTBOUND copy, computed by the server WITH
 * verification (lib/report-types.ts cannot verify; GET and SSR pass this in):
 *   INCLUDED     a verified ACCEPTED record (sources = scored cards; withdrawn = articles withdrawn from this report)
 *   UNAVAILABLE  a verified UNAVAILABLE record, or this server's own unsigned CLIENT_MISCONFIGURED marker while it
 *                still has no signing key (the only unsigned record ever described)
 *   WITHDRAWN    a verified RETRACTED record
 *   UNVERIFIED   a signed record this server cannot verify now (key missing / retired without a verify copy / not
 *                matching) — the report is shown exactly as saved and says so; never INCLUDED
 * null: nothing to describe (no record, unreadable, unsigned / forged with no key context).
 */
export type AsjpCheck = { status: "INCLUDED" | "UNAVAILABLE" | "WITHDRAWN" | "UNVERIFIED"; sources: number; reason?: string | null; withdrawn?: number };
export function asjpCheckOf(value: unknown, binding: AsjpRecordBinding, keys: AsjpKeyMaterial = asjpKeyring(), env: Record<string, string | undefined> = process.env): AsjpCheck | null {
  const r = parseAsjpEvidenceRecord(value);
  if (!r) return null;
  const ring = ringOf(keys);
  const v = verifyAsjpRecordDetailed(r, binding, ring);
  if (v === "UNSIGNED") return r.status === "UNAVAILABLE" && r.reason === "CLIENT_MISCONFIGURED" && !ring.current && asjpReportEvidenceEnabled(env) ? { status: "UNAVAILABLE", sources: 0, reason: "CLIENT_MISCONFIGURED" } : null;
  if (v === "NO_KEY" && !asjpReportEvidenceEnabled(env)) return null; // an environment that never configured ASJP describes nothing
  if (v !== "OK") return { status: "UNVERIFIED", sources: 0, reason: v === "MISMATCH" ? "UNVERIFIED_RECORD" : v };
  const withdrawn = (r.withdrawnSourceIds ?? []).length;
  if (r.status === "RETRACTED") return { status: "WITHDRAWN", sources: 0, reason: r.reason, withdrawn: asjpWithdrawnOf(r).length };
  if (r.status === "UNAVAILABLE") return { status: "UNAVAILABLE", sources: 0, reason: r.reason, ...(withdrawn ? { withdrawn } : {}) };
  return { status: "INCLUDED", sources: r.cards.filter((c) => c.scored && !(r.withdrawnSourceIds ?? []).includes(c.sourceId)).length, ...(withdrawn ? { withdrawn } : {}) };
}

/** Back-compat (Phase 6 tests / benchmark): the decision shape, now built on the record. */
export type AsjpReportEvidenceDecision = { evidence: { asjpPublicationEvidence: AsjpChannel; cards: AsjpPersistedCard[]; pins: AsjpEvidencePins } | null; status: "INCLUDED" | "DISABLED" | "UNAVAILABLE"; reason: string | null };
export function acceptAsjpAnswer(answer: AsjpServiceAnswer | null | undefined, expected: { generationId: string; logicalManifestSha256: string; wordCount: number; text?: string; normalization?: number; allowLocalResearchPolicy?: boolean }, enabled = asjpReportEvidenceEnabled()): AsjpReportEvidenceDecision {
  const record = asjpEvidenceRecordFromAnswer(answer, { ...expected, text: expected.text ?? "" }, enabled);
  if (!record) return { evidence: null, status: "DISABLED", reason: null };
  if (record.status !== "ACCEPTED") return { evidence: null, status: "UNAVAILABLE", reason: record.reason };
  return { evidence: { asjpPublicationEvidence: asjpChannelFromCards(record.cards), cards: record.cards, pins: record.pins! }, status: "INCLUDED", reason: null };
}

/** Reads a response body with a hard byte cap (A1): an oversized answer is refused unread. */
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
 * The service call, with a client-side deadline over the whole exchange; never throws (a failure is an UNAVAILABLE
 * answer). With a request-signing key (protocol v2, lib/asjp-service-protocol.ts — required for any non-loopback URL):
 *   1. POST /attest — signed, no manuscript, no bearer token — must come back with a valid response signature for
 *      THIS hostname, or nothing else is sent (SERVICE_NOT_AUTHENTICATED);
 *   2. POST /match — signed, bearer token — and the answer must carry a valid response signature bound to this
 *      request's nonce, the manuscript body digest, the hostname, the status and the exact bytes (UNAUTHENTICATED_ANSWER
 *      otherwise); answers over 2 MB are refused unread (RESPONSE_TOO_LARGE).
 */
export async function requestAsjpAnswer(url: string, token: string, body: { text: string; title?: string | null; referenceDate?: string | null; excludeSourceIds?: string[] }, timeoutMs = 8000, extraHeaders: Record<string, string> = {}, requestSigningKey: string | null = null): Promise<AsjpServiceAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const host = new URL(url).host;
    const base = url.replace(/\/+$/, "");
    const signedHeaders = (method: string, path: string, raw: Buffer) => {
      if (!requestSigningKey) return { headers: {} as Record<string, string>, nonce: "", bodySha: "" };
      const ts = String(Date.now()), nonce = randomUUID().replace(/-/g, ""), bodySha = sha256Hex(raw);
      return { headers: { "x-asjp-timestamp": ts, "x-asjp-nonce": nonce, "x-asjp-signature": asjpRequestMac(requestSigningKey, { method, path, host, ts, nonce, bodySha256: bodySha }) }, nonce, bodySha };
    };
    const answerVerified = (res: Response, bytes: Buffer, nonce: string, bodySha: string) =>
      macEquals(asjpResponseMac(requestSigningKey!, { nonce, host, requestBodySha256: bodySha, status: res.status, responseBodySha256: sha256Hex(bytes) }), res.headers.get("x-asjp-response-signature"));
    if (requestSigningKey) {
      const raw = Buffer.from("{}", "utf8");
      const s = signedHeaders("POST", "/attest", raw);
      const res = await fetch(`${base}/attest`, { method: "POST", headers: { ...extraHeaders, ...s.headers, "content-type": "application/json" }, body: raw, signal: controller.signal });
      const bytes = await readCapped(res, 4096);
      if (!bytes || res.status !== 200 || !answerVerified(res, bytes, s.nonce, s.bodySha)) return { state: "UNAVAILABLE", failureCode: "SERVICE_NOT_AUTHENTICATED" };
    }
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    const s = signedHeaders("POST", "/match", raw);
    const res = await fetch(`${base}/match`, { method: "POST", headers: { ...extraHeaders, ...s.headers, "content-type": "application/json", authorization: `Bearer ${token}` }, body: raw, signal: controller.signal });
    const bytes = await readCapped(res, ASJP_RESPONSE_MAX_BYTES);
    if (!bytes) return { state: "UNAVAILABLE", failureCode: "RESPONSE_TOO_LARGE" };
    if (requestSigningKey && !answerVerified(res, bytes, s.nonce, s.bodySha)) return { state: "UNAVAILABLE", failureCode: "UNAUTHENTICATED_ANSWER" };
    let parsed: any;
    try { parsed = JSON.parse(new TextDecoder("utf-8").decode(bytes)); } catch { return { state: "UNAVAILABLE", failureCode: "MALFORMED_ANSWER" }; }
    if (!parsed || typeof parsed !== "object") return { state: "UNAVAILABLE", failureCode: "MALFORMED_ANSWER" };
    if (!res.ok && parsed.state === "COMPLETE") return { state: "UNAVAILABLE", failureCode: "MALFORMED_ANSWER" };
    return parsed as AsjpServiceAnswer;
  } catch (error) {
    return { state: "UNAVAILABLE", failureCode: (error as Error)?.name === "AbortError" ? "CLIENT_TIMEOUT" : "SERVICE_UNREACHABLE" };
  } finally { clearTimeout(timer); }
}

/**
 * The report path's client configuration — environment only (never source code):
 *   ASJP_REPORT_EVIDENCE_ENABLED=true, ASJP_SERVICE_URL (https, or http to loopback only), ASJP_SERVICE_TOKEN /
 *   ASJP_SERVICE_TOKEN_FILE (strong: >= 32 characters, >= 12 distinct), ASJP_SERVICE_REQUEST_SIGNING_KEY (strong;
 *   REQUIRED for any non-loopback URL), ASJP_PINNED_GENERATION_ID, ASJP_PINNED_MANIFEST_SHA256, optional
 *   ASJP_PINNED_LANE_VERSION, ASJP_EVIDENCE_SIGNING_KEY / _FILE (+ _ID, ASJP_EVIDENCE_VERIFY_KEYS), ASJP_SERVICE_TIMEOUT_MS
 *   (1000–30000, default 8000; keep the service's own deadline below it so abandoned work does not hold workers),
 *   ASJP_REQUIRED_DB_HOST (C1: the database host this deployment must use; REQUIRED on a Vercel Preview — ASJP refuses
 *   to run on any other database, so a Preview that inherited the shared database never tests ASJP on it)
 * Review finding 12: with ASJP on, an incomplete configuration is reported (asjpReportClientConfigProblem), logged
 * once by name, and recorded as UNAVAILABLE("CLIENT_MISCONFIGURED") — never silently skipped.
 */
/**
 * Phase 7 (hosting): when the service sits behind a Cloudflare Tunnel protected by Cloudflare Access, the report path
 * also sends the Access service-token headers (ASJP_SERVICE_ACCESS_CLIENT_ID / ASJP_SERVICE_ACCESS_CLIENT_SECRET, both
 * or neither). Environment only, never logged; the bearer token is still required by the service itself.
 */
export type AsjpReportClientConfig = { url: string; token: string; generationId: string; logicalManifestSha256: string; laneVersion: string | null; timeoutMs: number; allowLocalResearchPolicy: boolean; accessHeaders: Record<string, string>; requestSigningKey: string | null };
const dbHostOf = (url: string | undefined) => { try { return url ? new URL(url.replace(/^libsql:/, "https:")).host.toLowerCase() : ""; } catch { return ""; } };
export function asjpReportClientConfigProblem(env: Record<string, string | undefined> = process.env): string | null {
  if (!asjpReportEvidenceEnabled(env)) return null;
  const url = env.ASJP_SERVICE_URL ?? "";
  let parsed: URL | null = null; try { parsed = new URL(url); } catch { parsed = null; }
  if (!parsed || (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackUrl(url))) || parsed.username || parsed.password || parsed.search || parsed.hash) return "ASJP_SERVICE_URL";
  let token = "";
  if (env.ASJP_SERVICE_TOKEN_FILE) { try { token = readFileSync(env.ASJP_SERVICE_TOKEN_FILE, "utf8").trim(); } catch { return "ASJP_SERVICE_TOKEN_FILE"; } if (asjpCredentialProblem(token)) return "ASJP_SERVICE_TOKEN_FILE"; }
  else if (asjpCredentialProblem((env.ASJP_SERVICE_TOKEN ?? "").trim())) return "ASJP_SERVICE_TOKEN";
  const requestKey = (env.ASJP_SERVICE_REQUEST_SIGNING_KEY ?? "").trim();
  if (requestKey ? asjpCredentialProblem(requestKey) : !isLoopbackUrl(url)) return "ASJP_SERVICE_REQUEST_SIGNING_KEY";
  if (!env.ASJP_PINNED_GENERATION_ID || !env.ASJP_PINNED_MANIFEST_SHA256) return "ASJP_PINNED_GENERATION";
  if (!asjpSigningKey(env) || !KEY_ID.test((env.ASJP_EVIDENCE_SIGNING_KEY_ID ?? "k1").trim())) return "ASJP_EVIDENCE_SIGNING_KEY";
  if (!!env.ASJP_SERVICE_ACCESS_CLIENT_ID !== !!env.ASJP_SERVICE_ACCESS_CLIENT_SECRET) return "ASJP_SERVICE_ACCESS_CLIENT";
  const requiredDbHost = (env.ASJP_REQUIRED_DB_HOST ?? "").trim().toLowerCase();
  if (env.VERCEL_ENV === "preview" && !requiredDbHost) return "ASJP_REQUIRED_DB_HOST";
  if (requiredDbHost && dbHostOf(env.TURSO_DATABASE_URL) !== requiredDbHost) return "ASJP_REQUIRED_DB_HOST";
  return null;
}
export function asjpReportClientConfig(env: Record<string, string | undefined> = process.env): AsjpReportClientConfig | null {
  if (!asjpReportEvidenceEnabled(env) || asjpReportClientConfigProblem(env)) return null;
  const token = env.ASJP_SERVICE_TOKEN_FILE ? readFileSync(env.ASJP_SERVICE_TOKEN_FILE, "utf8").trim() : (env.ASJP_SERVICE_TOKEN ?? "").trim();
  const timeout = Number(env.ASJP_SERVICE_TIMEOUT_MS ?? 8000);
  return { url: env.ASJP_SERVICE_URL!, token, generationId: env.ASJP_PINNED_GENERATION_ID!, logicalManifestSha256: env.ASJP_PINNED_MANIFEST_SHA256!, laneVersion: env.ASJP_PINNED_LANE_VERSION || null, timeoutMs: Number.isFinite(timeout) ? Math.min(30_000, Math.max(1_000, timeout)) : 8_000, allowLocalResearchPolicy: env.ASJP_ALLOW_LOCAL_RESEARCH_POLICY === "true", accessHeaders: env.ASJP_SERVICE_ACCESS_CLIENT_ID && env.ASJP_SERVICE_ACCESS_CLIENT_SECRET ? { "CF-Access-Client-Id": env.ASJP_SERVICE_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": env.ASJP_SERVICE_ACCESS_CLIENT_SECRET } : {}, requestSigningKey: (env.ASJP_SERVICE_REQUEST_SIGNING_KEY ?? "").trim() || null };
}
/** A6: a configuration problem is logged once per process, by variable NAME only (never a value). */
const loggedProblems = new Set<string>();
function logConfigProblemOnce(problem: string | null) {
  if (!problem || loggedProblems.has(problem)) return;
  loggedProblems.add(problem);
  console.warn(JSON.stringify({ event: "asjp_client_misconfigured", problem }));
}

/** Query the service once for a report and return the (unsigned) record to persist (never throws; null when ASJP is off). */
export async function checkAsjpForReport(
  input: { text: string; wordCount: number; title?: string | null },
  config: AsjpReportClientConfig | null = asjpReportClientConfig(),
  fetchAnswer: (config: AsjpReportClientConfig, body: { text: string; title?: string | null; excludeSourceIds?: string[] }) => Promise<AsjpServiceAnswer> = (c, body) => requestAsjpAnswer(c.url, c.token, body, c.timeoutMs, c.accessHeaders, c.requestSigningKey),
  attempts = 0,
  env: Record<string, string | undefined> = process.env,
  withdrawn: readonly string[] = [],
): Promise<AsjpPersistedEvidence | null> {
  const excludeSourceIds = normalizeWithdrawn([...withdrawn, ...asjpGlobalWithdrawn(env)]);
  if (!config) {
    if (!asjpReportEvidenceEnabled(env)) return null;
    logConfigProblemOnce(asjpReportClientConfigProblem(env));
    return unavailable("CLIENT_MISCONFIGURED", input, attempts, excludeSourceIds);
  }
  let answer: AsjpServiceAnswer | null = null;
  try { answer = await fetchAnswer(config, { text: input.text, title: input.title ?? null, ...(excludeSourceIds.length ? { excludeSourceIds } : {}) }); } catch { answer = null; }
  return asjpEvidenceRecordFromAnswer(answer, { generationId: config.generationId, logicalManifestSha256: config.logicalManifestSha256, laneVersion: config.laneVersion, wordCount: input.wordCount, text: input.text, allowLocalResearchPolicy: config.allowLocalResearchPolicy, withdrawn: excludeSourceIds }, true, attempts);
}

/**
 * What a SAVE does with ASJP (review finding 5: the service is asked ONLY on a first save or a changed manuscript):
 *   - same manuscript, the stored record verifies          -> carry it forward unchanged
 *   - same manuscript, a SIGNED record that cannot be verified now (A5: key missing / retired without a verify copy /
 *     changed)                                              -> preserveStored: the save must keep the stored report
 *                                                             exactly as it was (score, cards, record) — never a
 *                                                             silent recompute without ASJP; the report says
 *                                                             "cannot currently be verified"
 *   - same manuscript, this server's own unsigned CLIENT_MISCONFIGURED marker -> carried (A6: the notice stays)
 *   - same manuscript, anything else (none, legacy, unsigned / client-planted) -> none (a report saved without ASJP never gains it on a resave)
 *   - first save / changed manuscript                       -> ask the service once, excluding this report's withdrawn
 *                                                             articles (B3: from its verified previous record) and the
 *                                                             deployment takedown list; sign the answer for this report
 */
export type AsjpSaveDecision = { record: AsjpPersistedEvidence | null; preserveStored: boolean; reason: string | null };
export async function asjpSaveDecision(
  input: { text: string; wordCount: number; scoringNormalizationVersion: number; isFirstSave: boolean; persistedRecord: unknown; persistedText: string | null; binding: AsjpRecordBinding },
  check: (withdrawn: string[]) => Promise<AsjpPersistedEvidence | null>,
  keys: AsjpKeyMaterial = asjpKeyring(),
  env: Record<string, string | undefined> = process.env,
): Promise<AsjpSaveDecision> {
  const ring = ringOf(keys);
  const stored = input.isFirstSave ? null : parseAsjpEvidenceRecord(input.persistedRecord);
  const verification = stored ? verifyAsjpRecordDetailed(stored, input.binding, ring) : null;
  const sameManuscript = !input.isFirstSave && input.persistedText === input.text;
  if (sameManuscript) {
    if (!stored) return { record: null, preserveStored: false, reason: null };
    if (verification === "OK") return stored.textSha256 === asjpTextSha256(input.text) ? { record: stored, preserveStored: false, reason: null } : { record: null, preserveStored: false, reason: "TEXT_MISMATCH" };
    if (verification === "UNSIGNED") return stored.status === "UNAVAILABLE" && stored.reason === "CLIENT_MISCONFIGURED" && !ring.current ? { record: stored, preserveStored: false, reason: "CLIENT_MISCONFIGURED" } : { record: null, preserveStored: false, reason: "UNSIGNED_RECORD" };
    // A5, narrowed by the re-review (N1 / N4): the stored report is preserved ONLY where ASJP is on in this deployment
    // and the record is an ACCEPTED one (it put ASJP words in the saved score). With ASJP off (Production today) an
    // unverifiable record is dropped and the report recomputed exactly as 1df8762 does; an unverifiable UNAVAILABLE /
    // RETRACTED record carried no ASJP words, so dropping it changes no score. MISMATCH stays preserved on purpose:
    // the owner rule is that a key changed under the same id never silently moves a score (23 % -> 0 %).
    if (asjpReportEvidenceEnabled(env) && stored.status === "ACCEPTED") return { record: stored, preserveStored: true, reason: verification };
    return { record: null, preserveStored: false, reason: verification };
  }
  if (input.scoringNormalizationVersion !== 2 || !input.text) return { record: null, preserveStored: false, reason: null };
  const withdrawn = verification === "OK" ? asjpWithdrawnOf(stored) : [];
  const fresh = await check(withdrawn);
  return { record: fresh ? signAsjpRecord(fresh, input.binding, ring) : null, preserveStored: false, reason: null };
}
/** Back-compat: the record a save persists (see asjpSaveDecision). */
export async function asjpEvidenceForSave(
  input: { text: string; wordCount: number; scoringNormalizationVersion: number; isFirstSave: boolean; persistedRecord: unknown; persistedText: string | null; binding: AsjpRecordBinding },
  check: (withdrawn: string[]) => Promise<AsjpPersistedEvidence | null>,
  keys: AsjpKeyMaterial = asjpKeyring(),
): Promise<AsjpPersistedEvidence | null> {
  const d = await asjpSaveDecision(input, check, keys);
  return d.preserveStored ? null : d.record;
}

/** B1: does this record take real space (cards / research) — i.e. can replacing it by a marker make a report fit? */
export function asjpRecordOccupiesSpace(record: AsjpPersistedEvidence | null): boolean {
  return !!record && (record.cards.length > 0 || !!record.research);
}
/**
 * B1: the signed marker that replaces an ACCEPTED record which does not fit in the report's size ceiling — status
 * UNAVAILABLE, reason RECORD_DOES_NOT_FIT, no cards, no research (nothing is truncated: the whole ASJP contribution is
 * left out and the report says the check is unavailable). The withdrawn list is kept (B3).
 */
export function asjpRecordDoesNotFit(record: AsjpPersistedEvidence, binding: AsjpRecordBinding, keys: AsjpKeyMaterial = asjpKeyring()): AsjpPersistedEvidence | null {
  // re-review N3: only a record that VERIFIES is ever re-signed — an unverified one (a preserved or planted record) is
  // never turned into a server-signed marker (its withdrawn list would become trusted); null = leave it out entirely
  if (!verifyAsjpRecord(record, binding, keys)) return null;
  const { signature: _s, keyId: _k, research: _r, ...base } = record;
  return signAsjpRecord({ ...base, status: "UNAVAILABLE", reason: "RECORD_DOES_NOT_FIT", checkedAt: new Date().toISOString(), cards: [] }, binding, keys);
}

/** Retry an UNAVAILABLE record: a fresh check, kept only if ACCEPTED (an UNAVAILABLE retry bumps `attempts`). Unsigned result. */
export async function retryUnavailableAsjpRecord(record: AsjpPersistedEvidence, report: { text: string; wordCount: number }, check: (attempts: number) => Promise<AsjpPersistedEvidence | null>, maxAttempts = 3): Promise<AsjpPersistedEvidence | null> {
  if (record.status !== "UNAVAILABLE" || record.attempts >= maxAttempts || record.textSha256 !== asjpTextSha256(report.text) || record.wordCount !== report.wordCount) return null;
  const next = await check(record.attempts + 1);
  if (!next) return null;
  const { signature: _old, keyId: _oldId, ...base } = record;
  return next.status === "ACCEPTED" ? next : { ...base, attempts: record.attempts + 1, reason: next.reason, checkedAt: next.checkedAt };
}
