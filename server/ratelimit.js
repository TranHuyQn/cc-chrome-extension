// Fixed-window rate limiting for the pairing endpoint. Tokens are 128-bit
// random values not worth guessing; the pairing secret is chosen by a human and
// only required to be 12 characters, so it is the value that needs throttling.

export class RateLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map(); // key -> { count, resetAt }
    setInterval(() => this.sweep(), windowMs).unref();
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }

  // 0 when the caller may proceed, otherwise the seconds left to wait.
  retryAfter(key) {
    const entry = this.hits.get(key);
    if (!entry) return 0;
    const now = Date.now();
    if (entry.resetAt <= now) {
      this.hits.delete(key);
      return 0;
    }
    if (entry.count < this.limit) return 0;
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  }

  fail(key) {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count++;
    }
  }

  reset(key) {
    this.hits.delete(key);
  }
}

// X-Forwarded-For is trivially forged, so it is honored only when the operator
// states this process really is behind a proxy that sets it. Otherwise an
// attacker would bypass the limiter by sending a different value every request.
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) return String(forwarded).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}
