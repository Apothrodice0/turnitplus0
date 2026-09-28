import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Archive } from "lucide-react";
import { loadAdminGate } from "@/lib/admin-gate";
import { getReportsDbClient } from "@/lib/reports-db";
import { getArchiveExplorerSummary, listArchiveExplorerSources, type ArchiveExplorerListResult, type ArchiveExplorerSummary } from "@/lib/corpus-admission-archive-explorer";
import { AdminHeader } from "@/components/admin/admin-header";
import { ArchiveLifecycle, ArchiveOverview, ArchiveRuntimePills } from "@/components/admin/archive/archive-overview";
import { AdminArchiveWorkspace } from "@/components/admin/archive/archive-workspace";

export const dynamic = "force-dynamic";

// Non-admins (including a fully anonymous visitor) get the same plain 404 a
// nonexistent route would — never a 401/403, and never a page-identifying
// title either (see lib/admin-gate.ts's own comment) — that would confirm
// this page exists.
export async function generateMetadata(): Promise<Metadata> {
  const admin = await loadAdminGate();
  if (!admin) return {};
  return { title: "Archive · Admin · TurnitPlus", robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } } };
}

export default async function AdminArchivePage() {
  const admin = await loadAdminGate();
  if (!admin) notFound();

  // Read-only, server-side (this page is already admin-gated and
  // force-dynamic). The summary and the first page of sources are loaded
  // independently: either failing degrades to its own "unavailable" state,
  // never a broken workspace. Every later page / detail goes through the
  // admin-gated GET /api/admin/archive routes.
  const asOf = new Date();
  let summary: ArchiveExplorerSummary | null = null;
  let initialList: ArchiveExplorerListResult | null = null;
  const client = await getReportsDbClient();
  try {
    const [summaryResult, listResult] = await Promise.allSettled([
      getArchiveExplorerSummary(client, { asOf }),
      listArchiveExplorerSources(client, { page: 1, pageSize: 25 }, { asOf }),
    ]);
    if (summaryResult.status === "fulfilled") summary = summaryResult.value;
    else console.error("AdminArchivePage: getArchiveExplorerSummary failed (non-fatal):", summaryResult.reason instanceof Error ? summaryResult.reason.message : String(summaryResult.reason));
    if (listResult.status === "fulfilled") initialList = listResult.value;
    else console.error("AdminArchivePage: listArchiveExplorerSources failed (non-fatal):", listResult.reason instanceof Error ? listResult.reason.message : String(listResult.reason));
  } finally {
    client.close();
  }

  return (
    <main className="developer-page admin-archive-page">
      <AdminHeader
        icon={Archive}
        title="Archive"
        description="Reference sources and prior submissions available to the hosted runtime, with maturity, eligibility, provenance and growth. Read-only; not visible to ordinary accounts."
      />
      {summary && <ArchiveRuntimePills summary={summary} />}

      {summary ? (
        <ArchiveOverview summary={summary} />
      ) : (
        <p role="alert" className="admin-form-error">Corpus totals are temporarily unavailable. The source table below may still load.</p>
      )}

      <AdminArchiveWorkspace summary={summary} lifecycle={summary ? <ArchiveLifecycle summary={summary} /> : null} initialList={initialList} />
    </main>
  );
}
