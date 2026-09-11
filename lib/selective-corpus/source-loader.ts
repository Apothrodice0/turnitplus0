import type { SelectiveCorpusArtifact, SelectiveCorpusDoc } from "./artifact";
import { getSelectiveCorpusFixturePath } from "./config";
import { SELECTIVE_CORPUS_SOURCE_TEXT_LRU } from "./constants";
import { createLocalFilesystemStorageAdapter, SelectiveCorpusObjectNotFoundError } from "./storage-adapter";

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
 */

const lru = new Map<string, string>(); // "<artifactPath>|<ordinal>" -> text

export type SelectiveCorpusCandidateText = {
  doc: SelectiveCorpusDoc;
  text: string;
};

function bareId(rawId: string): { kind: "bulk" | "fixture" | "other"; id: string } {
  if (rawId.startsWith("bulk:")) return { kind: "bulk", id: rawId.slice(5) };
  if (rawId.startsWith("fixture:")) return { kind: "fixture", id: rawId.slice(8) };
  return { kind: "other", id: rawId };
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

  const { kind, id } = bareId(doc.rawId);
  let text: string;
  if (kind === "bulk") {
    try {
      const bytes = await artifact.storage.readObject(`raw/${id}.txt`);
      text = Buffer.from(bytes).toString("utf8");
    } catch {
      return null;
    }
  } else if (kind === "fixture") {
    const fx = getSelectiveCorpusFixturePath();
    if (!fx) return null; // fixtures unavailable outside regression
    try {
      const fixtureStorage = createLocalFilesystemStorageAdapter(fx);
      const bytes = await fixtureStorage.readObject(`families/${doc.family}/${id}.txt`);
      text = Buffer.from(bytes).toString("utf8");
    } catch (err) {
      if (err instanceof SelectiveCorpusObjectNotFoundError) return null;
      return null; // any other read failure also degrades to "candidate skipped", unchanged from before
    }
  } else {
    return null;
  }

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
