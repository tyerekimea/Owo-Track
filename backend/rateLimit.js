// Minimal in-memory rate limiter — no new dependency needed for a single
// Node process. Keys attempts by IP + a scope name so different endpoints
// (e.g. registration) are tracked independently.
//
// Not suitable as-is for a multi-instance deployment (state isn't shared
// across processes) — swap for a shared store (Redis, etc.) if this ever
// runs behind more than one instance at once.

const buckets = new Map();

function createRateLimiter({ windowMs, max, message, scope }) {
  return function rateLimiter(req, res, next) {
    const key = `${scope}:${req.ip}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        error: message || "Too many attempts. Please try again later.",
      });
    }

    next();
  };
}

export { createRateLimiter };
