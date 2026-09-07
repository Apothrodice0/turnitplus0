import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Database, ClipboardList, ShieldCheck, Activity } from "lucide-react";
import { loadAdminGate } from "@/lib/admin-gate";
import { getReportsDbClient } from "@/lib/reports-db";
import { AdminCorpusSearch } from "@/components/admin/corpus-search";
import { AdminCorpusStatusStrip } from "@/components/admin/corpus-status-strip";
import { AdminHeader } from "@/components/admin/admin-header";
import { MetricGrid, MetricTile } from "@/components/admin/metric-tile";
import { isCorpusPromotionEnabled } from "@/lib/corpus-admission-promotion";
import { isCorpusRetentionEnabled } from "@/lib/corpus-admission-retention-sweep";
import { isCorpusSourceMatchingEnabled } from "@/lib/corpus-source-matching-flag";
import { getCorpusAdmissionOperationalSummary, getCorpusAdmissionStatusCounts, type CorpusAdmissionStatusCounts } from "@/lib/corpus-admission-admin-repo";
import { DeveloperCorpusMaturityExemptions, type CorpusMaturityExemptionRow } from "@/components/developer/corpus-maturity-exemptions";
import { listCorpusMaturityExemptions } from "@/lib/developer-corpus-maturity-exemptions";

export const dynamic = "force-dynamic";

// Non-admins (including a fully anonymous visitor) get the same plain 404 a
// nonexistent route would — never a 401/403, and never a page-identifying
// title either (see lib/admin-gate.ts's own comment) — that would confirm
// this page exists.
export async function generateMetadata(): Promise<Metadata> {
  const admin = await loadAdminGate();
  if (!admin) return {};
  return { title: "Corpus admission · Admin · TurnitPlus", robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } } };
}

export default async function AdminCorpusPage() {
  const admin = await loadAdminGate();
  if (!admin) notFound();

  // Loaded directly, server-side — this page is already authenticated
  // (loadAdminGate above) and force-dynamic, so there is no reason to
  // round-trip through a dedicated API route just to display these values;
  // see components/admin/corpus-status-strip.tsx's own header comment.
  // A failure in any one of these three is logged and treated as
  // "unavailable," never allowed to fail the whole page — each card has
  // nothing to do with the other two and must still render.
  let operationalSummary: Awaited<ReturnType<typeof getCorpusAdmissionOperationalSummary>> | null = null;
  let statusCounts: CorpusAdmissionStatusCounts | null = null;
  // Corpus maturity exemptions — SELECT-only list for the workspace section;
  // adding/removing goes through POST/DELETE /api/developer/corpus-maturity-
  // exemptions (its own admin gate), never written from this Server Component.
  let corpusMaturityExemptions: CorpusMaturityExemptionRow[] = [];
  const dbClient = await getReportsDbClient();
  try {
    operationalSummary = await getCorpusAdmissionOperationalSummary(dbClient);
  } catch (err) {
    console.error("AdminCorpusPage: getCorpusAdmissionOperationalSummary failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
  try {
    statusCounts = await getCorpusAdmissionStatusCounts(dbClient);
  } catch (err) {
    console.error("AdminCorpusPage: getCorpusAdmissionStatusCounts failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
  try {
    corpusMaturityExemptions = await listCorpusMaturityExemptions(dbClient);
  } catch (err) {
    console.error("AdminCorpusPage: listCorpusMaturityExemptions failed (non-fatal):", err instanceof Error ? err.message : String(err));
  } finally {
    dbClient.close();
  }

  return (
    <main className="developer-page">
      <AdminHeader
        icon={Database}
        title="Corpus"
        description="Every admission attempt — accepted, review, rejected, failed, pending, or cancelled — across every account. Not visible to ordinary accounts."
      />

      {statusCounts && (
        <MetricGrid>
          <MetricTile label="Total corpus representations" value={statusCounts.activeRepresentations} sub={`${statusCounts.total} admission attempts total`} />
          <MetricTile label="Accepted / admitted" value={statusCounts.accepted} />
          <MetricTile label="Rejected" value={statusCounts.rejected} />
          <MetricTile label="Pending" value={statusCounts.pending} />
          <MetricTile label="Maturity-exempt accounts" value={corpusMaturityExemptions.length} />
        </MetricGrid>
      )}

      <section className="admin-card">
        <h2>
          <ClipboardList size={17} className="admin-card-title-icon" aria-hidden="true" />
          Corpus admission
        </h2>
        <AdminCorpusSearch />
      </section>

      <section className="admin-card">
        <h2>
          <ShieldCheck size={17} className="admin-card-title-icon" aria-hidden="true" />
          Maturity exemptions
        </h2>
        <DeveloperCorpusMaturityExemptions initialExemptions={corpusMaturityExemptions} />
      </section>

      <section className="admin-card">
        <h2>
          <Activity size={17} className="admin-card-title-icon" aria-hidden="true" />
          Corpus status
        </h2>
        <AdminCorpusStatusStrip
          vercelEnv={process.env.VERCEL_ENV}
          promotionEnabled={isCorpusPromotionEnabled()}
          retentionEnabled={isCorpusRetentionEnabled()}
          sourceMatchingEnabled={isCorpusSourceMatchingEnabled()}
          summary={operationalSummary}
        />
      </section>
    </main>
  );
}
