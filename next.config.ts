import type { NextConfig } from "next";

/**
 * Release-hardening audit finding HDR-01: no response anywhere set any
 * browser-security header before this change. Split deliberately into two
 * tiers, per the task's own explicit instruction not to blindly enforce a
 * full CSP in one step:
 *
 * 1. ENFORCED headers/directives — X-Frame-Options, X-Content-Type-Options,
 *    Referrer-Policy, a restrictive Permissions-Policy, and only the four
 *    named low-breakage CSP directives (base-uri/object-src/frame-ancestors/
 *    form-action). None of these can plausibly break this app: it never
 *    frames itself or is meant to be framed, never MIME-sniffs, never
 *    navigates via a <base> tag, never plugin-embeds anything, and every
 *    <form> (login/signup/upload) already only ever submits to itself.
 *
 * 2. REPORT-ONLY broader policy (Content-Security-Policy-Report-Only) —
 *    default-src/script-src/style-src/connect-src/worker-src/img-src/
 *    font-src, built from a full source-level audit of every external
 *    resource this app's pages actually load:
 *      - No Google Fonts or any other external font (grepped for
 *        fonts.googleapis.com/@font-face across app/ and components/ —
 *        zero hits).
 *      - Exactly one external script/worker origin anywhere:
 *        lib/document-check-pipeline.ts loads the pdf.js worker from
 *        unpkg.com (pdfjs.GlobalWorkerOptions.workerSrc) — hence
 *        worker-src also allowing https://unpkg.com.
 *      - Every fetch() in every "use client" component targets this app's
 *        own /api/* routes only (grepped every client component; no
 *        third-party fetch target found) — connect-src 'self' covers it.
 *      - No <img> tag anywhere in app/ or components/ — img-src stays
 *        default-equivalent (self + data:, for the one confirmed
 *        createObjectURL()/blob use in lib/document-check-pipeline.ts's
 *        receipt download).
 *    This is Report-Only specifically because a genuine, expected gap was
 *    already found by this same source audit: several components
 *    (app/page.tsx, report-detail-shell.tsx, ai-report.tsx,
 *    similarity-report-papers.tsx, document-upload-panel.tsx) use React's
 *    style={{...}} prop, which renders as inline style="..." attributes —
 *    a real style-src violation this Report-Only pass exists to surface,
 *    not silently work around. Promoting this to enforced is deliberately
 *    left for a follow-up pass once real violation reports (or a nonce/
 *    'unsafe-inline' decision for style-src specifically) have been
 *    reviewed — see this release's own audit report for the verification
 *    performed against a real production build.
 *
 * No HSTS here: Vercel's edge network adds Strict-Transport-Security to
 * every response for a project's production domains by default — adding
 * an app-level one risks a conflicting/duplicate value and was explicitly
 * out of scope for this pass pending that verification.
 */
const ENFORCED_SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "bluetooth=()",
      "magnetometer=()",
      "gyroscope=()",
      "accelerometer=()",
      "ambient-light-sensor=()",
      "midi=()",
      "clipboard-write=()",
      "fullscreen=()",
      "interest-cohort=()",
    ].join(", "),
  },
  {
    key: "Content-Security-Policy",
    value: [
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; "),
  },
  {
    key: "Content-Security-Policy-Report-Only",
    value: [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "worker-src 'self' https://unpkg.com",
      "img-src 'self' data:",
      "font-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; "),
  },
];

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

  async headers() {
    return [
      {
        source: "/:path*",
        headers: ENFORCED_SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
