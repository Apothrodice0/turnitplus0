import type { DeclaredContext } from "./reuse-context-declarations";

/**
 * Wire types for the ordinary-user reuse-context flow, kept in a
 * runtime-import-free module so client components can import them without
 * pulling node:crypto / DB code (lib/reuse-context-action-ref.ts,
 * lib/reuse-context-report-binding.ts) into the browser bundle.
 *
 * Every field here is bounded: enums, dates (date-only), the public report
 * handle, and opaque session-bound actionRefs. No document identity id,
 * representation id, matched submission reference id, declaration primary
 * key, account id, email, or source_ref ever appears in these shapes.
 */

export type ReuseContextUnavailableReason = "NO_PRIOR_SUBMISSION_MATCH" | "MULTIPLE_SOURCES";

export type ReuseContextActiveDeclaration = {
  actionRef: string;
  state: "SELF_ASSERTED_UNVERIFIED" | "MUTUALLY_CONFIRMED";
  declaredContext: DeclaredContext;
  /** Date only (YYYY-MM-DD); confirmed state only. */
  confirmedDate?: string;
  /** True iff this declaration's representation is the report's current first-eligible PRIOR_SUBMISSION. At most one entry is true. */
  isCurrent: boolean;
};

export type ReuseContextPendingDeclaration = {
  actionRef: string;
  state: "SELF_ASSERTED_UNVERIFIED";
  declaredContext: DeclaredContext;
  /** Date only (YYYY-MM-DD). */
  declaredDate: string;
};

/** An attestation the viewer (as ORIGINAL submitter) has already confirmed and may still retract via POST /api/reuse-context/revoke. */
export type ReuseContextConfirmedDeclaration = {
  actionRef: string;
  declaredContext: DeclaredContext;
  /** Date only (YYYY-MM-DD). */
  confirmedDate?: string;
};

export type ReuseContextEnvelope = {
  /** The existing public report handle — never an internal id. */
  reportId: string;
  declare: {
    available: boolean;
    canDeclare: boolean;
    unavailableReason?: ReuseContextUnavailableReason;
    activeDeclarations: ReuseContextActiveDeclaration[];
  };
  confirm: {
    /** Strictly SELF_ASSERTED_UNVERIFIED — awaiting the original submitter's decision. */
    pending: ReuseContextPendingDeclaration[];
    /** Active MUTUALLY_CONFIRMED attestations referencing this original report — retractable by the confirmer. */
    confirmed: ReuseContextConfirmedDeclaration[];
  };
};
