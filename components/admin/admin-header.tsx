import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Shared header for every workspace under /admin — icon + title + short
 * description, plus a "Back to Admin" (or a caller-chosen back target)
 * link above it. Purely presentational; every caller still runs its own
 * loadAdminGate()/loadDeveloperGate() check before rendering this.
 */
export function AdminHeader({
  icon: Icon,
  title,
  description,
  backHref = "/admin",
  backLabel = "Back to Admin",
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  backHref?: string | null;
  backLabel?: string;
}) {
  return (
    <>
      {backHref && (
        <Link href={backHref} className="admin-back-link">
          <ArrowLeft size={15} />
          {backLabel}
        </Link>
      )}
      <header className="admin-header">
        <span className="admin-header-icon">
          <Icon size={22} />
        </span>
        <div className="admin-header-text">
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
      </header>
    </>
  );
}
