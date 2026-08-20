import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * "Confirmed production discrepancy" investigation: pdfjs-dist's Node
   * ("legacy") build needs its own pdf.worker.mjs resolvable at a path
   * relative to pdf.mjs's real on-disk location — that is how it sets up
   * its synchronous "fake worker" fallback when no browser Worker API is
   * available (the Node/server case, exercised here by
   * lib/http-content-retriever.ts's PDF-content-type branch). Turbopack's
   * server bundling pulls pdf.mjs's code into a single chunk file but does
   * not carry pdf.worker.mjs along to the path pdf.mjs computes at
   * runtime, so `pdfjs.getDocument(...)` throws "Setting up fake worker
   * failed: Cannot find module '.../.next/server/chunks/pdf.worker.mjs'"
   * — confirmed live: every retrieval of a real candidate PDF failed this
   * way when run through the actual built server, while the identical
   * code succeeded every time run as a plain (unbundled) Node script.
   * serverExternalPackages is Next.js's own documented mechanism for
   * exactly this class of package (needs a co-located file its own code
   * resolves at a relative path, not just plain JS a bundler can inline):
   * it excludes pdfjs-dist from server bundling entirely, so it is
   * require()/import()-ed normally from node_modules at runtime instead —
   * the same resolution path the working standalone-script case already
   * relies on.
   */
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
