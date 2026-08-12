import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, verifyPassword } from '../lib/auth-crypto.js';

test('hashPassword produces a self-describing scrypt string, never the raw password', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.match(hash, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.doesNotMatch(hash, /correct horse battery staple/);
});

test('verifyPassword accepts the correct password and rejects a wrong one', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
});

test('verifyPassword rejects malformed/garbage stored hashes instead of throwing', async () => {
  assert.equal(await verifyPassword('anything', 'not-a-real-hash'), false);
  assert.equal(await verifyPassword('anything', ''), false);
  assert.equal(await verifyPassword('anything', 'scrypt$16384$8$1$badsalt$badhash'), false);
});

test('two hashes of the same password use different random salts', async () => {
  const hashA = await hashPassword('same password');
  const hashB = await hashPassword('same password');
  assert.notEqual(hashA, hashB);
  assert.equal(await verifyPassword('same password', hashA), true);
  assert.equal(await verifyPassword('same password', hashB), true);
});

console.log('auth-crypto tests passed');
