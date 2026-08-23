import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * Release-hardening audit finding HDR-01: no response anywhere set any
 * browser-security header before this change. next.config.ts's headers()
 * function applies at Next.js's own request pipeline, outside any route
 * handler — a direct import-and-call test of a route handler (this
 * codebase's usual pattern, e.g. tests/api-auth.test.mjs) cannot observe
 * it at all, so this suite is structural (matching the same "read source,
 * assert on it" convention tests/database-isolation.test.mjs and
 * tests/report-detail-route.test.mjs already use for properties that
 * aren't reachable by directly calling a handler).
 *
 * This was ALSO verified live in this same release-hardening pass: a real
 * `next build && next start` production server was curled against the
 * homepage, an authenticated API route (GET /api/reports/rooms), and the
 * closed /api/ingest route's 404 — every enforced header below was present
 * and correctly formed on all three, including the 404. See this release's
 * own audit report for the exact captured header output. The live pass
 * also fetched the real rendered homepage HTML and confirmed: 2 inline
 * <script> tags exist (Next's own hydration payload — a REAL, expected
 * Report-Only script-src 'self' violation, not silently worked around),
 * 0 inline style="" attributes on that specific page (other pages/states
 * do use React's style={{}} prop per source grep — see next.config.ts's
 * own header comment), and 0 external-domain references in the initial
 * HTML (the unpkg.com PDF worker loads lazily, only once a PDF is opened).
 */

async function readConfig() {
  return readFile(new URL('../next.config.ts', import.meta.url), 'utf8');
}

test('ENFORCED_SECURITY_HEADERS is applied to every route via headers()', async () => {
  const source = await readConfig();
  assert.match(source, /async headers\(\)/, 'next.config.ts must export a headers() function');
  const headersFnMatch = source.match(/async headers\(\) \{[\s\S]*?\n {2}\},/);
  assert.ok(headersFnMatch, 'headers() function body must be found');
  assert.match(headersFnMatch[0], /source:\s*["']\/:path\*["']/, 'the header set must apply to every route (source: "/:path*"), not a subset');
  assert.match(headersFnMatch[0], /headers:\s*ENFORCED_SECURITY_HEADERS/);
});

test('the four always-on headers are present with the exact required values', async () => {
  const source = await readConfig();
  assert.match(source, /\{ key: "X-Frame-Options", value: "DENY" \}/);
  assert.match(source, /\{ key: "X-Content-Type-Options", value: "nosniff" \}/);
  assert.match(source, /\{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" \}/);
  assert.match(source, /key: "Permissions-Policy"/);
});

test('Permissions-Policy disables every unused browser capability this app never touches', async () => {
  const source = await readConfig();
  const policyMatch = source.match(/key: "Permissions-Policy",\s*value: \[([\s\S]*?)\]\.join/);
  assert.ok(policyMatch, 'Permissions-Policy directive list must be found');
  const directives = policyMatch[1];
  for (const capability of [
    'camera', 'microphone', 'geolocation', 'payment', 'usb', 'bluetooth',
    'magnetometer', 'gyroscope', 'accelerometer', 'ambient-light-sensor',
    'midi', 'clipboard-write', 'fullscreen', 'interest-cohort',
  ]) {
    assert.match(directives, new RegExp(`${capability}=\\(\\)`), `Permissions-Policy must disable ${capability}`);
  }
});

test('the enforced Content-Security-Policy contains ONLY the four named low-breakage directives — not a broader policy', async () => {
  const source = await readConfig();
  const enforcedCspMatch = source.match(/key: "Content-Security-Policy",\s*value: \[([\s\S]*?)\]\.join\("; "\),/);
  assert.ok(enforcedCspMatch, 'the enforced Content-Security-Policy directive must be found');
  const directives = enforcedCspMatch[1];
  assert.match(directives, /base-uri 'self'/);
  assert.match(directives, /object-src 'none'/);
  assert.match(directives, /frame-ancestors 'none'/);
  assert.match(directives, /form-action 'self'/);
  // Deliberately must NOT contain script-src/style-src/default-src/connect-src
  // yet — those belong only in the Report-Only policy below.
  assert.doesNotMatch(directives, /script-src|style-src|default-src|connect-src/, 'the enforced CSP must stay minimal — broader directives belong in Report-Only mode first');
});

test('the broader intended policy is Report-Only, never enforced, and covers every external resource this app actually loads', async () => {
  const source = await readConfig();
  assert.match(source, /key: "Content-Security-Policy-Report-Only"/, 'the broader policy must use the Report-Only header, not Content-Security-Policy');
  const reportOnlyMatch = source.match(/key: "Content-Security-Policy-Report-Only",\s*value: \[([\s\S]*?)\]\.join\("; "\),/);
  assert.ok(reportOnlyMatch, 'the Report-Only directive list must be found');
  const directives = reportOnlyMatch[1];
  assert.match(directives, /default-src 'self'/);
  assert.match(directives, /script-src 'self'/);
  assert.match(directives, /style-src 'self'/);
  assert.match(directives, /connect-src 'self'/);
  // The one confirmed external resource this app's browser code loads —
  // lib/document-check-pipeline.ts's pdf.js worker.
  assert.match(directives, /worker-src 'self' https:\/\/unpkg\.com/);
  assert.match(directives, /img-src 'self' data:/);
  assert.match(directives, /font-src 'self'/);
});

test('no Strict-Transport-Security header was added — HSTS is deliberately deferred pending Vercel-side verification', async () => {
  const source = await readConfig();
  // Strip comments first — this file's own header comment legitimately
  // narrates the HSTS decision by name; only an actual { key: "..." }
  // header entry may fail this check.
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(withoutComments, /Strict-Transport-Security/, 'HSTS must not be added until it is verified Vercel is not already supplying it for every affected subdomain');
});

test('lib/document-check-pipeline.ts is still the only source of the unpkg.com worker reference the Report-Only policy allows for', async () => {
  const { execSync } = await import('node:child_process');
  const grep = execSync('grep -rl "unpkg.com" lib/ app/ components/ 2>&1 || true', { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  const files = grep.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).sort();
  assert.deepEqual(files, ['lib/document-check-pipeline.ts'], 'a new unpkg.com (or other external) reference must be reviewed against the Report-Only worker-src allowance before this test is updated');
});
