"use client";

import { useEffect } from "react";
import { RouteErrorPanel } from "@/components/report/route-error-panel";

// Production audit fix — see components/report/route-error-panel.tsx's own
// header comment for why this exists at all. A report whose own stored
// data can't be parsed is handled upstream as a normal not-found instead
// (see app/reports/[id]/page.tsx's loadOwnedReport); this boundary only
// ever catches a genuinely unexpected failure — most realistically a
// transient DB connectivity error, which "Try again" can actually resolve.
export default function ReportDetailError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Report detail page failed to render:", error);
  }, [error]);

  return <RouteErrorPanel reset={reset} message="This report could not be loaded right now." />;
}
