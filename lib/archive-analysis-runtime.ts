import type { ArchiveAnalysisResult } from "./archive-result-framing";

/**
 * 100k-scale architecture, slice 2E / 2G — the ONE place the real
 * document-analysis flow decides which archive engine runs, so ordinary
 * uploads (app/page.tsx) and room uploads
 * (app/reports/rooms/[room]/room-page-shell.tsx) — both of which go through
 * lib/document-check-pipeline.ts's analyzeText — share a single abstraction
 * instead of two server-call paths:
 *
 *              analyzeArchive(text, fileName, onProgress)
 *                    |
 *      engine === "server"   (ARCHIVE_SERVER_SIDE_ENABLED === "true")
 *                    |            -> POST /api/archive/match  (DB matcher + G1s)
 *                    |
 *      engine === "browser"  (explicit archiveServerSide:false ONLY)
 *                                 -> await import("./archive-browser-runtime")
 *                                    -> the legacy static packed-index worker
 *
 * The engine is resolved ONCE per page load from GET /api/archive/match and
 * never both run for one submission. Resolution FAILS CLOSED: only a
 * successful GET that returns a real boolean archiveServerSide picks an
 * engine (false => browser, true => server). A network failure, a non-2xx
 * response, a non-JSON body, or a missing/non-boolean archiveServerSide field
 * is AMBIGUOUS — it THROWS and archive analysis fails; it does NOT fall back
 * to "browser", and the browser runtime module is NEVER imported as a
 * consolation. (A successful resolution is memoised; a failed one is not, so
 * the next submission re-attempts discovery rather than wedging the session.)
 * When the resolved engine is "server" and the POST fails, this likewise
 * REJECTS — it does not silently fall back to the browser worker: Preview
 * testing must prove the server path actually executed, and the browser
 * engine stays one flag flip (ARCHIVE_SERVER_SIDE_ENABLED off, so the GET
 * returns false) away regardless.
 *
 * Slice 2G: the legacy browser worker — and the only reference to its module
 * URL — lives in lib/archive-browser-runtime.ts, reached ONLY through the
 * dynamic import below. This module therefore holds no static reference to
 * that worker at all, so Turbopack code-splits it (and the packed archive it
 * loads) into a lazy chunk fetched only on the explicit browser path.
 *
 * ArchiveAnalysisResult is the frozen worker-result contract
 * (lib/archive-result-framing.ts); both paths return exactly it, so
 * analyzeText's SimilarityReport mapping is engine-agnostic.
 */

import type { BrowserArchiveRunner } from "./archive-browser-runtime";

export type ArchiveEngine = "browser" | "server";

type ArchiveProgress = (progress: number, label: string) => void;

// ── browser engine (lazy module boundary — slice 2G) ───────────────────────
// lib/archive-browser-runtime.ts (and the packed archive it fetches) is
// imported on demand so it is never part of this module's static dependency
// graph. The import is kicked off ONLY from the explicit
// archiveServerSide:false path in analyzeArchive.
let browserRunnerPromise: Promise<BrowserArchiveRunner> | null = null;
let browserRuntimeRequested = false;

function getBrowserRunner(): Promise<BrowserArchiveRunner> {
  browserRuntimeRequested = true;
  browserRunnerPromise ??= import("./archive-browser-runtime").then(
    ({ createBrowserArchiveRunner }) => createBrowserArchiveRunner(),
  );
  return browserRunnerPromise;
}

// ── server engine (DB matcher via API) ─────────────────────────────────────
async function runViaServer(text: string, onProgress: ArchiveProgress): Promise<ArchiveAnalysisResult> {
  onProgress(45, "Comparing against the archive");
  const response = await fetch("/api/archive/match", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    throw new Error(`The archive comparison service returned ${response.status}.`);
  }
  const data = (await response.json().catch(() => null)) as { result?: ArchiveAnalysisResult } | null;
  if (!data || typeof data !== "object" || !data.result || typeof data.result !== "object") {
    throw new Error("The archive comparison service returned an unexpected response.");
  }
  onProgress(88, "Calculating similarity result");
  return data.result;
}

// ── engine resolution (GET /api/archive/match, fail-closed) ────────────────
let enginePromise: Promise<ArchiveEngine> | null = null;

async function discoverArchiveEngine(): Promise<ArchiveEngine> {
  const response = await fetch("/api/archive/match", { method: "GET" }).catch((cause: unknown) => {
    throw new Error("The archive engine could not be determined — the configuration request failed.", { cause });
  });
  if (!response.ok) {
    throw new Error(`The archive engine could not be determined — the configuration request returned ${response.status}.`);
  }
  const data = (await response.json().catch((cause: unknown) => {
    throw new Error("The archive engine could not be determined — the configuration response was not valid JSON.", { cause });
  })) as { archiveServerSide?: unknown };
  if (!data || typeof data !== "object" || typeof data.archiveServerSide !== "boolean") {
    throw new Error("The archive engine could not be determined — the configuration response had no archiveServerSide flag.");
  }
  return data.archiveServerSide ? "server" : "browser";
}

export function resolveArchiveEngine(): Promise<ArchiveEngine> {
  if (!enginePromise) {
    const attempt = discoverArchiveEngine();
    enginePromise = attempt;
    // Memoise only a SUCCESSFUL resolution — clear a rejection so the next
    // submission re-attempts discovery (fail closed, but not permanently
    // wedged). Never resolves to "browser" here as a fallback.
    attempt.catch(() => {
      if (enginePromise === attempt) enginePromise = null;
    });
  }
  return enginePromise;
}

/** Test-only: forget the memoised engine decision and the lazy browser runtime. Never called in production. */
export function __resetArchiveEngineForTests(): void {
  enginePromise = null;
  browserRunnerPromise = null;
  browserRuntimeRequested = false;
}

/**
 * Test-only: report whether the lazy browser runtime has been requested since
 * the last reset. Proves server / ambiguous / POST-failure paths never reach
 * the legacy worker module. Never called in production.
 */
export function __getArchiveRuntimeTestState(): { browserRuntimeRequested: boolean } {
  return { browserRuntimeRequested };
}

/**
 * Analyse `text` against the built-in archive and return the frozen
 * worker-result shape. Engine is picked once per page load; the two engines
 * never both run for one submission.
 *
 * Fail closed: if resolveArchiveEngine() throws (ambiguous mode discovery),
 * this rejects here — BEFORE getBrowserRunner() — so the browser runtime
 * module is never imported as a consolation. Only an explicit
 * archiveServerSide:false ever reaches the browser path.
 */
export async function analyzeArchive(
  text: string,
  fileName: string,
  onProgress: ArchiveProgress,
): Promise<ArchiveAnalysisResult> {
  const engine = await resolveArchiveEngine();
  if (engine === "server") {
    // No silent fallback — a server-path failure surfaces to analyzeText's
    // caller exactly like a worker failure would.
    return runViaServer(text, onProgress);
  }
  const runner = await getBrowserRunner();
  return runner.run(text, fileName, onProgress);
}
