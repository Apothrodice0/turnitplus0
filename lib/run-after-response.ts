import { after } from "next/server";

/**
 * Runs `work` without delaying the caller's HTTP response, using Next.js's
 * built-in after() (stable since Next 15; backed by Vercel's waitUntil in
 * production, and by Next's own internal deferred-task tracking under
 * `next dev`/`next start`). This project has no queue/background-job
 * infrastructure (no Redis, BullMQ, Inngest, QStash — checked before writing
 * this), so after() is the smallest correct answer: zero new dependencies,
 * zero new services, already shipped by the framework already in use.
 *
 * after() requires an active Next.js request scope (Server Component render,
 * Route Handler, Server Action, or Middleware) and throws synchronously
 * outside one — which is exactly how every route handler in this project's
 * test suite is invoked (`await someRoute.POST(request)`, a plain function
 * call with no real Next.js server underneath). Rather than let that break
 * every existing/'future test that saves a report, the fallback below runs
 * the same `work` inline and awaits it, so:
 *  - in production (real request scope): the response is sent first, then
 *    `work` runs during the same invocation without blocking it.
 *  - in tests (no request scope): `work` runs to completion before
 *    runAfterResponse's own promise resolves, so a test can await the route
 *    handler and immediately assert on `work`'s effects — no polling for a
 *    background task that was never actually scheduled outside a real
 *    server.
 * Either way, `work` itself is responsible for handling its own errors if it
 * needs "best-effort, never fail the response" semantics — this helper does
 * not swallow rejections, since after() itself does not either.
 */
export async function runAfterResponse(work: () => Promise<void>): Promise<void> {
  try {
    after(work);
  } catch {
    await work();
  }
}
