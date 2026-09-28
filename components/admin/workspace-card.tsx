import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * One large icon card on the /admin launcher — opens a workspace. `children`
 * (optional) is a live at-a-glance block rendered under the description, and
 * `ctaLabel` (optional) names the action beside the arrow; a card without
 * either renders exactly as before.
 */
export function AdminWorkspaceCard({
  href,
  icon: Icon,
  title,
  description,
  children,
  ctaLabel,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
  children?: ReactNode;
  ctaLabel?: string;
}) {
  return (
    <Link href={href} className="admin-workspace-card">
      <span className="admin-workspace-card-icon">
        <Icon size={26} />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
      <span className="admin-workspace-card-arrow">
        {ctaLabel && <span className="admin-workspace-card-cta">{ctaLabel}</span>}
        <ChevronRight size={18} />
      </span>
    </Link>
  );
}
