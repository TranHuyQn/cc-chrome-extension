// Unit test for the /pair rate limiter's client identification.
//
// clientIp() decides what the limiter counts against. Reading the wrong end of
// X-Forwarded-For silently voids the whole limiter: behind nginx (whose
// canonical `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`
// appends) the leftmost entry is fully attacker-controlled, so 10 bad pairing
// attempts with 10 different forged values are never throttled. The rightmost
// entry is the one the adjacent trusted proxy appended.
//
// clientIp only reads req.headers["x-forwarded-for"] and req.socket.remoteAddress,
// so an object literal is a complete stand-in for a real request here.
//
// Usage: node test/ratelimit.test.mjs   (no dependencies)

import { clientIp, RateLimiter } from "../server/ratelimit.js";

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

const req = (forwarded, remoteAddress = "10.0.0.9") => ({
  headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
  socket: { remoteAddress },
});

// --- trustProxy off: the header must be ignored entirely --------------------

check(
  "trustProxy=false ignores X-Forwarded-For",
  clientIp(req("1.2.3.4"), false) === "10.0.0.9",
  clientIp(req("1.2.3.4"), false)
);
check(
  "trustProxy=false ignores a multi-hop X-Forwarded-For",
  clientIp(req("1.2.3.4, 5.6.7.8, 203.0.113.7"), false) === "10.0.0.9",
  clientIp(req("1.2.3.4, 5.6.7.8, 203.0.113.7"), false)
);

// --- trustProxy on: the rightmost (trusted) entry wins -----------------------

check(
  "trustProxy=true with one entry uses it",
  clientIp(req("203.0.113.7"), true) === "203.0.113.7",
  clientIp(req("203.0.113.7"), true)
);
check(
  "trustProxy=true with a multi-hop header picks the RIGHTMOST entry",
  clientIp(req("1.2.3.4, 5.6.7.8, 203.0.113.7"), true) === "203.0.113.7",
  clientIp(req("1.2.3.4, 5.6.7.8, 203.0.113.7"), true)
);
check(
  "a forged leftmost entry cannot change the key",
  clientIp(req("evil-1, 203.0.113.7"), true) === clientIp(req("evil-2, 203.0.113.7"), true),
  `${clientIp(req("evil-1, 203.0.113.7"), true)} vs ${clientIp(req("evil-2, 203.0.113.7"), true)}`
);
check(
  "whitespace around entries is tolerated",
  clientIp(req("  1.2.3.4 ,   203.0.113.7   "), true) === "203.0.113.7",
  JSON.stringify(clientIp(req("  1.2.3.4 ,   203.0.113.7   "), true))
);
check(
  "no comma, just padding, is tolerated",
  clientIp(req("   203.0.113.7  "), true) === "203.0.113.7",
  JSON.stringify(clientIp(req("   203.0.113.7  "), true))
);

// --- fallbacks --------------------------------------------------------------

check(
  "no X-Forwarded-For falls back to the socket address",
  clientIp(req(undefined), true) === "10.0.0.9",
  clientIp(req(undefined), true)
);
check(
  "an empty X-Forwarded-For falls back to the socket address",
  clientIp(req(""), true) === "10.0.0.9",
  clientIp(req(""), true)
);
check(
  "a header with no usable entry falls back to the socket address",
  clientIp(req("  ,  "), true) === "10.0.0.9",
  clientIp(req("  ,  "), true)
);
check(
  "no socket address at all still yields a key",
  clientIp({ headers: {}, socket: {} }, false) === "unknown",
  clientIp({ headers: {}, socket: {} }, false)
);

// --- the limiter itself keys on whatever clientIp returned ------------------

// Sanity check that the fix actually changes the outcome: with the rightmost
// entry, attempts that differ only in the forged prefix share one counter.
const limiter = new RateLimiter({ limit: 3, windowMs: 60_000 });
for (let i = 0; i < 3; i++) {
  limiter.fail(clientIp(req(`forged-${i}, 203.0.113.7`), true));
}
check(
  "forged prefixes all land on the same limiter bucket",
  limiter.retryAfter("203.0.113.7") > 0,
  `retryAfter=${limiter.retryAfter("203.0.113.7")}`
);
check(
  "a genuinely different proxy-reported IP is unaffected",
  limiter.retryAfter("198.51.100.4") === 0,
  `retryAfter=${limiter.retryAfter("198.51.100.4")}`
);

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
