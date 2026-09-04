import type { ReactNode } from "react";

/** A `<details>`-based collapsible card for detailed diagnostics below a card's summary metrics. */
export function AdminCollapsible({
  summary,
  defaultOpen = false,
  children,
}: {
  summary: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="admin-collapsible" open={defaultOpen}>
      <summary>{summary}</summary>
      <div className="admin-collapsible-body">{children}</div>
    </details>
  );
}
