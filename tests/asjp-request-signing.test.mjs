import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { asjpRequestVerifier } from '../services/asjp-matching/server.ts';
import { requestAsjpAnswer } from '../lib/asjp-report-evidence.ts';
import { asjpRequestMac, asjpResponseMac, asjpCredentialProblem, sha256Hex } from '../lib/asjp-service-protocol.ts';

/**
 * Phase 7 remediation A1 / A2 — ASJP service wire protocol v2: signed requests (method, path, Host, timestamp,
 * single-use nonce, raw body bytes), signed answers bound to the request, and a manuscript-free attestation before any
 * manuscript or bearer token is sent. Local fixtures only (127.0.0.1 servers standing in for a live / expired tunnel).
 */
const KEY = randomBytes(32).toString('hex');
const TOKEN = randomBytes(32).toString('hex');
const OTHER_KEY = randomBytes(32).toString('hex');
let n = 0; const nonce = () => (++n).toString(16).padStart(32, '0');
const signed = (body, { key = KEY, method = 'POST', path = '/match', host = 'svc.example', ts = String(Date.now()), nonce: nn = nonce() } = {}) => ({
  method, url: path, headers: { host, 'x-asjp-timestamp': ts, 'x-asjp-nonce': nn, 'x-asjp-signature': asjpRequestMac(key, { method, path, host, ts, nonce: nn, bodySha256: sha256Hex(Buffer.from(body)) }) },
});

test('request verifier: once only; stale, future, pre-restart, changed body / path / method / host, other key, unsigned and malformed all refused', () => {
  const verify = asjpRequestVerifier(KEY, 120_000, Date.now() - 1000);
  const body = JSON.stringify({ text: 'controlled test text' });
  const r = signed(body);
  assert.ok(verify(r, Buffer.from(body)), 'a correctly signed request passes');
  assert.equal(verify(r, Buffer.from(body)), null, 'replayed nonce');
  assert.equal(verify(signed(body, { ts: String(Date.now() - 200_000) }), Buffer.from(body)), null, 'stale');
  assert.equal(verify(signed(body, { ts: String(Date.now() + 200_000) }), Buffer.from(body)), null, 'future');
  const fresh = asjpRequestVerifier(KEY, 120_000, Date.now());
  assert.equal(fresh(signed(body, { ts: String(Date.now() - 5000) }), Buffer.from(body)), null, 'A2: a request signed before the service (re)started is refused');
  assert.equal(verify(signed(body), Buffer.from(body + ' ')), null, 'body changed');
  const p = signed(body); assert.equal(verify({ ...p, url: '/admin/switch' }, Buffer.from(body)), null, 'path changed');
  const m = signed(body); assert.equal(verify({ ...m, method: 'PUT' }, Buffer.from(body)), null, 'method changed');
  const h = signed(body); assert.equal(verify({ ...h, headers: { ...h.headers, host: 'new-tunnel.example' } }, Buffer.from(body)), null, 'relayed to another host');
  assert.equal(verify(signed(body, { key: OTHER_KEY }), Buffer.from(body)), null, 'other key');
  assert.equal(verify({ method: 'POST', url: '/match', headers: {} }, Buffer.from(body)), null, 'unsigned');
  const z = signed(body); assert.equal(verify({ ...z, headers: { ...z.headers, 'x-asjp-signature': 'zz' } }, Buffer.from(body)), null, 'malformed');
  // A2: the MAC covers the raw bytes — an invalid UTF-8 byte and U+FFFD no longer sign the same
  const bad = Buffer.from([0x7b, 0xff, 0x7d]), replaced = Buffer.from('{�}', 'utf8');
  const rb = signed('x');
  rb.headers['x-asjp-signature'] = asjpRequestMac(KEY, { method: 'POST', path: '/match', host: 'svc.example', ts: rb.headers['x-asjp-timestamp'], nonce: rb.headers['x-asjp-nonce'], bodySha256: sha256Hex(bad) });
  assert.equal(verify(rb, replaced), null, 'raw bytes, not a lossy decode');
});

test('credential strength: >= 32 characters, no whitespace, >= 12 distinct characters', () => {
  assert.equal(asjpCredentialProblem(randomBytes(32).toString('hex')), null);
  assert.equal(asjpCredentialProblem('a'.repeat(31)), 'TOO_SHORT');
  assert.equal(asjpCredentialProblem('k'.repeat(64)), 'LOW_ENTROPY');
  assert.equal(asjpCredentialProblem(`${randomBytes(20).toString('hex')} x`), 'WHITESPACE');
});

/** A local stand-in for the service (or for whoever holds an expired tunnel hostname). Records what it received. */
async function endpoint(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => { const raw = Buffer.concat(chunks); seen.push({ path: req.url, auth: req.headers.authorization ?? null, body: raw.toString('utf8'), headers: req.headers }); handler(req, res, raw); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}
const answer = { state: 'COMPLETE', wordCount: 3, cards: [], asjpPublicationEvidence: [] };
const reply = (req, res, raw, status, body, { key = KEY, nonceOverride, hostOverride, bodyShaOverride, statusOverride } = {}) => {
  const bytes = Buffer.from(JSON.stringify(body));
  const sig = asjpResponseMac(key, { nonce: nonceOverride ?? req.headers['x-asjp-nonce'], host: hostOverride ?? req.headers.host, requestBodySha256: bodyShaOverride ?? sha256Hex(raw), status: statusOverride ?? status, responseBodySha256: sha256Hex(bytes) });
  res.writeHead(status, { 'content-type': 'application/json', 'x-asjp-response-signature': sig }); res.end(bytes);
};

test('A1: a genuine endpoint (holds the key): attest, then the signed match; the answer is accepted', async () => {
  const ep = await endpoint((req, res, raw) => reply(req, res, raw, 200, req.url === '/attest' ? { ok: true } : answer));
  try {
    const r = await requestAsjpAnswer(ep.url, TOKEN, { text: 'a b c' }, 3000, {}, KEY);
    assert.equal(r.state, 'COMPLETE');
    assert.deepEqual(ep.seen.map((s) => s.path), ['/attest', '/match']);
    assert.equal(ep.seen[0].auth, null, 'the attestation carries no bearer token');
    assert.ok(!ep.seen[0].body.includes('a b c'), 'the attestation carries no manuscript');
    assert.notEqual(ep.seen[0].headers['x-asjp-nonce'], ep.seen[1].headers['x-asjp-nonce'], 'fresh nonce per request');
  } finally { ep.close(); }
});

test('A1: an EXPIRED tunnel hostname now held by someone else (no key) never receives the manuscript or the bearer token', async () => {
  // the impostor answers /attest like a server would, but cannot sign the answer
  const ep = await endpoint((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(req.url === '/attest' ? { ok: true } : answer)); });
  try {
    const r = await requestAsjpAnswer(ep.url, TOKEN, { text: 'SECRET-MANUSCRIPT-MARKER words here' }, 3000, {}, KEY);
    assert.equal(r.state, 'UNAVAILABLE'); assert.equal(r.failureCode, 'SERVICE_NOT_AUTHENTICATED');
    assert.deepEqual(ep.seen.map((s) => s.path), ['/attest'], 'nothing after the failed attestation');
    assert.ok(ep.seen.every((s) => s.auth === null && !s.body.includes('SECRET-MANUSCRIPT-MARKER')), 'no token, no manuscript');
  } finally { ep.close(); }
});

test('A1: an impostor that RELAYS the attestation to the real service (other hostname) still fails: the signature binds the Host', async () => {
  // simulate: the real service signed for its own (new) hostname; the client called the old one
  const ep = await endpoint((req, res, raw) => reply(req, res, raw, 200, { ok: true }, { hostOverride: 'new-tunnel.trycloudflare.com' }));
  try {
    const r = await requestAsjpAnswer(ep.url, TOKEN, { text: 'SECRET-MANUSCRIPT-MARKER' }, 3000, {}, KEY);
    assert.equal(r.failureCode, 'SERVICE_NOT_AUTHENTICATED');
    assert.equal(ep.seen.length, 1);
  } finally { ep.close(); }
});

test('A1: malicious or mismatched answers are refused (unsigned, other key, replayed from another request, other manuscript, other status)', async () => {
  for (const [name, opts] of [
    ['unsigned', null], ['other key', { key: OTHER_KEY }], ['replayed (other nonce)', { nonceOverride: 'f'.repeat(32) }],
    ['other manuscript', { bodyShaOverride: sha256Hex('another manuscript') }], ['status changed', { statusOverride: 503 }],
  ]) {
    const ep = await endpoint((req, res, raw) => {
      if (req.url === '/attest') return reply(req, res, raw, 200, { ok: true });
      if (!opts) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(answer)); }
      return reply(req, res, raw, 200, answer, opts);
    });
    try {
      const r = await requestAsjpAnswer(ep.url, TOKEN, { text: 'a b c' }, 3000, {}, KEY);
      assert.equal(r.state, 'UNAVAILABLE', name); assert.equal(r.failureCode, 'UNAUTHENTICATED_ANSWER', name);
    } finally { ep.close(); }
  }
});

test('A1: an oversized answer is refused unread; a signed failure answer is passed through as a failure', async () => {
  const big = await endpoint((req, res, raw) => {
    if (req.url === '/attest') return reply(req, res, raw, 200, { ok: true });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(Buffer.alloc(3 * 1024 * 1024, 0x20));
  });
  try { assert.equal((await requestAsjpAnswer(big.url, TOKEN, { text: 'x' }, 5000, {}, KEY)).failureCode, 'RESPONSE_TOO_LARGE'); } finally { big.close(); }
  const busy = await endpoint((req, res, raw) => reply(req, res, raw, req.url === '/attest' ? 200 : 503, req.url === '/attest' ? { ok: true } : { state: 'BUSY', failureCode: 'ASJP_BUSY' }));
  try { assert.equal((await requestAsjpAnswer(busy.url, TOKEN, { text: 'x' }, 3000, {}, KEY)).failureCode, 'ASJP_BUSY'); } finally { busy.close(); }
});
