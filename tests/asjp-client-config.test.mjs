import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { asjpReportClientConfig, asjpReportClientConfigProblem, requestAsjpAnswer, checkAsjpForReport } from '../lib/asjp-report-evidence.ts';

/**
 * Phase 7: the report path's ASJP client configuration (environment only) and the Cloudflare Access headers.
 * Remediation A1 / C1: https only (plain http to loopback only), strong credentials (>= 32 characters, >= 12 distinct),
 * a request-signing key REQUIRED for any non-loopback service, and the database-host pin (required on a Vercel Preview).
 */
const strong = () => randomBytes(32).toString('hex');
const base = { ASJP_REPORT_EVIDENCE_ENABLED: 'true', ASJP_SERVICE_URL: 'https://asjp.example', ASJP_SERVICE_TOKEN: strong(), ASJP_SERVICE_REQUEST_SIGNING_KEY: strong(), ASJP_PINNED_GENERATION_ID: 'g', ASJP_PINNED_MANIFEST_SHA256: 'm', ASJP_EVIDENCE_SIGNING_KEY: strong() };

test('config: complete -> usable; each missing piece is named; ASJP off -> null without a problem', () => {
  assert.equal(asjpReportClientConfigProblem(base), null);
  assert.ok(asjpReportClientConfig(base));
  for (const [k, problem] of [['ASJP_SERVICE_URL', 'ASJP_SERVICE_URL'], ['ASJP_SERVICE_TOKEN', 'ASJP_SERVICE_TOKEN'], ['ASJP_SERVICE_REQUEST_SIGNING_KEY', 'ASJP_SERVICE_REQUEST_SIGNING_KEY'], ['ASJP_PINNED_GENERATION_ID', 'ASJP_PINNED_GENERATION'], ['ASJP_EVIDENCE_SIGNING_KEY', 'ASJP_EVIDENCE_SIGNING_KEY']]) {
    const env = { ...base }; delete env[k];
    assert.equal(asjpReportClientConfigProblem(env), problem, k);
    assert.equal(asjpReportClientConfig(env), null);
  }
  assert.equal(asjpReportClientConfigProblem({}), null);
  assert.equal(asjpReportClientConfig({}), null);
  assert.equal(asjpReportClientConfig({ ...base, ASJP_SERVICE_TIMEOUT_MS: 'abc' }).timeoutMs, 8000, 'a non-numeric timeout falls back to 8 s');
});

test('A1: https only (http to loopback only), no credentials or query in the URL; strong credentials; a signing key for any remote service', () => {
  assert.equal(asjpReportClientConfigProblem({ ...base, ASJP_SERVICE_URL: 'http://example.invalid' }), 'ASJP_SERVICE_URL', 'plain http to a remote host');
  assert.equal(asjpReportClientConfigProblem({ ...base, ASJP_SERVICE_URL: 'https://user:pw@asjp.example' }), 'ASJP_SERVICE_URL');
  assert.equal(asjpReportClientConfigProblem({ ...base, ASJP_SERVICE_URL: 'https://asjp.example/?t=1' }), 'ASJP_SERVICE_URL');
  assert.equal(asjpReportClientConfigProblem({ ...base, ASJP_SERVICE_URL: 'ftp://asjp.example' }), 'ASJP_SERVICE_URL');
  assert.equal(asjpReportClientConfigProblem({ ...base, ASJP_SERVICE_URL: 'http://127.0.0.1:47500' }), null, 'loopback http is allowed (the PC itself, tests)');
  assert.equal(asjpReportClientConfigProblem({ ...base, ASJP_SERVICE_REQUEST_SIGNING_KEY: 'x' }), 'ASJP_SERVICE_REQUEST_SIGNING_KEY', 'a 1-character request key');
  assert.equal(asjpReportClientConfigProblem({ ...base, ASJP_SERVICE_REQUEST_SIGNING_KEY: 'k'.repeat(64) }), 'ASJP_SERVICE_REQUEST_SIGNING_KEY', 'a low-entropy request key');
  assert.equal(asjpReportClientConfigProblem({ ...base, ASJP_SERVICE_TOKEN: 't' }), 'ASJP_SERVICE_TOKEN', 'a weak bearer token');
  const remoteNoKey = { ...base }; delete remoteNoKey.ASJP_SERVICE_REQUEST_SIGNING_KEY;
  assert.equal(asjpReportClientConfigProblem({ ...remoteNoKey, ASJP_SERVICE_URL: 'http://127.0.0.1:1' }), null, 'only loopback may go unsigned');
});

test('C1: the database-host pin — required on a Vercel Preview, and ASJP refuses any other database (never a silent fallback)', () => {
  const preview = { ...base, VERCEL_ENV: 'preview', TURSO_DATABASE_URL: 'libsql://turnitplus-asjp-preview-x.aws-eu-west-1.turso.io' };
  assert.equal(asjpReportClientConfigProblem(preview), 'ASJP_REQUIRED_DB_HOST', 'a Preview without the pin');
  assert.equal(asjpReportClientConfigProblem({ ...preview, ASJP_REQUIRED_DB_HOST: 'turnitplus-asjp-preview-x.aws-eu-west-1.turso.io' }), null);
  assert.equal(asjpReportClientConfigProblem({ ...preview, ASJP_REQUIRED_DB_HOST: 'turnitplus-asjp-preview-x.aws-eu-west-1.turso.io', TURSO_DATABASE_URL: 'libsql://turnitplus-preview-shared.aws-eu-west-1.turso.io' }), 'ASJP_REQUIRED_DB_HOST', 'an inherited shared Preview database');
});

test('Cloudflare Access service-token headers: both or neither; sent on every request; a half configuration is refused', async () => {
  assert.equal(asjpReportClientConfigProblem({ ...base, ASJP_SERVICE_ACCESS_CLIENT_ID: 'id' }), 'ASJP_SERVICE_ACCESS_CLIENT');
  assert.deepEqual(asjpReportClientConfig(base).accessHeaders, {});
  let seen = null;
  const server = http.createServer((req, res) => { seen = { id: req.headers['cf-access-client-id'], secret: req.headers['cf-access-client-secret'], auth: req.headers.authorization }; res.end(JSON.stringify({ state: 'BUSY', failureCode: 'ASJP_BUSY' })); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const loopback = { ...base, ASJP_SERVICE_URL: `http://127.0.0.1:${server.address().port}`, ASJP_SERVICE_ACCESS_CLIENT_ID: 'id-1', ASJP_SERVICE_ACCESS_CLIENT_SECRET: 'secret-1' };
    delete loopback.ASJP_SERVICE_REQUEST_SIGNING_KEY; // an unsigned loopback stub (signed exchanges: tests/asjp-request-signing)
    const config = asjpReportClientConfig(loopback);
    const record = await checkAsjpForReport({ text: 'a b c', wordCount: 3 }, config);
    assert.deepEqual(seen, { id: 'id-1', secret: 'secret-1', auth: `Bearer ${base.ASJP_SERVICE_TOKEN}` });
    assert.equal(record.status, 'UNAVAILABLE'); assert.equal(record.reason, 'ASJP_BUSY');
    const direct = await requestAsjpAnswer(config.url, config.token, { text: 'x' }, 2000);
    assert.equal(direct.failureCode, 'ASJP_BUSY');
  } finally { server.close(); }
});
