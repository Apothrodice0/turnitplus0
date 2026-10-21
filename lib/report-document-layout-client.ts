import type { DocxDocument, DocxMedia } from "@/lib/docx-document";
import {
  DOCUMENT_LAYOUT_LIMITS,
  DOCUMENT_LAYOUT_MEDIA_TYPES,
  fromStoredDocumentLayout,
  mediaRef,
  parseStoredDocumentLayout,
  toStoredDocumentLayout,
  type StoredDocumentLayout,
} from "@/lib/report-document-layout";

/**
 * SAVED DOCUMENT LAYOUT — browser side (2026-10-21).
 *
 * Capture: right after a room upload's report is saved, the uploaded .docx (still in this tab — nothing is
 * re-selected) is read for its structure (lib/docx-document.ts). The layout is kept only when every line of the
 * report's saved text has a verified place in it; its images are downscaled here; then one owner-only request
 * stores it with the report (app/api/reports/[id]/document-layout). The original file is never uploaded.
 *
 * Load: when the report is opened (on any device), the layout and its images are read back through the same
 * owner-only routes and used for the printed manuscript, but only if they still describe the report's text.
 */

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const MAX_IMAGE_SIDE = 1800;

/** The image as a storable blob: kept as is when small enough, otherwise redrawn smaller. Null when a browser cannot draw it. */
async function storableImage(media: DocxMedia): Promise<Blob | null> {
  const original = new Blob([media.bytes as BlobPart], { type: media.contentType });
  if (!(DOCUMENT_LAYOUT_MEDIA_TYPES as readonly string[]).includes(media.contentType)) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(original);
  } catch {
    return null;
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && original.size <= DOCUMENT_LAYOUT_LIMITS.mediaBytes / 2) {
    bitmap.close();
    return original;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const encode = (type: string, quality?: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  const png = media.contentType === "image/png" ? await encode("image/png") : null;
  if (png && png.size <= DOCUMENT_LAYOUT_LIMITS.mediaBytes / 2) return png;
  return encode("image/jpeg", 0.86);
}

export type CapturedDocumentLayout = { stored: StoredDocumentLayout; media: Blob[] };

/** The .docx's layout, ready to store — or null when it cannot be verified against the report's saved text. */
export async function captureDocumentLayout(file: File, reportText: string): Promise<CapturedDocumentLayout | null> {
  if (!/\.docx$/i.test(file.name) || !reportText) return null;
  const [{ default: JSZip }, { readDocxDocument }, { mapHighlightsOntoDocx }] = await Promise.all([
    import("jszip"),
    import("@/lib/docx-document"),
    import("@/lib/docx-manuscript-map"),
  ]);
  const doc = await readDocxDocument(await JSZip.loadAsync(await file.arrayBuffer()), (xml) => new DOMParser().parseFromString(xml, "application/xml"));
  // kept only when every line of the saved text has a verified place in this structure
  if (mapHighlightsOntoDocx(doc, reportText, []).unmappedLines.length > 0) return null;

  const kept: Array<{ path: string; blob: Blob }> = [];
  let budget = DOCUMENT_LAYOUT_LIMITS.requestBytes - DOCUMENT_LAYOUT_LIMITS.layoutBytes;
  for (const [path, media] of doc.media) {
    if (kept.length >= DOCUMENT_LAYOUT_LIMITS.mediaCount) break;
    const blob = await storableImage(media);
    if (!blob || blob.size > DOCUMENT_LAYOUT_LIMITS.mediaBytes || blob.size > budget) continue;
    budget -= blob.size;
    kept.push({ path, blob });
  }
  const stored = toStoredDocumentLayout(doc, await sha256Hex(reportText), kept.map((k) => ({ path: k.path, contentType: k.blob.type })));
  if (new Blob([JSON.stringify(stored)]).size > DOCUMENT_LAYOUT_LIMITS.layoutBytes) return null;
  return { stored, media: kept.map((k) => k.blob) };
}

export type SaveLayoutOutcome = "saved" | "unavailable" | "failed";

export async function saveDocumentLayoutRemote(reportId: string, captured: CapturedDocumentLayout): Promise<SaveLayoutOutcome> {
  const form = new FormData();
  form.append("layout", new Blob([JSON.stringify(captured.stored)], { type: "application/json" }), "layout.json");
  captured.media.forEach((blob, i) => form.append("media", blob, `image-${i}`));
  try {
    const response = await fetch(`/api/reports/${encodeURIComponent(reportId)}/document-layout`, { method: "PUT", body: form, credentials: "same-origin" });
    if (response.ok) return "saved";
    return response.status === 503 ? "unavailable" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Captures and stores the layout after a report is saved. Background work: it never blocks or fails the upload,
 * and a report without a saved layout simply prints its standard manuscript.
 */
export async function captureAndSaveDocumentLayout(reportId: string, file: File, reportText: string): Promise<SaveLayoutOutcome | "skipped"> {
  try {
    const captured = await captureDocumentLayout(file, reportText);
    if (!captured) return "skipped";
    let outcome = await saveDocumentLayoutRemote(reportId, captured);
    if (outcome === "failed") {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      outcome = await saveDocumentLayoutRemote(reportId, captured);
    }
    return outcome;
  } catch {
    return "failed";
  }
}

export type LoadedDocumentLayout = { doc: DocxDocument; imageUrls: Map<string, string> };

/** The report's saved layout with its images as local object URLs, or null when there is none or it does not fit the text. */
export async function fetchDocumentLayout(reportId: string, reportText: string): Promise<LoadedDocumentLayout | null> {
  let body: { layout?: unknown; mediaIndexes?: unknown };
  try {
    const response = await fetch(`/api/reports/${encodeURIComponent(reportId)}/document-layout`, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return null;
    body = await response.json();
  } catch {
    return null;
  }
  const stored = parseStoredDocumentLayout(body.layout);
  if (!stored || stored.textSha256 !== (await sha256Hex(reportText))) return null;
  const present = new Set(Array.isArray(body.mediaIndexes) ? body.mediaIndexes.filter((n): n is number => typeof n === "number") : []);
  const imageUrls = new Map<string, string>();
  for (const { index } of stored.media) {
    if (!present.has(index)) continue;
    try {
      const response = await fetch(`/api/reports/${encodeURIComponent(reportId)}/document-layout/media/${index}`, { credentials: "same-origin", cache: "no-store" });
      const blob = response.ok ? await response.blob() : null;
      if (blob && (DOCUMENT_LAYOUT_MEDIA_TYPES as readonly string[]).includes(blob.type)) imageUrls.set(mediaRef(index), URL.createObjectURL(blob));
    } catch {
      /* the figure then prints as "image not available", never as something invented */
    }
  }
  return { doc: fromStoredDocumentLayout(stored), imageUrls };
}
