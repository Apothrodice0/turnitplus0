import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { asjpReportClientConfig, asjpReportClientConfigProblem, requestAsjpAnswer, checkAsjpForReport } from '../lib/asjp-report-evidence.ts';

/** Phase 7: the report path's ASJP client configuration (environment only) and the Cloudflare Access headers. */
const base = { ASJP_REPORT_EVIDENCE_ENABLED: 'true', ASJP_SERVICE_URL: 'https://asjp.example', ASJP_SERVICE_TOKEN: 't', ASJP_PINNED_GENERATION_ID: 'g', ASJP_PINNED_MANIFEST_SHA256: 'm', ASJP_EVIDENCE_SIGNING_KEY: 'k'.repeat(40) };

test('config: complete -> usable; each missing piece is named; ASJP off -> null without a problem', () => {
  assert.equal(asjpReportClientConfigProblem(base), null);
  assert.ok(asjpReportClientConfig(base));
  for (const [k, problem] of [['ASJP_SERVICE_URL', 'ASJP_SERVICE_URL'], ['ASJP_SERVICE_TOKEN', 'ASJP_SERVICE_TOKEN'], ['ASJP_PINNED_GENERATION_ID', 'ASJP_PINNED_GENERATION'], ['ASJP_EVIDENCE_SIGNING_KEY', 'ASJP_EVIDENCE_SIGNING_KEY']]) {
    const env = { ...base }; delete env[k];
    assert.equal(asjpReportClientConfigProblem(env), problem, k);
    assert.equal(asjpReportClientConfig(env), null);
  }
  assert.equal(asjpReportClientConfigProblem({}), null);
  assert.equal(asjpReportClientConfig({}), null);
  assert.equal(asjpReportClientConfig({ ...base, ASJP_SERVICE_TIMEOUT_MS: 'abc' }).timeoutMs, 8000, 'a non-numeric timeout falls back to 8 s');
});

test('Cloudflare Access service-token headers: both or neither; sent on every request; a half configuration is refused', async () => {
  assert.equal(asjpReportClientConfigProblem({ ...base, ASJP_SERVICE_ACCESS_CLIENT_ID: 'id' }), 'ASJP_SERVICE_ACCESS_CLIENT');
  assert.deepEqual(asjpReportClientConfig(base).accessHeaders, {});
  const config = asjpReportClientConfig({ ...base, ASJP_SERVICE_ACCESS_CLIENT_ID: 'id-1', ASJP_SERVICE_ACCESS_CLIENT_SECRET: 'secret-1' });
  let seen = null;
  const server = http.createServer((req, res) => { seen = { id: req.headers['cf-access-client-id'], secret: req.headers['cf-access-client-secret'], auth: req.headers.authorization }; res.end(JSON.stringify({ state: 'BUSY', failureCode: 'ASJP_BUSY' })); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const record = await checkAsjpForReport({ text: 'a b c', wordCount: 3 }, { ...config, url: `http://127.0.0.1:${server.address().port}` });
    assert.deepEqual(seen, { id: 'id-1', secret: 'secret-1', auth: 'Bearer t' });
    assert.equal(record.status, 'UNAVAILABLE'); assert.equal(record.reason, 'ASJP_BUSY');
    const direct = await requestAsjpAnswer(`http://127.0.0.1:${server.address().port}`, 't', { text: 'x' }, 2000);
    assert.equal(direct.failureCode, 'ASJP_BUSY');
  } finally { server.close(); }
});
