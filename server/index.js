#!/usr/bin/env node
// MCP server that bridges Claude Code to the "Claude Code Chrome Bridge"
// extension.
//
// Two modes:
//
// 1. stdio (default) — for running locally on each developer machine:
//      Claude Code --(MCP/stdio)--> this process --(ws://127.0.0.1)--> extension
//
// 2. http (--http flag or CC_CHROME_MODE=http) — for hosting on a shared
//    VPS so a whole team can use one server:
//      Claude Code --(MCP over Streamable HTTP, Bearer token)--> this process
//      extension  --(wss://host/ws?token=...)--------------------^
//    Each token identifies one team member: their Claude Code sessions are
//    routed to their own Chrome extension. Tokens are required in http mode.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TokenStore } from "./tokens.js";
import { RateLimiter, clientIp } from "./ratelimit.js";
import { AgentSession } from "./agent.js";

const MODE = process.argv.includes("--http") || process.env.CC_CHROME_MODE === "http" ? "http" : "stdio";
const PORT = Number(process.env.CC_CHROME_PORT || (MODE === "http" ? 8787 : 9876));
const HOST = process.env.CC_CHROME_HOST || (MODE === "http" ? "0.0.0.0" : "127.0.0.1");
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
const VERSION = "3.4.0";

// The panel spawns `claude` on this host with the team's logged-in account, so
// it exists only on a bridge nobody else can reach. A public deployment keeps
// serving tools and refuses the panel outright — see /panel below.
function isLoopbackHost(host) {
  const bare = String(host || "").replace(/^\[|\]$/g, "");
  return bare === "127.0.0.1" || bare === "localhost" || bare === "::1";
}
const AGENT_ENABLED = isLoopbackHost(HOST);

// One Chrome tab group per Claude Code session. stdio serves exactly one
// session per process, so a value minted at startup is that session's identity;
// http reuses the MCP session id, which already means the same thing.
const STDIO_SESSION_ID = randomUUID();

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
// the handshake with no usable error. Both modes install this: stdio normally
// sees no subprotocol, but a local URL that still carries ?token= would make
// the extension offer one.
function pickSubprotocol(protocols) {
  for (const proto of protocols) {
    if (proto.startsWith(SUBPROTOCOL_PREFIX)) return proto;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Extension connections
// ---------------------------------------------------------------------------

// An unparseable or absent version counts as too old: only a version this
// server can read and confirm to be >= 3.0.0 proves the extension enforces
// tab-group isolation.
function isPreIsolationExtension(version) {
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
      if (isPreIsolationExtension(msg.version)) {
        log(
          `[${this.name}] WARNING: extension version ${msg.version || "unknown"} is older than 3.0.0 — ` +
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
    const where = MODE === "http"
      ? `Point the extension at this server: click the extension icon in Chrome and set the WebSocket URL to wss://<your-domain>/ws?token=<your-token> (same token as your Claude Code config), then 'Lưu & kết nối lại'.`
      : `Make sure Chrome is running with the extension installed and its WebSocket URL is ws://127.0.0.1:${PORT} (click the extension icon to check).`;
    return new Error(
      "Chrome extension is not connected for this account.\n" +
      "1. Chrome must be running with the 'Claude Code Chrome Bridge' extension installed (chrome://extensions -> Load unpacked -> extension/ folder).\n" +
      `2. ${where}`
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
    "Switch to (activate and focus) a tab by id. Only accepts a tab in this session's own tab group.",
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
// stdio mode (local, single user)
// ---------------------------------------------------------------------------

async function mainStdio() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT, handleProtocols: pickSubprotocol });
  wss.on("listening", () => log(`WebSocket bridge listening on ws://127.0.0.1:${PORT}`));
  wss.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log(`FATAL: port ${PORT} already in use. Another MCP server instance running? Set CC_CHROME_PORT to change.`);
      process.exit(1);
    }
    log("WebSocket server error:", err.message);
  });
  wss.on("connection", (socket, req) => {
    const origin = req.headers.origin || "";
    if (!originAllowed(origin)) {
      log(`Rejected connection from origin: ${origin || "(none)"}`);
      socket.close(4003, "origin not allowed");
      return;
    }
    registry.attach(socket, "default", "local");
  });

  const server = buildMcpServer(
    () => registry.require("default"),
    () => registry.requireNow("default"),
    { mode: "stdio" },
    { id: STDIO_SESSION_ID }
  );
  await server.connect(new StdioServerTransport());
  log(`MCP server ready (stdio). Waiting for the Chrome extension on ws://127.0.0.1:${PORT} ...`);
}

// ---------------------------------------------------------------------------
// GET /install.sh, GET /uninstall.sh — one-command onboarding and removal
// ---------------------------------------------------------------------------

// Generates the installer as plain bash text, with `base` (this server's own
// public origin, from publicOrigin(req)) baked into it — never a hardcoded
// domain. Kept as a template rather than a separate .sh asset in dist/ so it
// never drifts out of sync with what this server actually serves at
// /ccchrome.md and /extension.zip.
function installScript(base) {
  return `#!/usr/bin/env bash
# Claude Code Chrome Bridge — bộ cài đặt một lệnh.
# Được tải mới mỗi lần từ ${base}/install.sh. Nên đọc trước khi chạy:
#   curl -fsSL ${base}/install.sh -o install.sh
#   less install.sh
#   bash install.sh
#
# Script này chỉ làm việc mà một script làm được từ đầu đến cuối: cài slash
# command /ccchrome. Cài extension Chrome cần bấm tay trong chrome://extensions,
# nên việc đó chuyển sang '/ccchrome connect' — chạy đúng lúc người dùng cần nó
# và đang chú ý, chứ không nhét vào một script chạy nền im lặng.

BASE="${base}"
COMMAND_DEST="$HOME/.claude/commands/ccchrome.md"

echo "Claude Code Chrome Bridge — cài đặt"
echo "  Server:         $BASE"
echo "  Slash command:  $COMMAND_DEST"
echo ""

if [ -z "$BASH_VERSION" ]; then
  echo "Lỗi: script này cần chạy bằng bash (vd: curl -fsSL $BASE/install.sh | bash)." >&2
  exit 1
fi

set -euo pipefail

missing=""
for cmd in curl; do
  command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"
done
if [ -n "$missing" ]; then
  echo "Lỗi: thiếu lệnh cần thiết:$missing — cài rồi chạy lại." >&2
  exit 1
fi

# --- Slash command /ccchrome -------------------------------------------------

mkdir -p "$(dirname "$COMMAND_DEST")"
tmp_cmd="$(mktemp)"
curl -fsSL "$BASE/ccchrome.md" -o "$tmp_cmd"
if [ -f "$COMMAND_DEST" ] && ! cmp -s "$tmp_cmd" "$COMMAND_DEST"; then
  echo "Đã có /ccchrome cũ ở $COMMAND_DEST, nội dung khác bản mới — ghi đè (lệnh đã đổi giữa các bản)."
fi
mv "$tmp_cmd" "$COMMAND_DEST"
echo "Đã cài slash command: $COMMAND_DEST"

# --- Bước tiếp theo -----------------------------------------------------------

echo ""
echo "Xong. Bước tiếp theo:"
echo ""
echo "  Mở Claude Code, gõ:"
echo "    /ccchrome connect $BASE"
echo ""
echo "  Lệnh sẽ dẫn bạn cài extension Chrome từng bước, và hỏi pairing secret"
echo "  — xin admin của server này cấp secret đó."
`;
}

// The counterpart to installScript. It removes more than install.sh created:
// install.sh only writes the slash command, but by the time anyone uninstalls,
// /ccchrome connect has also written ~/.ccchrome.json and registered the MCP
// server. Leaving that registration behind is the worst outcome — Claude Code
// would keep starting a bridge that can no longer work, once per session, with
// no hint why.
//
// Two things it deliberately does NOT do, both stated in its own output rather
// than left for the user to discover: it cannot remove the Chrome extension
// (that is a click in chrome://extensions, and the unpacked folder is wherever
// the user chose to put it), and it does not revoke the token on the server.
function uninstallScript(base) {
  return `#!/usr/bin/env bash
# Claude Code Chrome Bridge — gỡ cài đặt.
# Được tải mới mỗi lần từ ${base}/uninstall.sh. Nên đọc trước khi chạy:
#   curl -fsSL ${base}/uninstall.sh -o uninstall.sh
#   less uninstall.sh
#   bash uninstall.sh
#
# Xem trước mà không xoá gì:
#   curl -fsSL ${base}/uninstall.sh | bash -s -- --dry-run

BASE="${base}"
COMMAND_DIR="$HOME/.claude/commands"
COMMAND_DEST="$COMMAND_DIR/ccchrome.md"
CONFIG="$HOME/.ccchrome.json"

if [ -z "$BASH_VERSION" ]; then
  echo "Lỗi: script này cần chạy bằng bash (vd: curl -fsSL $BASE/uninstall.sh | bash)." >&2
  exit 1
fi

set -euo pipefail

# while/shift, not 'for arg in "$@"': bash 3.2 (mặc định trên macOS) coi "$@"
# rỗng là biến chưa gán khi có 'set -u', nên chạy không tham số sẽ chết ngay.
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY_RUN=1 ;;
    -h|--help)
      echo "Cách dùng: bash uninstall.sh [--dry-run]"
      exit 0
      ;;
    *)
      echo "Tham số không hiểu: $1 (chỉ hỗ trợ --dry-run)" >&2
      exit 1
      ;;
  esac
  shift
done

echo "Claude Code Chrome Bridge — gỡ cài đặt"
echo "  Server: $BASE"
if [ "$DRY_RUN" = "1" ]; then
  echo "  CHẾ ĐỘ XEM TRƯỚC — không xoá gì cả."
fi
echo ""
echo "Trước khi xoá: token của bạn trên server vẫn còn hiệu lực sau khi gỡ."
echo "Muốn thu hồi thì dừng lại (Ctrl-C), chạy '/ccchrome disconnect' trong Claude Code trước."
echo ""

removed=0

drop_file() {
  # $1 = đường dẫn, $2 = mô tả
  if [ -f "$1" ]; then
    if [ "$DRY_RUN" = "0" ]; then
      rm -f "$1"
    fi
    echo "  [x] $2: $1"
    removed=$((removed + 1))
  else
    echo "  [ ] $2: không có sẵn, bỏ qua"
  fi
}

# install.sh tạo file này.
drop_file "$COMMAND_DEST" "slash command /ccchrome"

# Chỉ xoá thư mục khi nó rỗng: người dùng có thể có slash command khác ở đó,
# và install.sh cũng chỉ 'mkdir -p' chứ không sở hữu thư mục này.
if [ -d "$COMMAND_DIR" ] && [ -z "$(ls -A "$COMMAND_DIR" 2>/dev/null)" ]; then
  if [ "$DRY_RUN" = "0" ]; then
    rmdir "$COMMAND_DIR" 2>/dev/null || true
  fi
  echo "  [x] thư mục rỗng: $COMMAND_DIR"
  removed=$((removed + 1))
fi

# /ccchrome connect tạo file này (chứa serverUrl + token).
drop_file "$CONFIG" "cấu hình kết nối"

# /ccchrome connect đăng ký MCP server này.
if command -v claude >/dev/null 2>&1; then
  if claude mcp get chrome >/dev/null 2>&1; then
    if [ "$DRY_RUN" = "0" ]; then
      claude mcp remove --scope user chrome >/dev/null 2>&1 || true
      # Kiểm chứng thay vì tin: 'chrome' có thể được đăng ký ở scope project
      # hoặc local, mà lệnh trên chỉ gỡ scope user — báo "đã gỡ" lúc đó là sai.
      if claude mcp get chrome >/dev/null 2>&1; then
        echo "  [!] MCP server 'chrome' vẫn còn đăng ký (nhiều khả năng ở scope project hoặc local)."
        echo "      Gỡ tay: claude mcp remove --scope project chrome   (hoặc --scope local)"
      else
        echo "  [x] đăng ký MCP server 'chrome' (scope user)"
        removed=$((removed + 1))
      fi
    else
      echo "  [x] đăng ký MCP server 'chrome'"
      removed=$((removed + 1))
    fi
  else
    echo "  [ ] đăng ký MCP server 'chrome': không có sẵn, bỏ qua"
  fi
else
  echo "  [!] không thấy lệnh 'claude' trong PATH — tự chạy: claude mcp remove --scope user chrome"
fi

echo ""
if [ "$DRY_RUN" = "1" ]; then
  echo "Xem trước xong: $removed mục sẽ bị xoá. Chạy lại không kèm --dry-run để xoá thật."
else
  echo "Đã gỡ $removed mục."
fi

echo ""
echo "Script không tự làm được hai việc sau — cần bạn tự tay:"
echo ""
echo "  1. Gỡ extension khỏi Chrome: mở chrome://extensions, xoá 'Claude Code Chrome"
echo "     Bridge', rồi xoá thư mục bạn đã giải nén extension vào (đường dẫn ghi ngay"
echo "     trên thẻ extension đó)."
echo ""
echo "  2. Thu hồi token trên server: token vừa xoá khỏi máy bạn vẫn còn hiệu lực trên"
echo "     $BASE cho tới khi bị thu hồi. Nếu đã lỡ xoá file cấu hình rồi, nhờ admin thu"
echo "     hồi giúp."
`;
}

// ---------------------------------------------------------------------------
// http mode (VPS, multi user)
// ---------------------------------------------------------------------------

async function mainHttp() {
  const tokens = new TokenStore(log);
  if (tokens.size === 0 && !tokens.pairSecret) {
    log("FATAL: http mode requires auth. Set CC_CHROME_TOKENS=\"<token>=<name>,...\" (static tokens),");
    log("and/or CC_CHROME_PAIR_SECRET=<secret> to enable self-service pairing via POST /pair (/ccchrome connect).");
    log("Generate strong values with: openssl rand -hex 16");
    process.exit(1);
  }
  if (tokens.size) log(`Loaded ${tokens.size} token(s): ${tokens.names().join(", ")}`);
  log(tokens.pairSecret
    ? `Self-service pairing ENABLED (POST /pair). Dynamic tokens persist in ${tokens.stateFile}`
    : "Self-service pairing disabled (set CC_CHROME_PAIR_SECRET to enable /ccchrome connect)");

  const TRUST_PROXY = process.env.CC_CHROME_TRUST_PROXY === "1";
  // A typo here used to become NaN, and `dynamicSize >= NaN` is always false —
  // the cap disappeared silently. Same guard as CC_CHROME_SESSION_TTL_MS below.
  const maxTokensFromEnv = Number(process.env.CC_CHROME_MAX_TOKENS);
  if (process.env.CC_CHROME_MAX_TOKENS !== undefined && !(Number.isFinite(maxTokensFromEnv) && maxTokensFromEnv > 0)) {
    log(`Ignoring invalid CC_CHROME_MAX_TOKENS=${JSON.stringify(process.env.CC_CHROME_MAX_TOKENS)}; must be a positive number. Using the default.`);
  }
  const MAX_TOKENS = Number.isFinite(maxTokensFromEnv) && maxTokensFromEnv > 0 ? maxTokensFromEnv : 100;
  const pairLimiter = new RateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });
  if (tokens.pairSecret && !TRUST_PROXY) {
    log("Note: CC_CHROME_TRUST_PROXY is not set, so /pair rate limiting keys on the socket address.");
    log("      Behind a reverse proxy that is the proxy itself — set CC_CHROME_TRUST_PROXY=1 there.");
  }

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

  const isPairSecret = (value) => {
    if (!tokens.pairSecret || !value) return false;
    const a = Buffer.from(value);
    const b = Buffer.from(tokens.pairSecret);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  // Public URLs as seen by clients. x-forwarded-proto/-host are client-supplied
  // exactly like x-forwarded-for, so they are honored under the same flag —
  // otherwise anyone reaching this process directly could steer the URLs handed
  // back by /pair (and printed by /ccchrome connect) at a host of their choice.
  const firstHop = (value) => (value ? String(value).split(",")[0].trim() : "");
  const publicOrigin = (req) => {
    const proto = (TRUST_PROXY && firstHop(req.headers["x-forwarded-proto"])) || "http";
    const host = (TRUST_PROXY && firstHop(req.headers["x-forwarded-host"])) || req.headers.host || `localhost:${PORT}`;
    return { proto, host, base: `${proto}://${host}` };
  };
  const publicUrls = (req, token) => {
    const { proto, host, base } = publicOrigin(req);
    const wsProto = proto === "https" ? "wss" : "ws";
    return {
      mcpUrl: `${base}/mcp`,
      wsUrl: `${wsProto}://${host}/ws?token=${token}`,
    };
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

    // --- onboarding: one-command installer (`curl <base>/install.sh | bash`).
    // Generated per-request so it can embed the URL the request actually
    // arrived on (see publicUrls below) instead of a hardcoded domain — the
    // same reasoning that governs publicUrls itself.

    if (req.method === "GET" && url.pathname === "/install.sh") {
      // Refuse to hand out a script guaranteed to fail: it downloads exactly
      // this dist/ file further down. The extension zip is no longer part of
      // the installer — /ccchrome connect fetches it separately, when needed.
      if (!existsSync(join(distDir(), "ccchrome.md"))) {
        return json(res, 404, distNotBuilt("installer"));
      }
      const { base } = publicOrigin(req);
      const body = installScript(base);
      res.writeHead(200, {
        "content-type": "text/x-shellscript; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      return res.end(body);
    }

    // No dist/ guard here, unlike /install.sh: the uninstaller downloads
    // nothing, it only deletes local files. Gating it on a built dist/ would
    // mean a server that cannot serve the installer also refuses to help
    // anyone remove what an earlier build installed.
    if (req.method === "GET" && url.pathname === "/uninstall.sh") {
      const { base } = publicOrigin(req);
      const body = uninstallScript(base);
      res.writeHead(200, {
        "content-type": "text/x-shellscript; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      return res.end(body);
    }

    // --- self-service pairing (used by the /ccchrome slash command) ---------

    if (url.pathname === "/pair" && req.method === "POST") {
      if (!tokens.pairSecret) return json(res, 404, { error: "pairing disabled on this server (CC_CHROME_PAIR_SECRET not set)" });

      const ip = clientIp(req, TRUST_PROXY);
      const wait = pairLimiter.retryAfter(ip);
      if (wait > 0) {
        res.setHeader("retry-after", String(wait));
        return json(res, 429, { error: `too many failed pairing attempts; retry in ${wait}s` });
      }
      if (!isPairSecret(bearerOf(req))) {
        pairLimiter.fail(ip);
        log(`Failed pairing attempt from ${ip}`);
        return json(res, 401, { error: "bad pairing secret. Send 'Authorization: Bearer <CC_CHROME_PAIR_SECRET>'." });
      }
      pairLimiter.reset(ip);

      // 503, not 429: the rate limit above says "wait and retry" and carries
      // Retry-After, while this says "the server is full until a human acts".
      // Returning 429 for both left the client unable to tell them apart.
      if (tokens.dynamicSize >= MAX_TOKENS) {
        return json(res, 503, { error: `token limit reached (${MAX_TOKENS} dynamic tokens, CC_CHROME_MAX_TOKENS); waiting will not help — ask the admin to revoke unused tokens or raise CC_CHROME_MAX_TOKENS` });
      }

      let body = {};
      try {
        body = (await readBody(req)) || {};
      } catch {
        return json(res, 400, { error: "invalid JSON body" });
      }
      const name = String(body.name || "").trim().slice(0, 40) || `user-${randomBytes(2).toString("hex")}`;
      const token = tokens.pair(name);
      return json(res, 200, { token, name, ...publicUrls(req, token) });
    }

    if (url.pathname === "/pair/status" && req.method === "GET") {
      const token = authToken(req);
      if (!token) return json(res, 401, { error: "unauthorized" });
      return json(res, 200, {
        name: tokens.get(token),
        extensionConnected: !!registry.get(token),
        ...publicUrls(req, token),
      });
    }

    if (url.pathname === "/pair" && req.method === "DELETE") {
      const token = authToken(req);
      if (!token) return json(res, 401, { error: "unauthorized" });
      try {
        const conn = registry.get(token);
        if (conn) try { conn.socket.close(4001, "token revoked"); } catch {}
        tokens.revoke(token);
        return json(res, 200, { revoked: true });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
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

  const PANEL_CWD = join(homedir(), ".cc-chrome-bridge", "panel");
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

  async function handlePanelMessage(panel, msg, send) {
    if (msg.type === "start") {
      if (panel.agent) panel.agent.dispose();
      mkdirSync(PANEL_CWD, { recursive: true });
      const sessionId = msg.sessionId || randomUUID();
      panel.agent = new AgentSession({
        sessionId,
        model: msg.model || null,
        token: panel.token,
        mcpUrl: `http://127.0.0.1:${PORT}/mcp?panel=${panel.id}`,
        allowedTools: PANEL_ALLOWED_TOOLS,
        cwd: PANEL_CWD,
        systemPrompt: PANEL_SYSTEM_PROMPT,
        // A panel that reopens replays the id it remembered from `ready`, and
        // for that id the conversation already exists on disk — the first turn
        // has to --resume it. Only a server-generated id is genuinely new.
        resuming: Boolean(msg.sessionId),
        onEvent: (event) => send(event),
        log,
      });
      send({
        type: "ready",
        sessionId,
        model: msg.model || null,
        // Must match sessionGroupTitle() in extension/background.js character
        // for character — the panel shows the user which tab group is theirs.
        groupTitle: `Claude · ${panel.mcpSessionId.replace(/-/g, "").slice(0, 4)}`,
      });
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
      const message = /browser-internal page/.test(err.message)
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

    // Checked before origin and token on purpose: on a public bridge the panel
    // does not exist, and saying so is not a credential leak.
    if (isPanel && !AGENT_ENABLED) {
      log(`Rejected /panel upgrade: bridge is bound to ${HOST}, not loopback`);
      return reject(4004, "panel disabled on a non-loopback bridge");
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
    log(`MCP server (http mode) listening on http://${HOST}:${PORT}`);
    log(`  Claude Code:  claude mcp add --transport http chrome https://<domain>/mcp --header "Authorization: Bearer <token>"`);
    log(`  Extension:    wss://<domain>/ws?token=<token>  (set in the extension popup)`);
    log(`  Health:       GET /health`);
    log(`  Pairing:      POST /pair, GET /pair/status, DELETE /pair (for /ccchrome connect)`);
    log(`  Downloads:    GET /extension.zip, GET /extension.crx, GET /ccchrome.md (if dist/ is built)`);
    log(`  Onboarding:   GET /install.sh  (curl -fsSL https://<domain>/install.sh | bash)`);
    log(`  Removal:      GET /uninstall.sh  (curl -fsSL https://<domain>/uninstall.sh | bash)`);
  });
}

if (MODE === "http") await mainHttp();
else await mainStdio();
