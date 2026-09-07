import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Relocated under the admin console (Admin Console Phase 1) — this route is
// kept only so old links/bookmarks to /developer/reports/[id] keep working.
// The real gate + content now live at /admin/developer/reports/[id]
// (app/admin/developer/reports/[id]/page.tsx). deviceKey is forwarded as-is;
// the target page itself 404s if it's missing or invalid.
export default async function DeveloperReportInspectRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ deviceKey?: string }>;
}) {
  const { id } = await params;
  const { deviceKey } = await searchParams;
  const query = deviceKey ? `?deviceKey=${encodeURIComponent(deviceKey)}` : "";
  redirect(`/admin/developer/reports/${encodeURIComponent(id)}${query}`);
}
