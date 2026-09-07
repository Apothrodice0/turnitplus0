import type { ArchiveAnalysisResult } from "./archive-result-framing";

/**
 * 100k-scale architecture, slice 2G — the legacy browser archive engine,
 * isolated behind a lazy module boundary.
 *
 * This module is the ONLY runtime reference to app/similarity-worker.ts (the
 * static packed-index worker). lib/archive-analysis-runtime.ts reaches it
 * exclusively through a dynamic `import("./archive-browser-runtime")`, so
 * Turbopack code-splits the worker — plus the ~28 MB packed archive it fetches
 * — into a lazy chunk that is pulled in ONLY when the resolved engine is the
 * explicit `archiveServerSide:false` browser path. In server mode
 * (ARCHIVE_SERVER_SIDE_ENABLED=true) nothing here is imported, constructed, or
 * fetched.
 *
 * The Worker singleton and its request-id / progress plumbing were lifted
 * verbatim from lib/archive-analysis-runtime.ts (same URL, same
 * { type: "module" }, same message contract). They now live INSIDE the runner
 * instance returned by createBrowserArchiveRunner(), so a test can drop the
 * whole engine — worker and all — by discarding the runner.
 */

type ArchiveProgress = (progress: number, label: string) => void;

export interface BrowserArchiveRunner {
  /**
   * Analyse `text` against the static packed index in the similarity worker
   * and resolve with the frozen ArchiveAnalysisResult shape. Rejects with the
   * worker's error message on a worker-side failure.
   */
  run(
    text: string,
    fileName: string,
    onProgress: ArchiveProgress,
  ): Promise<ArchiveAnalysisResult>;
}

/**
 * Create a browser archive runner. The runner owns its own similarity-worker
 * singleton and monotonic request counter — the worker is constructed lazily
 * on the first run() call and reused for the life of the runner.
 */
export function createBrowserArchiveRunner(): BrowserArchiveRunner {
  let similarityWorker: Worker | null = null;
  let workerRequestId = 0;

  function getWorker(): Worker {
    similarityWorker ??= new Worker(
      new URL("../app/similarity-worker.ts", import.meta.url),
      { type: "module" },
    );
    return similarityWorker;
  }

  return {
    run(text, fileName, onProgress) {
      const worker = getWorker();
      const id = ++workerRequestId;
      return new Promise<ArchiveAnalysisResult>((resolve, reject) => {
        const handleMessage = (event: MessageEvent) => {
          if (event.data.type === "progress") {
            onProgress(event.data.progress, event.data.label);
            return;
          }
          if (event.data.id !== id) return;
          worker.removeEventListener("message", handleMessage);
          if (event.data.ok) resolve(event.data.result as ArchiveAnalysisResult);
          else reject(new Error(event.data.error));
        };
        worker.addEventListener("message", handleMessage);
        worker.postMessage({ id, text, fileName });
      });
    },
  };
}
