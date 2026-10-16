import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { tokenSpans, tokensForScoringNormalization } from "./similarity-core";
import { sha256Hex } from "./asjp-service-protocol";
import { docIdFromDecimal } from "./corpus-engine/ids";
import type { CorpusGenerationReader } from "./corpus-engine/reader";
import { ASJP_PROVIDER, publicationTimingOf, type AsjpCatalogEntry, type AsjpLicencePolicy } from "./asjp-academic-lane";
import { ASJP_SIXWORD_INDEX_FORMAT, SixwordIndex, SixwordTokenDirMismatch } from "./asjp-sixword-index";
import { findSixwordRuns, SixwordBudgetExceeded } from "./asjp-sixword-match";
import { applyHolderGates, ASJP_SIXWORD_EVIDENCE_VERSION, holderOffsets, sixwordMatches, type SixwordMatch, type WordDf } from "./asjp-sixword-evidence";
import {
  ASJP_SIXWORD_CONTRACT_VERSION, ASJP_SIXWORD_OVERLAP_LABEL, SIXWORD_LIMITS, unavailableSixwordOverlap,
  type SixwordGateReason, type SixwordOverlapHolder, type SixwordOverlapMatch, type SixwordOverlapPins, type SixwordOverlapResponse,
} from "./asjp-sixword-contract";

/**
 * SIX-WORD OVERLAP for the ASJP matching service (integration preparation, local only; contract
 * asjp-sixword-overlap-contract-v1). Informational only: nothing here is scored, and nothing here can change the lane's
 * answer (the service computes it AFTER the lane, in its own block, and any failure becomes a coded UNAVAILABLE).
 *
 * Session: the six-word index must be pinned to the SAME generation (id + logical manifest) as the lane session, else it
 * is refused (GENERATION_MISMATCH). Article identity is read once from that generation's own metadata records with the
 * lane's rule (provider cerist-asjp, numeric external id), so a holder is named exactly as the lane would name it.
 */
export class SixwordOverlapUnavailable extends Error { constructor(readonly code: string) { super(code); } }
export type SixwordOverlapSession = {
  index: SixwordIndex; identities: Array<{ articleId: string; canonicalUrl: string | null } | null>; wordDf: WordDf;
  generationId: string; logicalManifestSha256: string; openMs: number;
};

export async function openSixwordOverlapSession(options: { indexDir: string; reader: CorpusGenerationReader; generationId: string; logicalManifestSha256: string; wordDf: WordDf; laneTokensDir?: string | null }): Promise<SixwordOverlapSession> {
  const t0 = performance.now();
  let index: SixwordIndex;
  // final review L-A: with a lane token store, the index opens exactly that (validated) directory or is refused
  try { index = SixwordIndex.open(options.indexDir, options.laneTokensDir ? { tokensDir: options.laneTokensDir } : {}); }
  catch (error) { throw new SixwordOverlapUnavailable(error instanceof SixwordTokenDirMismatch ? "INDEX_TOKEN_STORE_MISMATCH" : "INDEX_UNAVAILABLE"); }
  const pin = index.identity.generation;
  if (pin.generationId !== options.generationId || pin.logicalManifestSha256 !== options.logicalManifestSha256 || options.reader.identity().generationId !== options.generationId) {
    index.close(); throw new SixwordOverlapUnavailable("GENERATION_MISMATCH");
  }
  // review L6: the index must be built from the SAME token store the lane serves (not a self-declared label): the
  // store's index.json digest and tokens.bin size must equal the ones recorded at build time
  if (options.laneTokensDir) {
    let same = false;
    try {
      same = sha256Hex(readFileSync(path.join(options.laneTokensDir, "index.json"))) === index.identity.laneTokens.indexJsonSha256
        && statSync(path.join(options.laneTokensDir, "tokens.bin")).size === index.identity.laneTokens.tokensBinBytes;
    } catch { same = false; }
    if (!same) { index.close(); throw new SixwordOverlapUnavailable("INDEX_TOKEN_STORE_MISMATCH"); }
  }
  const identities: SixwordOverlapSession["identities"] = [];
  let missing = 0;
  for (const docId of index.docs.docIds) {
    const md = await options.reader.fetchMetadata(docIdFromDecimal(docId));
    if (md.state !== "OK") missing += 1;
    identities.push(md.state === "OK" ? asjpIdentityOfRecord(md.metadata as Record<string, unknown>, (md as { laterAliases?: unknown[] }).laterAliases ?? []) : null);
  }
  // every indexed document must exist in the pinned generation (an index of another corpus never opens as READY)
  if (missing > 0) { index.close(); throw new SixwordOverlapUnavailable("INDEX_NOT_OF_GENERATION"); }
  return { index, identities, wordDf: options.wordDf, generationId: options.generationId, logicalManifestSha256: options.logicalManifestSha256, openMs: Math.round(performance.now() - t0) };
}

/** The lane's identity rule (asjp-academic-lane.ts asjpIdentityOf, not exported there): mirrored exactly, tested equal. */
export function asjpIdentityOfRecord(record: Record<string, unknown>, laterAliases: readonly unknown[]): { articleId: string; canonicalUrl: string | null } | null {
  for (const candidate of [record.canonicalSource, ...(Array.isArray(record.aliases) ? record.aliases : []), ...laterAliases]) {
    if (!candidate || typeof candidate !== "object") continue;
    const s = candidate as Record<string, unknown>;
    if (s.provider !== ASJP_PROVIDER || typeof s.externalId !== "string" || !/^\d+$/.test(s.externalId)) continue;
    return { articleId: s.externalId, canonicalUrl: typeof s.canonicalUrl === "string" ? s.canonicalUrl : null };
  }
  return null;
}

/** The lane's source gates for one indexed article (same reason codes; no article-count restriction of any kind). */
export function sixwordSourceGate(identity: { articleId: string; canonicalUrl: string | null } | null, entry: AsjpCatalogEntry | null, licencePolicy: AsjpLicencePolicy, referenceDate: string | null): { eligible: boolean; reason: SixwordGateReason | null } {
  if (!identity) return { eligible: false, reason: "NO_ASJP_IDENTITY" };
  if (!entry) return { eligible: false, reason: "NOT_IN_CATALOG" };
  if (entry.articleId !== identity.articleId || !identity.canonicalUrl || identity.canonicalUrl !== entry.canonicalUrl) return { eligible: false, reason: "UNVERIFIED_SOURCE_IDENTITY" };
  if (entry.withdrawn) return { eligible: false, reason: "WITHDRAWN" };
  const licence = entry.licenceStatus ?? (entry.reusePermitted ? "PERMITTED" : "UNKNOWN");
  if (licencePolicy === "permitted-only" && licence !== "PERMITTED") return { eligible: false, reason: "LICENCE_NOT_PERMITTING" };
  if (referenceDate) {
    const timing = publicationTimingOf(entry.publicationDate, referenceDate);
    if (timing === "AFTER") return { eligible: false, reason: "PUBLISHED_AFTER_REFERENCE_DATE" };
    if (timing === "UNCERTAIN") return { eligible: false, reason: "PUBLICATION_DATE_UNCERTAIN" };
  }
  return { eligible: true, reason: null };
}

export type SixwordOverlapRequest = {
  text: string; referenceDate: string | null; licencePolicy: AsjpLicencePolicy;
  /** the SAME catalog snapshot the lane answer used */
  catalog: (articleId: string) => AsjpCatalogEntry | null; catalogDigest: string | null;
  /** the scored lane's credited positions for this text (reported per match; never changed) */
  creditedPositions: readonly number[];
  fetchText: (docId: string) => Promise<string | null>;
  limits?: Partial<typeof SIXWORD_LIMITS>;
};

export async function computeSixwordOverlap(session: SixwordOverlapSession, request: SixwordOverlapRequest): Promise<SixwordOverlapResponse> {
  const limits = { ...SIXWORD_LIMITS, ...request.limits };
  const t0 = performance.now(), deadlineAt = t0 + limits.timeBudgetMs;
  const { index } = session;
  const pins: SixwordOverlapPins = {
    contract: ASJP_SIXWORD_CONTRACT_VERSION, evidenceVersion: ASJP_SIXWORD_EVIDENCE_VERSION, indexFormat: ASJP_SIXWORD_INDEX_FORMAT,
    indexPostingsSha256: index.identity.files["postings.bin"].sha256, tokenStoreSha256: index.identity.laneTokens.tokensBinSha256,
    generationId: session.generationId, logicalManifestSha256: session.logicalManifestSha256, normalization: 2,
    catalogDigest: request.catalogDigest, licencePolicy: request.licencePolicy, referenceDate: request.referenceDate,
  };
  if (request.referenceDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(request.referenceDate)) return unavailableSixwordOverlap("UNAVAILABLE", "INVALID_REFERENCE_DATE", pins);
  const words = tokensForScoringNormalization(request.text, 2);
  let matches: SixwordMatch[], runs = 0;
  let t1 = t0, t2 = t0;
  try {
    const found = findSixwordRuns(index, words, { budget: { maxPairs: limits.maxPairs, deadlineAt } });
    runs = found.runs.length;
    t1 = performance.now();
    // final review L-B: the evidence step stops at the same deadline (a coded INCOMPLETE_BUDGET, never a worker kill)
    matches = sixwordMatches(index, words, found, { original: request.text, spans: tokenSpans(request.text, 2), wordDf: session.wordDf, deadlineAt });
    t2 = performance.now();
    if (t2 > deadlineAt) return unavailableSixwordOverlap("INCOMPLETE_BUDGET", "TIME_BUDGET", pins, words.length);
  } catch (error) {
    if (error instanceof SixwordBudgetExceeded) return unavailableSixwordOverlap("INCOMPLETE_BUDGET", error.code, pins, words.length);
    return unavailableSixwordOverlap("UNAVAILABLE", "SIXWORD_EXCEPTION", pins, words.length);
  }
  // gates: one decision per article, from the request's own catalog snapshot
  applyHolderGates(matches, (ord) => sixwordSourceGate(session.identities[ord] ?? null, session.identities[ord] ? request.catalog(session.identities[ord]!.articleId) : null, request.licencePolicy, request.referenceDate));
  const t3 = performance.now();
  const credited = new Set(request.creditedPositions);
  const inAny = new Set<number>(), inEligible = new Set<number>(), alreadyCredited = new Set<number>();
  const counts = { matches: matches.length, unique: 0, shared: 0, common: 0, withoutEligibleHolder: 0 };
  const candidates: SixwordMatch[] = [];
  for (const m of matches) {
    counts[m.commonness === "UNIQUE" ? "unique" : m.commonness === "SHARED" ? "shared" : "common"] += 1;
    const eligible = m.holders.some((h) => h.gate?.eligible);
    for (let q = m.s; q <= m.e; q += 1) { inAny.add(q); if (eligible) inEligible.add(q); if (credited.has(q)) alreadyCredited.add(q); }
    if (eligible) candidates.push(m); else counts.withoutEligibleHolder += 1;
  }
  // bounded presentation, by tier: every UNIQUE match first (longest first), then SHARED, then COMMON (capped
  // separately); every omission counted. The offset budget is spent in the same order.
  const tier = (m: SixwordMatch) => (m.commonness === "UNIQUE" ? 0 : m.commonness === "SHARED" ? 1 : 2);
  const byPriority = (a: SixwordMatch, b: SixwordMatch) => tier(a) - tier(b) || b.words - a.words || a.s - b.s;
  const notCommon = candidates.filter((m) => m.commonness !== "COMMON").sort(byPriority), common = candidates.filter((m) => m.commonness === "COMMON").sort(byPriority);
  const shownNotCommon = notCommon.slice(0, limits.maxMatchesShown);
  const shownCommon = common.slice(0, Math.max(0, Math.min(limits.maxCommonShown, limits.maxMatchesShown - shownNotCommon.length)));
  const shown = [...shownNotCommon, ...shownCommon];
  const sources: SixwordOverlapResponse["sources"] = {};
  // character offsets: re-verified on the generation text, for at most maxOffsetArticles articles inside the budget
  const offsetArticles = new Set<string>(), cache = new Map();
  let withoutChars = 0, withHoldersOmitted = 0;
  const out: SixwordOverlapMatch[] = [];
  for (const m of shown) {
    const eligible = m.holders.filter((h) => h.gate?.eligible).map((h) => ({ h, e: request.catalog(session.identities[h.ord]!.articleId)! }))
      .sort((x, y) => String(x.e.publicationDate ?? "9999").localeCompare(String(y.e.publicationDate ?? "9999")) || Number(x.e.articleId) - Number(y.e.articleId));
    const ineligible: SixwordOverlapMatch["ineligibleHolders"] = {};
    for (const h of m.holders) if (!h.gate?.eligible && h.gate?.reason) ineligible[h.gate.reason as SixwordGateReason] = (ineligible[h.gate.reason as SixwordGateReason] ?? 0) + 1;
    const listed = eligible.slice(0, limits.maxHoldersShown);
    if (eligible.length > listed.length) withHoldersOmitted += 1;
    const holders: SixwordOverlapHolder[] = [];
    for (const { h, e } of listed) {
      let chars: { sourceCharStart: number; sourceCharEnd: number } | null = null;
      const allowed = offsetArticles.has(h.docId) || (offsetArticles.size < limits.maxOffsetArticles && performance.now() < deadlineAt);
      if (allowed) {
        offsetArticles.add(h.docId);
        chars = await holderOffsets(request.fetchText, (t) => tokenSpans(t, 2), (t) => tokensForScoringNormalization(t, 2), h, words.slice(m.s, m.e + 1), cache);
      }
      if (!chars) withoutChars += 1;
      const sourceId = `asjp:${e.articleId}`;
      sources[sourceId] ??= { sourceId, articleId: e.articleId, title: e.title ?? null, journal: e.journal ?? null, publicationDate: e.publicationDate ?? null, canonicalUrl: e.canonicalUrl ?? null };
      holders.push({ sourceId, sourceWordStart: h.p, sourceWordEnd: h.q, sourceCharStart: chars?.sourceCharStart ?? null, sourceCharEnd: chars?.sourceCharEnd ?? null, occurrences: h.occurrences });
    }
    let laneWords = 0; for (let q = m.s; q <= m.e; q += 1) if (credited.has(q)) laneWords += 1;
    out.push({
      submittedWordStart: m.s, submittedWordEnd: m.e, words: m.words, band: m.band, scored: false, originEstablished: false,
      commonness: m.commonness, holdersInIndex: m.holderCount, eligibleHolders: eligible.length, holders, holdersOmitted: eligible.length - listed.length, ineligibleHolders: ineligible,
      wordsAlreadyCreditedByLane: laneWords, labels: { form: m.features.form, legal: m.features.legal, religious: m.features.religious },
    });
  }
  out.sort((a, b) => a.submittedWordStart - b.submittedWordStart || a.submittedWordEnd - b.submittedWordEnd);
  const t4 = performance.now();
  return {
    contract: ASJP_SIXWORD_CONTRACT_VERSION, state: "COMPLETE", reason: null, scored: false, label: ASJP_SIXWORD_OVERLAP_LABEL, pins, wordCount: words.length,
    summary: { ...counts, wordsInAnyMatch: inAny.size, wordsInEligibleMatch: inEligible.size, wordsAlreadyCreditedByLane: alreadyCredited.size, runs },
    matches: out,
    sources,
    truncation: { matchesOmitted: candidates.length - shown.length, commonOmitted: common.length - shownCommon.length, matchesWithHoldersOmitted: withHoldersOmitted, holdersWithoutCharOffsets: withoutChars },
    timings: { findMs: +(t1 - t0).toFixed(1), evidenceMs: +(t2 - t1).toFixed(1), gatesMs: +(t3 - t2).toFixed(1), offsetsMs: +(t4 - t3).toFixed(1), totalMs: +(t4 - t0).toFixed(1) },
  };
}
