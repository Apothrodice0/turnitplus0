import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** One large icon card on the /admin launcher — opens a workspace. */
export function AdminWorkspaceCard({
  href,
  icon: Icon,
  title,
  description,
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <Link href={href} className="admin-workspace-card">
      <span className="admin-workspace-card-icon">
        <Icon size={26} />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      <span className="admin-workspace-card-arrow">
        <ChevronRight size={18} />
      </span>
    </Link>
  );
}
