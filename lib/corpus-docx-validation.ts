import JSZip from "jszip";
import type { CorpusAdmissionLimits, CorpusHardGateCode } from "./corpus-admission-types";
import { DEFAULT_CORPUS_ADMISSION_LIMITS } from "./corpus-admission-types";

/**
 * Real OOXML/ZIP structural validation for corpus-admission DOCX
 * candidates — goes well beyond lib/corpus-file-validation.ts's magic-byte
 * check. Reads JSZip's central-directory metadata (uncompressedSize/
 * compressedSize, available on every entry immediately after loadAsync(),
 * before any entry is actually inflated) to bound zip-bomb risk BEFORE any
 * full decompression happens. Runs inside lib/corpus-extraction-worker.ts's
 * isolated worker-thread boundary, not in the main process, for the same
 * reason text extraction does — parsing untrusted archive structure is
 * itself part of "parsing untrusted file content."
 *
 * Uses jszip's own internal `_data.uncompressedSize`/`_data.compressedSize`
 * fields (not part of its public TypeScript surface, but the standard,
 * widely-used way to read central-directory size metadata without forcing
 * a full inflate) — accessed defensively: a missing/non-numeric value is
 * treated as a validation failure (fail closed), never silently skipped.
 */

export const CORPUS_DOCX_VALIDATION_VERSION = "corpus-docx-validation-v1";

const DANGEROUS_EMBEDDED_EXTENSIONS = new Set(["exe", "dll", "scr", "bat", "cmd", "vbs", "js", "jar", "msi", "ps1"]);
const MACRO_CONTENT_TYPE_MARKER = "macroEnabled";
const TRAVERSAL_PATTERN = /(^|\/)\.\.(\/|$)/;
const ABSOLUTE_OR_DRIVE_PATTERN = /^\/|^[A-Za-z]:/;

export type CorpusDocxValidationResult =
  | { ok: true }
  | { ok: false; reasonCode: CorpusHardGateCode; detail: string };

type JsZipInternalEntry = { dir: boolean; name: string; _data?: { uncompressedSize?: unknown; compressedSize?: unknown } };

function entrySize(entry: JsZipInternalEntry, field: "uncompressedSize" | "compressedSize"): number | null {
  const value = entry._data?.[field];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export async function validateDocxStructure(
  bytes: Buffer,
  limits: CorpusAdmissionLimits = DEFAULT_CORPUS_ADMISSION_LIMITS,
): Promise<CorpusDocxValidationResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: false });
  } catch (err) {
    return { ok: false, reasonCode: "DOCX_STRUCTURE_INVALID", detail: `Not a readable ZIP archive: ${err instanceof Error ? err.message : String(err)}` };
  }

  const entries = Object.values(zip.files) as unknown as JsZipInternalEntry[];

  if (entries.length > limits.maxZipEntries.value) {
    return { ok: false, reasonCode: "DOCX_ZIP_BOMB_SUSPECTED", detail: `Archive has ${entries.length} entries, exceeding the ${limits.maxZipEntries.value}-entry cap.` };
  }

  let totalUncompressed = 0;
  for (const entry of entries) {
    if (entry.dir) continue;

    // Defense-in-depth: verified empirically that JSZip's own loadAsync()
    // already fully resolves/strips ".." segments out of every entry name
    // it reports (any depth, any position — confirmed against
    // "../../etc/evil.xml", "foo/../../bar.xml", and
    // "a/b/../../../../escape.xml", none of which survive with a literal
    // ".." after loading), so entry.name can never actually contain a
    // traversal segment via this parser. This check stays anyway — cheap,
    // and a safety net against a future parsing-library change rather than
    // dead code removed on the assumption today's behavior never changes.
    if (TRAVERSAL_PATTERN.test(entry.name) || ABSOLUTE_OR_DRIVE_PATTERN.test(entry.name)) {
      return { ok: false, reasonCode: "DOCX_PATH_TRAVERSAL_ENTRY", detail: `Archive entry "${entry.name}" is an absolute path or contains a ".." traversal segment.` };
    }

    const uncompressedSize = entrySize(entry, "uncompressedSize");
    const compressedSize = entrySize(entry, "compressedSize");
    if (uncompressedSize === null || compressedSize === null) {
      return { ok: false, reasonCode: "DOCX_STRUCTURE_INVALID", detail: `Archive entry "${entry.name}" has no readable size metadata.` };
    }

    if (uncompressedSize > limits.maxZipEntryUncompressedBytes.value) {
      return { ok: false, reasonCode: "DOCX_ZIP_BOMB_SUSPECTED", detail: `Archive entry "${entry.name}" uncompresses to ${uncompressedSize} bytes, exceeding the ${limits.maxZipEntryUncompressedBytes.value}-byte per-entry cap.` };
    }

    const ratio = uncompressedSize / Math.max(1, compressedSize);
    if (ratio > limits.maxZipCompressionRatio.value) {
      return { ok: false, reasonCode: "DOCX_ZIP_BOMB_SUSPECTED", detail: `Archive entry "${entry.name}" has a ${ratio.toFixed(1)}:1 compression ratio, exceeding the ${limits.maxZipCompressionRatio.value}:1 cap.` };
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.maxZipTotalUncompressedBytes.value) {
      return { ok: false, reasonCode: "DOCX_ZIP_BOMB_SUSPECTED", detail: `Archive's total uncompressed size exceeds the ${limits.maxZipTotalUncompressedBytes.value}-byte cap.` };
    }
  }

  const entryNames = new Set(entries.filter((e) => !e.dir).map((e) => e.name));
  const hasContentTypes = entryNames.has("[Content_Types].xml");
  const hasRootRels = entryNames.has("_rels/.rels");
  const hasDocumentXml = [...entryNames].some((name) => /^word\/document\.xml$/i.test(name));
  if (!hasContentTypes || !hasRootRels || !hasDocumentXml) {
    return {
      ok: false,
      reasonCode: "DOCX_STRUCTURE_INVALID",
      detail: `Missing required OOXML part(s): ${[
        !hasContentTypes && "[Content_Types].xml",
        !hasRootRels && "_rels/.rels",
        !hasDocumentXml && "word/document.xml",
      ].filter(Boolean).join(", ")}.`,
    };
  }

  if (entryNames.has("word/vbaProject.bin")) {
    return { ok: false, reasonCode: "DOCX_MACRO_DETECTED", detail: "Archive contains word/vbaProject.bin (VBA macro project)." };
  }

  const contentTypesFile = zip.file("[Content_Types].xml");
  if (contentTypesFile) {
    const contentTypesXml = await contentTypesFile.async("string");
    if (contentTypesXml.includes(MACRO_CONTENT_TYPE_MARKER)) {
      return { ok: false, reasonCode: "DOCX_MACRO_DETECTED", detail: "[Content_Types].xml declares a macro-enabled content type." };
    }
  }

  for (const name of entryNames) {
    if (!/^word\/embeddings\//i.test(name)) continue;
    const extension = name.split(".").pop()?.toLowerCase() ?? "";
    if (DANGEROUS_EMBEDDED_EXTENSIONS.has(extension)) {
      return { ok: false, reasonCode: "DOCX_DANGEROUS_EMBEDDED_OBJECT", detail: `Embedded object "${name}" has a disallowed extension.` };
    }
  }

  return { ok: true };
}
