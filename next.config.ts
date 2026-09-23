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

  /**
   * Hosted imported-similarity-evidence delivery
   * (scripts/materialize-imported-similarity-evidence.mjs,
   * lib/imported-similarity-evidence/config.ts): the materialized package
   * path is read at RUNTIME from a value Next's own static output-file
   * tracing cannot see (a build-time-written file, resolved dynamically via
   * `existsSync`/`readFileSync` on a path computed in
   * lib/imported-similarity-evidence/materialized-path.ts — never a static
   * `import`/`require` literal tracing could follow on its own). Without
   * this, a materialized file present at build time could still be pruned
   * from the deployed serverless function output.
   *
   * Explicit per-route keys, one per confirmed real caller of
   * resolvePrimarySimilaritySummary() (the only path into the loader),
   * instead of a broad /api/**\/* catch-all — verified with Graphify +
   * source against every export from lib/report-primary-similarity.ts,
   * lib/developer-repo.ts, and lib/selective-corpus-authoritative.ts, and
   * proven against real `.next/**\/*.nft.json` output:
   *   - /api/reports              — app/api/reports/route.ts POST (report
   *     create/resave)
   *   - /api/developer/reports/*  — app/api/developer/reports/[id]/route.ts
   *     GET -> getReportSimilarityDecisionTrace()
   *   - /api/internal/selective-corpus-authoritative-sweep — ->
   *     finalizeSelectiveCorpusAuthoritativeReport() ->
   *     resolvePrimarySimilaritySummary()
   *   - /admin/developer/reports/* — an App Router PAGE (force-dynamic,
   *     Node runtime), not under /api/* at all — DeveloperReportInspectPage()
   *     calls getReportSimilarityDecisionTrace() at render time. A prior
   *     /api/**\/*-only version of this config silently missed this one
   *     (proven via a real build's .nft.json trace containing zero
   *     "turnitplus" entries for this route despite its own compiled SSR
   *     chunk containing the path-resolution code) — this is why this route
   *     is listed explicitly rather than assumed covered by a wildcard.
   *
   * A literal `[id]` dynamic-segment key (e.g. "/api/developer/reports/[id]")
   * was tried first and DID NOT get traced by this project's actual
   * `next build` (Next 16.3.2, Turbopack) — confirmed by a real build whose
   * generated `.nft.json` for that exact route came back with zero
   * "turnitplus" entries, even though a standalone simulation against Next's
   * own bundled `picomatch` (next/dist/compiled/picomatch, the engine
   * collect-build-traces.js calls) said it should match. Turbopack's actual
   * route-trace matching evidently does not special-case bracket segments
   * the same way. A single-path-segment `*` wildcard in that position
   * (matching any one segment, not crossing `/`) was verified instead —
   * re-built with it, re-inspected `.nft.json` for all 4 target routes,
   * confirmed present in every one. Route-key correctness here is proven
   * against real generated build output only, never assumed from config
   * shape or JS-level glob-library behavior alone.
   *
   * Real-build side effect, also measured (not assumed): with `contains`-style
   * matching and no right-side anchor, "/api/reports" also (harmlessly)
   * matches its own dynamic children /api/reports/[id],
   * /api/reports/[id]/ai-retry, and /api/reports/rooms, and
   * "/api/developer/reports/*" also matches its own sibling list route
   * /api/developer/reports (no [id]) — 4 extra Node routes total, all in the
   * same two already-closely-related report-handling families, confirmed via
   * a full scan of every generated `.nft.json` in the build (8 of 51 routes
   * total carry the file, down from all 35 `/api/**` routes under the
   * previous /api/**\/* -only config). Eliminating those 4 would need
   * additional outputFileTracingExcludes entries for a cosmetic-only gain;
   * left as the simplest config that is proven to cover every required
   * route. Matches nothing (costs nothing) when the materializer is a
   * no-op, which is every deployment today.
   */
  outputFileTracingIncludes: {
    "/api/reports": [".turnitplus/imported-similarity-evidence/**/*"],
    "/api/developer/reports/*": [".turnitplus/imported-similarity-evidence/**/*"],
    "/api/internal/selective-corpus-authoritative-sweep": [".turnitplus/imported-similarity-evidence/**/*"],
    "/admin/developer/reports/*": [".turnitplus/imported-similarity-evidence/**/*"],
  },

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
