import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SelectiveCorpusArtifact, SelectiveCorpusDoc } from "./artifact";
import { getSelectiveCorpusFixturePath } from "./config";
import { SELECTIVE_CORPUS_SOURCE_TEXT_LRU } from "./constants";

/**
 * Selective Corpus V1 SHADOW slice — lazy candidate source-text loader.
 *
 * NEVER loads the whole corpus. Reads ONE raw/<docId>.txt per candidate,
 * behind a small LRU (SELECTIVE_CORPUS_SOURCE_TEXT_LRU) so re-evaluating the
 * same submission (a repeat report view) does not re-read from disk. A
 * docmap rawId of the form "bulk:<docId>" resolves to
 * <artifactPath>/raw/<docId>.txt; "fixture:<docId>" resolves under
 * SELECTIVE_CORPUS_FIXTURE_PATH (regression only) and is skipped in every
 * non-regression context.
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

export function loadSelectiveCorpusCandidateText(
  artifact: SelectiveCorpusArtifact,
  ordinal: number,
): SelectiveCorpusCandidateText | null {
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
  let file: string | null = null;
  if (kind === "bulk") {
    file = join(artifact.artifactPath, "raw", `${id}.txt`);
  } else if (kind === "fixture") {
    const fx = getSelectiveCorpusFixturePath();
    if (!fx) return null; // fixtures unavailable outside regression
    file = join(fx, "families", doc.family, `${id}.txt`);
  } else {
    return null;
  }
  if (!file || !existsSync(file)) return null;

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
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
