import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { asjpKeyring, type AsjpKeyMaterial, type AsjpKeyring, type AsjpRecordBinding } from "./asjp-report-evidence";
import {
  ASJP_SIXWORD_CONTRACT_VERSION, ASJP_SIXWORD_OVERLAP_LABEL, SIXWORD_LIMITS, sixwordOverlapProblem,
  type SixwordOverlapMatch, type SixwordOverlapPins, type SixwordOverlapResponse,
} from "./asjp-sixword-contract";

/**
 * REPORT RECORD for informational six-word overlap (integration preparation, local only; not wired to any route).
 *
 * A separate payload field, `$.asjpSixwordOverlap`, beside — never inside — `$.asjpEvidence` and never read by any
 * scoring code: computeUnifiedSimilarity, the lanes' credited positions and every percentage are unaware of it. It is
 * shown only in an admin / developer evidence section, labelled ASJP_SIXWORD_OVERLAP_LABEL.
 *
 *   ACCEPTED     a complete, well-formed answer (sixwordOverlapProblem = null) pinned to the report's expected
 *                generation and word count; trimmed to SIXWORD_LIMITS.maxRecordBytes if needed (COMMON matches first,
 *                then the shortest), with exact counts of what was trimmed
 *   UNAVAILABLE  anything else, with a code (service down, busy, timeout, budget, wrong generation, malformed, …)
 *   RETRACTED    withdrawn by an explicit call (rollback): no match is shown any more
 *
 * Integrity: an HMAC (the ASJP evidence signing key, a DIFFERENT schema string than the scored ASJP record, so neither
 * record can be passed off as the other) over the record and the report it belongs to (device key, report id, owner).
 * Unsigned, forged or moved records are never shown. The record is never re-queried: a takedown after saving is applied
 * by redactWithdrawnHolders, which only removes holders (and matches left without one).
 */
export const ASJP_SIXWORD_RECORD_SCHEMA = "asjp-sixword-overlap-record-v1";
/** Report-side display flag (default off): compute nothing new, only allow an admin view of a trusted record. */
export function asjpSixwordOverlapDisplayEnabled(env: Record<string, string | undefined> = process.env): boolean { return env.ASJP_SIXWORD_OVERLAP_DISPLAY_ENABLED === "true"; }

export type AsjpSixwordRecord = {
  schema: typeof ASJP_SIXWORD_RECORD_SCHEMA; contract: typeof ASJP_SIXWORD_CONTRACT_VERSION;
  status: "ACCEPTED" | "UNAVAILABLE" | "RETRACTED"; reason: string | null;
  scored: false; label: typeof ASJP_SIXWORD_OVERLAP_LABEL;
  checkedAt: string; textSha256: string; wordCount: number;
  pins: SixwordOverlapPins | null;
  summary: SixwordOverlapResponse["summary"];
  matches: SixwordOverlapMatch[];
  sources: SixwordOverlapResponse["sources"];
  truncation: SixwordOverlapResponse["truncation"] & { recordTrimmedMatches: number; redactedHolders: number; redactedMatches: number };
  retractedAt?: string; retractionReason?: string;
  /** the evidence keyring id of the key that signed it (A5 rotation: retired keys stay verify-only) */
  keyId?: string;
  signature?: string;
};
export type SixwordRecordExpectation = { text: string; wordCount: number; generationId: string; logicalManifestSha256: string; allowLocalResearchPolicy?: boolean };

const sha256 = (s: string) => createHash("sha256").update(s ?? "").digest("hex");
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : stableJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}
const emptyTruncation = () => ({ matchesOmitted: 0, commonOmitted: 0, matchesWithHoldersOmitted: 0, holdersWithoutCharOffsets: 0, recordTrimmedMatches: 0, redactedHolders: 0, redactedMatches: 0 });
const unavailable = (reason: string, x: SixwordRecordExpectation, now: string): AsjpSixwordRecord => ({ schema: ASJP_SIXWORD_RECORD_SCHEMA, contract: ASJP_SIXWORD_CONTRACT_VERSION, status: "UNAVAILABLE", reason, scored: false, label: ASJP_SIXWORD_OVERLAP_LABEL, checkedAt: now, textSha256: sha256(x.text), wordCount: x.wordCount, pins: null, summary: null, matches: [], sources: {}, truncation: emptyTruncation() });

/** Only the sources some listed holder still refers to. */
const referencedSources = (matches: readonly SixwordOverlapMatch[], all: SixwordOverlapResponse["sources"]) => {
  const out: SixwordOverlapResponse["sources"] = {};
  for (const m of matches) for (const h of m.holders) if (all[h.sourceId]) out[h.sourceId] = all[h.sourceId];
  return out;
};
/** A service answer block -> the (unsigned) record. Never throws. */
export function sixwordRecordFromAnswer(answer: unknown, expected: SixwordRecordExpectation, now = new Date().toISOString()): AsjpSixwordRecord {
  try {
    if (!answer || typeof answer !== "object") return unavailable("NO_ANSWER", expected, now);
    const problem = sixwordOverlapProblem(answer, expected.wordCount);
    if (problem) return unavailable(`MALFORMED_${problem}`, expected, now);
    const a = answer as SixwordOverlapResponse;
    if (a.state !== "COMPLETE") return unavailable(`${a.state}_${a.reason ?? "UNKNOWN"}`, expected, now);
    if (a.pins!.generationId !== expected.generationId || a.pins!.logicalManifestSha256 !== expected.logicalManifestSha256) return unavailable("GENERATION_MISMATCH", expected, now);
    if (a.pins!.licencePolicy !== "permitted-only" && !(expected.allowLocalResearchPolicy && a.pins!.licencePolicy === "local-research-all")) return unavailable("LICENCE_POLICY_NOT_ALLOWED", expected, now);
    const record: AsjpSixwordRecord = { schema: ASJP_SIXWORD_RECORD_SCHEMA, contract: ASJP_SIXWORD_CONTRACT_VERSION, status: "ACCEPTED", reason: null, scored: false, label: ASJP_SIXWORD_OVERLAP_LABEL, checkedAt: now, textSha256: sha256(expected.text), wordCount: expected.wordCount, pins: a.pins, summary: a.summary, matches: a.matches.map((m) => ({ ...m })), sources: { ...a.sources }, truncation: { ...a.truncation, recordTrimmedMatches: 0, redactedHolders: 0, redactedMatches: 0 } };
    // byte bound: drop COMMON first, then SHARED, then UNIQUE, the shortest first in each, until the record fits
    const rank = (m: SixwordOverlapMatch) => (m.commonness === "COMMON" ? 0 : m.commonness === "SHARED" ? 1 : 2);
    const order = [...record.matches].sort((x, y) => rank(x) - rank(y) || x.words - y.words);
    while (Buffer.byteLength(JSON.stringify(record)) > SIXWORD_LIMITS.maxRecordBytes && order.length) {
      const drop = order.shift()!;
      record.matches = record.matches.filter((m) => m !== drop);
      record.sources = referencedSources(record.matches, record.sources);
      record.truncation.recordTrimmedMatches += 1;
    }
    return record;
  } catch { return unavailable("RECORD_EXCEPTION", expected, now); }
}

const macOf = (record: AsjpSixwordRecord, binding: AsjpRecordBinding, key: string) => {
  const { signature: _ignored, ...body } = record;
  return createHmac("sha256", key).update(stableJson([ASJP_SIXWORD_RECORD_SCHEMA, binding.reportDeviceKey, binding.reportId, binding.accountId ?? null, body])).digest("hex");
};
/** The same keyring as the scored ASJP record (Phase 7 remediation A5): a bare key is id "k1". */
const ringOf = (m: AsjpKeyMaterial | undefined): AsjpKeyring => (typeof m === "string" ? { current: { id: "k1", key: m }, verify: new Map([["k1", m]]) } : m ?? { current: null, verify: new Map() });
/** Signs with the CURRENT key and records its id (inside the signed body). No key -> unsigned (never shown). */
export function signSixwordRecord(record: AsjpSixwordRecord, binding: AsjpRecordBinding, keys: AsjpKeyMaterial = asjpKeyring()): AsjpSixwordRecord {
  const { signature: _old, keyId: _oldId, ...base } = record;
  const ring = ringOf(keys);
  if (!ring.current) return { ...base };
  const unsigned: AsjpSixwordRecord = { ...base, keyId: ring.current.id };
  return { ...unsigned, signature: macOf(unsigned, binding, ring.current.key) };
}
/** The record if it is signed for exactly this report and owner by a key of the keyring, else null (fail closed). */
export function trustedSixwordRecord(record: unknown, binding: AsjpRecordBinding, keys: AsjpKeyMaterial = asjpKeyring()): AsjpSixwordRecord | null {
  const r = record as AsjpSixwordRecord;
  if (!r || typeof r !== "object" || r.schema !== ASJP_SIXWORD_RECORD_SCHEMA || r.scored !== false || typeof r.signature !== "string" || !/^[0-9a-f]{64}$/.test(r.signature)) return null;
  const ring = ringOf(keys);
  const key = typeof r.keyId === "string" ? ring.verify.get(r.keyId) : undefined;
  if (!key) return null;
  return timingSafeEqual(Buffer.from(r.signature, "hex"), Buffer.from(macOf(r, binding, key), "hex")) ? r : null;
}
/** Rollback: the record stays (audit) but shows nothing. */
export function retractSixwordRecord(record: AsjpSixwordRecord, reason: string, now = new Date().toISOString()): AsjpSixwordRecord {
  return { ...record, status: "RETRACTED", retractedAt: now, retractionReason: reason, matches: [], sources: {}, signature: undefined };
}
/** Takedown after saving: removes withdrawn holders; a match left with no listed holder is removed. Never re-queries. */
export function redactWithdrawnHolders(record: AsjpSixwordRecord, withdrawn: (articleId: string) => boolean): AsjpSixwordRecord {
  let holders = 0, removed = 0;
  const matches: SixwordOverlapMatch[] = [];
  for (const m of record.matches) {
    const kept = m.holders.filter((h) => !withdrawn(record.sources[h.sourceId]?.articleId ?? h.sourceId.replace(/^asjp:/, "")));
    holders += m.holders.length - kept.length;
    if (kept.length === m.holders.length) { matches.push(m); continue; }
    if (kept.length === 0) { removed += 1; continue; }
    matches.push({ ...m, holders: kept, eligibleHolders: m.eligibleHolders - (m.holders.length - kept.length) });
  }
  return { ...record, matches, sources: referencedSources(matches, record.sources), truncation: { ...record.truncation, redactedHolders: record.truncation.redactedHolders + holders, redactedMatches: record.truncation.redactedMatches + removed }, signature: undefined };
}
/**
 * The admin / developer view: only a trusted ACCEPTED record, only with the display flag on. Every item is labelled
 * and states that no origin is established. Nothing here is a scored highlight.
 */
export function sixwordAdminView(record: unknown, binding: AsjpRecordBinding, env: Record<string, string | undefined> = process.env, keys: AsjpKeyMaterial = asjpKeyring(env), withdrawn: ReadonlySet<string> = new Set()) {
  if (!asjpSixwordOverlapDisplayEnabled(env)) return null;
  const verified = trustedSixwordRecord(record, binding, keys);
  if (!verified) return null;
  // takedowns after the search (deployment list, the report's own withdrawn articles) are applied at display time
  const r = withdrawn.size ? redactWithdrawnHolders(verified, (articleId) => withdrawn.has(`asjp:${articleId}`)) : verified;
  if (r.status !== "ACCEPTED") {
    // never presented as "no matches": a stopped or failed search shows no result at all, with its reason
    const stopped = /^INCOMPLETE_BUDGET/.test(String(r.reason));
    const outcome = r.status === "RETRACTED" ? "RETRACTED" : stopped ? "SEARCH_STOPPED_AT_LIMIT" : "SEARCH_UNAVAILABLE";
    const message = outcome === "RETRACTED" ? "This search result was retracted; nothing is shown."
      : outcome === "SEARCH_STOPPED_AT_LIMIT" ? "The search stopped at its time or size limit. No result is available — this does NOT mean zero matches."
      : "The search was unavailable. No result is available — this does NOT mean zero matches.";
    return { label: ASJP_SIXWORD_OVERLAP_LABEL, outcome, message, status: r.status, reason: r.reason ?? r.retractionReason ?? null, checkedAt: r.checkedAt, items: [] };
  }
  return {
    // L4: "no overlap" only when the search really found none; matches found but not listable say so
    label: ASJP_SIXWORD_OVERLAP_LABEL, outcome: "COMPLETE" as const,
    message: r.matches.length ? "Verified exact text overlap. Informational only: not included in the similarity score."
      : (r.summary?.matches ?? 0) > 0 || r.truncation.recordTrimmedMatches > 0 || r.truncation.redactedMatches > 0 || r.truncation.matchesOmitted > 0
        ? "Exact overlap was found, but no match can be listed here (no eligible holder, withdrawn after the search, or trimmed to fit the record). This does NOT mean zero matches."
        : "The search completed and found no exact overlap of six or more words with any indexed article.",
    status: r.status, reason: null, checkedAt: r.checkedAt, pins: r.pins, summary: r.summary, truncation: r.truncation,
    items: r.matches.map((m) => ({
      scored: false as const, label: ASJP_SIXWORD_OVERLAP_LABEL, words: [m.submittedWordStart, m.submittedWordEnd] as [number, number], length: m.words, band: m.band,
      held: m.eligibleHolders === 1 ? "Held by 1 indexed article (original source not established)" : `Held by ${m.eligibleHolders} indexed articles — multiple source holders (original source not established)`,
      multipleHolders: m.eligibleHolders > 1,
      commonness: m.commonness, holdersInIndex: m.holdersInIndex, alreadyCountedThroughScoredLane: m.wordsAlreadyCreditedByLane,
      holders: m.holders.map((h) => ({ sourceId: h.sourceId, title: r.sources[h.sourceId]?.title ?? null, journal: r.sources[h.sourceId]?.journal ?? null, date: r.sources[h.sourceId]?.publicationDate ?? null, url: r.sources[h.sourceId]?.canonicalUrl ?? null, sourceWords: [h.sourceWordStart, h.sourceWordEnd], sourceChars: h.sourceCharStart === null ? null : [h.sourceCharStart, h.sourceCharEnd] })),
      holdersNotListed: m.holdersOmitted, notEligible: m.ineligibleHolders, labels: m.labels,
    })),
  };
}
