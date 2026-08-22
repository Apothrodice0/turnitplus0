import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { loadAdminGate } from "@/lib/admin-gate";
import { AdminCorpusSearch } from "@/components/admin/corpus-search";

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

  return (
    <main className="developer-page">
      <header className="developer-header">
        <h1>Corpus admission</h1>
        <p>Every admission attempt — accepted, review, rejected, failed, pending, or cancelled — across every account. Not visible to ordinary accounts.</p>
      </header>
      <AdminCorpusSearch />
    </main>
  );
}
