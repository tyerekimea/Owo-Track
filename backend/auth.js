const crypto = require("node:crypto");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(password, salt, 100000, 64, "sha512")
    .toString("hex");

  return { hash, salt };
}

function verifyPassword(password, salt, hash) {
  const candidate = crypto
    .pbkdf2Sync(password, salt, 100000, 64, "sha512")
    .toString("hex");

  const expected = Buffer.from(hash, "hex");
  const actual = Buffer.from(candidate, "hex");

  if (expected.length !== actual.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, actual);
}

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function createSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getSessionExpiry(fromDate = new Date()) {
  return new Date(fromDate.getTime() + SESSION_DURATION_MS).toISOString();
}

function isSessionExpired(session) {
  if (!session.expires_at) return false; // safety net for any row missed by migration
  return new Date(session.expires_at).getTime() < Date.now();
}

function getUserForSession({ user, session }) {
  if (!user || !session) {
    return null;
  }

  return user.id === session.user_id ? user : null;
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSessionToken,
  getUserForSession,
  getSessionExpiry,
  isSessionExpired,
};
