import type { ReportExtractionDiagnostic } from "@/lib/evidence-interpretation/extraction";
import { MAX_REPORT_SAVE_REQUEST_BYTES } from "@/lib/report-transport-limits";

/**
 * USER-SUPPLIED REFERENCES — the shared, DEPENDENCY-FREE constants and value
 * types for both the server verifier (lib/user-supplied-references.ts,
 * lib/report-user-supplied-references.ts) and the browser upload intake
 * (lib/document-check-pipeline.ts, components/reports/reference-files-panel.tsx).
 *
 * This module deliberately imports nothing that pulls in `node:crypto` (i.e. not
 * lib/document-identity.ts) so it is safe to bundle into the client. The limits
 * here are the SINGLE SOURCE OF TRUTH — the upload UI surfaces exactly these
 * numbers and never invents its own, and `app/api/reports/route.ts` enforces the
 * same `referenceTransportBudgetError` independently.
 */

/** V1 supported reference formats. NOT md/html/csv (those are manuscript-only). */
export const SUPPORTED_REFERENCE_FILE_TYPES = ["pdf", "docx", "txt"] as const;
export type SuppliedReferenceFileType = (typeof SUPPORTED_REFERENCE_FILE_TYPES)[number];

export const MAX_REFERENCE_FILES = 20;

/**
 * Aggregate ceiling on the SUM of every reference's extracted-text length. A
 * 1.2M-char ASCII reference set serialises to ~1.27 MB — comfortably inside the
 * {@link MAX_REPORT_SAVE_REQUEST_BYTES} request cap alongside a typical
 * manuscript. Enforced client-side (friendly block) AND server-side (413).
 */
export const MAX_REFERENCE_AGGREGATE_TEXT_CHARS = 1_200_000;

/**
 * Per-reference extracted-text ceiling. A single reference may fill the whole
 * budget; a reference PAST it is REJECTED, never truncated — the client drops
 * that one reference from the check (keeping the others) and the server 413s the
 * whole request. Equal to the aggregate by design (one reference == the whole
 * budget); `referenceTransportBudgetError` returns `"PER_REFERENCE_TEXT"` here.
 */
export const MAX_REFERENCE_TEXT_CHARS = MAX_REFERENCE_AGGREGATE_TEXT_CHARS;

/**
 * UTF-8 BYTE ceiling for the whole `userSuppliedReferences` request sibling —
 * the byte-accurate guard. A character count alone understates the serialised
 * size for non-ASCII text (an em-dash / curly-quote / accented / CJK codepoint
 * is 2-3 UTF-8 bytes), so a 1.2M-char aggregate that passes the char check can
 * still be ~2.5 MB on the wire. This bounds that.
 */
export const MAX_REFERENCE_REQUEST_BYTES = 1_400_000;

/** Rough serialised size of the non-reference save envelope (deviceKey, summary,
 *  devicePassport, extractionCompleteness, JSON structure) — used by the
 *  combined manuscript + references pre-submit estimate. Deliberately generous. */
export const SAVE_REQUEST_ENVELOPE_BYTES = 16_000;
/** Headroom kept below {@link MAX_REPORT_SAVE_REQUEST_BYTES} for the combined estimate. */
export const SAVE_REQUEST_SAFETY_MARGIN_BYTES = 64_000;

export const MAX_REFERENCE_FILENAME_CHARS = 260;

/** The app-wide per-file byte cap — the SAME limit the manuscript upload uses. */
export const REFERENCE_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** `accept` attribute for the reference `<input type="file">`. */
export const REFERENCE_ACCEPT_ATTR = ".pdf,.docx,.txt";

/**
 * What the browser sends as the `userSuppliedReferences` sibling of the save
 * payload. ONLY the file's own name/type and its already-extracted text — every
 * matched position / % / interpretation / admission is (re)computed server-side.
 */
export type SuppliedReferenceInput = {
  fileName: string;
  fileType: SuppliedReferenceFileType;
  extractedText: string;
  extraction?: ReportExtractionDiagnostic | null;
};

// ── transport budget ────────────────────────────────────────────────────

/** Actual UTF-8 byte length of a string — isomorphic (browser + Node). */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export type ReferenceBudgetError = "PER_REFERENCE_TEXT" | "AGGREGATE_TEXT" | "REQUEST_BYTES";

/** Global block message for the AGGREGATE / REQUEST_BYTES outcomes (the whole
 *  check is not submitted) — never exposes byte/char numbers. */
export const REFERENCE_BUDGET_MESSAGE =
  "These reference files contain too much text to check together. Remove one or more files and try again.";

/** Per-reference rejection note (shown on that one reference's row; the other
 *  references are still checked) — never exposes byte/char numbers. */
export const REFERENCE_TOO_LARGE_MESSAGE = "This reference contains too much text to check.";

/**
 * `null` when the supplied references fit the transport budget; otherwise which
 * bound was exceeded. Consumed IDENTICALLY by the pre-submit client guard and by
 * `app/api/reports/route.ts` (independent HTTP 413 before the matcher / before
 * any persistence).
 *
 * `"PER_REFERENCE_TEXT"` — a single reference's extracted text is over
 * {@link MAX_REFERENCE_TEXT_CHARS}. The real client never sends this (its intake
 * drops such a reference to an empty FAILED input before submitting); it exists
 * so a FORGED over-limit reference is rejected by the server WITHOUT truncation
 * and without any matcher work.
 *
 * Order matters: the per-reference and aggregate char checks gate the
 * `JSON.stringify` below, so a pathological multi-megabyte input is rejected
 * without ever being serialised.
 *
 * Pass `manuscriptText` (client only) to also fail when the COMBINED
 * manuscript + references + envelope estimate would exceed the request cap.
 */
export function referenceTransportBudgetError(
  inputs: ReadonlyArray<Pick<SuppliedReferenceInput, "extractedText" | "fileName" | "fileType">>,
  manuscriptText?: string,
): ReferenceBudgetError | null {
  let aggregateChars = 0;
  for (const input of inputs) {
    if (input.extractedText.length > MAX_REFERENCE_TEXT_CHARS) return "PER_REFERENCE_TEXT";
    aggregateChars += input.extractedText.length;
  }
  if (aggregateChars > MAX_REFERENCE_AGGREGATE_TEXT_CHARS) return "AGGREGATE_TEXT";

  const siblingBytes = utf8ByteLength(JSON.stringify(inputs));
  if (siblingBytes > MAX_REFERENCE_REQUEST_BYTES) return "REQUEST_BYTES";

  if (typeof manuscriptText === "string") {
    const combined = siblingBytes + utf8ByteLength(manuscriptText) + SAVE_REQUEST_ENVELOPE_BYTES;
    if (combined > MAX_REPORT_SAVE_REQUEST_BYTES - SAVE_REQUEST_SAFETY_MARGIN_BYTES) return "REQUEST_BYTES";
  }
  return null;
}

// ── browser intake (pre-submission) ──────────────────────────────────────

/**
 * PHASE 4 — the lightweight per-file lifecycle shown in the upload UI.
 * `checked` / `checking` NEVER imply a source matched — only that the server
 * ran (or is running) its own verification.
 */
export type ReferenceIntakeStatus = "ready" | "processing" | "failed" | "checking" | "checked";

export const REFERENCE_STATUS_LABEL: Record<ReferenceIntakeStatus, string> = {
  ready: "Ready",
  processing: "Reading file…",
  failed: "Could not read this reference",
  checking: "Checking against your document…",
  checked: "Checked",
};

export type ReferenceIntakeEntry = {
  /** client-only id — never sent, never a source identity. */
  id: string;
  file: File;
  /** basename for display — `File.name` is already a basename in every browser. */
  displayName: string;
  fileType: SuppliedReferenceFileType;
  sizeLabel: string;
  status: ReferenceIntakeStatus;
  /** short reason under a FAILED row — never a path, id, or digest. */
  note: string | null;
};

export type ReferenceRejection = { fileName: string; reason: string };

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The supported reference file type for a name, or null if unsupported. */
export function referenceFileType(name: string): SuppliedReferenceFileType | null {
  const ext = extensionOf(name);
  return (SUPPORTED_REFERENCE_FILE_TYPES as readonly string[]).includes(ext)
    ? (ext as SuppliedReferenceFileType)
    : null;
}

export function formatReferenceBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let intakeSeq = 0;

/**
 * PHASE 2 — validate + fold newly chosen files into the existing list. An
 * invalid file is REJECTED locally with a clear reason and never blocks the
 * valid references already selected. Enforces exactly `MAX_REFERENCE_FILES`
 * (the backend's own limit) and de-dupes by name + size.
 */
export function addReferenceFiles(
  existing: readonly ReferenceIntakeEntry[],
  incoming: readonly File[],
): { entries: ReferenceIntakeEntry[]; rejected: ReferenceRejection[] } {
  const entries = [...existing];
  const rejected: ReferenceRejection[] = [];
  for (const file of incoming) {
    const name = (file?.name ?? "").trim();
    const fileType = referenceFileType(name);
    if (!fileType) {
      rejected.push({ fileName: name || "file", reason: "Unsupported type — add a PDF, DOCX, or TXT file" });
      continue;
    }
    if (typeof file.size === "number" && file.size > REFERENCE_MAX_FILE_BYTES) {
      rejected.push({ fileName: name, reason: "Larger than 10 MB" });
      continue;
    }
    if (entries.some((e) => e.displayName === name && e.file.size === file.size)) {
      rejected.push({ fileName: name, reason: "Already added" });
      continue;
    }
    if (entries.length >= MAX_REFERENCE_FILES) {
      rejected.push({ fileName: name, reason: `Limit is ${MAX_REFERENCE_FILES} reference files` });
      continue;
    }
    intakeSeq += 1;
    entries.push({
      id: `ref-${Date.now().toString(36)}-${intakeSeq}`,
      file,
      displayName: name,
      fileType,
      sizeLabel: typeof file.size === "number" ? formatReferenceBytes(file.size) : "",
      status: "ready",
      note: null,
    });
  }
  return { entries, rejected };
}

export function removeReferenceFile(
  existing: readonly ReferenceIntakeEntry[],
  id: string,
): ReferenceIntakeEntry[] {
  return existing.filter((e) => e.id !== id);
}

export function setReferenceEntryStatus(
  existing: readonly ReferenceIntakeEntry[],
  id: string,
  status: ReferenceIntakeStatus,
  note: string | null = null,
): ReferenceIntakeEntry[] {
  return existing.map((e) => (e.id === id ? { ...e, status, note } : e));
}

/** After a save completes, every reference that was `checking` becomes `checked`. */
export function markReferencesChecked(
  existing: readonly ReferenceIntakeEntry[],
): ReferenceIntakeEntry[] {
  return existing.map((e) => (e.status === "checking" ? { ...e, status: "checked" } : e));
}
