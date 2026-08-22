import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { loadDeveloperGate } from "@/lib/developer-gate";
import { DeveloperLookupSearch } from "@/components/developer/lookup-search";

export const dynamic = "force-dynamic";

// See lib/developer-gate.ts's own comment: a non-admin must never see a
// page-identifying title either, not just a 404 body.
export async function generateMetadata(): Promise<Metadata> {
  const admin = await loadDeveloperGate();
  if (!admin) return {};
  return { title: "Article lookup · Developer · TurnitPlus", robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } } };
}

export default async function DeveloperLookupPage() {
  const admin = await loadDeveloperGate();
  if (!admin) notFound();

  return (
    <main className="developer-page">
      <header className="developer-header">
        <h1>Article History / Lookup</h1>
        <p>Search by title, DOI, URL, document hash/fingerprint, author, or document/report id.</p>
      </header>
      <DeveloperLookupSearch />
    </main>
  );
}
