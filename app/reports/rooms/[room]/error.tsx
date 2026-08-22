"use client";

import { useEffect } from "react";
import { RouteErrorPanel } from "@/components/report/route-error-panel";

// Production audit fix — see components/report/route-error-panel.tsx's own
// header comment for why this exists at all. Most realistically catches a
// transient DB connectivity error while loading this room's occupant,
// which "Try again" can actually resolve.
export default function RoomPageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Room page failed to render:", error);
  }, [error]);

  return <RouteErrorPanel reset={reset} message="This room could not be loaded right now." />;
}
