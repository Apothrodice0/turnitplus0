// ASJP matching service — one worker process: a pinned lane session, the in-memory catalog snapshot, the prepared lane
// tokens. Configuration arrives as JSON in ASJP_WORKER_CONFIG (never a credential). Messages: {type:"match", id, text,
// title?, referenceDate?} -> {type:"result", id, ...}; {type:"refresh-catalog", id} -> {type:"refreshed", id, ok}.
import { createHash } from "node:crypto";
import { LocalDirectoryObjectStore } from "../../lib/corpus-engine/storage";
import { asjpPublicationEvidenceOf, asjpSourceCards, openAsjpLaneSession, runAsjpAcademicLane, ASJP_ACADEMIC_LANE_VERSION, type AsjpLaneSource, type AsjpMatchingCorrections } from "../../lib/asjp-academic-lane";
import { AsjpCatalogSource } from "../../lib/asjp-catalog-snapshot";
import { asjpShortPassageSignal, loadWordDf, type WordDf } from "../../lib/asjp-short-passages";

export type AsjpWorkerConfig = {
  root: string; generationId: string; logicalManifestSha256: string; catalogPath: string; catalogImmutable: boolean;
  laneTokensDir?: string; numericIndexDir?: string; licencePolicy: "permitted-only" | "local-research-all"; corrections?: AsjpMatchingCorrections;
  /**
   * Phase 6.5 — independent feature flags, decided by the service from its own environment (never by a request):
   *   numericTables  the number-table candidate path (ASJP_NUMERIC_TABLES_ENABLED; needs numericIndexDir)
   *   shortSignal    the UNSCORED 25–59-word research signal (ASJP_SHORT_SIGNAL_ENABLED; needs the word-df table)
   * Both default off. The answer reports which were on, so a report pins them.
   */
  features?: { numericTables?: boolean; shortSignal?: { wordDfPath: string } | null };
};

/** The digest of an answer: what a golden query must reproduce exactly. */
export function answerDigest(r: { state?: string; creditedPositions?: number[]; cards?: unknown }): string {
  return createHash("sha256").update(JSON.stringify([r.state, r.creditedPositions ?? [], r.cards ?? []])).digest("hex");
}

/** Sources the short signal may name: those that passed identity, catalog, takedown, licence and publication-date gates. */
const SIGNAL_EXCLUDED = new Set(["UNVERIFIED_SOURCE_IDENTITY", "NOT_IN_CATALOG", "LICENCE_NOT_PERMITTING", "WITHDRAWN", "PUBLISHED_AFTER_REFERENCE_DATE", "PUBLICATION_DATE_UNCERTAIN"]);

async function main() {
  const config = JSON.parse(process.env.ASJP_WORKER_CONFIG ?? "{}") as AsjpWorkerConfig;
  if (!config.logicalManifestSha256) throw new Error("a serving worker requires a pinned logicalManifestSha256");
  const numericTables = config.features?.numericTables === true && !!config.numericIndexDir;
  const shortSignal = !!config.features?.shortSignal?.wordDfPath && !!config.laneTokensDir;
  const store = new LocalDirectoryObjectStore(config.root);
  const session = await openAsjpLaneSession({ store, generationId: config.generationId, logicalManifestSha256: config.logicalManifestSha256, useDerivedSourceSidecar: true, laneTokensDir: config.laneTokensDir, numericIndexDir: numericTables ? config.numericIndexDir : undefined });
  const catalog = await AsjpCatalogSource.open(config.catalogPath, { immutable: config.catalogImmutable });
  const wordDf: WordDf | null = shortSignal ? loadWordDf(config.features!.shortSignal!.wordDfPath) : null;
  const corrections: AsjpMatchingCorrections = { ...config.corrections, numericTables };
  const features = { numericTables, shortSignal };
  const send = (m: unknown) => process.send?.(m);
  send({ type: "ready", pid: process.pid, generationId: config.generationId, laneVersion: ASJP_ACADEMIC_LANE_VERSION, catalogEntries: catalog.current.entries.size, catalogLoadedAt: catalog.current.loadedAt, catalogDigest: catalog.current.digest, features });
  process.on("message", async (m: any) => {
    if (m?.type === "refresh-catalog") { const ok = await catalog.refresh(); send({ type: "refreshed", id: m.id, ok, error: catalog.lastRefreshError, loadedAt: catalog.current.loadedAt, catalogDigest: catalog.current.digest }); return; }
    if (m?.type !== "match") return;
    const t0 = performance.now();
    try {
      // one catalog snapshot for the whole answer: a refresh swapping in mid-query cannot mix two catalog states
      const snapshot = catalog.current;
      // B3 (Phase 7 remediation): the report's withdrawn articles are treated exactly like catalog-withdrawn ones, so the
      // lane never credits them and can still credit any other article for the same words
      const excluded = new Set<string>(Array.isArray(m.excludeSourceIds) ? m.excludeSourceIds : []);
      const lookup = (articleId: string) => { const e = snapshot.entries.get(articleId) ?? null; return e && excluded.has(`asjp:${articleId}`) ? { ...e, withdrawn: true } : e; };
      // the lane's own flag gate is enforced by the service (ASJP_SERVICE_ENABLED), so the worker passes ignoreFlag
      const r: any = await runAsjpAcademicLane({ store, generationId: config.generationId, logicalManifestSha256: config.logicalManifestSha256, submissionText: m.text, submissionTitle: m.title ?? null, referenceDate: m.referenceDate ?? undefined, catalog: lookup, ignoreFlag: true, licencePolicy: config.licencePolicy, corrections, session });
      const cards = r.state === "COMPLETE" ? asjpSourceCards(r) : [];
      const out = { state: r.state, failureCode: (r as any).failureCode ?? null, wordCount: r.submissionWordCount ?? null, creditedPositions: r.creditedPositions ?? [], asjpPublicationEvidence: r.state === "COMPLETE" ? asjpPublicationEvidenceOf(r) : [], cards };
      // UNSCORED research signal: outside the digest and outside the evidence; never scored by a report
      let research: unknown = undefined;
      if (shortSignal && wordDf && r.state === "COMPLETE") {
        const eligible = (r.sources as AsjpLaneSource[]).filter((s) => s.publication && !SIGNAL_EXCLUDED.has(String(s.notCreditedReason)));
        const signal = await asjpShortPassageSignal({ reader: session.reader, laneTokens: session.laneTokens!, wordDf, submissionText: m.text, candidates: eligible.map((s) => ({ sourceId: s.sourceId, docId: s.docId })), creditedPositions: r.creditedPositions });
        const meta = new Map(eligible.map((s) => [s.sourceId, s.publication!]));
        research = { shortPassages: { ...signal, passages: signal.passages.map((p) => ({ ...p, title: meta.get(p.sourceId)?.title ?? null, url: meta.get(p.sourceId)?.canonicalUrl ?? null, journal: meta.get(p.sourceId)?.journal ?? null })) } };
      }
      send({ type: "result", id: m.id, ...out, digest: answerDigest(out), generationId: config.generationId, logicalManifestSha256: config.logicalManifestSha256, laneVersion: ASJP_ACADEMIC_LANE_VERSION, licencePolicy: config.licencePolicy, normalization: 2, catalogLoadedAt: snapshot.loadedAt, catalogDigest: snapshot.digest, features, ...(research ? { research } : {}), workerMs: Math.round(performance.now() - t0), laneTimings: r.timings ?? null, rssMb: Math.round(process.memoryUsage().rss / 1048576) });
    } catch (error) {
      // no-leak: a code only, never the exception message (it could quote input)
      send({ type: "result", id: m.id, state: "FAILED", failureCode: "WORKER_EXCEPTION" });
    }
  });
}
// review E3: an unexpected error never prints a stack (which could quote input) — a code only, then the pool replaces the worker
process.on("unhandledRejection", () => { process.send?.({ type: "fatal", error: "UNHANDLED_REJECTION" }); process.exit(1); });
process.on("uncaughtException", () => { process.send?.({ type: "fatal", error: "UNCAUGHT_EXCEPTION" }); process.exit(1); });
main().catch((error) => { process.send?.({ type: "fatal", error: String(error?.message ?? error) }); process.exit(1); });
