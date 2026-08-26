"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type ListRow = {
  rowId: string;
  status: "pending" | "failed" | "cancelled" | "accepted" | "review" | "rejected";
  decision: "ACCEPT" | "REVIEW" | "REJECT" | null;
  detectedLanguage: string | null;
  extractedWordCount: number | null;
  qualityScore: number | null;
  accountId: string | null;
  accountEmail: string | null;
  attemptCount: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  promotionStatus: "staged" | "indexed" | "failed" | "skipped" | "dead_lettered" | null;
  /** B1C: the promotion row's own completed-attempt count — distinguishes a retryable 'failed' row from one that has exhausted MAX_PROMOTION_ATTEMPTS (5, lib/corpus-admission-promotion.ts). */
  promotionAttemptCount: number | null;
  /** null = never ACCEPTed (or ACCEPTed with no fingerprint at all) — no Remove/Removed affordance for this row. */
  acceptedRepresentationId: string | null;
  /** true = active (show Remove); false = already deactivated (show Removed); null when acceptedRepresentationId is null. */
  acceptedRepresentationActive: boolean | null;
};

type ListResponse = { rows: ListRow[]; page: number; pageSize: number; totalCount: number };

const STATUS_OPTIONS = ["", "pending", "failed", "cancelled", "accepted", "review", "rejected"] as const;

// 400/404/429 are the deactivate route's own pre-defined, non-internal
// messages (reason validation, "no accepted fingerprint", rate limit) — safe
// to show verbatim. Anything else (500, network failure, CSRF 404 with no
// body) falls back to this fixed message so a raw error/DB internal can
// never reach the admin's screen — see lib/admin-http.ts's adminJsonResponse
// for what a 500 body can otherwise contain (err.message, unsanitized).
const REMOVE_SAFE_ERROR_STATUSES = new Set([400, 404, 429]);
const REMOVE_GENERIC_ERROR = "Could not remove this item from the corpus. Please try again.";

// B1C: 5 mirrors MAX_PROMOTION_ATTEMPTS in lib/corpus-admission-promotion.ts
// — a literal, not an import, since that module pulls in node:crypto and
// cannot be imported from a "use client" component (see lib/corpus-
// admission-source-ref.ts's own header comment for the exact class of
// `next build` failure that guards against).
const MAX_PROMOTION_ATTEMPTS_DISPLAY = 5;

function promotionStatusLabel(status: ListRow["promotionStatus"], attemptCount: number | null): string {
  if (status === null) return "—";
  if (status === "failed") return `failed — retrying (attempt ${attemptCount ?? "?"}/${MAX_PROMOTION_ATTEMPTS_DISPLAY})`;
  if (status === "dead_lettered") return `dead-lettered — exhausted ${MAX_PROMOTION_ATTEMPTS_DISPLAY}/${MAX_PROMOTION_ATTEMPTS_DISPLAY}, retries stopped`;
  return status;
}

/** Client-side list/search/filter/pagination for /admin/corpus — hits GET /api/admin/corpus, itself independently gated by getAdminSessionUser. Renders no data of its own on first paint; every result comes from that authorized fetch. */
export function AdminCorpusSearch() {
  const [status, setStatus] = useState<(typeof STATUS_OPTIONS)[number]>("");
  const [language, setLanguage] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a successful Remove to force the SAME fetch effect below to
  // re-run against the current filters/page — the one and only list-loading
  // path, never a second, parallel fetch of its own.
  const [reloadToken, setReloadToken] = useState(0);

  const [removeDialogRowId, setRemoveDialogRowId] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState("");
  const [removeLoading, setRemoveLoading] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (language.trim()) params.set("language", language.trim());
    if (q.trim()) params.set("q", q.trim());
    params.set("page", String(page));

    fetch(`/api/admin/corpus?${params.toString()}`)
      .then((response) => {
        if (!response.ok) throw new Error(`Request failed (${response.status})`);
        return response.json() as Promise<ListResponse>;
      })
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Request failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [status, language, q, page, reloadToken]);

  function openRemoveDialog(rowId: string) {
    setRemoveDialogRowId(rowId);
    setRemoveReason("");
    setRemoveError(null);
    setSuccessMessage(null);
  }

  function closeRemoveDialog() {
    if (removeLoading) return;
    setRemoveDialogRowId(null);
    setRemoveReason("");
    setRemoveError(null);
  }

  // Calls the EXISTING admin deactivate action/endpoint
  // (lib/corpus-admission-admin-actions.ts's deactivateAcceptedRepresentation,
  // via app/api/admin/corpus/[id]/deactivate/route.ts) — the same one
  // components/admin/corpus-detail.tsx already uses. No new route, no new
  // revocation/snapshot-invalidation/generation-bump/audit logic here.
  async function confirmRemove() {
    if (!removeDialogRowId) return;
    setRemoveLoading(true);
    setRemoveError(null);
    try {
      const response = await fetch(`/api/admin/corpus/${encodeURIComponent(removeDialogRowId)}/deactivate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: removeReason }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string; outcome?: string } | null;
      if (!response.ok) {
        throw new Error(REMOVE_SAFE_ERROR_STATUSES.has(response.status) && body?.error ? body.error : REMOVE_GENERIC_ERROR);
      }
      setRemoveDialogRowId(null);
      setRemoveReason("");
      setSuccessMessage(body?.outcome === "already_inactive" ? "Already removed from corpus." : "Removed from corpus.");
      setReloadToken((token) => token + 1);
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : REMOVE_GENERIC_ERROR);
    } finally {
      setRemoveLoading(false);
    }
  }

  const totalPages = result ? Math.max(1, Math.ceil(result.totalCount / result.pageSize)) : 1;

  return (
    <div className="developer-lookup">
      <form
        className="admin-corpus-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
        }}
      >
        <input type="text" value={q} onChange={(event) => { setQ(event.target.value); setPage(1); }} placeholder="Search source ref, reason codes, error" aria-label="Search corpus admission" />
        <select value={status} onChange={(event) => { setStatus(event.target.value as (typeof STATUS_OPTIONS)[number]); setPage(1); }} aria-label="Filter by status">
          {STATUS_OPTIONS.map((option) => (
            <option key={option} value={option}>{option === "" ? "All statuses" : option}</option>
          ))}
        </select>
        <input type="text" value={language} onChange={(event) => { setLanguage(event.target.value); setPage(1); }} placeholder="Language (e.g. English)" aria-label="Filter by detected language" />
      </form>

      {error && <p role="alert">{error}</p>}
      {loading && <p>Loading…</p>}
      {successMessage && <p role="status">{successMessage}</p>}

      {result && (
        <>
          <p>{result.totalCount} total · page {result.page} of {totalPages}</p>
          <div className="developer-table-scroll">
            <table className="developer-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Language</th>
                  <th>Word count</th>
                  <th>Quality</th>
                  <th>Account owner</th>
                  <th>Attempts</th>
                  <th>Created</th>
                  <th>Promotion</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.rowId}>
                    <td>{row.status}</td>
                    <td>{row.detectedLanguage ?? "—"}</td>
                    <td>{row.extractedWordCount ?? "—"}</td>
                    <td>{row.qualityScore ?? "—"}</td>
                    <td>{row.accountEmail ?? "unknown"}</td>
                    <td>{row.attemptCount ?? "—"}</td>
                    <td>{row.createdAt}</td>
                    <td>{promotionStatusLabel(row.promotionStatus, row.promotionAttemptCount)}</td>
                    <td>
                      <Link href={`/admin/corpus/${encodeURIComponent(row.rowId)}`}>Inspect</Link>
                      {row.acceptedRepresentationId && (
                        row.acceptedRepresentationActive ? (
                          <>
                            {" "}
                            <button type="button" onClick={() => openRemoveDialog(row.rowId)}>Remove</button>
                          </>
                        ) : (
                          <>
                            {" "}
                            <span>Removed</span>
                          </>
                        )
                      )}
                    </td>
                  </tr>
                ))}
                {result.rows.length === 0 && (
                  <tr>
                    <td colSpan={9}>No matching rows.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div>
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</button>
            <span> Page {page} of {totalPages} </span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        </>
      )}

      {removeDialogRowId && (
        <div role="dialog" aria-modal="true" aria-labelledby="admin-corpus-remove-dialog-title">
          <h2 id="admin-corpus-remove-dialog-title">Remove this item from the TurnitPlus corpus?</h2>
          <p>
            It will stop participating through this corpus entry. Existing reports, receipts, users and submission
            history will not be deleted. If the same content is still backed by another valid corpus source, it may
            remain matchable.
          </p>
          <label>
            Reason (required):{" "}
            <textarea
              value={removeReason}
              onChange={(event) => setRemoveReason(event.target.value)}
              placeholder="Short justification"
              disabled={removeLoading}
            />
          </label>
          {removeError && <p role="alert">{removeError}</p>}
          <div>
            <button type="button" onClick={closeRemoveDialog} disabled={removeLoading}>Cancel</button>
            <button type="button" onClick={confirmRemove} disabled={removeLoading || removeReason.trim().length === 0}>
              Remove from corpus
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
