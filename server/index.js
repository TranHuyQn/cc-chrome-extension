#!/usr/bin/env node
// MCP server that bridges Claude Code to the "Claude Code Chrome Bridge"
// extension. Claude Code talks MCP over stdio; the extension connects to this
// process over a localhost WebSocket. Each MCP tool call is forwarded to the
// extension as a JSON-RPC-style request and the extension's reply is returned
// as the tool result.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";

const PORT = Number(process.env.CC_CHROME_PORT || 9876);
const REQUEST_TIMEOUT_MS = Number(process.env.CC_CHROME_TIMEOUT_MS || 45000);

const log = (...args) => console.error("[claude-code-chrome-mcp]", ...args);

// ---------------------------------------------------------------------------
// WebSocket bridge to the extension
// ---------------------------------------------------------------------------

class ExtensionBridge {
  constructor(port) {
    this.socket = null;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.nextId = 1;
    this.extensionInfo = null;

    this.wss = new WebSocketServer({ host: "127.0.0.1", port });
    this.wss.on("listening", () => log(`WebSocket bridge listening on ws://127.0.0.1:${port}`));
    this.wss.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        log(`FATAL: port ${port} already in use. Another MCP server instance running? Set CC_CHROME_PORT to change.`);
        process.exit(1);
      }
      log("WebSocket server error:", err.message);
    });
    this.wss.on("connection", (socket, req) => this.onConnection(socket, req));
  }

  onConnection(socket, req) {
    const origin = req.headers.origin || "";
    // Only accept connections from a Chrome/Chromium extension on this machine.
    if (origin && !origin.startsWith("chrome-extension://")) {
      log(`Rejected connection from origin: ${origin}`);
      socket.close(4003, "origin not allowed");
      return;
    }
    if (this.socket) {
      log("New extension connection; replacing previous one");
      try { this.socket.close(4000, "replaced by new connection"); } catch {}
    }
    this.socket = socket;
    log(`Extension connected (origin: ${origin || "unknown"})`);

    socket.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "hello") {
        this.extensionInfo = { client: msg.client, version: msg.version, connectedAt: Date.now() };
      } else if (msg.type === "ping") {
        try { socket.send(JSON.stringify({ type: "pong" })); } catch {}
      } else if (msg.type === "response") {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) pending.reject(new Error(msg.error.message || "Extension error"));
        else pending.resolve(msg.result);
      }
    });

    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
        this.extensionInfo = null;
        log("Extension disconnected");
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Chrome extension disconnected mid-request"));
          this.pending.delete(id);
        }
      }
    });
    socket.on("error", (err) => log("Extension socket error:", err.message));
  }

  get connected() {
    return !!this.socket && this.socket.readyState === 1;
  }

  call(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.connected) {
      throw new Error(
        "Chrome extension is not connected. Make sure:\n" +
        "1. Chrome is running with the 'Claude Code Chrome Bridge' extension installed (chrome://extensions -> Load unpacked -> extension/ folder).\n" +
        "2. The extension popup shows 'connected' (click the extension icon; use 'Lưu & kết nối lại' to retry).\n" +
        `3. The extension's WebSocket URL matches this server (ws://127.0.0.1:${PORT}).`
      );
    }
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

const bridge = new ExtensionBridge(PORT);

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "claude-chrome",
  version: "1.0.0",
});

const textResult = (obj) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});

// Wraps a handler so extension errors come back as MCP tool errors (isError),
// which Claude Code shows without killing the session.
function tool(name, description, schema, handler) {
  server.tool(name, description, schema, async (args) => {
    try {
      return await handler(args ?? {});
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err.message}` }],
      };
    }
  });
}

const tabIdSchema = z.number().int().optional()
  .describe("Target tab id (from list_tabs). Defaults to the active tab.");

tool(
  "chrome_status",
  "Check whether the Chrome extension is connected to this MCP server. Use this first if other tools fail.",
  {},
  async () => {
    if (!bridge.connected) {
      return textResult({
        connected: false,
        hint: `Extension not connected. Install extension/ as an unpacked extension in Chrome and make sure its WebSocket URL is ws://127.0.0.1:${PORT}.`,
      });
    }
    const info = await bridge.call("status");
    return textResult({ connected: true, ...info, extension: bridge.extensionInfo });
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
  async (args) => textResult(await bridge.call("navigate", args))
);

tool(
  "read_page",
  "Read the page structure: title, headings, and all visible interactive elements (links, buttons, inputs...). Each element gets a numeric ref usable with click/fill. Call this again after the page changes — refs go stale.",
  {
    maxElements: z.number().int().optional().describe("Max interactive elements to return (default 150)"),
    tabId: tabIdSchema,
  },
  async (args) => {
    const r = await bridge.call("read_page", args);
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
    const r = await bridge.call("get_page_text", args);
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
  async (args) => textResult(await bridge.call("find", args))
);

tool(
  "click",
  "Click an element, identified by a ref number from read_page/find, or by a CSS selector.",
  {
    ref: z.number().int().optional().describe("Element ref from read_page or find"),
    selector: z.string().optional().describe("CSS selector (used if ref is not given)"),
    tabId: tabIdSchema,
  },
  async (args) => textResult(await bridge.call("click", args))
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
  async (args) => textResult(await bridge.call("fill", args))
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
  async (args) => textResult(await bridge.call("fill_form", args))
);

tool(
  "press_key",
  "Press a keyboard key in the focused element (real key events via the debugger API). Supports Enter, Tab, Escape, Backspace, Delete, arrows, Home/End, PageUp/PageDown, Space, or single characters, with optional modifiers.",
  {
    key: z.string().describe("Key name (e.g. 'Enter', 'Tab', 'a')"),
    modifiers: z.array(z.enum(["ctrl", "alt", "shift", "meta"])).optional(),
    tabId: tabIdSchema,
  },
  async (args) => textResult(await bridge.call("press_key", args))
);

tool(
  "type_text",
  "Type text into the currently focused element as real keyboard input (use fill for form fields; this is for editors/canvas apps).",
  {
    text: z.string().describe("Text to type"),
    tabId: tabIdSchema,
  },
  async (args) => textResult(await bridge.call("type_text", args))
);

tool(
  "take_screenshot",
  "Take a PNG screenshot of the current tab (visible viewport by default, or the full page).",
  {
    fullPage: z.boolean().optional().describe("Capture the full scrollable page (default false)"),
    tabId: tabIdSchema,
  },
  async (args) => {
    const r = await bridge.call("take_screenshot", args, 60000);
    return {
      content: [{ type: "image", data: r.base64, mimeType: r.mimeType }],
    };
  }
);

tool(
  "javascript_eval",
  "Evaluate a JavaScript expression in the page and return the result (await'ed if it returns a promise).",
  {
    code: z.string().describe("JavaScript expression to evaluate in the page context"),
    tabId: tabIdSchema,
  },
  async (args) => textResult(await bridge.call("javascript_eval", args))
);

tool(
  "read_console_messages",
  "Read console messages (log/warn/error + uncaught exceptions) from the tab. Capture starts the first time this is called on a tab — reload the page after the first call to capture load-time messages.",
  {
    limit: z.number().int().optional().describe("Max messages to return (default 100)"),
    clear: z.boolean().optional().describe("Clear the buffer after reading"),
    tabId: tabIdSchema,
  },
  async (args) => textResult(await bridge.call("read_console_messages", args))
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
  async (args) => textResult(await bridge.call("read_network_requests", args))
);

tool(
  "list_tabs",
  "List all open browser tabs with their tab ids.",
  {},
  async () => textResult(await bridge.call("list_tabs"))
);

tool(
  "new_tab",
  "Open a new browser tab, optionally at a URL.",
  { url: z.string().optional().describe("URL to open (default about:blank)") },
  async (args) => textResult(await bridge.call("new_tab", args))
);

tool(
  "close_tab",
  "Close a browser tab by id.",
  { tabId: z.number().int().describe("Tab id to close (from list_tabs)") },
  async (args) => textResult(await bridge.call("close_tab", args))
);

tool(
  "switch_tab",
  "Switch to (activate and focus) a tab by id.",
  { tabId: z.number().int().describe("Tab id to activate (from list_tabs)") },
  async (args) => textResult(await bridge.call("switch_tab", args))
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
  async (args) => textResult(await bridge.call("scroll", args))
);

tool(
  "wait_for",
  "Wait until an element matching a CSS selector appears and is visible (polls every 250ms).",
  {
    selector: z.string().describe("CSS selector to wait for"),
    timeoutMs: z.number().int().optional().describe("Max wait in ms (default 10000, max 30000)"),
    tabId: tabIdSchema,
  },
  async (args) => textResult(await bridge.call("wait_for", args))
);

tool(
  "resize_window",
  "Resize the browser window containing the tab.",
  {
    width: z.number().int().optional().describe("Width in px (default 1280)"),
    height: z.number().int().optional().describe("Height in px (default 800)"),
    tabId: tabIdSchema,
  },
  async (args) => textResult(await bridge.call("resize_window", args))
);

tool(
  "upload_file",
  "Set a file on an <input type=file> element. The file path must exist on the machine running Chrome.",
  {
    selector: z.string().describe("CSS selector of the file input"),
    filePath: z.string().describe("Absolute path of the file on the Chrome machine"),
    tabId: tabIdSchema,
  },
  async (args) => textResult(await bridge.call("upload_file", args))
);

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
log(`MCP server ready (stdio). Waiting for the Chrome extension on ws://127.0.0.1:${PORT} ...`);
