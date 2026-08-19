const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hashPassword,
  verifyPassword,
  createSessionToken,
  getUserForSession,
  getSessionExpiry,
  isSessionExpired,
} = require('../auth');

test('hashPassword creates a salted hash that verifies', () => {
  const password = 'super-secret-123';
  const result = hashPassword(password);

  assert.ok(result.hash);
  assert.ok(result.salt);
  assert.notEqual(result.hash, password);
  assert.equal(verifyPassword(password, result.salt, result.hash), true);
  assert.equal(verifyPassword('wrong-password', result.salt, result.hash), false);
});

test('createSessionToken generates a session value', () => {
  const token = createSessionToken();

  assert.ok(token);
  assert.equal(typeof token, 'string');
  assert.ok(token.length > 20);
});

test('getUserForSession resolves a user from a valid session record', () => {
  const user = { id: 'user-1', name: 'Ada', email: 'ada@example.com' };
  const session = { user_id: 'user-1', token: 'abc123' };

  const result = getUserForSession({ user, session });

  assert.deepEqual(result, user);
});

test('getSessionExpiry returns a timestamp 30 days after the given date', () => {
  const from = new Date('2026-01-01T00:00:00.000Z');
  const expiry = getSessionExpiry(from);

  assert.equal(expiry, '2026-01-31T00:00:00.000Z');
});

test('isSessionExpired detects past and future expiry timestamps', () => {
  const past = { expires_at: new Date(Date.now() - 1000).toISOString() };
  const future = { expires_at: new Date(Date.now() + 1000 * 60).toISOString() };
  const missing = { expires_at: null };

  assert.equal(isSessionExpired(past), true);
  assert.equal(isSessionExpired(future), false);
  assert.equal(isSessionExpired(missing), false);
});
