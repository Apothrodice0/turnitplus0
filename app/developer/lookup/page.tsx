import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Relocated under the admin console (Admin Console Phase 1) — this route is
// kept only so old links/bookmarks to /developer/lookup keep working. The
// real gate + content now live at /admin/developer/lookup
// (app/admin/developer/lookup/page.tsx).
export default function DeveloperLookupRedirect() {
  redirect("/admin/developer/lookup");
}
