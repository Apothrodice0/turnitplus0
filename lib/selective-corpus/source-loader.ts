import type { SelectiveCorpusArtifact, SelectiveCorpusDoc } from "./artifact";
import { getSelectiveCorpusFixturePath } from "./config";
import { SELECTIVE_CORPUS_SOURCE_TEXT_LRU } from "./constants";
import { createLocalFilesystemStorageAdapter } from "./storage-adapter";

/**
 * Selective Corpus V1 SHADOW slice — lazy candidate source-text loader.
 *
 * NEVER loads the whole corpus. Reads ONE raw/<docId>.txt per candidate,
 * behind a small LRU (SELECTIVE_CORPUS_SOURCE_TEXT_LRU) so re-evaluating the
 * same submission (a repeat report view) does not re-read from disk. A
 * docmap rawId of the form "bulk:<docId>" resolves through the artifact's
 * OWN storage adapter (the same one artifact.ts / shard-reader.ts already
 * use) at the key "raw/<docId>.txt"; "fixture:<docId>" resolves under
 * SELECTIVE_CORPUS_FIXTURE_PATH (regression only) via a throwaway local
 * adapter scoped to that separate root — constructed fresh per call, exactly
 * as the fixture path itself was already read fresh (uncached) per call
 * before this conversion — and is skipped in every non-regression context.
 *
 * Concurrency hardening: the LRU cache-miss check happens before an awaited
 * storage read, so two callers racing on the SAME candidate could otherwise
 * each independently start a read of the same source file. inFlightLoads
 * below de-dupes that down to one physical read, the same pattern
 * shard-reader.ts's own inFlightLoads map uses for the same reason.
 */

const lru = new Map<string, string>(); // "<artifactPath>|<ordinal>" -> text
const inFlightLoads = new Map<string, Promise<string | null>>();

export type SelectiveCorpusCandidateText = {
  doc: SelectiveCorpusDoc;
  text: string;
};

function bareId(rawId: string): { kind: "bulk" | "fixture" | "other"; id: string } {
  if (rawId.startsWith("bulk:")) return { kind: "bulk", id: rawId.slice(5) };
  if (rawId.startsWith("fixture:")) return { kind: "fixture", id: rawId.slice(8) };
  return { kind: "other", id: rawId };
}

/** The actual read+decode for one candidate, executed exactly once per
 *  physical load no matter how many concurrent loadSelectiveCorpusCandidateText()
 *  callers are waiting on it (see inFlightLoads above). Returns null for
 *  every failure mode — missing file, unreadable, fixtures unavailable —
 *  exactly the "candidate skipped" degradation this module always had;
 *  never throws. */
async function loadCandidateTextUncached(
  artifact: SelectiveCorpusArtifact,
  doc: SelectiveCorpusDoc,
): Promise<string | null> {
  const { kind, id } = bareId(doc.rawId);
  if (kind === "bulk") {
    try {
      const bytes = await artifact.storage.readObject(`raw/${id}.txt`);
      return Buffer.from(bytes).toString("utf8");
    } catch {
      return null;
    }
  }
  if (kind === "fixture") {
    const fx = getSelectiveCorpusFixturePath();
    if (!fx) return null; // fixtures unavailable outside regression
    try {
      const fixtureStorage = createLocalFilesystemStorageAdapter(fx);
      const bytes = await fixtureStorage.readObject(`families/${doc.family}/${id}.txt`);
      return Buffer.from(bytes).toString("utf8");
    } catch {
      return null;
    }
  }
  return null;
}

export async function loadSelectiveCorpusCandidateText(
  artifact: SelectiveCorpusArtifact,
  ordinal: number,
): Promise<SelectiveCorpusCandidateText | null> {
  const doc = artifact.docByOrdinal[ordinal];
  if (!doc) return null;

  const key = `${artifact.artifactPath}|${ordinal}`;
  const cached = lru.get(key);
  if (cached !== undefined) {
    // refresh LRU recency
    lru.delete(key);
    lru.set(key, cached);
    return { doc, text: cached };
  }

  let text: string | null;
  const existing = inFlightLoads.get(key);
  if (existing) {
    text = await existing;
  } else {
    const promise = loadCandidateTextUncached(artifact, doc);
    inFlightLoads.set(key, promise);
    try {
      text = await promise;
    } finally {
      // Runs on both success and null-on-failure: a successful result is
      // cached into `lru` below, so the next call is a genuine cache hit; a
      // missing/failed load must not permanently block a later retry (e.g.
      // if the underlying source later becomes available).
      inFlightLoads.delete(key);
    }
  }

  if (text === null) return null;

  lru.set(key, text);
  if (lru.size > SELECTIVE_CORPUS_SOURCE_TEXT_LRU) {
    const oldest = lru.keys().next().value as string | undefined;
    if (oldest !== undefined) lru.delete(oldest);
  }
  return { doc, text };
}

export function clearSelectiveCorpusSourceCache(): void {
  lru.clear();
}
