"use client";

import type { RefObject } from "react";
import { FileText, Paperclip, X } from "lucide-react";
import {
  MAX_REFERENCE_FILES,
  REFERENCE_ACCEPT_ATTR,
  REFERENCE_STATUS_LABEL,
  type ReferenceIntakeEntry,
  type ReferenceRejection,
} from "@/lib/user-supplied-reference-constants";

/**
 * USER-SUPPLIED REFERENCES V1 — the optional "Reference files" section shown
 * beneath the manuscript upload (anonymous Dashboard + a room's empty slot, both
 * via components/reports/document-upload-panel.tsx).
 *
 * PRODUCT UX RULE: there is NO consent checkbox and NO "enable checking" toggle —
 * if reference files are added, TurnitPlus checks them automatically on submit.
 *
 * Purely presentational: it owns no state and does no extraction. The parent
 * (app/page.tsx / room-page-shell.tsx) holds the entry list, runs Extraction V2
 * at submit time, and sends the raw text as the `userSuppliedReferences` sibling
 * of the save payload. Every match / % / interpretation is server-derived — this
 * panel never implies a source matched (a `checked` row means the server ran its
 * check, not that anything overlapped).
 *
 * PRIVACY: only `File.name` (already a basename in every browser) is shown —
 * never a filesystem path, a `C:\fakepath\` value, an upload/storage id, or any
 * content digest.
 */

type Props = {
  entries: ReferenceIntakeEntry[];
  rejections: ReferenceRejection[];
  /** true while a check is running — the list is frozen but still visible. */
  busy?: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
  onDismissRejections: () => void;
};

export function ReferenceFilesPanel({
  entries,
  rejections,
  busy,
  inputRef,
  onAdd,
  onRemove,
  onClear,
  onDismissRejections,
}: Props) {
  const atLimit = entries.length >= MAX_REFERENCE_FILES;
  const disabled = Boolean(busy);

  function openPicker() {
    if (disabled || atLimit) return;
    inputRef.current?.click();
  }

  return (
    <section className="reference-files" aria-labelledby="reference-files-heading">
      <div className="reference-files-head">
        <p className="section-label" id="reference-files-heading">
          Reference files <span className="reference-files-optional">optional</span>
        </p>
        <p className="reference-files-lede">
          Add papers, reports, or documents you used. TurnitPlus will compare your document
          against them automatically.
        </p>
      </div>

      <div
        className={`reference-dropzone ${disabled ? "is-disabled" : ""}`}
        onDragOver={(event) => {
          if (!disabled && !atLimit) event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (disabled) return;
          onAdd(Array.from(event.dataTransfer.files));
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={REFERENCE_ACCEPT_ATTR}
          multiple
          hidden
          disabled={disabled || atLimit}
          onChange={(event) => {
            onAdd(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <span className="reference-dropzone-icon" aria-hidden="true">
          <Paperclip />
        </span>
        <strong>Drop reference files here</strong>
        <button
          type="button"
          className="button secondary reference-dropzone-browse"
          onClick={openPicker}
          disabled={disabled || atLimit}
        >
          Browse files
        </button>
        <span className="reference-dropzone-meta">
          PDF, DOCX, or TXT · up to {MAX_REFERENCE_FILES} files
        </span>
      </div>

      {rejections.length > 0 && (
        <div className="reference-files-rejections" role="status">
          <ul>
            {rejections.map((rejection, index) => (
              <li key={`${rejection.fileName}-${index}`}>
                <span className="reference-file-name">{rejection.fileName}</span>
                {" — "}
                {rejection.reason}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="reference-files-dismiss"
            onClick={onDismissRejections}
            aria-label="Dismiss these messages"
          >
            <X aria-hidden="true" />
          </button>
        </div>
      )}

      {entries.length > 0 && (
        <>
          <ul className="reference-files-list">
            {entries.map((entry) => (
              <li key={entry.id} className={`reference-file-row reference-file-${entry.status}`}>
                <span className="reference-file-icon" aria-hidden="true">
                  <FileText />
                </span>
                <span className="reference-file-body">
                  <span className="reference-file-name">{entry.displayName}</span>
                  <span className="reference-file-sub">
                    {entry.sizeLabel ? `${entry.sizeLabel} · ` : ""}
                    <span className="reference-file-status">
                      {entry.note ?? REFERENCE_STATUS_LABEL[entry.status]}
                    </span>
                  </span>
                </span>
                <button
                  type="button"
                  className="reference-file-remove"
                  onClick={() => onRemove(entry.id)}
                  disabled={disabled}
                  aria-label={`Remove ${entry.displayName}`}
                >
                  <X aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <div className="reference-files-actions">
            <span className="reference-files-count">
              {entries.length} of {MAX_REFERENCE_FILES}
            </span>
            <button
              type="button"
              className="button subtle"
              onClick={onClear}
              disabled={disabled}
            >
              Clear all
            </button>
          </div>
        </>
      )}
    </section>
  );
}
