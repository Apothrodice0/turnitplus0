import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Database, Radar, Wrench } from "lucide-react";
import { loadAdminGate } from "@/lib/admin-gate";
import { AdminWorkspaceCard } from "@/components/admin/workspace-card";

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

  return (
    <main className="developer-page">
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
      </div>
    </main>
  );
}
