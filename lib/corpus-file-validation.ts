import type { CorpusAdmissionLimits, CorpusHardGateCode, CorpusSupportedFormat } from "./corpus-admission-types";
import { DEFAULT_CORPUS_ADMISSION_LIMITS } from "./corpus-admission-types";

/**
 * Corpus-admission-only file validation: extension tier + magic-byte
 * signature check + a dangerous-signature blocklist that applies regardless
 * of claimed extension. Pure, synchronous, byte-prefix-only — does not
 * attempt real structural parsing (that is lib/corpus-docx-validation.ts,
 * run inside the isolated extraction worker, lib/corpus-extraction-worker.ts).
 *
 * Deliberately corpus-admission-only: ordinary report checking
 * (app/page.tsx, lib/document-check-pipeline.ts) keeps its own existing,
 * unrelated extension allow-list (pdf/docx/txt/md/html/csv, no signature
 * check) untouched — this module is never imported by that path. See
 * tests/corpus-admission-privacy.test.mjs.
 */

export const CORPUS_ADMISSION_FILE_VALIDATION_VERSION = "corpus-file-validation-v1";

/** v1 auto-admission-eligible extensions plus the two "accepted but capped to REVIEW" extensions (html/md — see lib/corpus-admission-policy.ts's FORMAT_DEFERRED_FOR_V1 rule). csv is deliberately excluded — corpus admission only, ordinary report checking is unaffected. */
const ALLOWED_EXTENSIONS: ReadonlySet<CorpusSupportedFormat> = new Set(["pdf", "docx", "txt", "md", "html"]);

export type CorpusFileValidationResult =
  | { ok: true; format: CorpusSupportedFormat }
  | { ok: false; reasonCode: CorpusHardGateCode; detail: string };

const PDF_SIGNATURE = Buffer.from("%PDF-", "latin1");
const ZIP_LOCAL_FILE_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
/** An empty zip archive's central-directory-only signature — a real DOCX is never this short, but a well-formed-if-empty zip could otherwise slip past the local-file-header check below. */
const ZIP_EMPTY_ARCHIVE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/**
 * Cross-format dangerous-signature blocklist: catches an executable/script
 * renamed to a claimed-safe extension regardless of what the extension
 * says. Checked for every candidate, not just non-pdf/docx ones — a real
 * %PDF-/PK-prefixed file can never also start with one of these, so there
 * is no false-positive risk against legitimate PDFs/DOCX files.
 */
const DANGEROUS_SIGNATURES: Array<{ name: string; bytes: number[] }> = [
  { name: "Windows PE/EXE/DLL (MZ)", bytes: [0x4d, 0x5a] },
  { name: "ELF executable", bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: "Mach-O (32-bit LE)", bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { name: "Mach-O (64-bit LE)", bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: "Mach-O (32-bit BE)", bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { name: "Mach-O (64-bit BE)", bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { name: "Mach-O fat/universal binary", bytes: [0xca, 0xfe, 0xba, 0xbe] },
];

function startsWith(bytes: Buffer, prefix: Buffer | number[]): boolean {
  const prefixArray = Buffer.isBuffer(prefix) ? prefix : Buffer.from(prefix);
  if (bytes.length < prefixArray.length) return false;
  // Buffer.compare() (not .equals(), whose inherited-from-Uint8Array
  // .subarray() return type some @types/node versions don't narrow back to
  // Buffer) accepts plain Uint8Array on both sides, sidestepping that gap.
  return Buffer.compare(bytes.subarray(0, prefixArray.length), prefixArray) === 0;
}

function detectFormat(filename: string): CorpusSupportedFormat | null {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return (ALLOWED_EXTENSIONS as ReadonlySet<string>).has(extension) ? (extension as CorpusSupportedFormat) : null;
}

export function validateCorpusCandidateFile(
  params: { filename: string; bytes: Buffer },
  limits: CorpusAdmissionLimits = DEFAULT_CORPUS_ADMISSION_LIMITS,
): CorpusFileValidationResult {
  const { filename, bytes } = params;
  const format = detectFormat(filename);
  if (!format) {
    const extension = filename.split(".").pop()?.toLowerCase() ?? "(none)";
    return { ok: false, reasonCode: "UNSUPPORTED_FILE_FORMAT", detail: `Extension ".${extension}" is not eligible for corpus admission (csv and every other extension are excluded in v1).` };
  }

  if (bytes.length === 0) {
    return { ok: false, reasonCode: "EMPTY_FILE", detail: "The candidate file is empty." };
  }

  if (bytes.length > limits.maxFileBytes.value) {
    return { ok: false, reasonCode: "FILE_TOO_LARGE", detail: `File is ${bytes.length} bytes, exceeding the ${limits.maxFileBytes.value}-byte corpus-admission cap.` };
  }

  for (const signature of DANGEROUS_SIGNATURES) {
    if (startsWith(bytes, signature.bytes)) {
      return { ok: false, reasonCode: "DANGEROUS_FILE_SIGNATURE", detail: `File begins with a ${signature.name} signature, regardless of its claimed ".${format}" extension.` };
    }
  }

  if (format === "pdf") {
    if (!startsWith(bytes, PDF_SIGNATURE)) {
      return { ok: false, reasonCode: "FILE_SIGNATURE_MISMATCH", detail: 'File claims a .pdf extension but does not begin with the "%PDF-" signature.' };
    }
    return { ok: true, format };
  }

  if (format === "docx") {
    if (!startsWith(bytes, ZIP_LOCAL_FILE_HEADER) && !startsWith(bytes, ZIP_EMPTY_ARCHIVE)) {
      return { ok: false, reasonCode: "FILE_SIGNATURE_MISMATCH", detail: "File claims a .docx extension but does not begin with a ZIP local-file-header signature." };
    }
    return { ok: true, format };
  }

  // txt/md/html: no positive magic-byte signature exists for plain text, but
  // a ZIP signature under one of these extensions is exactly the "disguised
  // archive" spoofing case the dangerous-signature check above exists for —
  // checked here too since ZIP itself is not in the DANGEROUS_SIGNATURES
  // blocklist (a real .docx legitimately starts this way).
  if (startsWith(bytes, ZIP_LOCAL_FILE_HEADER) || startsWith(bytes, ZIP_EMPTY_ARCHIVE)) {
    return { ok: false, reasonCode: "DANGEROUS_FILE_SIGNATURE", detail: `File begins with a ZIP archive signature despite its claimed ".${format}" (non-docx) extension.` };
  }

  return { ok: true, format };
}
