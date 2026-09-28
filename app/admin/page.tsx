import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Archive, Database, Radar, Wrench } from "lucide-react";
import { loadAdminGate } from "@/lib/admin-gate";
import { getReportsDbClient } from "@/lib/reports-db";
import { getArchiveExplorerCardMetrics, type ArchiveExplorerCardMetrics } from "@/lib/corpus-admission-archive-explorer";
import { AdminWorkspaceCard } from "@/components/admin/workspace-card";
import { ArchiveCardMetrics } from "@/components/admin/archive/archive-card-metrics";

export const dynamic = "force-dynamic";

// Non-admins (including a fully anonymous visitor) get the same plain 404 a
// nonexistent route would — never a 401/403, and never a page-identifying
// title, either (see lib/admin-gate.ts's own comment) — that would confirm
// this page exists.
export async function generateMetadata(): Promise<Metadata> {
  const admin = await loadAdminGate();
  if (!admin) return {};
  return { title: "Admin · TurnitPlus", robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } } };
}

export default async function AdminHomePage() {
  const admin = await loadAdminGate();
  if (!admin) notFound();

  // The Archive card's four live figures — read-only, loaded server-side
  // after the admin gate (same precedent as app/admin/corpus/page.tsx), from
  // the same derivation /admin/archive uses. A failure leaves the card
  // without figures ("unavailable"), never a broken launcher.
  let archiveMetrics: ArchiveExplorerCardMetrics | null = null;
  const client = await getReportsDbClient();
  try {
    archiveMetrics = await getArchiveExplorerCardMetrics(client);
  } catch (err) {
    console.error("AdminHomePage: getArchiveExplorerCardMetrics failed (non-fatal):", err instanceof Error ? err.message : String(err));
  } finally {
    client.close();
  }

  return (
    <main className="developer-page admin-launcher-page">
      <p className="admin-launcher-intro">Internal diagnostics and controls for the detection pipeline — not visible to ordinary accounts.</p>
      <div className="admin-launcher-grid">
        <AdminWorkspaceCard
          href="/admin/corpus"
          icon={Database}
          title="Corpus"
          description="Admission review, maturity exemptions, and corpus-source diagnostics."
        />
        <AdminWorkspaceCard
          href="/admin/shadow"
          icon={Radar}
          title="Shadow"
          description="Device Passport, shared-device risk, and corpus-duplicate shadow measurements — telemetry only."
        />
        <AdminWorkspaceCard
          href="/admin/developer"
          icon={Wrench}
          title="Developer"
          description="Article lookup, report inspection, and developer utilities."
        />
        <AdminWorkspaceCard
          href="/admin/archive"
          icon={Archive}
          title="Archive"
          description="Explore stored reference sources, admitted submissions, maturity, provenance, and corpus growth."
          ctaLabel="Explore archive"
        >
          <ArchiveCardMetrics metrics={archiveMetrics} />
        </AdminWorkspaceCard>
      </div>
    </main>
  );
}
