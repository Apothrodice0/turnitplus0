// ASJP matching service — one worker process: a pinned lane session, the in-memory catalog snapshot, the prepared lane
// tokens. Configuration arrives as JSON in ASJP_WORKER_CONFIG. Messages: {type:"match", id, text, title?,
// referenceDate?} -> {type:"result", id, ...}; {type:"refresh-catalog", id} -> {type:"refreshed", id, ok}.
import { createHash } from "node:crypto";
import { LocalDirectoryObjectStore } from "../../lib/corpus-engine/storage";
import { asjpPublicationEvidenceOf, asjpSourceCards, openAsjpLaneSession, runAsjpAcademicLane, ASJP_ACADEMIC_LANE_VERSION, type AsjpMatchingCorrections } from "../../lib/asjp-academic-lane";
import { AsjpCatalogSource } from "../../lib/asjp-catalog-snapshot";

export type AsjpWorkerConfig = {
  root: string; generationId: string; logicalManifestSha256: string; catalogPath: string; catalogImmutable: boolean;
  laneTokensDir?: string; numericIndexDir?: string; licencePolicy: "permitted-only" | "local-research-all"; corrections?: AsjpMatchingCorrections;
};

/** The digest of an answer: what a golden query must reproduce exactly. */
export function answerDigest(r: { state?: string; creditedPositions?: number[]; cards?: unknown }): string {
  return createHash("sha256").update(JSON.stringify([r.state, r.creditedPositions ?? [], r.cards ?? []])).digest("hex");
}

async function main() {
  const config = JSON.parse(process.env.ASJP_WORKER_CONFIG ?? "{}") as AsjpWorkerConfig;
  if (!config.logicalManifestSha256) throw new Error("a serving worker requires a pinned logicalManifestSha256");
  const store = new LocalDirectoryObjectStore(config.root);
  const session = await openAsjpLaneSession({ store, generationId: config.generationId, logicalManifestSha256: config.logicalManifestSha256, useDerivedSourceSidecar: true, laneTokensDir: config.laneTokensDir, numericIndexDir: config.numericIndexDir });
  const catalog = await AsjpCatalogSource.open(config.catalogPath, { immutable: config.catalogImmutable });
  const send = (m: unknown) => process.send?.(m);
  send({ type: "ready", pid: process.pid, generationId: config.generationId, laneVersion: ASJP_ACADEMIC_LANE_VERSION, catalogEntries: catalog.current.entries.size, catalogLoadedAt: catalog.current.loadedAt });
  process.on("message", async (m: any) => {
    if (m?.type === "refresh-catalog") { const ok = await catalog.refresh(); send({ type: "refreshed", id: m.id, ok, error: catalog.lastRefreshError, loadedAt: catalog.current.loadedAt }); return; }
    if (m?.type !== "match") return;
    const t0 = performance.now();
    try {
      // the lane's own flag gate is enforced by the service (ASJP_SERVICE_ENABLED), so the worker passes ignoreFlag
      const r: any = await runAsjpAcademicLane({ store, generationId: config.generationId, logicalManifestSha256: config.logicalManifestSha256, submissionText: m.text, submissionTitle: m.title ?? null, referenceDate: m.referenceDate ?? undefined, catalog: catalog.entry, ignoreFlag: true, licencePolicy: config.licencePolicy, corrections: config.corrections, session });
      const cards = r.state === "COMPLETE" ? asjpSourceCards(r) : [];
      const out = { state: r.state, failureCode: (r as any).failureCode ?? null, wordCount: r.submissionWordCount ?? null, creditedPositions: r.creditedPositions ?? [], asjpPublicationEvidence: r.state === "COMPLETE" ? asjpPublicationEvidenceOf(r) : [], cards };
      send({ type: "result", id: m.id, ...out, digest: answerDigest(out), generationId: config.generationId, logicalManifestSha256: config.logicalManifestSha256, laneVersion: ASJP_ACADEMIC_LANE_VERSION, catalogLoadedAt: catalog.current.loadedAt, workerMs: Math.round(performance.now() - t0), laneTimings: r.timings ?? null });
    } catch (error) {
      send({ type: "result", id: m.id, state: "FAILED", failureCode: "WORKER_EXCEPTION", failureMessage: String((error as Error)?.message ?? error) });
    }
  });
}
main().catch((error) => { process.send?.({ type: "fatal", error: String(error?.message ?? error) }); process.exit(1); });
