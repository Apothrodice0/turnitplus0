import assert from 'node:assert/strict';
import {
  isResendConfigured,
  resendEmailDeliveryProvider,
  __setResendFetchForTest,
} from '../lib/mail/resend-email-provider.ts';
import {
  getEmailDeliveryProvider,
  EmailDeliveryUnavailableError,
  __setEmailDeliveryProviderForTest,
} from '../lib/mail/email-delivery.ts';

/**
 * A3b — lib/mail/resend-email-provider.ts, the direct-fetch Resend delivery
 * provider selected by lib/mail/email-delivery.ts's getEmailDeliveryProvider()
 * whenever RESEND_API_KEY + EMAIL_VERIFICATION_FROM_ADDRESS are both present
 * and no test provider override is active. Covers exactly the "absent
 * provider config fails closed" and provider-failure-translation invariants;
 * the challenge/route-level behavior (revoke-on-failure, no orphan challenge)
 * is covered by tests/email-verification.test.mjs using a simpler injected
 * fake provider.
 */

const ORIGINAL_API_KEY = process.env.RESEND_API_KEY;
const ORIGINAL_FROM = process.env.EMAIL_VERIFICATION_FROM_ADDRESS;

function clearResendEnv() {
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_VERIFICATION_FROM_ADDRESS;
}

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n       ') : err}`);
  } finally {
    clearResendEnv();
    __setResendFetchForTest(null);
    __setEmailDeliveryProviderForTest(null);
  }
}

const sampleMessage = { to: 'user@example.com', code: '482913', expiresAt: Date.now() + 30 * 60_000 };

// ====================================================================

await test('isResendConfigured() is false with no env, false with only one of the two vars, true with both', async () => {
  clearResendEnv();
  assert.equal(isResendConfigured(), false);

  process.env.RESEND_API_KEY = 're_test_key';
  assert.equal(isResendConfigured(), false, 'API key alone is not enough');
  clearResendEnv();

  process.env.EMAIL_VERIFICATION_FROM_ADDRESS = 'TurnitPlus <verify@example.com>';
  assert.equal(isResendConfigured(), false, 'from-address alone is not enough');
  clearResendEnv();

  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_VERIFICATION_FROM_ADDRESS = 'TurnitPlus <verify@example.com>';
  assert.equal(isResendConfigured(), true);
});

await test('absent provider config fails closed: sendEmailVerification throws EmailDeliveryUnavailableError, no fetch attempted', async () => {
  clearResendEnv();
  let fetchCalled = false;
  __setResendFetchForTest(async () => {
    fetchCalled = true;
    throw new Error('fetch must never be called when unconfigured');
  });
  await assert.rejects(() => resendEmailDeliveryProvider.sendEmailVerification(sampleMessage), EmailDeliveryUnavailableError);
  assert.equal(fetchCalled, false);
});

await test('absent provider config fails closed at the getEmailDeliveryProvider() level too (no test override, no Resend env)', async () => {
  clearResendEnv();
  __setEmailDeliveryProviderForTest(null);
  const provider = getEmailDeliveryProvider();
  await assert.rejects(() => provider.sendEmailVerification(sampleMessage), EmailDeliveryUnavailableError);
});

await test('getEmailDeliveryProvider() resolves the Resend provider once both env vars are set', async () => {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_VERIFICATION_FROM_ADDRESS = 'TurnitPlus <verify@example.com>';
  __setEmailDeliveryProviderForTest(null);
  assert.equal(getEmailDeliveryProvider(), resendEmailDeliveryProvider);
});

await test('configured: sends one POST to the Resend API with the correct auth header, from/to, and the code embedded — no internal ids, no raw token language', async () => {
  process.env.RESEND_API_KEY = 're_test_key_123';
  process.env.EMAIL_VERIFICATION_FROM_ADDRESS = 'TurnitPlus <verify@example.com>';

  let capturedUrl = null;
  let capturedInit = null;
  __setResendFetchForTest(async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(JSON.stringify({ id: 'fake-resend-id' }), { status: 200 });
  });

  await resendEmailDeliveryProvider.sendEmailVerification(sampleMessage);

  assert.equal(capturedUrl, 'https://api.resend.com/emails');
  assert.equal(capturedInit.method, 'POST');
  assert.equal(capturedInit.headers.Authorization, 'Bearer re_test_key_123');
  assert.equal(capturedInit.headers['Content-Type'], 'application/json');

  const body = JSON.parse(capturedInit.body);
  assert.equal(body.from, 'TurnitPlus <verify@example.com>');
  assert.equal(body.to, 'user@example.com');
  assert.match(body.subject, /TurnitPlus/);
  assert.ok(body.html.includes('482913'), 'the code appears prominently in the HTML body');
  assert.ok(body.text.includes('482913'), 'the code appears in the plaintext body');
  for (const forbidden of ['challenge', 'digest', 'token_digest', 'user_id', 'http://', 'https://']) {
    assert.equal(body.html.toLowerCase().includes(forbidden), false, `html must not contain "${forbidden}"`);
    assert.equal(body.text.toLowerCase().includes(forbidden), false, `text must not contain "${forbidden}"`);
  }
});

await test('a non-2xx Resend response is translated to EmailDeliveryUnavailableError, never the raw response', async () => {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_VERIFICATION_FROM_ADDRESS = 'TurnitPlus <verify@example.com>';
  __setResendFetchForTest(async () => new Response(JSON.stringify({ message: 'Invalid `from` field secret-account-detail' }), { status: 422 }));

  try {
    await resendEmailDeliveryProvider.sendEmailVerification(sampleMessage);
    assert.fail('expected a throw');
  } catch (err) {
    assert.ok(err instanceof EmailDeliveryUnavailableError);
    assert.equal(/secret-account-detail/i.test(err.message), false, 'the provider internal detail must not leak into the thrown error');
  }
});

await test('a network-level fetch throw is translated to EmailDeliveryUnavailableError, never the raw error', async () => {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_VERIFICATION_FROM_ADDRESS = 'TurnitPlus <verify@example.com>';
  __setResendFetchForTest(async () => {
    throw new TypeError('fetch failed: getaddrinfo ENOTFOUND api.resend.com');
  });

  await assert.rejects(() => resendEmailDeliveryProvider.sendEmailVerification(sampleMessage), EmailDeliveryUnavailableError);
});

// ====================================================================

clearResendEnv();
if (ORIGINAL_API_KEY !== undefined) process.env.RESEND_API_KEY = ORIGINAL_API_KEY;
if (ORIGINAL_FROM !== undefined) process.env.EMAIL_VERIFICATION_FROM_ADDRESS = ORIGINAL_FROM;
__setResendFetchForTest(null);
__setEmailDeliveryProviderForTest(null);

if (failures > 0) {
  console.error(`\nmail-resend-provider: ${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll mail-resend-provider tests passed');
