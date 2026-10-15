/**
 * ASJP evidence for a TurnitPlus report (LOCAL PROTOTYPE; behind ASJP_REPORT_EVIDENCE_ENABLED, default off).
 *
 * The matching service answers with the lane's verified passages (`asjpPublicationEvidence`, the exact shape
 * computeUnifiedSimilarity's ASJP channel takes) and the source cards (title, journal, date, DOI, canonical ASJP URL,
 * licence, PREVIOUSLY_PUBLISHED_WORK / SELF_OVERLAP_SAME_AUTHORS / QUOTES_PRIMARY_SOURCE / ... attribution, labels).
 * This module turns an answer into the report channel, and refuses anything it cannot trust:
 *   - only state COMPLETE from the PINNED generation (generationId + logicalManifestSha256 the report path expects)
 *   - passages clamped to the manuscript's word count; a passage outside it is dropped, never moved
 *   - anything else (flag off, service down, busy, timeout, failed, wrong generation) -> null and a reason: the report
 *     is computed exactly as without ASJP, marked "ASJP check unavailable"
 * Union scoring is computeUnifiedSimilarity's own: a word ASJP shares with another channel counts once (overlap), and
 * asjpPublicationPositions lists only the words no other channel holds, so a highlight is never double counted.
 * Persisting: the report must store the accepted channel (with its pins) and pass THE SAME stored evidence to every
 * later recompute (refresh, self-heal, Selective finalization) — a recompute must never drop or re-query it silently.
 */
export type AsjpServiceAnswer = {
  state: string; failureCode?: string | null; wordCount?: number | null; generationId?: string; logicalManifestSha256?: string; laneVersion?: string; catalogLoadedAt?: string;
  asjpPublicationEvidence?: Array<{ sourceId: string; matchedPassages: Array<{ submittedWordStart: number; submittedWordEnd: number; matchedWordCount: number }> }>;
  cards?: Array<Record<string, unknown>>;
};
export type AsjpReportEvidence = {
  asjpPublicationEvidence: NonNullable<AsjpServiceAnswer["asjpPublicationEvidence"]>; cards: NonNullable<AsjpServiceAnswer["cards"]>;
  pins: { generationId: string; logicalManifestSha256: string; laneVersion: string | null; catalogLoadedAt: string | null };
};
export type AsjpReportEvidenceDecision = { evidence: AsjpReportEvidence | null; status: "INCLUDED" | "DISABLED" | "UNAVAILABLE"; reason: string | null };

export function asjpReportEvidenceEnabled(env: Record<string, string | undefined> = process.env): boolean { return env.ASJP_REPORT_EVIDENCE_ENABLED === "true"; }

export function acceptAsjpAnswer(answer: AsjpServiceAnswer | null | undefined, expected: { generationId: string; logicalManifestSha256: string; wordCount: number }, enabled = asjpReportEvidenceEnabled()): AsjpReportEvidenceDecision {
  if (!enabled) return { evidence: null, status: "DISABLED", reason: null };
  if (!answer) return { evidence: null, status: "UNAVAILABLE", reason: "NO_ANSWER" };
  if (answer.state !== "COMPLETE") return { evidence: null, status: "UNAVAILABLE", reason: answer.failureCode ?? answer.state };
  if (answer.generationId !== expected.generationId || answer.logicalManifestSha256 !== expected.logicalManifestSha256) return { evidence: null, status: "UNAVAILABLE", reason: "GENERATION_MISMATCH" };
  if (answer.wordCount != null && answer.wordCount !== expected.wordCount) return { evidence: null, status: "UNAVAILABLE", reason: "WORD_COUNT_MISMATCH" };
  const evidence = (answer.asjpPublicationEvidence ?? []).map((s) => ({
    sourceId: s.sourceId,
    matchedPassages: s.matchedPassages.filter((p) => p.submittedWordStart >= 0 && p.submittedWordEnd >= p.submittedWordStart && p.submittedWordEnd < expected.wordCount),
  })).filter((s) => s.matchedPassages.length > 0);
  return { evidence: { asjpPublicationEvidence: evidence, cards: answer.cards ?? [], pins: { generationId: answer.generationId!, logicalManifestSha256: answer.logicalManifestSha256!, laneVersion: answer.laneVersion ?? null, catalogLoadedAt: answer.catalogLoadedAt ?? null } }, status: "INCLUDED", reason: null };
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
