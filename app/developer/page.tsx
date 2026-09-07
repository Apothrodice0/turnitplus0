import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Relocated under the admin console (Admin Console Phase 1) — this route is
// kept only so old links/bookmarks to /developer keep working. The real
// gate + content now live at /admin/developer (app/admin/developer/page.tsx).
export default function DeveloperOverviewRedirect() {
  redirect("/admin/developer");
}
