// Token storage for the bridge. One shape only: tokens configured up front,
// which for a normal install means the single token the installer generates
// and writes to ~/.cc-chrome-bridge/tokens.json.
//
//   CC_CHROME_TOKENS:      "token1=alice,token2=bob"  (name optional)
//   CC_CHROME_TOKENS_FILE: path to a JSON file { "token1": "alice", ... }
//
// There is no self-service pairing and no dynamic token issuance. Both existed
// for the shared-server deployment this project no longer has: every user runs
// their own bridge on loopback, so there is nobody to pair with.

import { readFileSync } from "node:fs";

export class TokenStore {
  constructor(log) {
    this.log = log;
    this.static = new Map();

    if (process.env.CC_CHROME_TOKENS_FILE) {
      const parsed = JSON.parse(readFileSync(process.env.CC_CHROME_TOKENS_FILE, "utf8"));
      for (const [token, name] of Object.entries(parsed)) this.static.set(token, String(name));
    }
    if (process.env.CC_CHROME_TOKENS) {
      for (const entry of process.env.CC_CHROME_TOKENS.split(",")) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf("=");
        if (eq > 0) this.static.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
        else this.static.set(trimmed, trimmed.slice(0, 6));
      }
    }
    for (const token of this.static.keys()) {
      if (token.length < 8) {
        log(`FATAL: token '${token.slice(0, 2)}...' is shorter than 8 chars. Generate strong tokens, e.g.: openssl rand -hex 16`);
        process.exit(1);
      }
    }
  }

  get size() {
    return this.static.size;
  }

  has(token) {
    return this.static.has(token);
  }

  get(token) {
    return this.static.get(token);
  }

  names() {
    return [...this.static.values()];
  }
}
