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
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TokenStore } from "./tokens.js";
import { RateLimiter, clientIp } from "./ratelimit.js";

const MODE = process.argv.includes("--http") || process.env.CC_CHROME_MODE === "http" ? "http" : "stdio";
const PORT = Number(process.env.CC_CHROME_PORT || (MODE === "http" ? 8787 : 9876));
const HOST = process.env.CC_CHROME_HOST || (MODE === "http" ? "0.0.0.0" : "127.0.0.1");
const REQUEST_TIMEOUT_MS = Number(process.env.CC_CHROME_TIMEOUT_MS || 45000);
const VERSION = "1.2.0";

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

class ExtensionConnection {
  constructor(socket, token, name) {
    this.socket = socket;
    this.token = token;
    this.name = name;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.nextId = 1;
    this.extensionInfo = null;
    this.isAlive = true;

    socket.on("pong", () => { this.isAlive = true; });
    socket.on("message", (data) => this.onMessage(data));
    socket.on("close", () => this.onClose());
    socket.on("error", (err) => log(`[${this.name}] extension socket error:`, err.message));
  }

  onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "hello") {
      this.extensionInfo = { client: msg.client, version: msg.version, connectedAt: Date.now() };
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

  onClose() {
    log(`[${this.name}] extension disconnected`);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Chrome extension disconnected mid-request"));
      this.pending.delete(id);
    }
  }

  get connected() {
    return this.socket.readyState === 1;
  }

  call(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ type: "request", id, method, params }));
    });
  }
}

class BridgeRegistry {
  constructor() {
    this.connections = new Map(); // token -> ExtensionConnection
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
    return conn;
  }

  get(token) {
    const conn = this.connections.get(token);
    return conn && conn.connected ? conn : null;
  }

  require(token) {
    const conn = this.get(token);
    if (!conn) {
      const where = MODE === "http"
        ? `Point the extension at this server: click the extension icon in Chrome and set the WebSocket URL to wss://<your-domain>/ws?token=<your-token> (same token as your Claude Code config), then 'Lưu & kết nối lại'.`
        : `Make sure Chrome is running with the extension installed and its WebSocket URL is ws://127.0.0.1:${PORT} (click the extension icon to check).`;
      throw new Error(
        "Chrome extension is not connected for this account.\n" +
        "1. Chrome must be running with the 'Claude Code Chrome Bridge' extension installed (chrome://extensions -> Load unpacked -> extension/ folder).\n" +
        `2. ${where}`
      );
    }
    return conn;
  }
}

const registry = new BridgeRegistry();

// ---------------------------------------------------------------------------
// MCP tool definitions
// ---------------------------------------------------------------------------

const textResult = (obj) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});

// getBridge: () => ExtensionConnection (throws a helpful error when absent)
function buildMcpServer(getBridge, statusExtra = {}) {
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

  const call = (method, args, timeoutMs) => getBridge().call(method, args, timeoutMs);

  const tabIdSchema = z.number().int().optional()
    .describe("Target tab id (from list_tabs). Defaults to the active tab.");

  tool(
    "chrome_status",
    "Check whether the Chrome extension is connected to this MCP server. Use this first if other tools fail.",
    {},
    async () => {
      let bridge;
      try {
        bridge = getBridge();
      } catch (err) {
        return textResult({ connected: false, hint: err.message, ...statusExtra });
      }
      const info = await bridge.call("status");
      return textResult({ connected: true, ...info, extension: bridge.extensionInfo, ...statusExtra });
    }
  );

  tool(
    "navigate",
    "Navigate the current (or given) tab to a URL, or go back/forward/reload. Waits for the page to finish loading.",
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
    "Take a PNG screenshot of the current tab (visible viewport by default, or the full page).",
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
    "List all open browser tabs with their tab ids.",
    {},
    async () => textResult(await call("list_tabs"))
  );

  tool(
    "new_tab",
    "Open a new browser tab, optionally at a URL.",
    { url: z.string().optional().describe("URL to open (default about:blank)") },
    async (args) => textResult(await call("new_tab", args))
  );

  tool(
    "close_tab",
    "Close a browser tab by id.",
    { tabId: z.number().int().describe("Tab id to close (from list_tabs)") },
    async (args) => textResult(await call("close_tab", args))
  );

  tool(
    "switch_tab",
    "Switch to (activate and focus) a tab by id.",
    { tabId: z.number().int().describe("Tab id to activate (from list_tabs)") },
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

  const server = buildMcpServer(() => registry.require("default"), { mode: "stdio" });
  await server.connect(new StdioServerTransport());
  log(`MCP server ready (stdio). Waiting for the Chrome extension on ws://127.0.0.1:${PORT} ...`);
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
  const MAX_TOKENS = Number(process.env.CC_CHROME_MAX_TOKENS || 100);
  const pairLimiter = new RateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });
  if (tokens.pairSecret && !TRUST_PROXY) {
    log("Note: CC_CHROME_TRUST_PROXY is not set, so /pair rate limiting keys on the socket address.");
    log("      Behind a reverse proxy that is the proxy itself — set CC_CHROME_TRUST_PROXY=1 there.");
  }

  const sessions = new Map(); // mcp-session-id -> { transport, token }

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

  // Public URLs as seen by clients (honors reverse-proxy headers).
  const publicUrls = (req, token) => {
    const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
    const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
    const wsProto = proto === "https" ? "wss" : "ws";
    return {
      mcpUrl: `${proto}://${host}/mcp`,
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
      return json(res, 200, { ok: true, version: VERSION, extensionsConnected: [...registry.connections.values()].filter((c) => c.connected).length });
    }

    // --- extension downloads (built by `npm run build` into dist/) ----------
    // Public like the Web Store would be: the package contains no secrets.

    if (req.method === "GET" && (url.pathname === "/extension.zip" || url.pathname === "/extension.crx")) {
      const distDir = process.env.CC_CHROME_DIST_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
      const file = join(distDir, url.pathname.slice(1));
      if (!existsSync(file)) {
        return json(res, 404, { error: "extension package not built. Run 'npm run build' in the repo and redeploy (dist/ must be available to the server)." });
      }
      const body = readFileSync(file);
      res.writeHead(200, {
        "content-type": url.pathname.endsWith(".crx") ? "application/x-chrome-extension" : "application/zip",
        "content-length": body.length,
        "content-disposition": `attachment; filename="claude-code-chrome-bridge${url.pathname.slice(url.pathname.lastIndexOf("."))}"`,
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

      if (tokens.dynamicSize >= MAX_TOKENS) {
        return json(res, 429, { error: `token limit reached (${MAX_TOKENS}); ask the admin to revoke unused tokens or raise CC_CHROME_MAX_TOKENS` });
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
        const body = req.method === "POST" ? await readBody(req) : undefined;
        await session.transport.handleRequest(req, res, body);
        return;
      }

      if (req.method !== "POST") {
        return json(res, 400, { error: "missing mcp-session-id" });
      }

      // New session (initialize request).
      const body = await readBody(req);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => sessions.set(id, { transport, token }),
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      const name = tokens.get(token);
      const server = buildMcpServer(() => registry.require(token), { mode: "http", user: name });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log("HTTP /mcp error:", err.message);
      if (!res.headersSent) json(res, 500, { error: err.message });
    }
  });

  // WebSocket endpoint for extensions: /ws (token carried in Sec-WebSocket-Protocol)
  const wss = new WebSocketServer({ noServer: true, handleProtocols: pickSubprotocol });
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    // Rejections complete the handshake and then close with a specific code.
    // A browser cannot read the HTTP status of a failed upgrade, so destroying
    // the socket would reach the extension as an indistinguishable 1006 — the
    // user would see "server not running" for what is really a config error.
    // A rejected socket is never registered, so it can do nothing meanwhile.
    const reject = (code, reason) => {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(code, reason));
    };

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

    wss.handleUpgrade(req, socket, head, (ws) => {
      registry.attach(ws, token, tokens.get(token));
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
    log(`  Downloads:    GET /extension.zip, GET /extension.crx (if dist/ is built)`);
  });
}

if (MODE === "http") await mainHttp();
else await mainStdio();
