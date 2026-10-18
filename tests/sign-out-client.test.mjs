// Browser sign-out behaviour (security fix): L7 of the logout-defect investigation.
// The unfixed page fired POST /api/auth/logout without awaiting it, swallowed every error and
// always announced "You have signed out." These cases drive lib/sign-out-client.ts directly
// with stub fetch/recheck functions; no network, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  requestServerSignOut,
  performSignOut,
  createSignOutRunner,
  signOutFailureMessage,
  SIGN_OUT_MESSAGES,
} from '../lib/sign-out-client.ts';

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function stubFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fetchImpl, calls };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const SIGNED_IN = { status: 'signed-in', user: { username: 'alice', email: 'alice@example.com' }, emailVerification: null };

function recordingDeps(overrides = {}) {
  const events = [];
  const deps = {
    request: async () => ({ status: 'signed-out', revoked: true }),
    recheck: async () => { events.push('recheck'); return SIGNED_IN; },
    completeSignOut: () => events.push('complete'),
    keepSignedIn: (state) => events.push(`keep:${state.user.email}`),
    notify: (message) => events.push(`notify:${message}`),
    ...overrides,
  };
  return { deps, events };
}

test('L7a requestServerSignOut: POSTs same-origin, no-store, with a timeout signal', async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse(200, { ok: true, revoked: true, outcome: 'revoked' }));
  assert.deepEqual(await requestServerSignOut(fetchImpl), { status: 'signed-out', revoked: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/auth/logout');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('L7b requestServerSignOut classifies every non-confirmation as a failure', async () => {
  const cases = [
    [jsonResponse(200, { ok: true, revoked: false, outcome: 'no_active_session' }), { status: 'signed-out', revoked: false }],
    [jsonResponse(429, { ok: false }, { 'Retry-After': '42' }), { status: 'failed', reason: 'rate-limited', retryAfterSeconds: 42 }],
    [jsonResponse(429, { ok: false }), { status: 'failed', reason: 'rate-limited', retryAfterSeconds: null }],
    [jsonResponse(503, { ok: false, revoked: false, outcome: 'failed', error: 'x' }), { status: 'failed', reason: 'server', retryAfterSeconds: null }],
    [jsonResponse(500, { error: 'Internal error' }), { status: 'failed', reason: 'server', retryAfterSeconds: null }],
    // the old route's body, and a Deployment Protection sign-in page reached through a redirect
    [jsonResponse(200, { ok: true }), { status: 'failed', reason: 'server', retryAfterSeconds: null }],
    [new Response('<html>Vercel Authentication</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }), { status: 'failed', reason: 'server', retryAfterSeconds: null }],
    [jsonResponse(401, { error: 'unauthorized' }), { status: 'failed', reason: 'server', retryAfterSeconds: null }],
  ];
  for (const [response, expected] of cases) {
    const { fetchImpl } = stubFetch(() => response.clone());
    assert.deepEqual(await requestServerSignOut(fetchImpl), expected, `HTTP ${response.status}`);
  }
});

test('L7c requestServerSignOut: a network error or a timeout is a failure, never success', async () => {
  const thrown = await requestServerSignOut(async () => { throw new TypeError('Failed to fetch'); });
  assert.deepEqual(thrown, { status: 'failed', reason: 'network', retryAfterSeconds: null });
  const hanging = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  // Node's AbortSignal.timeout timer is unref'd: hold the event loop open while it runs.
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    assert.deepEqual(await requestServerSignOut(hanging, 20), { status: 'failed', reason: 'network', retryAfterSeconds: null });
  } finally {
    clearTimeout(keepAlive);
  }
});

test('L7d confirmed sign-out: complete (and broadcast) only after the server answered, then announce', async () => {
  const gate = deferred();
  const { deps, events } = recordingDeps({ request: () => gate.promise });
  const running = performSignOut(deps);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(events, [], 'nothing is cleared, broadcast or announced while the request is pending');
  gate.resolve({ status: 'signed-out', revoked: true });
  assert.equal(await running, 'signed-out');
  assert.deepEqual(events, ['complete', `notify:${SIGN_OUT_MESSAGES.revoked}`]);
});

test('L7e nothing-to-revoke is still a signed-out browser, with its own truthful message', async () => {
  const { deps, events } = recordingDeps({ request: async () => ({ status: 'signed-out', revoked: false }) });
  assert.equal(await performSignOut(deps), 'signed-out');
  assert.deepEqual(events, ['complete', `notify:${SIGN_OUT_MESSAGES.noActiveSession}`]);
});

test('L7f failed sign-out with a still-valid session: stay signed in, no broadcast, truthful error', async () => {
  for (const failure of [
    { status: 'failed', reason: 'server', retryAfterSeconds: null },
    { status: 'failed', reason: 'network', retryAfterSeconds: null },
    { status: 'failed', reason: 'rate-limited', retryAfterSeconds: 12 },
  ]) {
    const { deps, events } = recordingDeps({ request: async () => failure });
    assert.equal(await performSignOut(deps), 'still-signed-in');
    assert.deepEqual(events, ['recheck', 'keep:alice@example.com', `notify:${signOutFailureMessage(failure)}`], failure.reason);
    assert.ok(!events.includes('complete'));
    assert.match(signOutFailureMessage(failure), /still signed in/);
    assert.doesNotMatch(signOutFailureMessage(failure), /You have signed out/);
  }
  assert.match(signOutFailureMessage({ status: 'failed', reason: 'rate-limited', retryAfterSeconds: 12 }), /in 12 seconds/);
});

test('L7g failed request but the recheck confirms no session: complete as signed out', async () => {
  const { deps, events } = recordingDeps({
    request: async () => ({ status: 'failed', reason: 'network', retryAfterSeconds: null }),
    recheck: async () => { events.push('recheck'); return { status: 'signed-out' }; },
  });
  assert.equal(await performSignOut(deps), 'signed-out');
  assert.deepEqual(events, ['recheck', 'complete', `notify:${SIGN_OUT_MESSAGES.confirmedByRecheck}`]);
});

test('L7h failed request and an indeterminate recheck: change nothing, say it is unconfirmed', async () => {
  const { deps, events } = recordingDeps({
    request: async () => ({ status: 'failed', reason: 'server', retryAfterSeconds: null }),
    recheck: async () => { events.push('recheck'); return { status: 'error' }; },
  });
  assert.equal(await performSignOut(deps), 'unknown');
  assert.deepEqual(events, ['recheck', `notify:${SIGN_OUT_MESSAGES.unconfirmed}`]);
});

test('L7i repeated clicks while a sign-out is running send exactly one logout request', async () => {
  const gate = deferred();
  let requests = 0;
  const { deps, events } = recordingDeps({ request: () => { requests++; return gate.promise; } });
  const runner = createSignOutRunner();
  const first = runner.run(deps);
  const second = runner.run(deps);
  assert.equal(runner.isRunning(), true);
  assert.equal(first, second, 'the second click joins the running attempt');
  gate.resolve({ status: 'signed-out', revoked: true });
  assert.equal(await first, 'signed-out');
  assert.equal(requests, 1);
  assert.equal(events.filter((e) => e === 'complete').length, 1);
  assert.equal(runner.isRunning(), false);
  await runner.run(deps);
  assert.equal(requests, 2, 'a later sign-out (after the first finished) runs normally');
});

test('L7j the runner releases its lock after a failing attempt', async () => {
  const runner = createSignOutRunner();
  const { deps } = recordingDeps({ request: async () => { throw new Error('boom'); } });
  await assert.rejects(runner.run(deps));
  assert.equal(runner.isRunning(), false);
});

test('L7k end to end with a real Response pipeline: a 503 then a recheck still signed in', async () => {
  const { fetchImpl } = stubFetch(() => jsonResponse(503, { ok: false, revoked: false, outcome: 'failed', error: 'Sign-out could not be completed. Please try again.' }));
  const { deps, events } = recordingDeps({ request: () => requestServerSignOut(fetchImpl) });
  assert.equal(await performSignOut(deps), 'still-signed-in');
  assert.ok(!events.includes('complete'));
  assert.ok(!events.some((e) => e === `notify:${SIGN_OUT_MESSAGES.revoked}`));
});

test('L7l app/page.tsx wiring: no fire-and-forget logout; broadcast only inside the confirmed path', () => {
  const src = fs.readFileSync(path.resolve('app/page.tsx'), 'utf8');
  assert.doesNotMatch(src, /fetch\(\s*["']\/api\/auth\/logout["']/, 'the page never calls the logout route directly');
  const start = src.indexOf('async function signOutAccount(');
  assert.ok(start > 0, 'signOutAccount is async');
  const signOut = src.slice(start, src.indexOf('\n  function ', start + 10));
  assert.match(signOut, /createSignOutRunner\(\)/);
  assert.match(signOut, /requestServerSignOut\(\)/);
  assert.match(signOut, /recheck: \(\) => fetchAccountHydration\(\)/);
  assert.match(signOut, /completeSignOut: completeSignOutInThisTab/);
  assert.doesNotMatch(signOut, /SIGNED_OUT_BROADCAST_KEY|You have signed out/, 'no broadcast or success text outside the confirmed path');
  const complete = src.slice(src.indexOf('function completeSignOutInThisTab('), start);
  assert.match(complete, /SIGNED_OUT_BROADCAST_KEY/);
  assert.equal((src.match(/localStorage\.setItem\(SIGNED_OUT_BROADCAST_KEY/g) ?? []).length, 1, 'exactly one broadcast site');
  assert.match(src, /disabled=\{isSigningOut\}/, 'the button is disabled while a sign-out runs');
});
