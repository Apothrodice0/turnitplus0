"use client";

import { useEffect, useRef, useState } from "react";
import type { DeclaredContext } from "@/lib/reuse-context-declarations";
import type { ReuseContextEnvelope } from "@/lib/reuse-context-types";
import { ReuseContextPanel, type ReuseContextOutcome } from "./reuse-context-panel";
import { OriginalSubmitterConfirmationPanel, type PendingActionOutcome } from "./original-submitter-confirmation-panel";

/**
 * Client orchestrator for the ordinary-user reuse-context flow.
 *
 * Reads state ENTIRELY from the `reuseContext` envelope prop
 * (GET /api/reports/[id] -> { payload, reuseContext }), held here in
 * separate state — never merged into the report object, never persisted.
 * There is no read fetch: /api/reuse-context/status and /pending no longer
 * exist. Each mutation POST returns a fresh envelope which is applied in
 * place, so a stale click self-heals from authoritative server state.
 *
 * Every request body contains only { reportId } (the existing public
 * handle) plus a declaredContext enum or an opaque session-bound actionRef.
 * No document identity id, representation id, or declaration id is ever
 * sent.
 */

const JSON_HEADERS = { "Content-Type": "application/json" };

async function postMutation(
  url: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; reuseContext: ReuseContextEnvelope | null; bodyStatus: string | null }> {
  try {
    const res = await fetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body), cache: "no-store" });
    const data = (await res.json().catch(() => null)) as { reuseContext?: ReuseContextEnvelope; status?: string } | null;
    return {
      ok: res.ok,
      status: res.status,
      reuseContext: data?.reuseContext ?? null,
      bodyStatus: data?.status ?? null,
    };
  } catch {
    return { ok: false, status: 0, reuseContext: null, bodyStatus: null };
  }
}

function hasVisibleContent(envelope: ReuseContextEnvelope): boolean {
  return (
    envelope.declare.available ||
    envelope.declare.activeDeclarations.length > 0 ||
    envelope.confirm.pending.length > 0 ||
    envelope.confirm.confirmed.length > 0
  );
}

export function ReuseContextContainer({ reuseContext }: { reuseContext: ReuseContextEnvelope }) {
  const [envelope, setEnvelope] = useState<ReuseContextEnvelope>(reuseContext);
  const [declarerOutcome, setDeclarerOutcome] = useState<ReuseContextOutcome>(null);
  const [pendingAction, setPendingAction] = useState<PendingActionOutcome>(null);
  const busyRef = useRef(false);

  // Keep in sync when the shell delivers a newer envelope (e.g. the one-shot
  // enrichment fetch resolves, or the report is re-fetched).
  useEffect(() => {
    setEnvelope(reuseContext);
  }, [reuseContext]);

  const reportId = envelope.reportId;

  async function run(url: string, body: Record<string, unknown>): Promise<ReuseContextEnvelope | null> {
    if (busyRef.current) return null;
    busyRef.current = true;
    try {
      const result = await postMutation(url, body);
      if (result.reuseContext) setEnvelope(result.reuseContext);
      return result.reuseContext;
    } finally {
      busyRef.current = false;
    }
  }

  async function handleDeclare(declaredContext: DeclaredContext) {
    setDeclarerOutcome(null);
    await run("/api/reuse-context/declare", { reportId, declaredContext });
  }

  async function handleWithdraw(actionRef: string) {
    const fresh = await run("/api/reuse-context/withdraw", { reportId, actionRef });
    if (fresh) setDeclarerOutcome("WITHDRAWN");
  }

  async function handleConfirm(actionRef: string) {
    await run("/api/reuse-context/confirm", { reportId, actionRef });
    setPendingAction({ actionRef, outcome: "CONFIRMED" });
  }

  async function handleReject(actionRef: string) {
    await run("/api/reuse-context/reject", { reportId, actionRef });
    setPendingAction({ actionRef, outcome: "REJECTED" });
  }

  async function handleRevokeConfirmation(actionRef: string) {
    await run("/api/reuse-context/revoke", { reportId, actionRef });
    setPendingAction({ actionRef, outcome: "CONFIRMATION_REVOKED" });
  }

  if (!hasVisibleContent(envelope) && !declarerOutcome && !pendingAction) return null;

  return (
    <section className="historical-match-block reuse-context-section" aria-live="polite">
      <h3>Additional context</h3>
      <p className="reuse-context-legend">
        A confirmed reuse context explains why a prior submission matches. It never removes the match from your similarity score.
      </p>
      <ReuseContextPanel
        declare={envelope.declare}
        outcome={declarerOutcome}
        onDeclare={handleDeclare}
        onWithdraw={handleWithdraw}
      />
      <OriginalSubmitterConfirmationPanel
        pending={envelope.confirm.pending}
        confirmed={envelope.confirm.confirmed}
        lastAction={pendingAction}
        onConfirm={handleConfirm}
        onReject={handleReject}
        onRevokeConfirmation={handleRevokeConfirmation}
      />
    </section>
  );
}
