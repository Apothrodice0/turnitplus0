import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { SESSION_COOKIE_NAME, getAdminSessionUserByToken } from "@/lib/auth-session";
import { getReportsDbClient } from "@/lib/reports-db";
import { DeveloperLookupSearch } from "@/components/developer/lookup-search";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: "Article lookup · Developer · TurnitPlus", robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } } };
}

export default async function DeveloperLookupPage() {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null;
  if (!token) notFound();

  const client = await getReportsDbClient();
  try {
    const admin = await getAdminSessionUserByToken(token, client);
    if (!admin) notFound();
  } finally {
    client.close();
  }

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
