const test = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter } = require('../rateLimit');

function mockReq(ip) {
  return { ip };
}

function mockRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    set(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('allows requests under the limit', () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 3, scope: 'test-under' });
  const req = mockReq('1.1.1.1');

  for (let i = 0; i < 3; i += 1) {
    let called = false;
    limiter(req, mockRes(), () => {
      called = true;
    });
    assert.equal(called, true);
  }
});

test('blocks requests once the limit is exceeded', () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 2, scope: 'test-over' });
  const req = mockReq('2.2.2.2');

  limiter(req, mockRes(), () => {});
  limiter(req, mockRes(), () => {});

  const res = mockRes();
  let called = false;
  limiter(req, res, () => {
    called = true;
  });

  assert.equal(called, false);
  assert.equal(res.statusCode, 429);
  assert.ok(res.headers['Retry-After']);
});

test('tracks different IPs independently', () => {
  const limiter = createRateLimiter({ windowMs: 60000, max: 1, scope: 'test-ip' });

  let firstCalled = false;
  limiter(mockReq('3.3.3.3'), mockRes(), () => {
    firstCalled = true;
  });

  let secondCalled = false;
  limiter(mockReq('4.4.4.4'), mockRes(), () => {
    secondCalled = true;
  });

  assert.equal(firstCalled, true);
  assert.equal(secondCalled, true);
});

test('tracks different scopes independently for the same IP', () => {
  const loginLimiter = createRateLimiter({ windowMs: 60000, max: 1, scope: 'test-scope-login' });
  const registerLimiter = createRateLimiter({ windowMs: 60000, max: 1, scope: 'test-scope-register' });
  const req = mockReq('5.5.5.5');

  let loginCalled = false;
  loginLimiter(req, mockRes(), () => {
    loginCalled = true;
  });

  let registerCalled = false;
  registerLimiter(req, mockRes(), () => {
    registerCalled = true;
  });

  assert.equal(loginCalled, true);
  assert.equal(registerCalled, true);
});
