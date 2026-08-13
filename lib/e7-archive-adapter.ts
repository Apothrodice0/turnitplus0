/**
 * Phase E7 (calibration/observation pilot against the 230-document archive,
 * not part of the E1-E6D provenance/discovery module family): read-only
 * archive adapter.
 *
 * This module only reads:
 *   - public/data/document-index.meta.json (the shipped browser search
 *     index: id/title/sourceType/originalSimilarity/wordCount/
 *     uniqueShingleCount for all 230 archive documents)
 *   - corpus/manifest.json + the text file it points to, if and only if a
 *     corpus/ tree happens to exist locally (it is gitignored and, as of
 *     this phase, absent from this checkout entirely)
 *
 * It never writes to either location, never modifies document-index*
 * files, never modifies corpus/ contents, and never fabricates text: if a
 * document's full text cannot be located, resolveArchiveDocumentText
 * returns a TEXT_UNAVAILABLE result instead of substituting the title,
 * score, or any other metadata as a stand-in for body text.
 *
 * One documented exception to "read the literal manifest textPath": two
 * archive titles contain a ':', which the manifest (built where ':' is a
 * legal filename character) still records literally, but which Windows
 * cannot store — the actual file on a Windows corpus/ tree has '_' in its
 * place. resolveArchiveDocumentText tries the literal path first and only
 * falls back to the ':' -> '_' substitution when the literal path is
 * missing AND the manifest textPath actually contains a ':'; the result is
 * still only accepted if it passes the manifest's sha256 check (or
 * rejected outright if the manifest has no sha256 to check it against) —
 * never accepted on filename similarity alone.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

export type ArchiveDocumentMetadata = {
  id: string;
  title: string;
  sourceType: string;
  originalSimilarity: number | null;
  wordCount: number;
  uniqueShingleCount: number;
};

export type ArchiveIndexMeta = {
  corpusVersion: string;
  documentCount: number;
  articles: ArchiveDocumentMetadata[];
};

const DEFAULT_INDEX_META_PATH = "public/data/document-index.meta.json";
const DEFAULT_CORPUS_ROOT = "corpus";

/** Read-only. Throws if the index is missing or internally inconsistent — never invents a document count. */
export function loadArchiveIndexMeta(indexMetaPath: string = DEFAULT_INDEX_META_PATH): ArchiveIndexMeta {
  const raw = readFileSync(indexMetaPath, "utf8");
  const meta = JSON.parse(raw) as {
    schema?: string;
    documentCount?: number;
    corpusVersion?: string;
    articles?: ArchiveDocumentMetadata[];
  };
  if (meta.schema !== "tplus-packed-search-index") {
    throw new Error(`Unexpected archive index schema at ${indexMetaPath}: ${String(meta.schema)}`);
  }
  if (!Array.isArray(meta.articles) || meta.articles.length !== meta.documentCount) {
    throw new Error(`Archive index at ${indexMetaPath} is internally inconsistent (documentCount vs articles.length).`);
  }
  return { corpusVersion: meta.corpusVersion ?? "unknown", documentCount: meta.documentCount!, articles: meta.articles };
}

export function findArchiveDocumentMetadata(
  articles: ArchiveDocumentMetadata[],
  id: string,
): ArchiveDocumentMetadata | null {
  return articles.find((a) => a.id === id) ?? null;
}

export type ArchiveAdapterResult =
  | { status: "TEXT_AVAILABLE"; metadata: ArchiveDocumentMetadata; submittedText: string; textSource: string }
  | { status: "TEXT_UNAVAILABLE"; metadata: ArchiveDocumentMetadata; reason: string };

type MinimalManifestEntry = {
  id: string;
  roles?: string[];
  textPath?: string;
  provenance?: { sha256?: string | null };
};

/**
 * Attempts to resolve an archive document's full text via a local
 * corpus/manifest.json + its referenced text file, if present. This is a
 * deliberately minimal, standalone reader (it does not import
 * tools/calibration-utils.ts's full manifest validator, which enforces
 * many unrelated corpus-building rules for other roles like ai-negative;
 * a read-only E7 lookup for one index-source document should not be able
 * to fail because of an unrelated validation rule elsewhere in the
 * manifest). Never writes anything. Never substitutes title/score/word
 * count for missing text.
 */
export function resolveArchiveDocumentText(
  metadata: ArchiveDocumentMetadata,
  corpusRoot: string = DEFAULT_CORPUS_ROOT,
): ArchiveAdapterResult {
  const manifestPath = join(corpusRoot, "manifest.json");
  if (!existsSync(manifestPath)) {
    return { status: "TEXT_UNAVAILABLE", metadata, reason: `no corpus manifest present at ${manifestPath} in this environment` };
  }

  let manifest: MinimalManifestEntry[];
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("manifest.json is not an array");
    manifest = parsed as MinimalManifestEntry[];
  } catch (error) {
    return {
      status: "TEXT_UNAVAILABLE",
      metadata,
      reason: `corpus manifest at ${manifestPath} could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const entry = manifest.find((e) => e && e.id === metadata.id && Array.isArray(e.roles) && e.roles.includes("index-source"));
  if (!entry) {
    return { status: "TEXT_UNAVAILABLE", metadata, reason: `no index-source manifest entry for document id ${metadata.id}` };
  }
  if (!entry.textPath) {
    return { status: "TEXT_UNAVAILABLE", metadata, reason: `manifest entry for ${metadata.id} has no textPath` };
  }

  const corpusRootResolved = resolve(corpusRoot);

  function resolveWithinCorpus(relativeTextPath: string): string | null {
    const candidate = resolve(corpusRoot, relativeTextPath);
    if (!candidate.startsWith(corpusRootResolved)) return null; // path-escape guard
    return candidate;
  }

  const literalPath = resolveWithinCorpus(entry.textPath);
  if (!literalPath) {
    return { status: "TEXT_UNAVAILABLE", metadata, reason: `manifest textPath for ${metadata.id} escapes the corpus root; refusing to read it` };
  }

  // The manifest is built on a filesystem where ':' is a legal filename
  // character; Windows is not one of them. When the literal path is
  // missing AND the manifest's own textPath contains a ':', try the single
  // documented substitution Windows itself forces on write (':' -> '_') —
  // never a fuzzy/best-effort filename match, and never accepted without
  // the sha256 check below still passing. Any other missing-file case (no
  // colon involved) does not get a fallback attempt at all.
  let textFilePath = literalPath;
  let usedWindowsColonFallback = false;
  if (!existsSync(textFilePath) && entry.textPath.includes(":")) {
    const fallbackPath = resolveWithinCorpus(entry.textPath.replace(/:/g, "_"));
    if (fallbackPath && existsSync(fallbackPath)) {
      textFilePath = fallbackPath;
      usedWindowsColonFallback = true;
    }
  }

  if (!existsSync(textFilePath)) {
    return {
      status: "TEXT_UNAVAILABLE",
      metadata,
      reason: `text file for ${metadata.id} not found at ${entry.textPath}${entry.textPath.includes(":") ? " (Windows ':' -> '_' fallback also not found)" : ""}`,
    };
  }

  const expectedSha256 = entry.provenance?.sha256;
  if (usedWindowsColonFallback && !expectedSha256) {
    // Never silently accept a fallback-resolved file based on filename
    // similarity alone — a fallback match requires hash confirmation.
    return {
      status: "TEXT_UNAVAILABLE",
      metadata,
      reason: `text file for ${metadata.id} resolved only via the Windows ':' fallback path, and the manifest has no sha256 to verify it against; refusing to accept on filename similarity alone`,
    };
  }

  const text = readFileSync(textFilePath, "utf8");
  if (expectedSha256) {
    const actualSha256 = createHash("sha256").update(text, "utf8").digest("hex");
    if (actualSha256 !== expectedSha256) {
      return {
        status: "TEXT_UNAVAILABLE",
        metadata,
        reason: `text file for ${metadata.id} failed integrity check (sha256 mismatch against manifest provenance)${usedWindowsColonFallback ? " [resolved via Windows ':' fallback path]" : ""}`,
      };
    }
  }

  return { status: "TEXT_AVAILABLE", metadata, submittedText: text, textSource: textFilePath };
}
