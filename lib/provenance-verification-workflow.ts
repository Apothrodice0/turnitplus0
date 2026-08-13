import type { Client, InStatement } from "@libsql/client";
import { isValidProvenanceTransition, type ProvenanceState } from "./provenance-types";
import { findProvenanceSourceById, transitionProvenanceState, type ProvenanceSource } from "./provenance-registry";
import { findEvidenceForSource } from "./provenance-evidence";
import { evaluateVerificationEligibility, type VerificationEligibilityResult } from "./provenance-verification-policy";
import {
  isVerificationMethod,
  type VerificationMethod,
  type VerificationDecisionOutcome,
} from "./provenance-verification-decision-types";

/**
 * Phase E5: the controlled provenance verification decision workflow.
 *
 * This module is the ONLY place that is allowed to move a
 * provenance_sources row into or out of VERIFIED_SOURCE, DISPUTED_SOURCE,
 * RETRACTED_SOURCE, or VERIFICATION_REJECTED as a deliberate verification
 * decision. lib/provenance-verification-policy.ts's evaluateVerificationGate/
 * evaluateVerificationEligibility (Phase E4) remain pure and untouched —
 * they answer "does the evidence support verification," never "make it so."
 * Every function here requires an explicit caller (a human review process,
 * or a deliberate SYSTEM_POLICY call — never an automatic side effect of
 * evaluating evidence) — see tests/provenance-scoring-invariance.test.mjs,
 * extended in this phase to prove evaluating the gate alone never mutates
 * provenance_sources.
 *
 * No "verified = true" flag exists anywhere: provenance_sources
 * .provenance_state (via isEligibleForVerifiedSimilarity) is always the
 * single current source of truth; provenance_verification_decisions is only
 * the audit trail of how it got there. Every state-changing decision here
 * reuses lib/provenance-types.ts's isValidProvenanceTransition — the same
 * centralized validator Phase E1 established — and
 * lib/provenance-registry.ts's transitionProvenanceState to actually apply
 * it, via that function's new (Phase E5) extraStatements parameter, so the
 * state transition and its decision record are written in one atomic
 * client.batch() call: both succeed or neither does.
 */

export type VerificationDecisionParams = {
  sourceId: string;
  method: VerificationMethod;
  reason?: string | null;
  /** Defaults to every evidence record currently on file for this source. */
  evidenceIdsConsidered?: number[];
  /** Defaults to now. Only meaningful for backfilling a decision made out of band (e.g. an IMPORTED_TRUSTED_SOURCE bulk import). */
  decidedAt?: string;
};

export type ReasonedVerificationDecisionParams = VerificationDecisionParams & { reason: string };

export type VerificationDecision = {
  id: number;
  sourceId: string;
  previousState: ProvenanceState;
  requestedState: ProvenanceState;
  decision: VerificationDecisionOutcome;
  evaluation: VerificationEligibilityResult;
  evidenceIdsConsidered: number[];
  reason: string | null;
  method: VerificationMethod;
  decidedAt: string;
  createdAt: string;
};

export type VerificationWorkflowResult = {
  /** false only for an idempotent repeat of a request the source already satisfies (see this module's own idempotency note below), or a REAFFIRMED decision (which never changes state by design). */
  stateChanged: boolean;
  /** null only for the idempotent-repeat case above — nothing new to audit when nothing happened. */
  decision: VerificationDecision | null;
  source: ProvenanceSource;
  previousState: ProvenanceState;
  newState: ProvenanceState;
  evaluation: VerificationEligibilityResult;
};

type RawDecisionRow = {
  id: number;
  source_id: string;
  previous_state: string;
  requested_state: string;
  decision: string;
  evaluation_json: string;
  evidence_ids_json: string;
  reason: string | null;
  method: string;
  decided_at: string;
  created_at: string;
};

const DECISION_COLUMNS =
  "id, source_id, previous_state, requested_state, decision, evaluation_json, evidence_ids_json, reason, method, decided_at, created_at";

function toVerificationDecision(row: RawDecisionRow): VerificationDecision {
  return {
    id: Number(row.id),
    sourceId: row.source_id,
    previousState: row.previous_state as ProvenanceState,
    requestedState: row.requested_state as ProvenanceState,
    decision: row.decision as VerificationDecisionOutcome,
    evaluation: JSON.parse(row.evaluation_json),
    evidenceIdsConsidered: JSON.parse(row.evidence_ids_json),
    reason: row.reason,
    method: row.method as VerificationMethod,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
  };
}

async function findVerificationDecisionById(client: Client, id: number): Promise<VerificationDecision> {
  const result = await client.execute({ sql: `SELECT ${DECISION_COLUMNS} FROM provenance_verification_decisions WHERE id = ?`, args: [id] });
  const row = result.rows[0] as unknown as RawDecisionRow | undefined;
  if (!row) throw new Error(`findVerificationDecisionById: row ${id} was not found immediately after insert`);
  return toVerificationDecision(row);
}

/** Full, ordered decision history for one source — the audit trail this whole module exists to produce. */
export async function findVerificationDecisionsForSource(client: Client, sourceId: string): Promise<VerificationDecision[]> {
  const result = await client.execute({
    sql: `SELECT ${DECISION_COLUMNS} FROM provenance_verification_decisions WHERE source_id = ? ORDER BY decided_at ASC, id ASC`,
    args: [sourceId],
  });
  return (result.rows as unknown as RawDecisionRow[]).map(toVerificationDecision);
}

function requireNonEmptyReason(reason: string | null | undefined, fnName: string): void {
  if (!reason || !reason.trim()) throw new Error(`${fnName}: a non-empty reason is required`);
}

type ApplyDecisionParams = {
  sourceId: string;
  toState: ProvenanceState;
  decision: VerificationDecisionOutcome;
  method: VerificationMethod;
  reason?: string | null;
  evidenceIdsConsidered?: number[];
  decidedAt?: string;
  /** true only for approveVerification — every other decision kind is explicitly allowed regardless of gate state (Phase E3 design: "do not require the gate to pass before recording a rejection"). */
  requireGateEligible: boolean;
};

/**
 * The single shared implementation behind approveVerification/
 * rejectVerification/recordDispute/recordRetraction. Order of checks is
 * deliberate: cheap, structural checks (method validity, source existence,
 * "are we already there") happen before any evidence is fetched or
 * evaluated, and the transition graph (isValidProvenanceTransition) is
 * checked before the evidence gate — a structurally invalid request (e.g.
 * approving a CANDIDATE_SOURCE directly, skipping PROVENANCE_PENDING) is
 * rejected on that basis alone, never on evidence content.
 *
 * Idempotency (Phase E5 section 9): if the source is already in the
 * requested state, this is treated as a safe no-op — `stateChanged: false`,
 * `decision: null`, nothing written. There is genuinely nothing new to
 * decide or audit in that case, and no-op is strictly safer than either (a)
 * throwing, which would make a harmless retry look like a real failure, or
 * (b) writing a duplicate decision row, which would make the audit trail
 * imply a second, distinct review happened when it did not. Any other kind
 * of repeat (e.g. rejecting an already-VERIFIED_SOURCE) is not a "repeat" at
 * all — it is a structurally different transition, and
 * isValidProvenanceTransition already rejects it (VERIFICATION_REJECTED is
 * not a reachable target from VERIFIED_SOURCE in Phase E1's graph), so no
 * extra contradiction-detection logic is needed here beyond reusing that
 * one validator.
 */
async function applyVerificationDecision(client: Client, params: ApplyDecisionParams): Promise<VerificationWorkflowResult> {
  if (!isVerificationMethod(params.method)) {
    throw new Error(`applyVerificationDecision: "${params.method}" is not a recognized verification method`);
  }
  const source = await findProvenanceSourceById(client, params.sourceId);
  if (!source) throw new Error(`applyVerificationDecision: no provenance_sources row ${params.sourceId}`);

  const previousState = source.provenanceState;
  const evidence = await findEvidenceForSource(client, params.sourceId);
  const evaluation = evaluateVerificationEligibility(evidence);

  if (previousState === params.toState) {
    return { stateChanged: false, decision: null, source, previousState, newState: previousState, evaluation };
  }

  if (!isValidProvenanceTransition(previousState, params.toState)) {
    throw new Error(`applyVerificationDecision: ${previousState} -> ${params.toState} is not an allowed provenance transition`);
  }

  if (params.requireGateEligible && !evaluation.eligible) {
    throw new Error(
      `applyVerificationDecision: verification gate not satisfied for source ${params.sourceId} — missing: ${evaluation.missing.join(", ")}`,
    );
  }

  const decidedAt = params.decidedAt ?? new Date().toISOString();
  const evidenceIdsConsidered = params.evidenceIdsConsidered ?? evidence.map((e) => e.id);
  const decisionStatement: InStatement = {
    sql: `INSERT INTO provenance_verification_decisions
            (source_id, previous_state, requested_state, decision, evaluation_json, evidence_ids_json, reason, method, decided_at, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [
      params.sourceId,
      previousState,
      params.toState,
      params.decision,
      JSON.stringify(evaluation),
      JSON.stringify(evidenceIdsConsidered),
      params.reason ?? null,
      params.method,
      decidedAt,
    ],
  };

  // Atomic: the provenance_sources UPDATE, the provenance_events INSERT
  // (both inside transitionProvenanceState), and the decision row above all
  // happen in one client.batch() — see that function's Phase E5 comment.
  const { source: updatedSource, extraResults } = await transitionProvenanceState(
    client,
    { sourceId: params.sourceId, toState: params.toState, reason: params.reason ?? null },
    [decisionStatement],
  );

  const decisionId = Number(extraResults[0]?.lastInsertRowid);
  const decision = await findVerificationDecisionById(client, decisionId);

  return { stateChanged: true, decision, source: updatedSource, previousState, newState: updatedSource.provenanceState, evaluation };
}

/**
 * The only path that can move a source INTO VERIFIED_SOURCE. Requires the
 * nine-criterion gate (Phase E4) to be fully satisfied — throws otherwise,
 * per Phase E3 design's explicit VERIFIED_SOURCE requirements. Valid
 * pre-states are whatever lib/provenance-types.ts's transition graph
 * already allows (PROVENANCE_PENDING, or DISPUTED_SOURCE for a restoring
 * re-verification) — not hardcoded here, so this function can never drift
 * out of sync with the one graph that defines it.
 */
export async function approveVerification(client: Client, params: VerificationDecisionParams): Promise<VerificationWorkflowResult> {
  return applyVerificationDecision(client, { ...params, toState: "VERIFIED_SOURCE", decision: "APPROVED", requireGateEligible: true });
}

/**
 * Rejects a candidate. Deliberately does NOT require the verification gate
 * to pass — a rejection is always possible for any structurally valid
 * pre-state (Phase E3 design: insufficient evidence, unestablished
 * correspondence/independence, unacceptable source class, and unresolved
 * conflicts are all valid reasons to reject, and none of them require first
 * computing a passing gate). `reason` is required — a rejection must always
 * be explainable.
 */
export async function rejectVerification(client: Client, params: ReasonedVerificationDecisionParams): Promise<VerificationWorkflowResult> {
  requireNonEmptyReason(params.reason, "rejectVerification");
  return applyVerificationDecision(client, { ...params, toState: "VERIFICATION_REJECTED", decision: "REJECTED", requireGateEligible: false });
}

/** Moves a currently-VERIFIED_SOURCE into DISPUTED_SOURCE. `reason` is required, matching rejectVerification's rationale. */
export async function recordDispute(client: Client, params: ReasonedVerificationDecisionParams): Promise<VerificationWorkflowResult> {
  requireNonEmptyReason(params.reason, "recordDispute");
  return applyVerificationDecision(client, { ...params, toState: "DISPUTED_SOURCE", decision: "DISPUTED", requireGateEligible: false });
}

/** Moves a currently-VERIFIED_SOURCE or DISPUTED_SOURCE into RETRACTED_SOURCE (terminal — see lib/provenance-types.ts). `reason` is required. */
export async function recordRetraction(client: Client, params: ReasonedVerificationDecisionParams): Promise<VerificationWorkflowResult> {
  requireNonEmptyReason(params.reason, "recordRetraction");
  return applyVerificationDecision(client, { ...params, toState: "RETRACTED_SOURCE", decision: "RETRACTED", requireGateEligible: false });
}

/**
 * Phase E3 design section 7's "new evidence arrives on an already-VERIFIED_
 * SOURCE, a reviewer confirms it still holds" case. Unlike the four
 * functions above, this never calls transitionProvenanceState — previous
 * and requested state are both VERIFIED_SOURCE, and
 * isValidProvenanceTransition rejects same-state transitions by design, so
 * there is no provenance_events row for a reaffirmation, only a
 * provenance_verification_decisions row (decision: "REAFFIRMED") recording
 * that the evidence was re-examined and still passes the gate. Throws if
 * the source is not currently VERIFIED_SOURCE, or if the gate no longer
 * passes (in which case recordDispute or recordRetraction is the correct
 * call instead — reaffirmation cannot be used to paper over evidence that
 * no longer supports verification).
 */
export async function reaffirmVerification(client: Client, params: VerificationDecisionParams): Promise<VerificationWorkflowResult> {
  if (!isVerificationMethod(params.method)) {
    throw new Error(`reaffirmVerification: "${params.method}" is not a recognized verification method`);
  }
  const source = await findProvenanceSourceById(client, params.sourceId);
  if (!source) throw new Error(`reaffirmVerification: no provenance_sources row ${params.sourceId}`);
  if (source.provenanceState !== "VERIFIED_SOURCE") {
    throw new Error(`reaffirmVerification: source ${params.sourceId} is ${source.provenanceState}, not VERIFIED_SOURCE — nothing to reaffirm`);
  }

  const evidence = await findEvidenceForSource(client, params.sourceId);
  const evaluation = evaluateVerificationEligibility(evidence);
  if (!evaluation.eligible) {
    throw new Error(
      `reaffirmVerification: evidence no longer supports verification for source ${params.sourceId} (missing: ${evaluation.missing.join(", ")}) — use recordDispute or recordRetraction instead`,
    );
  }

  const decidedAt = params.decidedAt ?? new Date().toISOString();
  const evidenceIdsConsidered = params.evidenceIdsConsidered ?? evidence.map((e) => e.id);
  const result = await client.execute({
    sql: `INSERT INTO provenance_verification_decisions
            (source_id, previous_state, requested_state, decision, evaluation_json, evidence_ids_json, reason, method, decided_at, created_at)
          VALUES (?,'VERIFIED_SOURCE','VERIFIED_SOURCE','REAFFIRMED',?,?,?,?,?,CURRENT_TIMESTAMP)`,
    args: [params.sourceId, JSON.stringify(evaluation), JSON.stringify(evidenceIdsConsidered), params.reason ?? null, params.method, decidedAt],
  });
  const decision = await findVerificationDecisionById(client, Number(result.lastInsertRowid));

  return { stateChanged: false, decision, source, previousState: "VERIFIED_SOURCE", newState: "VERIFIED_SOURCE", evaluation };
}
