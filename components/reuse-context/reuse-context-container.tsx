"use client";

import { useCallback, useEffect, useState } from "react";
import type { CanDeclareReuseContextResult, DeclaredContext, ReuseContextDeclarationView } from "@/lib/reuse-context-declarations";
import { ReuseContextPanel, type ReuseContextOutcome } from "./reuse-context-panel";
import { OriginalSubmitterConfirmationPanel, type PendingActionOutcome } from "./original-submitter-confirmation-panel";

/**
 * E8S Step 11: the client-side data-fetching orchestrator that wires the
 * pure-presentational components (reuse-context-panel.tsx,
 * original-submitter-confirmation-panel.tsx, both from E8S Step 6) to the
 * six live, session-authenticated routes (app/api/reuse-context/*). Only
 * ever mounted when the server has already decided this viewer is E8S-
 * allowlisted and this report's own document identity resolved
 * (SimilarityReport.reuseContext, set by lib/e8s-report-integration.ts) —
 * for every other viewer this component is never rendered at all, so it
 * never mounts, its useEffect never fires, and zero E8S network requests
 * are ever made (E8S Step 11 requirement 7).
 *
 * The client never sends an account id, email, session token, or any
 * "declared/confirmed/revoked by" field (requirement 8) — every request
 * body below contains only documentIdentityId/representationId/
 * declaredContext/declarationId; identity is resolved entirely from the
 * session cookie by each route itself.
 *
 * Freshness (requirement 9): every mutation handler re-fetches the
 * relevant GET endpoint afterward and renders purely from that response,
 * regardless of what the mutation's own result was — a stale click (the
 * declaration was already confirmed/revoked/rejected by another tab in the
 * meantime) self-heals through this same re-fetch, never assumed from the
 * click itself.
 */

type StatusResponse = { affordance: CanDeclareReuseContextResult; activeDeclaration: ReuseContextDeclarationView | null };
type PendingResponse = { declarations: ReuseContextDeclarationView[] };

async function callApi<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T | null }> {
  try {
    const res = await fetch(url, init);
    const body = (await res.json().catch(() => null)) as T | null;
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export function ReuseContextContainer({
  documentIdentityId,
  representationId,
  /** true when nothing else in the report already renders the "Previously submitted content" section (E8S Step 11 requirement 10) — this component then supplies its own section wrapper, but ONLY once it actually has something to show, never an empty shell. */
  standalone = false,
}: {
  documentIdentityId: string;
  representationId: string | null;
  standalone?: boolean;
}) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(!representationId);
  const [pending, setPending] = useState<ReuseContextDeclarationView[]>([]);
  const [pendingLoaded, setPendingLoaded] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<ReuseContextOutcome>(null);
  const [lastAction, setLastAction] = useState<PendingActionOutcome>(null);

  const statusUrl = representationId
    ? `/api/reuse-context/status?documentIdentityId=${encodeURIComponent(documentIdentityId)}&representationId=${encodeURIComponent(representationId)}`
    : null;
  const pendingUrl = `/api/reuse-context/pending?documentIdentityId=${encodeURIComponent(documentIdentityId)}`;

  const refreshStatus = useCallback(async () => {
    if (!statusUrl) return;
    const result = await callApi<StatusResponse>(statusUrl);
    if (result.ok && result.body) setStatus(result.body);
    setStatusLoaded(true);
  }, [statusUrl]);

  const refreshPending = useCallback(async () => {
    const result = await callApi<PendingResponse>(pendingUrl);
    if (result.ok && result.body) setPending(result.body.declarations);
    setPendingLoaded(true);
  }, [pendingUrl]);

  useEffect(() => {
    void refreshStatus();
    void refreshPending();
  }, [refreshStatus, refreshPending]);

  async function handleDeclare(declaredContext: DeclaredContext) {
    if (!representationId) return;
    setLastOutcome(null);
    await callApi("/api/reuse-context/declare", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ documentIdentityId, representationId, declaredContext }),
    });
    await refreshStatus();
  }

  async function handleWithdraw() {
    const declarationId = status?.activeDeclaration?.id;
    if (declarationId === undefined) return;
    const result = await callApi<{ status: string }>("/api/reuse-context/revoke", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ declarationId }),
    });
    setLastOutcome(result.body?.status === "REVOKED" || result.body?.status === "ALREADY_REVOKED" ? "REVOKED" : null);
    await refreshStatus();
  }

  async function handleConfirm(declarationId: number) {
    await callApi("/api/reuse-context/confirm", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ declarationId }),
    });
    setLastAction({ declarationId, outcome: "CONFIRMED" });
    await refreshPending();
  }

  async function handleReject(declarationId: number) {
    await callApi("/api/reuse-context/reject", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ declarationId }),
    });
    setLastAction({ declarationId, outcome: "REJECTED" });
    await refreshPending();
  }

  if (!statusLoaded || !pendingLoaded) return null; // avoid a flash of the wrong content before the first fetch resolves

  const hasStatusContent = representationId !== null && status !== null;
  const hasPendingContent = pending.length > 0 || (lastAction?.outcome === "REJECTED" && !pending.some((d) => d.id === lastAction.declarationId));
  if (standalone && !hasStatusContent && !hasPendingContent) return null;

  const inner = (
    <>
      {hasStatusContent && status && (
        <ReuseContextPanel
          affordance={status.affordance}
          activeDeclaration={status.activeDeclaration}
          lastOutcome={lastOutcome}
          onDeclare={handleDeclare}
          onWithdraw={handleWithdraw}
        />
      )}
      <OriginalSubmitterConfirmationPanel pending={pending} lastAction={lastAction} onConfirm={handleConfirm} onReject={handleReject} />
    </>
  );

  if (!standalone) return inner;
  return (
    <section className="historical-match-block">
      <h3>Previously submitted content</h3>
      {inner}
    </section>
  );
}
