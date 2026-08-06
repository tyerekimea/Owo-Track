const test = require('node:test');
const assert = require('node:assert/strict');

const { hashPassword, verifyPassword, createSessionToken, getUserForSession } = require('../auth');

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
