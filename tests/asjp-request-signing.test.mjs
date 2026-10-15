import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { signatureValid } from '../services/asjp-matching/server.ts';
import { requestAsjpAnswer, asjpReportClientConfig } from '../lib/asjp-report-evidence.ts';

/** Phase 7 (PC / quick-tunnel hosting): HMAC request signing with a fresh timestamp and a single-use nonce. */
const KEY = 'signing-key-'.padEnd(48, 'k');
const headersFor = (body, { key = KEY, ts = String(Date.now()), nonce = [...Array(32)].map((_, i) => '0123456789abcdef'[(i * 7 + Date.now()) % 16]).join('') } = {}) => ({
  'x-asjp-timestamp': ts, 'x-asjp-nonce': nonce,
  'x-asjp-signature': createHmac('sha256', key).update(`${ts}\n${nonce}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex'),
});
const req = (headers) => ({ headers });
let n = 0; const nonce = () => (++n).toString(16).padStart(32, 'a');

test('a correctly signed request passes once; its replay, a stale or future timestamp, a changed body, another key, missing headers all fail', () => {
  const body = JSON.stringify({ text: 'controlled test text' });
  const h = headersFor(body, { nonce: nonce() });
  assert.equal(signatureValid(req(h), body, KEY, 300_000), true);
  assert.equal(signatureValid(req(h), body, KEY, 300_000), false, 'replayed nonce');
  assert.equal(signatureValid(req(headersFor(body, { nonce: nonce(), ts: String(Date.now() - 400_000) })), body, KEY, 300_000), false, 'stale');
  assert.equal(signatureValid(req(headersFor(body, { nonce: nonce(), ts: String(Date.now() + 400_000) })), body, KEY, 300_000), false, 'future');
  assert.equal(signatureValid(req(headersFor(body, { nonce: nonce() })), body + ' ', KEY, 300_000), false, 'body changed');
  assert.equal(signatureValid(req(headersFor(body, { nonce: nonce(), key: 'other-'.padEnd(48, 'x') })), body, KEY, 300_000), false, 'other key');
  assert.equal(signatureValid(req({}), body, KEY, 300_000), false, 'unsigned');
  assert.equal(signatureValid(req({ ...headersFor(body, { nonce: nonce() }), 'x-asjp-signature': 'zz' }), body, KEY, 300_000), false, 'malformed');
});

test('the report client signs every request (fresh nonce each time) when ASJP_SERVICE_REQUEST_SIGNING_KEY is set', async () => {
  const seen = [];
  const server = http.createServer((r, res) => { let raw = ''; r.on('data', (c) => { raw += c; }); r.on('end', () => { seen.push({ valid: signatureValid(r, raw, KEY, 300_000), nonce: r.headers['x-asjp-nonce'] }); res.end(JSON.stringify({ state: 'BUSY', failureCode: 'ASJP_BUSY' })); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const config = asjpReportClientConfig({ ASJP_REPORT_EVIDENCE_ENABLED: 'true', ASJP_SERVICE_URL: `http://127.0.0.1:${server.address().port}`, ASJP_SERVICE_TOKEN: 't', ASJP_PINNED_GENERATION_ID: 'g', ASJP_PINNED_MANIFEST_SHA256: 'm', ASJP_EVIDENCE_SIGNING_KEY: 'e'.repeat(40), ASJP_SERVICE_REQUEST_SIGNING_KEY: KEY });
    assert.equal(config.requestSigningKey, KEY);
    await requestAsjpAnswer(config.url, config.token, { text: 'a' }, 2000, {}, config.requestSigningKey);
    await requestAsjpAnswer(config.url, config.token, { text: 'a' }, 2000, {}, config.requestSigningKey);
    assert.deepEqual(seen.map((s) => s.valid), [true, true]);
    assert.notEqual(seen[0].nonce, seen[1].nonce);
    await requestAsjpAnswer(config.url, config.token, { text: 'a' }, 2000);
    assert.equal(seen[2].valid, false, 'an unsigned request does not verify');
  } finally { server.close(); }
});
