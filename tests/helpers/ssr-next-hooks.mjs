// Module-resolution hook used by tests that execute a REAL Next.js Server Component
// (app/reports/[id]/page.tsx, the admin developer inspector) under plain Node.
//
// `next/headers`, `next/navigation` and `next/link` need a live Next request context
// (cookies()/headers() throw outside one), so they are redirected to
// ./ssr-next-stubs.mjs, whose request state the test sets directly. Everything else —
// the page, its loaders, the DB, the decoder — is the real code, unmodified.
//
// Register it BEFORE importing the page:
//   import { register } from "node:module";
//   register("./helpers/ssr-next-hooks.mjs", import.meta.url);
const STUBS_URL = new URL("./ssr-next-stubs.mjs", import.meta.url).href;
const STUBBED = new Set(["next/headers", "next/navigation", "next/link"]);

export async function resolve(specifier, context, nextResolve) {
  if (STUBBED.has(specifier)) return { url: STUBS_URL, shortCircuit: true };
  return nextResolve(specifier, context);
}
