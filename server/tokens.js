// Token storage for http mode: static tokens configured by the admin, plus
// dynamic tokens issued on demand by the self-service /pair endpoint.
//
//   CC_CHROME_TOKENS:      "token1=alice,token2=bob"  (name optional)
//   CC_CHROME_TOKENS_FILE: path to a JSON file { "token1": "alice", ... }
//   CC_CHROME_PAIR_SECRET: team secret; enables POST /pair
//   CC_CHROME_STATE_FILE:  where dynamic tokens are persisted

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

export class TokenStore {
  constructor(log) {
    this.log = log;
    this.static = new Map();
    this.dynamic = new Map();
    this.pairSecret = process.env.CC_CHROME_PAIR_SECRET || null;
    this.stateFile = process.env.CC_CHROME_STATE_FILE || "./ccchrome-tokens.json";

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
    if (this.pairSecret && this.pairSecret.length < 12) {
      log("FATAL: CC_CHROME_PAIR_SECRET must be at least 12 chars. Generate one with: openssl rand -hex 16");
      process.exit(1);
    }
    if (this.pairSecret && existsSync(this.stateFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.stateFile, "utf8"));
        for (const [token, name] of Object.entries(parsed)) this.dynamic.set(token, String(name));
        if (this.dynamic.size) log(`Restored ${this.dynamic.size} paired token(s) from ${this.stateFile}`);
      } catch (err) {
        log(`WARNING: could not read state file ${this.stateFile}: ${err.message}`);
      }
    }
  }

  get size() {
    return this.static.size + this.dynamic.size;
  }

  has(token) {
    return this.static.has(token) || this.dynamic.has(token);
  }

  get(token) {
    return this.static.get(token) ?? this.dynamic.get(token);
  }

  names() {
    return [...this.static.values(), ...this.dynamic.values()];
  }

  persist() {
    try {
      writeFileSync(this.stateFile, JSON.stringify(Object.fromEntries(this.dynamic), null, 2));
    } catch (err) {
      this.log(`WARNING: could not persist tokens to ${this.stateFile}: ${err.message}`);
    }
  }

  pair(name) {
    const token = randomBytes(16).toString("hex");
    this.dynamic.set(token, name);
    this.persist();
    this.log(`Paired new token for '${name}' (${this.dynamic.size} dynamic token(s) total)`);
    return token;
  }

  revoke(token) {
    if (this.static.has(token)) {
      throw new Error("This token is configured statically (CC_CHROME_TOKENS); remove it from the server config instead.");
    }
    const existed = this.dynamic.delete(token);
    if (existed) this.persist();
    return existed;
  }
}
