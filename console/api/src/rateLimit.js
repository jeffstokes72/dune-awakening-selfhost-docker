export function createLoginRateLimiter(options = {}) {
  const {
    maxAttempts = 8,
    windowMs = 15 * 60 * 1000,
    blockMs = 15 * 60 * 1000,
    now = () => Date.now()
  } = options;
  const attempts = new Map();

  function check(key) {
    const current = attempts.get(key);
    const timestamp = now();
    if (!current) return { allowed: true, retryAfterSeconds: 0 };
    if (current.blockedUntil && current.blockedUntil > timestamp) {
      return { allowed: false, retryAfterSeconds: Math.ceil((current.blockedUntil - timestamp) / 1000) };
    }
    if (current.firstAttemptAt + windowMs <= timestamp) {
      attempts.delete(key);
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  function recordFailure(key) {
    const timestamp = now();
    const current = attempts.get(key);
    const next = !current || current.firstAttemptAt + windowMs <= timestamp
      ? { count: 1, firstAttemptAt: timestamp, blockedUntil: 0 }
      : { ...current, count: current.count + 1 };
    if (next.count >= maxAttempts) next.blockedUntil = timestamp + blockMs;
    attempts.set(key, next);
    return check(key);
  }

  function recordSuccess(key) {
    attempts.delete(key);
  }

  return { check, recordFailure, recordSuccess };
}
