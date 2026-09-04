import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Radar } from "lucide-react";
import { loadAdminGate } from "@/lib/admin-gate";
import { getReportsDbClient } from "@/lib/reports-db";
import {
  summarizeDeviceProvenanceShadowMeasurement,
  type DeviceProvenanceShadowMeasurement,
} from "@/lib/device-provenance-shadow-measurement";
import {
  summarizeSharedDeviceRiskMeasurement,
  type SharedDeviceRiskMeasurement,
} from "@/lib/device-sharedness-measurement";
import {
  summarizeCorpusDuplicateSuppressionShadowMeasurement,
  type CorpusDuplicateSuppressionShadowMeasurement,
} from "@/lib/corpus-duplicate-suppression-shadow-measurement";
import { AdminHeader } from "@/components/admin/admin-header";
import { DeviceProvenanceShadowCard } from "@/components/admin/shadow/device-provenance-shadow-card";
import { SharedDeviceRiskCard } from "@/components/admin/shadow/shared-device-risk-card";
import { CorpusDuplicateShadowCard } from "@/components/admin/shadow/corpus-duplicate-shadow-card";

export const dynamic = "force-dynamic";

// Non-admins (including a fully anonymous visitor) get the same plain 404 a
// nonexistent route would — never a 401/403, and never a page-identifying
// title, either (see lib/admin-gate.ts's own comment) — that would confirm
// this page exists.
export async function generateMetadata(): Promise<Metadata> {
  const admin = await loadAdminGate();
  if (!admin) return {};
  return { title: "Shadow diagnostics · Admin · TurnitPlus", robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } } };
}

export default async function AdminShadowPage() {
  const admin = await loadAdminGate();
  if (!admin) notFound();

  const client = await getReportsDbClient();
  let deviceShadow: DeviceProvenanceShadowMeasurement | null = null;
  let sharedDeviceRisk: SharedDeviceRiskMeasurement | null = null;
  let corpusDuplicateShadow: CorpusDuplicateSuppressionShadowMeasurement | null = null;
  try {
    // Compact aggregate view of the device-provenance-shadow-v1 telemetry —
    // measurement only, read-only, never touches similarity scoring. A
    // failure here degrades to a hidden card, never a broken workspace.
    try {
      deviceShadow = await summarizeDeviceProvenanceShadowMeasurement(client, { recentLimit: 25 });
    } catch (err) {
      console.error("admin shadow workspace: device-provenance shadow summary failed (non-fatal):", err instanceof Error ? err.message : String(err));
    }
    // Shared-device false-SELF risk for the current downgrade candidates —
    // also SELECT-only, also never touches scoring. Same degrade-to-hidden
    // discipline.
    try {
      sharedDeviceRisk = await summarizeSharedDeviceRiskMeasurement(client, { recentLimit: 25 });
    } catch (err) {
      console.error("admin shadow workspace: shared-device risk summary failed (non-fatal):", err instanceof Error ? err.message : String(err));
    }
    // Phase B2b corpus-duplicate suppression shadow — SELECT-only aggregate of
    // what the B1 counterfactual would do to the similarity score. Never
    // touches scoring. Same degrade-to-hidden discipline.
    try {
      corpusDuplicateShadow = await summarizeCorpusDuplicateSuppressionShadowMeasurement(client, { recentLimit: 25 });
    } catch (err) {
      console.error("admin shadow workspace: corpus-duplicate shadow summary failed (non-fatal):", err instanceof Error ? err.message : String(err));
    }
  } finally {
    client.close();
  }

  return (
    <main className="developer-page">
      <AdminHeader
        icon={Radar}
        title="Shadow"
        description="Telemetry-only measurements for proposed policies — none of these change production scoring or relationships."
      />

      {deviceShadow && <DeviceProvenanceShadowCard measurement={deviceShadow} />}
      {sharedDeviceRisk && <SharedDeviceRiskCard measurement={sharedDeviceRisk} />}
      {corpusDuplicateShadow && <CorpusDuplicateShadowCard measurement={corpusDuplicateShadow} />}

      {!deviceShadow && !sharedDeviceRisk && !corpusDuplicateShadow && (
        <section className="admin-card">
          <p>No shadow measurements are currently available.</p>
        </section>
      )}
    </main>
  );
}
