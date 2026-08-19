#!/usr/bin/env node
// MCP server that bridges Claude Code to the "Claude Code Chrome Bridge"
// extension.
//
// One mode: http, bound to loopback by default, installed as a per-user
// background service on each developer's own machine:
//      Claude Code --(MCP over Streamable HTTP, Bearer token)--> this process
//      extension  --(ws://127.0.0.1/ws?token=...)-----------------^
// One bridge per person, on their own machine. Tokens are still required: the
// loopback bind is not the only thing standing between a local process and
// full browser control.
//
// The `--http` flag is still accepted even though http is now the only mode
// (it is not required — process.argv is never checked for it — but every
// doc, unit file, and script that starts this server still passes it, and
// there is nothing to gain from making its absence an error).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { z } from "zod";
import { TokenStore } from "./tokens.js";
import { AgentSession, claudeBinFromEnv } from "./agent.js";
import { isLoopbackHost, isLoopbackAddress, forwardedHeadersIn } from "./loopback.js";
import { compareVersions, isValidTag, releaseUrls, parseChecksumFile, sha256File, reshapeToCheckout, isCacheFresh, buildRunnerSpawn, updateTaskName, LATEST_RELEASE_API } from "./updater.js";

// Below 32768 on purpose. Measured ephemeral ranges: macOS 49152-65535,
// Windows 49152-65535, Linux 32768-60999 — union 32768-65535. A default inside
// that can be taken as some other process's source port before the bridge binds
// it, which loses the race at logon and fails silently.
const PORT = Number(process.env.CC_CHROME_PORT || 23949);
// Loopback by default: the mode this replaced (stdio) bound 127.0.0.1
// unconditionally, and this release's premise is that most installs are a
// single person running the bridge on their own machine, where 0.0.0.0 would
// expose an unauthenticated GET /health (a positive fingerprint that this
// host runs Chrome Bridge with a live browser attached) to the network for
// nothing, and — the bigger reason — would leave AGENT_ENABLED below false,
// silently disabling the side panel until the user discovers CC_CHROME_HOST
// on their own. Anything other than loopback here is a configuration mistake,
// and it is exactly the mistake panelRefusalReason() below refuses to trust.
const HOST = process.env.CC_CHROME_HOST || "127.0.0.1";
const REQUEST_TIMEOUT_MS = Number(process.env.CC_CHROME_TIMEOUT_MS || 45000);
// Chrome terminates an extension's service worker once its window has been in
// the background long enough for intensive throttling to starve the keepalive
// (close=1001 "going away"). The extension's cc-keepalive alarm revives it
// within ~30s, so a tool call that lands in that gap is better off waiting than
// failing. Must stay comfortably below REQUEST_TIMEOUT_MS so a genuine absence
// still produces the helpful "not connected" error instead of a timeout.
// A garbage value must not become NaN — setTimeout(NaN) fires immediately, which
// would silently restore the old fail-fast behaviour. Same guard as
// CC_CHROME_SESSION_TTL_MS.
const graceFromEnv = Number(process.env.CC_CHROME_RECONNECT_GRACE_MS);
const RECONNECT_GRACE_MS = Number.isFinite(graceFromEnv) && graceFromEnv >= 0 ? graceFromEnv : 25000;
const VERSION = "1.1.0";

// The panel spawns `claude` on this host with the team's logged-in account, so
// it exists only on a bridge nobody else can reach. A public deployment keeps
// serving tools and refuses the panel outright — see panelRefusalReason() and
// /panel below.
const AGENT_ENABLED = isLoopbackHost(HOST);

// "Bound to loopback" and "nobody but this machine can reach me" are not the
// same claim. A bridge set to CC_CHROME_HOST=127.0.0.1 *because* a TLS reverse
// proxy sits in front of it is bound to loopback and reachable by the
// internet; a gate that only read the bind address would call it private and
// hand out a process spawn, once per chat turn, under whatever account that
// host is logged into.
//
// So a /panel upgrade has to prove all three, and any one failing is a 4004:
//   1. the bind address is loopback (kept as defence in depth),
//   2. the peer that actually arrived is loopback,
//   3. no X-Forwarded-* header is present — one proves a proxy is in front,
//      whatever the peer address says (a proxy's own peer address is loopback).
//
// Deliberately not overridable by an environment variable. A switch that
// re-enables this is a switch someone will eventually flip, and this is exactly
// the setting that must not be reachable by a configuration mistake.
function panelRefusalReason(req) {
  if (!AGENT_ENABLED) return `bridge is bound to ${HOST}, not loopback`;
  const peer = req.socket?.remoteAddress;
  if (!isLoopbackAddress(peer)) return `upgrade came from ${peer || "an unknown peer"}, not loopback`;
  const forwarded = forwardedHeadersIn(req.headers);
  if (forwarded.length) return `upgrade carries ${forwarded.join(", ")}, so a proxy is in front of this bridge`;
  return null;
}

// A bare IPv6 host has to be bracketed before it can go in a URL. HOST may
// already carry brackets (CC_CHROME_HOST="[::1]"), so strip first, then add.
function hostForUrl(host) {
  const bare = String(host || "").replace(/^\[|\]$/g, "");
  return bare.includes(":") ? `[${bare}]` : bare;
}

const log = (...args) => console.error("[claude-code-chrome-mcp]", ...args);

// Only the Chrome extension may drive the bridge. An absent Origin used to slip
// through this check, which let any local process connect and control the
// browser. Optionally pin to one extension id for a tighter guarantee — left
// unset by default because a Load-unpacked extension gets a path-derived id
// that differs from the signed .crx build.
const EXTENSION_ID = process.env.CC_CHROME_EXTENSION_ID || null;

function originAllowed(origin) {
  if (!origin.startsWith("chrome-extension://")) return false;
  return EXTENSION_ID ? origin === `chrome-extension://${EXTENSION_ID}` : true;
}

// Browsers cannot set custom headers on a WebSocket, so the token travels in
// Sec-WebSocket-Protocol rather than the query string — a query string ends up
// verbatim in every reverse-proxy access log.
const SUBPROTOCOL_PREFIX = "ccchrome.token.";

function tokenFromSubprotocol(req) {
  const header = req.headers["sec-websocket-protocol"] || "";
  for (const raw of header.split(",")) {
    const proto = raw.trim();
    if (proto.startsWith(SUBPROTOCOL_PREFIX)) return proto.slice(SUBPROTOCOL_PREFIX.length);
  }
  return null;
}

// `ws` omits Sec-WebSocket-Protocol from the 101 response unless a protocol is
// selected here, and a browser that offered protocols and got none back fails
// the handshake with no usable error. Both /ws and /panel install this.
function pickSubprotocol(protocols) {
  for (const proto of protocols) {
    if (proto.startsWith(SUBPROTOCOL_PREFIX)) return proto;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Extension connections
// ---------------------------------------------------------------------------

// Capability first, version only as a fallback for extensions too old to
// declare one. The version test alone was wrong the moment this project
// renumbered to 1.0.0 for its first published release: "major >= 3" then
// classified every current extension as pre-isolation and printed a warning
// saying isolation was NOT enforced, which was false and, being a security
// claim, worse than silence. Version numbers restart; capabilities do not.
//
// The fallback still reads major < 3, which remains correct for the
// extensions that predate the flag: isolation landed in that line's 3.0.0.
function isPreIsolationExtension(version, hello) {
  if (hello?.tabGroupIsolation === true) return false;
  const major = Number.parseInt(String(version ?? "").split(".")[0], 10);
  return !Number.isInteger(major) || major < 3;
}

class ExtensionConnection {
  constructor(socket, token, name) {
    this.socket = socket;
    this.token = token;
    this.name = name;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.nextId = 1;
    this.extensionInfo = null;
    this.isAlive = true;
    this.openedAt = Date.now();
    this.lastTrafficAt = Date.now();

    socket.on("pong", () => { this.isAlive = true; });
    socket.on("message", (data) => this.onMessage(data));
    socket.on("close", (code, reason) => this.onClose(code, reason));
    socket.on("error", (err) => log(`[${this.name}] extension socket error:`, err.message));
  }

  onMessage(data) {
    // Any frame counts as traffic. If a socket dies while this was recent, the
    // keepalive was working and something else killed it; if it dies after a
    // long silence, the keepalive itself stopped firing.
    this.lastTrafficAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "hello") {
      this.extensionInfo = { client: msg.client, version: msg.version, connectedAt: Date.now() };
      // Per-session tab-group isolation lives entirely in the extension. A
      // pre-3.0.0 one connects and works perfectly — with no isolation at all,
      // every tool reaching every tab in that browser. Nothing in the protocol
      // fails, so the only way this is ever noticed is if the server says it.
      if (isPreIsolationExtension(msg.version, msg)) {
        log(
          `[${this.name}] WARNING: extension version ${msg.version || "unknown"} predates tab-group isolation — ` +
          "per-session tab group isolation is NOT enforced, so every tool can reach every tab in that browser. " +
          "Reinstall the extension (<server>/extension.zip, or the extension/ folder in the repo)."
        );
      }
    } else if (msg.type === "ping") {
      try { this.socket.send(JSON.stringify({ type: "pong" })); } catch {}
    } else if (msg.type === "response") {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message || "Extension error"));
      else pending.resolve(msg.result);
    }
  }

  onClose(code, reason) {
    // The close code says who ended it and why: 1000/1001 is the extension
    // shutting down cleanly, 1006 means no close frame arrived at all — the
    // socket died under us, which points at the network or a proxy rather than
    // at either endpoint. Without it a disconnect is unattributable.
    const lived = Math.round((Date.now() - this.openedAt) / 1000);
    const quiet = Math.round((Date.now() - this.lastTrafficAt) / 1000);
    log(
      `[${this.name}] extension disconnected` +
      ` (close=${code ?? "?"}${reason && reason.length ? ` "${reason}"` : ""},` +
      ` lived=${lived}s, silent_for=${quiet}s)`
    );
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Chrome extension disconnected mid-request"));
      this.pending.delete(id);
    }
  }

  get connected() {
    return this.socket.readyState === 1;
  }

  call(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS, session) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ type: "request", id, method, params, session }));
    });
  }
}

class BridgeRegistry {
  constructor() {
    this.connections = new Map(); // token -> ExtensionConnection
    this.waiters = new Map();     // token -> Set<{resolve, reject, timer}>
    // Detect dead sockets (laptop sleep, network drop) via ws-level ping.
    setInterval(() => {
      for (const conn of this.connections.values()) {
        if (!conn.connected) continue;
        if (!conn.isAlive) {
          log(`[${conn.name}] no pong, terminating stale connection`);
          conn.socket.terminate();
          continue;
        }
        conn.isAlive = false;
        try { conn.socket.ping(); } catch {}
      }
    }, 30000).unref();
  }

  attach(socket, token, name) {
    const existing = this.connections.get(token);
    if (existing && existing.connected) {
      log(`[${name}] new extension connection, replacing previous one`);
      try { existing.socket.close(4000, "replaced by new connection"); } catch {}
    }
    const conn = new ExtensionConnection(socket, token, name);
    this.connections.set(token, conn);
    log(`[${name}] extension connected`);
    // Anything parked in require() for this token has been waiting for exactly
    // this moment — hand it the fresh connection instead of letting it expire.
    const waiting = this.waiters.get(token);
    if (waiting && waiting.size) {
      log(`[${name}] extension back — releasing ${waiting.size} waiting call(s)`);
      this.waiters.delete(token);
      for (const waiter of waiting) {
        clearTimeout(waiter.timer);
        waiter.resolve(conn);
      }
    }
    return conn;
  }

  get(token) {
    const conn = this.connections.get(token);
    return conn && conn.connected ? conn : null;
  }

  notConnectedError() {
    // ws://HOST:PORT is exactly right for the common case (a local install,
    // HOST defaulting to 127.0.0.1) — copy-pasteable as-is. Behind a reverse
    // proxy (the shared-VPS deployment) this process only knows its own bind
    // address, not the public domain or that TLS terminates in front of it,
    // so that one case still needs a human to swap in wss://<their-domain>.
    return new Error(
      "Chrome extension is not connected for this account.\n" +
      "1. Chrome must be running with the 'Claude Code Chrome Bridge' extension installed (chrome://extensions -> Load unpacked -> extension/ folder).\n" +
      `2. Point the extension at this server: click the extension icon in Chrome and set the WebSocket URL to ws://${HOST}:${PORT}/ws?token=<your-token> (same token as your Claude Code config; behind a reverse proxy, use wss://<your-domain>/ws?token=<your-token> instead), then 'Lưu & kết nối lại'.`
    );
  }

  // Returns the live connection, or waits up to RECONNECT_GRACE_MS for one to
  // attach before rejecting. Chrome kills a backgrounded extension's service
  // worker and the cc-keepalive alarm revives it ~30s later; without this wait
  // every tool call in that window failed instantly, which is precisely what
  // breaks unattended operation.
  requireNow(token) {
    const conn = this.get(token);
    if (!conn) throw this.notConnectedError();
    return conn;
  }

  require(token, graceMs = RECONNECT_GRACE_MS) {
    const conn = this.get(token);
    if (conn) return Promise.resolve(conn);
    if (!(graceMs > 0)) return Promise.reject(this.notConnectedError());

    log(`Extension not connected; waiting up to ${graceMs}ms for it to reconnect...`);
    const started = Date.now();
    return new Promise((resolve, reject) => {
      let set = this.waiters.get(token);
      if (!set) {
        set = new Set();
        this.waiters.set(token, set);
      }
      const waiter = {
        resolve: (value) => {
          set.delete(waiter);
          log(`Extension reconnected after ${Date.now() - started}ms; resuming the waiting call.`);
          resolve(value);
        },
        reject,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        // A rejected wait must leave nothing behind: drop the waiter, and drop
        // the whole set once it empties, so a token that never comes back does
        // not accumulate an entry per failed call.
        set.delete(waiter);
        if (set.size === 0) this.waiters.delete(token);
        log(`Extension did not reconnect within ${graceMs}ms; failing the call.`);
        reject(this.notConnectedError());
      }, graceMs);
      set.add(waiter);
    });
  }
}

const registry = new BridgeRegistry();

// ---------------------------------------------------------------------------
// MCP tool definitions
// ---------------------------------------------------------------------------

const textResult = (obj) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});

// getBridge: () => Promise<ExtensionConnection> — resolves once the extension
//   is there, waiting out a service-worker restart, and rejects with a helpful
//   error if it never comes back.
// getBridgeNow: () => ExtensionConnection — the same lookup without the wait,
//   for chrome_status: that is the tool you call to ask whether the extension
//   is connected, so it must answer now rather than stall for the grace period.
// sessionRef: { id: string|null }, read at call time rather than passed as a
// plain string — in http mode the MCP session id doesn't exist yet when this
// is called and is only assigned later, in onsessioninitialized.
function buildMcpServer(getBridge, getBridgeNow, statusExtra = {}, sessionRef = { id: null }) {
  const server = new McpServer({ name: "claude-chrome", version: VERSION });

  // Wraps handlers so extension errors come back as MCP tool errors (isError),
  // which Claude Code shows without killing the session.
  const tool = (name, description, schema, handler) => {
    server.tool(name, description, schema, async (args) => {
      try {
        return await handler(args ?? {});
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    });
  };

  const call = async (method, args, timeoutMs) =>
    (await getBridge()).call(method, args, timeoutMs, sessionRef.id);

  const tabIdSchema = z.number().int().optional()
    .describe("Target tab id (from list_tabs). The tab must be in this session's own tab group; any other tab is refused. Omit it to use (or open) a tab in that group — it is never the tab the user has in front of them.");

  tool(
    "chrome_status",
    "Check whether the Chrome extension is connected to this MCP server. Use this first if other tools fail.",
    {},
    async () => {
      let bridge;
      try {
        // Deliberately the non-waiting lookup: hanging for the reconnect grace
        // period would make the "is it connected?" tool useless.
        bridge = getBridgeNow();
      } catch (err) {
        return textResult({ connected: false, hint: err.message, ...statusExtra });
      }
      const info = await bridge.call("status");
      return textResult({ connected: true, ...info, extension: bridge.extensionInfo, ...statusExtra });
    }
  );

  tool(
    "navigate",
    "Navigate a tab to a URL, or go back/forward/reload. Without tabId, uses (or opens) a tab in this session's own tab group — it never takes over whatever tab the user has in front of them. Waits for the page to finish loading.",
    {
      url: z.string().optional().describe("URL to open (https:// is assumed if scheme is missing)"),
      action: z.enum(["back", "forward", "reload"]).optional()
        .describe("History action instead of opening a URL"),
      tabId: tabIdSchema,
    },
    async (args) => textResult(await call("navigate", args))
  );

  tool(
    "read_page",
    "Read the page structure: title, headings, and all visible interactive elements (links, buttons, inputs...). Each element gets a numeric ref usable with click/fill. Call this again after the page changes — refs go stale.",
    {
      maxElements: z.number().int().optional().describe("Max interactive elements to return (default 150)"),
      tabId: tabIdSchema,
    },
    async (args) => {
      const r = await call("read_page", args);
      const lines = [
        `URL: ${r.url}`,
        `Title: ${r.title}`,
        "",
        "## Headings",
        ...(r.headings.length ? r.headings : ["(none)"]),
        "",
        `## Interactive elements (${r.elementCount}) — use ref number with click/fill`,
        ...(r.elements.length ? r.elements : ["(none)"]),
      ];
      return textResult(lines.join("\n"));
    }
  );

  tool(
    "get_page_text",
    "Get the visible text content of the page (like selecting all and copying).",
    {
      maxChars: z.number().int().optional().describe("Max characters to return (default 50000)"),
      tabId: tabIdSchema,
    },
    async (args) => {
      const r = await call("get_page_text", args);
      const header = `URL: ${r.url}\nTitle: ${r.title}${r.truncated ? "\n(text truncated)" : ""}\n\n`;
      return textResult(header + r.text);
    }
  );

  tool(
    "find",
    "Find text on the current page. Returns matches with surrounding context; matches inside clickable elements include a ref usable with click.",
    {
      query: z.string().describe("Text to search for (case-insensitive)"),
      maxResults: z.number().int().optional().describe("Max matches to return (default 20)"),
      tabId: tabIdSchema,
    },
    async (args) => textResult(await call("find", args))
  );

  tool(
    "click",
    "Click an element, identified by a ref number from read_page/find, or by a CSS selector.",
    {
      ref: z.number().int().optional().describe("Element ref from read_page or find"),
      selector: z.string().optional().describe("CSS selector (used if ref is not given)"),
      tabId: tabIdSchema,
    },
    async (args) => textResult(await call("click", args))
  );

  tool(
    "fill",
    "Fill an input, textarea, select, or contenteditable element with a value. Fires input/change events so React/Vue apps register the change.",
    {
      ref: z.number().int().optional().describe("Element ref from read_page"),
      selector: z.string().optional().describe("CSS selector (used if ref is not given)"),
      value: z.string().describe("Value to set. For <select>, the option value or visible text."),
      clear: z.boolean().optional().describe("Clear existing value first (default true)"),
      tabId: tabIdSchema,
    },
    async (args) => textResult(await call("fill", args))
  );

  tool(
    "fill_form",
    "Fill multiple form fields in one call.",
    {
      fields: z.array(z.object({
        ref: z.number().int().optional(),
        selector: z.string().optional(),
        value: z.string(),
        clear: z.boolean().optional(),
      })).describe("Fields to fill, in order"),
      tabId: tabIdSchema,
    },
    async (args) => textResult(await call("fill_form", args))
  );

  tool(
    "press_key",
    "Press a keyboard key in the focused element (real key events via the debugger API). Supports Enter, Tab, Escape, Backspace, Delete, arrows, Home/End, PageUp/PageDown, Space, or single characters, with optional modifiers.",
    {
      key: z.string().describe("Key name (e.g. 'Enter', 'Tab', 'a')"),
      modifiers: z.array(z.enum(["ctrl", "alt", "shift", "meta"])).optional(),
      tabId: tabIdSchema,
    },
    async (args) => textResult(await call("press_key", args))
  );

  tool(
    "type_text",
    "Type text into the currently focused element as real keyboard input (use fill for form fields; this is for editors/canvas apps).",
    {
      text: z.string().describe("Text to type"),
      tabId: tabIdSchema,
    },
    async (args) => textResult(await call("type_text", args))
  );

  tool(
    "take_screenshot",
    "Take a PNG screenshot of a tab in this session's own tab group (visible viewport by default, or the full page). Without tabId it uses (or opens) a tab in that group, not the tab the user is looking at.",
    {
      fullPage: z.boolean().optional().describe("Capture the full scrollable page (default false)"),
      tabId: tabIdSchema,
    },
    async (args) => {
      const r = await call("take_screenshot", args, 60000);
      return { content: [{ type: "image", data: r.base64, mimeType: r.mimeType }] };
    }
  );

  tool(
    "javascript_eval",
    "Evaluate a JavaScript expression in the page and return the result (await'ed if it returns a promise).",
    {
      code: z.string().describe("JavaScript expression to evaluate in the page context"),
      tabId: tabIdSchema,
    },
    async (args) => textResult(await call("javascript_eval", args))
  );

  tool(
    "read_console_messages",
    "Read console messages (log/warn/error + uncaught exceptions) from the tab. Capture starts the first time this is called on a tab — reload the page after the first call to capture load-time messages.",
    {
      limit: z.number().int().optional().describe("Max messages to return (default 100)"),
      clear: z.boolean().optional().describe("Clear the buffer after reading"),
      tabId: tabIdSchema,
    },
    async (args) => textResult(await call("read_console_messages", args))
  );

  tool(
    "read_network_requests",
    "Read network requests made by the tab (URL, method, status, size, errors). Capture starts the first time this is called on a tab — reload or navigate after the first call to capture traffic.",
    {
      urlContains: z.string().optional().describe("Only return requests whose URL contains this substring"),
      limit: z.number().int().optional().describe("Max requests to return (default 100)"),
      clear: z.boolean().optional().describe("Clear the buffer after reading"),
      tabId: tabIdSchema,
    },
    async (args) => textResult(await call("read_network_requests", args))
  );

  tool(
    "list_tabs",
    "List the tabs in this session's own tab group, with their tab ids. Does not see tabs outside that group — drag a tab into the group (or use new_tab) to make it visible here.",
    {},
    async () => textResult(await call("list_tabs"))
  );

  tool(
    "new_tab",
    "Open a new browser tab, optionally at a URL. The tab joins this session's own tab group, so every other tool can then work on it.",
    { url: z.string().optional().describe("URL to open (default about:blank)") },
    async (args) => textResult(await call("new_tab", args))
  );

  tool(
    "close_tab",
    "Close a browser tab by id. Only accepts a tab in this session's own tab group — the user's own tabs cannot be closed.",
    { tabId: z.number().int().describe("Tab id to close (from list_tabs); must be in this session's tab group") },
    async (args) => textResult(await call("close_tab", args))
  );

  tool(
    "switch_tab",
    "Make a tab the visible one inside its own window. You do NOT need this before using other tools — every tool takes a tabId and works on a background tab — so only call it when the user asks to be shown something. It deliberately does not bring Chrome to the front over the app the user is working in. Only accepts a tab in this session's own tab group.",
    { tabId: z.number().int().describe("Tab id to activate (from list_tabs); must be in this session's tab group") },
    async (args) => textResult(await call("switch_tab", args))
  );

  tool(
    "scroll",
    "Scroll the page up/down/top/bottom, or scroll a specific element into view.",
    {
      direction: z.enum(["up", "down", "top", "bottom"]).optional().describe("Scroll direction (default down, ~80% of viewport)"),
      amount: z.number().int().optional().describe("Pixels to scroll (for up/down)"),
      selector: z.string().optional().describe("Scroll this element into view instead"),
      tabId: tabIdSchema,
    },
    async (args) => textResult(await call("scroll", args))
  );

  tool(
    "wait_for",
    "Wait until an element matching a CSS selector appears and is visible (polls every 250ms).",
    {
      selector: z.string().describe("CSS selector to wait for"),
      timeoutMs: z.number().int().optional().describe("Max wait in ms (default 10000, max 30000)"),
      tabId: tabIdSchema,
    },
    async (args) => textResult(await call("wait_for", args))
  );

  tool(
    "resize_window",
    "Resize the browser window containing the tab.",
    {
      width: z.number().int().optional().describe("Width in px (default 1280)"),
      height: z.number().int().optional().describe("Height in px (default 800)"),
      tabId: tabIdSchema,
    },
    async (args) => textResult(await call("resize_window", args))
  );

  tool(
    "upload_file",
    "Set a file on an <input type=file> element. The file path must exist on the machine running Chrome.",
    {
      selector: z.string().describe("CSS selector of the file input"),
      filePath: z.string().describe("Absolute path of the file on the Chrome machine"),
      tabId: tabIdSchema,
    },
    async (args) => textResult(await call("upload_file", args))
  );

  return server;
}

// ---------------------------------------------------------------------------
// http mode
// ---------------------------------------------------------------------------

async function mainHttp() {
  const tokens = new TokenStore(log);
  if (tokens.size === 0) {
    log("FATAL: http mode requires auth. Set CC_CHROME_TOKENS=\"<token>=<name>,...\", or point");
    log("CC_CHROME_TOKENS_FILE at the tokens.json the installer writes.");
    log("Generate a strong value with: openssl rand -hex 16");
    process.exit(1);
  }
  log(`Loaded ${tokens.size} token(s): ${tokens.names().join(", ")}`);

  const ttlFromEnv = Number(process.env.CC_CHROME_SESSION_TTL_MS);
  if (process.env.CC_CHROME_SESSION_TTL_MS !== undefined && !(Number.isFinite(ttlFromEnv) && ttlFromEnv > 0)) {
    log(`Ignoring invalid CC_CHROME_SESSION_TTL_MS=${JSON.stringify(process.env.CC_CHROME_SESSION_TTL_MS)}; must be a positive number. Using the default.`);
  }
  const SESSION_TTL_MS = Number.isFinite(ttlFromEnv) && ttlFromEnv > 0 ? ttlFromEnv : 8 * 60 * 60 * 1000;
  const sessions = new Map(); // mcp-session-id -> { transport, token, lastSeen }

  // A client that disappears without closing (laptop shut, session killed) used
  // to leave its transport here forever.
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastSeen <= SESSION_TTL_MS) continue;
      log(`Closing MCP session ${id}: idle for more than ${SESSION_TTL_MS}ms`);
      sessions.delete(id);
      try { session.transport.close(); } catch {}
    }
  }, Math.min(5 * 60 * 1000, SESSION_TTL_MS)).unref();

  const bearerOf = (req) => {
    const header = req.headers.authorization || "";
    return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  };

  const authToken = (req) => {
    const token = bearerOf(req);
    return token && tokens.has(token) ? token : null;
  };

  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    return raw ? JSON.parse(raw) : undefined;
  };

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/health") {
      // Reports live state (who's connected right now); a cached copy is
      // actively misleading, and this is the endpoint admins curl to confirm
      // a deploy landed. Same no-store reasoning as the downloads below.
      res.setHeader("cache-control", "no-store");
      return json(res, 200, {
        ok: true,
        version: VERSION,
        extensionsConnected: [...registry.connections.values()].filter((c) => c.connected).length,
        mcpSessions: sessions.size,
      });
    }

    // --- extension downloads (built by `npm run build` into dist/) ----------
    // Public like the Web Store would be: the package contains no secrets.
    // dist/ is not baked into the image — the Docker build copies only
    // server/*.js, and dist/ reaches the container through a read-only bind
    // mount — so every handler below re-reads CC_CHROME_DIST_DIR per request
    // rather than resolving it once at startup.

    const distDir = () => process.env.CC_CHROME_DIST_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
    const distNotBuilt = (what) => ({ error: `${what} not built. Run 'npm run build' in the repo and redeploy (dist/ must be available to the server).` });

    if (req.method === "GET" && (url.pathname === "/extension.zip" || url.pathname === "/extension.crx")) {
      const file = join(distDir(), url.pathname.slice(1));
      if (!existsSync(file)) {
        return json(res, 404, distNotBuilt("extension package"));
      }
      const body = readFileSync(file);
      res.writeHead(200, {
        "content-type": url.pathname.endsWith(".crx") ? "application/x-chrome-extension" : "application/zip",
        "content-length": body.length,
        "content-disposition": `attachment; filename="claude-code-chrome-bridge${url.pathname.slice(url.pathname.lastIndexOf("."))}"`,
        // These change every rebuild and are small, so revalidation buys
        // nothing — tell every intermediary (including Cloudflare, whose
        // default cache-by-extension rule would otherwise serve a stale
        // build for up to 4 hours) to never store a copy.
        "cache-control": "no-store",
      });
      return res.end(body);
    }

    // --- onboarding: the /ccchrome slash command, staged into dist/ by
    // `npm run build` alongside the zip/crx (see scripts/build-extension.mjs).

    if (req.method === "GET" && url.pathname === "/ccchrome.md") {
      const file = join(distDir(), "ccchrome.md");
      if (!existsSync(file)) {
        return json(res, 404, distNotBuilt("ccchrome.md"));
      }
      const body = readFileSync(file);
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-length": body.length,
        "cache-control": "no-store",
      });
      return res.end(body);
    }

    // --- MCP endpoint --------------------------------------------------------

    if (url.pathname !== "/mcp") {
      return json(res, 404, { error: "not found" });
    }

    const token = authToken(req);
    if (!token) {
      return json(res, 401, { error: "unauthorized. Send 'Authorization: Bearer <token>'." });
    }

    try {
      const sessionId = req.headers["mcp-session-id"];
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) {
          return json(res, 404, { error: "unknown or expired mcp session; reconnect" });
        }
        if (session.token !== token) {
          return json(res, 403, { error: "session belongs to a different token" });
        }
        session.lastSeen = Date.now();
        const body = req.method === "POST" ? await readBody(req) : undefined;
        await session.transport.handleRequest(req, res, body);
        return;
      }

      if (req.method !== "POST") {
        return json(res, 400, { error: "missing mcp-session-id" });
      }

      // New session (initialize request).
      const body = await readBody(req);
      const sessionRef = { id: null };
      // A panel keeps one MCP session id for its whole life even though it
      // spawns a fresh `claude` per turn. The id decides the tab group name, so
      // letting each turn generate its own would hand every turn a brand new
      // group and lock Claude out of the tabs it opened a moment earlier.
      const panelId = url.searchParams.get("panel");
      const panel = panelId ? panels.get(panelId) : null;
      if (panelId && !panel) {
        return json(res, 404, { error: "unknown panel id" });
      }
      if (panel && panel.token !== token) {
        return json(res, 403, { error: "panel belongs to a different token" });
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => (panel ? panel.mcpSessionId : randomUUID()),
        onsessioninitialized: (id) => {
          sessionRef.id = id;
          // The previous turn's transport still holds this id. Close it first,
          // or its entry is silently overwritten and never cleaned up.
          const previous = sessions.get(id);
          if (previous && previous.transport !== transport) {
            // close() is async: a plain try/catch would let a rejection escape
            // as an unhandled rejection, which Node ≥15 treats as fatal. This
            // runs on every single turn, so it has to be the safe form.
            Promise.resolve(previous.transport.close()).catch(() => { /* already gone */ });
          }
          sessions.set(id, { transport, token, lastSeen: Date.now() });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      const name = tokens.get(token);
      const server = buildMcpServer(
        () => registry.require(token),
        () => registry.requireNow(token),
        { mode: "http", user: name },
        sessionRef
      );
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log("HTTP /mcp error:", err.message);
      if (!res.headersSent) json(res, 500, { error: err.message });
    }
  });

  const INSTALL_DIR = join(homedir(), ".cc-chrome-bridge");
  const PANEL_CWD = join(homedir(), ".cc-chrome-bridge", "panel");
  // Outside the install directory on purpose: a rollback overwrites the whole
  // install dir and would swallow the very record explaining why it rolled back.
  const UPDATE_STATUS_FILE = join(homedir(), ".ccchrome-update.json");
  // The panel may ask as often as it likes — it asks on every `ready`, which
  // includes every reconnect — but GitHub allows 60 unauthenticated requests an
  // hour per IP, shared by every panel and every machine behind one address.
  // Exceeding it fails closed, so an un-cached check goes quiet precisely when a
  // release does exist. 30 minutes is irrelevant for a tool nobody updates hourly.
  const RELEASE_CACHE_MS = 30 * 60 * 1000;
  let releaseCache = null; // { at, latest, notes }
  // One update at a time, process-wide. A second panel asking mid-update must be
  // refused rather than queued — two installers racing over one directory is the
  // one failure this feature cannot recover from. The read-then-set in
  // update_start below has no `await` between the check and the write, so two
  // concurrent `update_start` frames cannot both pass it — Node runs that
  // handler to its first `await` without yielding, which is what makes the
  // race structurally impossible rather than merely untested.
  let updateInFlight = false;
  let updateInFlightTimer = null;
  // Everything under here is derived from the design's tool-set decision: the
  // agent gets the chrome MCP tools and nothing else.
  const PANEL_ALLOWED_TOOLS = process.env.CC_CHROME_PANEL_TOOLS || "mcp__chrome";
  const PANEL_SYSTEM_PROMPT =
    "Bạn là trợ lý duyệt web chạy trong khung chat bên cạnh trình duyệt Chrome của người dùng. " +
    "Bạn chỉ có các tool điều khiển trình duyệt, không đọc/ghi được file trên máy. " +
    "Bạn chỉ thao tác được trên các tab nằm trong tab group của phiên này; " +
    "muốn làm việc trên một trang người dùng đang mở, hãy bảo họ bấm nút \"Đưa tab này vào phiên\". " +
    "Trả lời ngắn gọn bằng tiếng Việt.";

  // A panel proves itself by receiving a frame, mirroring the rule the extension
  // already lives by: `open` fires for refusals too, so only a message from the
  // server is evidence of a live socket.
  function attachPanel(ws, token) {
    const panelId = randomUUID();
    const panel = {
      id: panelId,
      ws,
      token,
      agent: null,
      // Chosen here, handed to the MCP transport when the child initializes.
      mcpSessionId: randomUUID(),
    };
    panels.set(panelId, panel);
    log(`[panel ${panelId.slice(0, 8)}] connected`);

    // AgentSession.onEvent can still fire just after dispose(), by which point
    // the socket may already be gone — a send must never throw there.
    const send = (obj) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    };

    ws.on("close", () => {
      panels.delete(panelId);
      if (panel.agent) panel.agent.dispose();
      // The panel's MCP transport is keyed by an id only this panel ever uses,
      // so once the panel is gone nothing can reach it again — but it would sit
      // in `sessions` pinning a transport and an McpServer until the 8-hour
      // idle reaper. Open and close the side panel through a working day and
      // that is dozens of them.
      const session = sessions.get(panel.mcpSessionId);
      if (session) {
        sessions.delete(panel.mcpSessionId);
        Promise.resolve(session.transport.close()).catch(() => { /* already gone */ });
      }
      log(`[panel ${panelId.slice(0, 8)}] disconnected`);
    });
    ws.on("error", (err) => log(`[panel ${panelId.slice(0, 8)}] socket error:`, err.message));

    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      try {
        await handlePanelMessage(panel, msg, send);
      } catch (err) {
        send({ type: "error", message: err.message });
      }
    });

    ws.send(JSON.stringify({ type: "hello", panelId, version: VERSION }));
  }

  // Both ids a panel may replay are caller-supplied, and one of them reaches
  // argv: sessionId is handed to `claude --resume`/`--session-id`. spawn() takes
  // an argv array so there is no shell to inject into, but an arbitrary string
  // still reaches the CLI's own parser, and a value shaped like a flag is read
  // as one. Everything the server ever hands a panel is a UUID, so anything
  // else is a bug or an attempt — refuse it here rather than pass it on.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const uuidOrNull = (value, field) => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !UUID_RE.test(value)) {
      throw new Error(`${field} không hợp lệ (phải là UUID) — bấm "Phiên mới" để bắt đầu lại.`);
    }
    return value;
  };

  // An mcp session id replayed by a panel may only be adopted if nothing live
  // is using it: an id still bound to an MCP transport, or held by another open
  // panel, would put two conversations in one tab group and let the newcomer
  // evict the incumbent's transport.
  const mcpSessionIdFree = (panel, id) => {
    if (sessions.has(id)) return false;
    for (const other of panels.values()) {
      if (other !== panel && other.mcpSessionId === id) return false;
    }
    return true;
  };

  async function handlePanelMessage(panel, msg, send) {
    if (msg.type === "start") {
      // Validate both replayed ids before touching any existing agent state.
      // Validating after dispose() let a malformed frame tear down a live agent
      // and only then throw, leaving panel.agent pointing at the disposed
      // AgentSession — the `if (!panel.agent)` guard further down never fires,
      // so the next `prompt` spawns a real `claude` child whose events are all
      // swallowed by AgentSession.emit()'s `this.disposed` check. The panel
      // looks frozen and a paid turn is consumed for nothing.
      let sessionId = uuidOrNull(msg.sessionId, "sessionId");
      const replayedMcpId = uuidOrNull(msg.mcpSessionId, "mcpSessionId");

      if (panel.agent) panel.agent.dispose();
      mkdirSync(PANEL_CWD, { recursive: true });

      // Two side panels in two Chrome windows used to load one extension-global
      // id and both `claude --resume` the same on-disk conversation, interleaving
      // two chats into one file. The extension now keys its stored ids per
      // window; this is the backstop for every other way two panels can end up
      // holding one id — a fresh conversation, and a line saying so, instead of
      // silent corruption.
      const takenOver = Boolean(sessionId) &&
        [...panels.values()].some((other) => other !== panel && other.agent?.sessionId === sessionId);
      if (takenOver) sessionId = null;
      // A panel that reopens replays the id it remembered from `ready`, and for
      // that id the conversation already exists on disk — the first turn has to
      // --resume it. Only a server-generated id is genuinely new.
      const resuming = Boolean(sessionId);
      if (!sessionId) sessionId = randomUUID();

      // The conversation survives a reconnect through --resume; without this the
      // tab group did not. mcpSessionId is what sessionGroupTitle() hashes into
      // the group name, and a freshly minted one after a socket drop or a bridge
      // restart renames the group — stranding every tab the user attached, with
      // nothing on screen explaining why. So the panel replays it too.
      if (replayedMcpId && replayedMcpId !== panel.mcpSessionId && mcpSessionIdFree(panel, replayedMcpId)) {
        panel.mcpSessionId = replayedMcpId;
      }

      panel.agent = new AgentSession({
        sessionId,
        model: msg.model || null,
        token: panel.token,
        // Derived from HOST, not hardcoded: with CC_CHROME_HOST=::1 the panel
        // opens (::1 is loopback) and a hardcoded 127.0.0.1 would leave every
        // child unable to reach /mcp at all.
        mcpUrl: `http://${hostForUrl(HOST)}:${PORT}/mcp?panel=${panel.id}`,
        allowedTools: PANEL_ALLOWED_TOOLS,
        // Absolute path baked in by the installer. A bare "claude" resolves
        // through PATH, and this process runs as a background service whose
        // PATH is the OS default — /usr/bin:/bin:/usr/sbin:/sbin under launchd,
        // where no package manager's bin directory appears.
        claudeBin: claudeBinFromEnv(),
        cwd: PANEL_CWD,
        systemPrompt: PANEL_SYSTEM_PROMPT,
        // Which event shape this panel understands. Absent = 1 = an extension
        // that predates the activity timeline and only renders `tool`.
        protocol: Number(msg.protocol) || 1,
        resuming,
        onEvent: (event) => send(event),
        log,
      });
      send({
        type: "ready",
        sessionId,
        // Replayed back on the next `start` — see the tab-group note above.
        mcpSessionId: panel.mcpSessionId,
        model: msg.model || null,
        // Must match sessionGroupTitle() in extension/background.js character
        // for character — the panel shows the user which tab group is theirs.
        groupTitle: `Claude · ${panel.mcpSessionId.replace(/-/g, "").slice(0, 4)}`,
      });
      if (takenOver) {
        send({
          type: "error",
          message: "Hội thoại này đang mở ở một khung chat khác — khung chat này bắt đầu một hội thoại mới.",
        });
      }
      return;
    }

    if (msg.type === "update_check") {
      send(await buildUpdateStatus());
      return;
    }

    if (msg.type === "update_start") {
      // msg.url is deliberately not read. The URL is derived from a constant in
      // updater.js and from the tag GitHub reports; letting a caller name it
      // would turn this endpoint into "download and run whatever I point at".
      if (updateInFlight) {
        send({ type: "update_failed", reason: "Đang có một bản cập nhật chạy dở." });
        return;
      }
      if (panel.agent?.busy) {
        send({ type: "update_failed", reason: "Claude đang chạy — dừng lượt chat rồi cập nhật." });
        return;
      }
      updateInFlight = true;
      // Nothing clears this on the success path — the installer is expected to
      // kill this process long before the timer fires. It exists for the case
      // where the handover succeeds but the install never gets that far, which
      // would otherwise refuse every future update until the bridge restarts.
      // Cancelled wherever the flag is cleared: an uncancelled timer from an
      // earlier attempt would otherwise fire mid-way through a later one and
      // unlatch an update that really is in flight.
      updateInFlightTimer = setTimeout(() => { updateInFlight = false; }, 10 * 60 * 1000);
      updateInFlightTimer.unref();
      try {
        await startUpdate(send);
      } catch (err) {
        updateInFlight = false;
        if (updateInFlightTimer) { clearTimeout(updateInFlightTimer); updateInFlightTimer = null; }
        send({ type: "update_failed", reason: err.message });
      }
      return;
    }

    // Checked before the agent-state guard so an unrecognised type always names
    // itself: silence here would send whoever writes the panel UI hunting for a
    // bug in the agent when the real fault is a typo in the frame they sent.
    if (msg.type !== "prompt" && msg.type !== "stop" && msg.type !== "attach_tab") {
      throw new Error(`Không hiểu lệnh '${String(msg.type)}' từ panel.`);
    }

    if (!panel.agent) throw new Error("Chưa khởi tạo phiên — gửi 'start' trước.");

    if (msg.type === "prompt") {
      const text = String(msg.text || "").trim();
      if (!text) return;
      if (panel.agent.busy) throw new Error("Claude đang chạy — bấm dừng trước đã.");
      panel.agent.send(text);
      return;
    }

    if (msg.type === "stop") {
      panel.agent.stop();
      return;
    }

    if (msg.type === "attach_tab") {
      const result = await attachPanelTab(panel);
      send({ type: "attach_tab_result", ...result });
      return;
    }
  }

  // Reaches the extension over the bridge socket the same way a tool call does,
  // but carries the panel's own MCP session id so the tab lands in the panel's
  // group rather than the terminal session's.
  //
  // Takes no windowId: an earlier version accepted one from the panel and
  // validated it, but Chrome window ids are small sequential integers — a
  // local process holding the panel token could enumerate 1..N and pull an
  // arbitrary window's active tab into its group, not just the one the user
  // meant to share. The fix is that the extension itself derives the
  // focused window at handling time (see attach_tab in
  // extension/background.js), so there is no parameter here to validate.
  async function attachPanelTab(panel) {
    try {
      const conn = await registry.require(panel.token);
      const result = await conn.call("attach_tab", {}, REQUEST_TIMEOUT_MS, panel.mcpSessionId);
      return { ok: true, title: result.title, url: result.url };
    } catch (err) {
      // The extension's error messages here are written for Claude to act on
      // ("Navigate to a normal web page first."), not for the person reading
      // the Vietnamese panel UI. Translate the cases a user actually hits;
      // anything unrecognised passes through unchanged rather than being
      // papered over with a generic message that would hide a real fault.
      //
      // "No last-focused window" is Chrome's own rejection text from
      // chrome.windows.getLastFocused({windowTypes:["normal"]}) when no
      // normal window matches (e.g. only devtools/popup windows are open).
      // "Grouping is not supported by tabs in this window." is Chrome's own
      // text from chrome.tabs.group() for windows that structurally cannot
      // hold a tab group. "No active tab in window" is attach_tab's own
      // throw for the (now narrow, focus-then-query race) case where the
      // window found by getLastFocused() has no active tab by the time it's
      // queried — kept translated since it can still fire, just rarely.
      // "only available on a bridge running on this machine" is the extension's
      // own refusal (assertLoopbackBridge in extension/background.js) when its
      // saved URL points at a shared bridge. Reachable here only if the URL was
      // changed while this panel's socket stayed open, but it is the one case
      // where the fix is a setting the user can see.
      const message = /only available on a bridge running on this machine/.test(err.message)
        ? "Extension đang trỏ vào một bridge dùng chung, nên không đưa tab vào phiên được. Mở popup và đổi URL sang bridge chạy trên máy này (ws://127.0.0.1:…)."
        : /browser-internal page/.test(err.message)
        ? "Không thể thao tác trên trang nội bộ của trình duyệt (chrome://, devtools://...). Hãy chuyển sang một trang bình thường rồi thử lại."
        : /No last-focused window/.test(err.message)
          ? "Không tìm thấy cửa sổ trình duyệt nào đang mở để đưa tab vào phiên."
          : /Grouping is not supported by tabs in this window/.test(err.message)
            ? "Không thể nhóm tab ở cửa sổ này. Hãy thử lại từ một cửa sổ trình duyệt bình thường."
            : /No active tab in window/.test(err.message)
              ? "Không tìm thấy tab đang mở trong cửa sổ này."
              : err.message;
      return { ok: false, error: message };
    }
  }

  // Reports what is installed, what is published, and how the last attempt went.
  // A GitHub outage or a rate limit must not surface as an error the user has to
  // read — there is nothing they can do about it, and the panel is not a status
  // page for github.com. It degrades to "no update available".
  async function buildUpdateStatus() {
    let lastResult = null;
    try {
      lastResult = JSON.parse(readFileSync(UPDATE_STATUS_FILE, "utf8"));
    } catch { /* no previous update, or unreadable — not an error */ }

    if (isCacheFresh(releaseCache, Date.now(), RELEASE_CACHE_MS)) {
      return {
        type: "update_status",
        current: VERSION,
        latest: releaseCache.latest,
        available: compareVersions(releaseCache.latest, VERSION) === 1,
        notes: releaseCache.notes,
        lastResult,
      };
    }

    try {
      const res = await fetch(LATEST_RELEASE_API, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "cc-chrome-bridge" },
      });
      if (!res.ok) throw new Error(`GitHub trả ${res.status}`);
      const body = await res.json();
      const tag = body?.tag_name;
      if (!isValidTag(tag)) throw new Error(`tag không hợp lệ: ${String(tag)}`);
      const latest = String(tag).replace(/^v/, "");
      const notes = typeof body?.body === "string" ? body.body.slice(0, 2000) : "";
      releaseCache = { at: Date.now(), latest, notes };
      return {
        type: "update_status",
        current: VERSION,
        latest,
        available: compareVersions(latest, VERSION) === 1,
        notes,
        lastResult,
      };
    } catch (err) {
      // Deliberately does not touch releaseCache: a network hiccup must not
      // erase a previously known-good latest version, or the one real signal
      // this tool exists to surface (a release is available) goes dark right
      // when GitHub is having a bad minute.
      log("[update] không hỏi được bản mới:", err.message);
      if (releaseCache) {
        return {
          type: "update_status",
          current: VERSION,
          latest: releaseCache.latest,
          available: compareVersions(releaseCache.latest, VERSION) === 1,
          notes: releaseCache.notes,
          lastResult,
        };
      }
      return { type: "update_status", current: VERSION, latest: null, available: false, notes: "", lastResult };
    }
  }

  // Everything that can fail harmlessly happens here, while the socket is still
  // up and before a single byte of the installed copy is touched: the network,
  // the checksum, the disk. Only once a verified, reshaped source directory
  // exists does it hand over to the detached runner and let go.
  async function startUpdate(send) {
    send({ type: "update_progress", step: "downloading" });
    const status = await buildUpdateStatus();
    if (!status.available || !status.latest) throw new Error("Không có bản mới để cài.");

    const urls = releaseUrls(`v${status.latest}`);
    let work = null;
    try {
      work = mkdtempSync(join(tmpdir(), "cc-update-"));
      const tarball = join(work, "release.tar.gz");

      const tarRes = await fetch(urls.tarball);
      if (!tarRes.ok) throw new Error(`Tải gói thất bại (${tarRes.status}).`);
      writeFileSync(tarball, Buffer.from(await tarRes.arrayBuffer()));

      send({ type: "update_progress", step: "verifying" });
      const sumRes = await fetch(urls.checksum);
      if (!sumRes.ok) throw new Error(`Bản phát hành thiếu file checksum (${sumRes.status}).`);
      const expected = parseChecksumFile(await sumRes.text());
      if (!expected) throw new Error("File checksum không đọc được.");
      const actual = await sha256File(tarball);
      if (actual !== expected) {
        throw new Error("Checksum không khớp — gói tải về không đúng bản đã phát hành. Không cài gì cả.");
      }

      send({ type: "update_progress", step: "extracting" });
      const extracted = join(work, "extracted");
      mkdirSync(extracted, { recursive: true });
      await new Promise((resolve, reject) => {
        const child = spawn("tar", ["-xzf", tarball, "-C", extracted], { stdio: "ignore" });
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Giải nén thất bại (mã ${code}).`))));
      });
      const source = join(work, "source");
      reshapeToCheckout(extracted, source);

      send({ type: "update_progress", step: "installing" });
      spawnUpdateRunner({ source, work, version: status.latest });
    } catch (err) {
      // The reshaped source is only needed if the handover succeeded. On any
      // failure it is three copies of a node_modules-bearing payload, and the
      // stub throwing means this is the path every attempt takes today.
      if (work) rmSync(work, { recursive: true, force: true });
      throw err;
    }
  }

  // On darwin, `command`/`args` from buildRunnerSpawn IS the runner: detached
  // and unref'd, because it must outlive the process spawning it — the
  // installer's first act is to stop the service that IS this process. stdio
  // is fully detached for the same reason — a pipe to a dead parent would
  // kill it. `cwd` here is the LAUNCHER's cwd (on linux/win32 that means the
  // short-lived systemd-run/powershell process, not the runner itself — the
  // runner's own cwd comes from -WorkingDirectory on win32 and from systemd's
  // default on linux).
  //
  // On linux and win32, `command`/`args` is a short-lived LAUNCHER that hands
  // the runner to a supervisor (systemd, Task Scheduler) and exits, so it is
  // run synchronously and its exit code is checked: a failed handover must be
  // reported to the panel, not silently leave the bridge running with no
  // update in flight and no explanation. A failed *darwin* spawn can only be
  // discovered later, from the child's own 'error' event — by then this
  // function has already returned, so it writes the failure straight into
  // UPDATE_STATUS_FILE for the panel's next update_check to pick up.
  function spawnUpdateRunner({ source, work, version }) {
    const installer = process.platform === "win32"
      ? join(INSTALL_DIR, "install.ps1")
      : join(INSTALL_DIR, "install.sh");
    const taskName = updateTaskName(version, process.pid);
    const runnerArgs = [
      "--source", source,
      "--work", work,
      "--install-dir", INSTALL_DIR,
      "--installer", installer,
      "--port", String(PORT),
      "--expect-version", version,
      "--status-file", UPDATE_STATUS_FILE,
      "--task-name", taskName,
    ];
    // The absolute `claude` path this bridge is running with, forwarded so the
    // reinstall cannot lose it. The installer regenerates the service unit, and
    // its `command -v claude` runs under the service's own minimal PATH
    // (measured: /usr/bin:/bin:/usr/sbin:/sbin, where claude is not found) —
    // without this the regenerated unit silently drops the variable and every
    // later panel turn fails with "spawn claude ENOENT", after the update has
    // already been declared a success. Only the darwin branch spawns the runner
    // as our own child, so inheritance alone would not carry it on linux/win32.
    if (process.env.CC_CHROME_CLAUDE_BIN) {
      runnerArgs.push("--claude-bin", process.env.CC_CHROME_CLAUDE_BIN);
    }
    const { command, args, sync } = buildRunnerSpawn(process.platform, {
      node: process.execPath,
      runner: join(INSTALL_DIR, "update-runner.mjs"),
      args: runnerArgs,
      taskName,
      workingDir: tmpdir(),
    });

    if (!sync) {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        cwd: tmpdir(),
        windowsHide: true,
      });
      child.on("error", (err) => {
        // No uncaughtException handler exists anywhere in this file, so an
        // 'error' event with no listener would throw out of the event loop
        // and take the bridge down — exactly the outcome this whole feature
        // exists to avoid. startUpdate()'s try has already returned by the
        // time this fires, so the only way to tell the panel is the status
        // file its next update_check reads.
        //
        // updateInFlight and `work` are cleared here too, not just the status
        // file: startUpdate()'s catch — the only other place either is
        // touched — never runs on this path, because spawn() itself did not
        // throw. Left alone, updateInFlight would refuse every retry with
        // "Đang có một bản cập nhật chạy dở." for the full ten minutes, and
        // `work` (a node_modules-bearing temp tree) would never be removed.
        updateInFlight = false;
        if (updateInFlightTimer) { clearTimeout(updateInFlightTimer); updateInFlightTimer = null; }
        try { rmSync(work, { recursive: true, force: true }); } catch { /* best-effort cleanup only */ }
        try {
          writeFileSync(UPDATE_STATUS_FILE, JSON.stringify({
            ok: false, step: "handover-failed", version,
            reason: `Không bàn giao được tiến trình cập nhật: ${err.message}`,
            at: new Date().toISOString(),
          }, null, 2));
        } catch { /* a status we cannot write must not throw again */ }
      });
      child.unref();
      return;
    }

    // linux / win32: `command` is a short-lived launcher (systemd-run,
    // powershell), not the runner. Wait for it and read its exit code —
    // a non-zero one (e.g. systemd-run missing on a no-systemd install, see
    // scripts/install.sh:265-276) must surface as a thrown Error so
    // startUpdate()'s catch cleans up `work` and reports the failure to the
    // panel, instead of leaving the bridge silently stuck mid-update.
    //
    // cwd is tmpdir(), not the install directory the bridge inherited: on
    // Windows that install directory is exactly the tree about to be
    // replaced (see scripts/update-runner.mjs's own comment on why it never
    // runs from inside it). spawnSync blocks the whole event loop, so the
    // timeout is kept short — 15s, not 30s — to stay clear of the
    // extension-bridge liveness sweep's own 30s interval: Node runs the
    // timers phase before the poll phase, so a near-full-30s block could fire
    // that sweep before a buffered pong is read and terminate() a perfectly
    // healthy extension connection. 15s is still generous; the realistic path
    // (Register + Start) is 2-5s, the cost being PowerShell loading the
    // ScheduledTasks module. Do not raise it: on a timeout, startUpdate's
    // catch deletes `work`, which is only correct if the launcher hung
    // BEFORE the task started.
    const result = spawnSync(command, args, { stdio: "ignore", cwd: tmpdir(), windowsHide: true, timeout: 15000 });
    if (result.error || result.status !== 0) {
      const detail = result.error ? result.error.message : `mã thoát ${result.status}`;
      throw new Error(`Không bàn giao được tiến trình cập nhật cho ${command}: ${detail}.`);
    }
  }

  // WebSocket endpoints: /ws for the extension bridge, /panel for the side panel
  // chat. Two servers, one gate — both go through the same origin and token
  // checks, so there is only ever one auth path to keep honest.
  const wss = new WebSocketServer({ noServer: true, handleProtocols: pickSubprotocol });
  const panelWss = new WebSocketServer({ noServer: true, handleProtocols: pickSubprotocol });
  const panels = new Map(); // panelId -> PanelConnection (filled in by /panel below)

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const isPanel = url.pathname === "/panel";
    if (url.pathname !== "/ws" && !isPanel) {
      socket.destroy();
      return;
    }

    const server = isPanel ? panelWss : wss;

    // Rejections complete the handshake and then close with a specific code.
    // A browser cannot read the HTTP status of a failed upgrade, so destroying
    // the socket would reach the extension as an indistinguishable 1006 — the
    // user would see "server not running" for what is really a config error.
    // A rejected socket is never registered, so it can do nothing meanwhile.
    const reject = (code, reason) => {
      server.handleUpgrade(req, socket, head, (ws) => ws.close(code, reason));
    };

    // Checked before origin and token on purpose: on a bridge anyone else can
    // reach, the panel does not exist at all, and saying so is not a
    // credential leak.
    if (isPanel) {
      const refusal = panelRefusalReason(req);
      if (refusal) {
        log(`Rejected /panel upgrade: ${refusal}`);
        return reject(4004, "panel needs a bridge only this machine can reach");
      }
    }

    const origin = req.headers.origin || "";
    if (!originAllowed(origin)) {
      log(`Rejected ws upgrade from origin: ${origin || "(none)"}`);
      return reject(4003, "origin not allowed");
    }

    const token = tokenFromSubprotocol(req);
    if (!token) {
      log("Rejected ws upgrade: no token subprotocol (extension older than 2.0.0?)");
      return reject(4002, "missing token subprotocol");
    }
    if (!tokens.has(token)) {
      log("Rejected ws upgrade: bad token");
      return reject(4001, "invalid token");
    }

    server.handleUpgrade(req, socket, head, (ws) => {
      if (isPanel) attachPanel(ws, token);
      else registry.attach(ws, token, tokens.get(token));
    });
  });

  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log(`FATAL: port ${PORT} already in use.`);
      process.exit(1);
    }
    log("HTTP server error:", err.message);
  });

  httpServer.listen(PORT, HOST, () => {
    // These are the first lines in ~/.cc-chrome-bridge/logs/bridge.err.log,
    // which is exactly where install.sh and the README send a user whose
    // bridge did not come up — so they have to describe THIS bridge. The
    // default install is local: no domain, no TLS terminator, no pairing.
    // Printing wss://<domain>/… there sends someone to configure a server
    // that does not exist. Same derivation as notConnectedError() above,
    // hostForUrl() included so a CC_CHROME_HOST=::1 bridge prints a URL that
    // can actually be pasted.
    const base = `http://${hostForUrl(HOST)}:${PORT}`;
    log(`MCP server (http mode) listening on ${base}`);
    if (isLoopbackHost(HOST)) {
      log(`  Claude Code:  claude mcp add --scope user --transport http chrome ${base}/mcp --header "Authorization: Bearer <token>"`);
      log(`  Extension:    ws://${hostForUrl(HOST)}:${PORT}/ws?token=<token>  (set in the extension popup)`);
      log(`  Health:       GET ${base}/health`);
    } else {
      // Bound to a non-loopback address: a reverse proxy is the only
      // supported way to reach this, so the public URL is a domain this
      // process cannot know — <domain> stays a placeholder on purpose.
      log(`  Claude Code:  claude mcp add --transport http chrome https://<domain>/mcp --header "Authorization: Bearer <token>"`);
      log(`  Extension:    wss://<domain>/ws?token=<token>  (set in the extension popup)`);
      log(`  Health:       GET /health`);
      log(`  Downloads:    GET /extension.zip, GET /extension.crx, GET /ccchrome.md (if dist/ is built)`);
    }
  });
}

await mainHttp();
