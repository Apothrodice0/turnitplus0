import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { loadAdminGate } from "@/lib/admin-gate";
import { AdminCorpusDetail } from "@/components/admin/corpus-detail";

export const dynamic = "force-dynamic";

// See lib/admin-gate.ts's own comment: a non-admin must never see a
// page-identifying title either, not just a 404 body.
export async function generateMetadata(): Promise<Metadata> {
  const admin = await loadAdminGate();
  if (!admin) return {};
  return { title: "Admission detail · Admin · TurnitPlus", robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } } };
}

export default async function AdminCorpusDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await loadAdminGate();
  if (!admin) notFound();

  const { id } = await params;
  // Defensive: this Next.js version does not reliably auto-decode a %-encoded
  // dynamic segment for a page Server Component the way it does for a Route
  // Handler's params (confirmed empirically — /api/admin/corpus/[id]/route.ts
  // receives a correctly decoded id for the same URL shape). Without this,
  // a rowId like "decision:<uuid>" arrives here still literally encoded as
  // "decision%3A<uuid>", gets passed to the client component as-is, and then
  // gets double-encoded when it builds its own fetch/action URLs — breaking
  // the detail view, preview, deactivate, and reactivate for every row.
  let rowId: string;
  try {
    rowId = decodeURIComponent(id);
  } catch {
    notFound();
  }

  return (
    <main className="developer-page">
      <AdminCorpusDetail rowId={rowId} />
    </main>
  );
}
