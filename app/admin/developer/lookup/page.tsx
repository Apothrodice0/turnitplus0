import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Search } from "lucide-react";
import { loadDeveloperGate } from "@/lib/developer-gate";
import { AdminHeader } from "@/components/admin/admin-header";
import { DeveloperLookupSearch } from "@/components/developer/lookup-search";

export const dynamic = "force-dynamic";

// See lib/developer-gate.ts's own comment: a non-admin must never see a
// page-identifying title either, not just a 404 body.
export async function generateMetadata(): Promise<Metadata> {
  const admin = await loadDeveloperGate();
  if (!admin) return {};
  return { title: "Article lookup · Developer · Admin · TurnitPlus", robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } } };
}

export default async function AdminDeveloperLookupPage() {
  const admin = await loadDeveloperGate();
  if (!admin) notFound();

  return (
    <main className="developer-page">
      <AdminHeader
        icon={Search}
        title="Article History / Lookup"
        description="Search by title, DOI, URL, document hash/fingerprint, author, or document/report id."
        backHref="/admin/developer"
        backLabel="Back to Developer"
      />
      <DeveloperLookupSearch />
    </main>
  );
}
