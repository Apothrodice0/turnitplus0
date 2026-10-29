import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { UserCheck } from "lucide-react";
import { loadAdminGate } from "@/lib/admin-gate";
import { AdminHeader } from "@/components/admin/admin-header";
import { accountActivationEnforced } from "@/lib/account-entitlements";
import { AccountActivationConsole } from "@/components/admin/account-activation/account-activation-console";

export const dynamic = "force-dynamic";

// Same gate as every app/admin/* page: a non-admin (or signed-out) visitor gets the plain 404 a nonexistent route
// would, and no page-identifying title. The API routes behind this console enforce the same gate on their own.
export async function generateMetadata(): Promise<Metadata> {
  const admin = await loadAdminGate();
  if (!admin) return {};
  return { title: "Subscriptions · Admin · TurnitPlus", robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } } };
}

export default async function AccountActivationPage() {
  const admin = await loadAdminGate();
  if (!admin) notFound();

  return (
    <main className="developer-page admin-activation-page">
      <AdminHeader
        icon={UserCheck}
        title="Accounts & Subscriptions"
        description="Activate a registered, verified customer after arranging payment with them directly. Choose the plan duration and how many rooms the account receives; renew, adjust, suspend or reactivate it later."
      />
      <AccountActivationConsole enforcement={accountActivationEnforced()} />
    </main>
  );
}
