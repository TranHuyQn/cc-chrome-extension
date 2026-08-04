// Claude Code Chrome Bridge - background service worker.
//
// Connects to the local MCP bridge server over WebSocket and executes
// browser-automation commands (navigate, click, fill, screenshot, ...)
// using chrome.tabs / chrome.scripting / chrome.debugger.

const DEFAULT_WS_URL = "ws://127.0.0.1:9876";
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const KEEPALIVE_MS = 20000;
const CONSOLE_BUFFER_MAX = 500;
const NETWORK_BUFFER_MAX = 400;

// The server refuses a handshake by closing with one of these codes. Without
// this mapping every refusal reaches the user as a generic socket error, and a
// misconfigured token looks exactly like a server that is not running.
//
// 4002 covers two different causes and must name both: a pre-2.0.0 extension
// has no CLOSE_REASONS map at all, so the only client that can ever *display*
// this message is a 2.0.0 extension whose saved URL simply has no ?token=.
const CLOSE_REASONS = {
  4001: "Token sai hoặc đã bị thu hồi — chạy lại /ccchrome connect",
  4002: "URL thiếu token, hoặc extension cũ hơn server — kiểm tra URL đã có ?token=… chưa, rồi tải lại extension từ <server>/extension.zip nếu vẫn lỗi",
  4003: "Server từ chối: origin không hợp lệ",
};

// Refusals: the server will keep refusing until a human changes something, so
// retrying every second helps nobody.
const REFUSAL_CODES = new Set([4001, 4002, 4003]);

const MISSING_TOKEN_REASON =
  "URL thiếu token — server từ xa cần dạng wss://<domain>/ws?token=… (chạy /ccchrome connect để lấy URL)";

const GROUP_COLOR = "orange";

// The group title is the source of truth, not an in-memory map: MV3 kills the
// service worker at will, and re-deriving the group by querying its title
// costs one call and cannot go stale.
//
// A missing session id fails closed. Only a pre-3.0.0 server sends none, which
// happens during a staged rollout or when a popup still points at an older
// instance; substituting a constant would put every session on that extension
// into one shared group and silently delete the isolation this version
// promises. handleRequest turns this into an ordinary tool error, so Claude
// sees the remedy instead of a dead service worker.
function sessionGroupTitle(session) {
  if (!session) {
    throw new Error(
      "This MCP server is older than the extension and sends no session id, so tab-group isolation cannot be enforced. " +
      "Update the server to 3.0.0, or reinstall the matching 2.x extension."
    );
  }
  return `Claude · ${String(session).replace(/-/g, "").slice(0, 4)}`;
}

// Scoped per window on purpose. chrome.tabs.group moves a tab into the group's
// window, so a window-wide lookup would yank tabs across windows.
async function sessionGroupId(session, windowId) {
  const title = sessionGroupTitle(session);
  const [existing] = await chrome.tabGroups.query({ title, windowId });
  return existing ? existing.id : null;
}

// Creating the group is read-then-write across awaits, and Claude Code issues
// independent tool calls concurrently (the http transport does not serialize
// them). Two new_tab calls could both see "no group yet" and both create one
// with the same title; chrome.tabGroups.query then returns one arbitrary
// winner and every tab in the loser is permanently unreachable — invisible to
// list_tabs and refused by resolveTab, with no way back from Claude's side.
//
// So group creation is chained per title: the second caller waits for the
// first and then finds the group it made. The race only exists between
// in-flight requests inside one service-worker lifetime, so an in-memory map
// is enough — nothing needs to survive a worker restart.
const groupLocks = new Map();

function withGroupLock(title, fn) {
  const previous = groupLocks.get(title) || Promise.resolve();
  // .then(fn, fn) so one failed call does not wedge the chain for the rest.
  const next = previous.then(fn, fn);
  groupLocks.set(title, next);
  // Drop the entry once the chain drains, so the map does not grow one
  // permanent entry per session the worker has ever served.
  next.catch(() => {}).then(() => {
    if (groupLocks.get(title) === next) groupLocks.delete(title);
  });
  return next;
}

async function addTabToSessionGroup(tab, session) {
  const title = sessionGroupTitle(session);
  return await withGroupLock(title, async () => {
    let groupId = await sessionGroupId(session, tab.windowId);
    groupId = groupId === null
      ? await chrome.tabs.group({ tabIds: [tab.id] })
      : await chrome.tabs.group({ tabIds: [tab.id], groupId });
    await chrome.tabGroups.update(groupId, { title, color: GROUP_COLOR });
    return groupId;
  });
}

let ws = null;
let wsUrl = DEFAULT_WS_URL;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let keepaliveTimer = null;
let status = { state: "disconnected", url: DEFAULT_WS_URL, since: Date.now(), lastError: null };

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

async function loadConfig() {
  const stored = await chrome.storage.local.get({ wsUrl: DEFAULT_WS_URL });
  wsUrl = stored.wsUrl || DEFAULT_WS_URL;
  return wsUrl;
}

function setStatus(state, extra = {}) {
  status = { ...status, state, url: wsUrl, since: Date.now(), ...extra };
  const badge = { connected: "", connecting: "…", disconnected: "×" }[state] ?? "";
  chrome.action.setBadgeText({ text: state === "connected" ? "on" : badge });
  chrome.action.setBadgeBackgroundColor({ color: state === "connected" ? "#188038" : "#b3261e" });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

// A loopback URL is the stdio-mode bridge (ws://127.0.0.1:9876), which has no
// tokens at all. Anything else is a shared server, where a URL without a token
// can only ever be refused — worth saying locally instead of round-tripping.
function isLoopbackUrl(parsed) {
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  await loadConfig();
  setStatus("connecting");
  let socket;
  try {
    // The user pastes a URL that still carries ?token=... — strip it and send
    // the token as a subprotocol so it never appears in a proxy access log.
    const parsed = new URL(wsUrl);
    const token = parsed.searchParams.get("token");
    parsed.searchParams.delete("token");
    if (!token && !isLoopbackUrl(parsed)) {
      setStatus("disconnected", { lastError: MISSING_TOKEN_REASON });
      reconnectDelay = RECONNECT_MAX_MS;
      scheduleReconnect();
      return;
    }
    socket = token
      ? new WebSocket(parsed.toString(), [`ccchrome.token.${token}`])
      : new WebSocket(parsed.toString());
  } catch (err) {
    setStatus("disconnected", { lastError: String(err) });
    scheduleReconnect();
    return;
  }
  ws = socket;

  // `open` is NOT proof of success. Since 2.0.0 the server refuses by
  // completing the 101 handshake and then closing with a code (a browser cannot
  // read the HTTP status of a failed upgrade), so `open` fires for refusals
  // too. Treating it as success reset the backoff on every refusal, turning a
  // wrong token into a permanent 1 Hz reconnect storm with a badge flashing
  // green once a second. The connection is only proven once the server has
  // actually spoken to us — it sends nothing to a socket it is about to close.
  let proven = false;

  // Every handler checks `ws === socket` so events from a stale socket
  // (e.g. one the server replaced during a reconnect) can't clobber the
  // current connection and cause a reconnect storm.
  socket.onopen = () => {
    if (ws !== socket) return;
    send({ type: "hello", client: "claude-code-chrome-bridge", version: chrome.runtime.getManifest().version });
    // The server answers `ping` with `pong`, so this turns "proven" into a
    // sub-second signal instead of waiting a whole keepalive period.
    send({ type: "ping" });
    clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => send({ type: "ping" }), KEEPALIVE_MS);
  };

  socket.onmessage = async (event) => {
    if (ws !== socket) return;
    if (!proven) {
      proven = true;
      reconnectDelay = RECONNECT_MIN_MS;
      setStatus("connected", { lastError: null });
    }
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "pong") return;
    if (msg.type === "request") await handleRequest(msg);
  };

  socket.onclose = (event) => {
    if (ws !== socket) return;
    clearInterval(keepaliveTimer);
    // Always compute the reason, never merge: code 4000 ("replaced by new
    // connection") has no mapping, and merging would leave a stale "Token sai…"
    // on screen for a member who has since fixed their token. An unmapped code
    // on a socket that never proved itself is the ordinary "nothing answered"
    // case; one that did prove itself just ended, and has nothing to report.
    const reason = CLOSE_REASONS[event.code]
      ?? (proven ? null : "Không kết nối được — MCP server chưa chạy, hoặc URL sai?");
    setStatus("disconnected", { lastError: reason });
    ws = null;
    if (REFUSAL_CODES.has(event.code)) reconnectDelay = RECONNECT_MAX_MS;
    scheduleReconnect();
  };

  socket.onerror = () => {
    if (ws !== socket) return;
    setStatus("disconnected", { lastError: "websocket error (is the MCP server running?)" });
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

async function handleRequest(msg) {
  const { id, method, params = {}, session } = msg;
  try {
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown method: ${method}`);
    // resolveTab() reads this to find the session's tab group. Injecting it
    // here keeps all 22 handler signatures unchanged.
    params.__session = session;
    const result = await handler(params);
    send({ type: "response", id, result: result ?? { ok: true } });
  } catch (err) {
    send({ type: "response", id, error: { message: err?.message || String(err) } });
  }
}

// Keep the service worker alive while connected and retry when Chrome wakes us.
chrome.alarms.create("cc-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "cc-keepalive") connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

function forceReconnect() {
  if (ws) try { ws.close(); } catch {}
  ws = null;
  reconnectDelay = RECONNECT_MIN_MS;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  connect();
}

// Reconnect whenever the configured URL changes, no matter who changed it
// (popup, sync, or an automation writing chrome.storage directly). Messages
// sent from the service worker to itself are NOT delivered, so this listener
// is the reliable trigger.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.wsUrl) forceReconnect();
});

// Popup communication.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "getStatus") {
    sendResponse(status);
  } else if (msg?.type === "reconnect") {
    forceReconnect();
    sendResponse({ ok: true });
  } else if (msg?.type === "setWsUrl") {
    // storage.onChanged above triggers the actual reconnect.
    chrome.storage.local.set({ wsUrl: msg.wsUrl }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ---------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------

// Every one of the 22 tools routes through here, which is what makes the
// in-group restriction enforceable in one place. A tab outside the session's
// group is refused with a message that says how to grant access, because the
// fix is a user action in Chrome that Claude cannot perform.
async function resolveTab(params) {
  const session = params.__session;
  const title = sessionGroupTitle(session);

  if (params.tabId) {
    const tab = await chrome.tabs.get(params.tabId).catch(() => null);
    if (!tab) throw new Error(`No tab with id ${params.tabId}`);
    const groupId = await sessionGroupId(session, tab.windowId);
    if (groupId === null || tab.groupId !== groupId) {
      throw new Error(
        `Tab ${params.tabId} is outside the "${title}" tab group. Drag that tab into the group to let me work on it, or call new_tab to open a fresh one.`
      );
    }
    return tab;
  }

  // No tabId: look in the window the user is actually in first, then the rest
  // in chrome.windows.getAll() order (roughly window creation order). Within a
  // window it takes the group's last tab in tab-strip order — Chrome exposes no
  // per-tab activation time, so this is position, not recency.
  //
  // Checking the focused window first is what keeps this in step with new_tab,
  // which creates in the focused window: without it, a session that opened a
  // tab in window 1 and then had new_tab land in window 2 would keep resolving
  // to the stale window-1 tab, and Claude would silently read the wrong page.
  const focused = await chrome.windows.getLastFocused().catch(() => null);
  const all = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const windows = focused
    ? [...all.filter((w) => w.id === focused.id), ...all.filter((w) => w.id !== focused.id)]
    : all;
  for (const win of windows) {
    const groupId = await sessionGroupId(session, win.id);
    if (groupId === null) continue;
    const tabs = await chrome.tabs.query({ groupId });
    if (tabs.length) return tabs[tabs.length - 1];
  }

  const created = await chrome.tabs.create({ url: "about:blank", active: true });
  await addTabToSessionGroup(created, session);
  return await chrome.tabs.get(created.id);
}

function assertScriptableUrl(tab) {
  const url = tab.url || "";
  if (/^(chrome|chrome-extension|devtools|edge|about):/.test(url) && !url.startsWith("about:blank")) {
    throw new Error(`Cannot run scripts on ${url} (browser-internal page). Navigate to a normal web page first.`);
  }
}

// chrome.scripting.executeScript swallows exceptions thrown by the injected
// function (the promise resolves with result undefined), so injected functions
// wrap their body in try/catch and report failures as { __cc_err }.
async function execInTab(tab, func, args = [], world = "ISOLATED") {
  assertScriptableUrl(tab);
  let injected;
  try {
    injected = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args, world });
  } catch (err) {
    // resolveTab opens an about:blank tab when the session's group is empty, so
    // a read tool called before any navigate lands here. Chrome's own message
    // ("manifest must request permission to access this host") points at the
    // wrong fix — the fix is to navigate somewhere.
    if ((tab.url || "").startsWith("about:blank")) {
      throw new Error("This session's tab group has no page open yet (about:blank). Call navigate with a url first.", { cause: err });
    }
    throw err;
  }
  const [result] = injected;
  if (!result) throw new Error("Script returned no result");
  const value = result.result;
  if (value && typeof value === "object" && value.__cc_err) {
    throw new Error(value.__cc_err);
  }
  if (value === undefined || value === null) {
    throw new Error("In-page script failed (no result). The page may block content scripts.");
  }
  return value;
}

function waitForTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
    }).catch(finish);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Debugger (CDP) management for eval / keyboard / console / network
// ---------------------------------------------------------------------------

const debugSessions = new Map(); // tabId -> { domains:Set, console:[], network:Map, networkOrder:[] }

async function ensureDebugger(tabId, domains = []) {
  let session = debugSessions.get(tabId);
  if (!session) {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    session = { domains: new Set(), console: [], network: new Map(), networkOrder: [] };
    debugSessions.set(tabId, session);
  }
  for (const domain of domains) {
    if (!session.domains.has(domain)) {
      await cdp(tabId, `${domain}.enable`, {});
      session.domains.add(domain);
    }
  }
  return session;
}

function cdp(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) debugSessions.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  debugSessions.delete(tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const session = debugSessions.get(source.tabId);
  if (!session) return;

  if (method === "Runtime.consoleAPICalled") {
    const text = (params.args || [])
      .map((a) => a.value !== undefined ? String(a.value) : a.description || a.type)
      .join(" ");
    pushConsole(session, { level: params.type || "log", text, source: "console", ts: Date.now() });
  } else if (method === "Runtime.exceptionThrown") {
    const d = params.exceptionDetails || {};
    const text = d.exception?.description || d.text || "Uncaught exception";
    pushConsole(session, { level: "error", text, source: "exception", ts: Date.now() });
  } else if (method === "Log.entryAdded") {
    const e = params.entry || {};
    pushConsole(session, { level: e.level || "info", text: e.text || "", source: e.source || "log", ts: Date.now() });
  } else if (method === "Network.requestWillBeSent") {
    if (!session.network.has(params.requestId)) {
      session.networkOrder.push(params.requestId);
      if (session.networkOrder.length > NETWORK_BUFFER_MAX) {
        session.network.delete(session.networkOrder.shift());
      }
    }
    session.network.set(params.requestId, {
      url: params.request?.url,
      method: params.request?.method,
      type: params.type,
      status: null,
      mimeType: null,
      encodedBytes: 0,
      error: null,
      ts: Date.now(),
    });
  } else if (method === "Network.responseReceived") {
    const entry = session.network.get(params.requestId);
    if (entry) {
      entry.status = params.response?.status;
      entry.mimeType = params.response?.mimeType;
    }
  } else if (method === "Network.loadingFinished") {
    const entry = session.network.get(params.requestId);
    if (entry) entry.encodedBytes = params.encodedDataLength || 0;
  } else if (method === "Network.loadingFailed") {
    const entry = session.network.get(params.requestId);
    if (entry) entry.error = params.errorText || "failed";
  }
});

function pushConsole(session, entry) {
  session.console.push(entry);
  if (session.console.length > CONSOLE_BUFFER_MAX) session.console.shift();
}

// ---------------------------------------------------------------------------
// In-page functions (injected via chrome.scripting)
// ---------------------------------------------------------------------------

// Collects page structure + interactive elements. Elements get a stable ref
// number stored on window.__cc_refs so later click/fill calls can target them.
function pageReadPage(maxElements) {
  try {
  const refs = (window.__cc_refs = []);

  function visible(el) {
    if (!el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function label(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    if (el.labels && el.labels.length) return el.labels[0].innerText.trim();
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder;
    const alt = el.getAttribute("alt");
    if (alt) return alt;
    const title = el.getAttribute("title");
    if (title) return title;
    const text = (el.innerText || el.value || "").trim().replace(/\s+/g, " ");
    return text.slice(0, 80);
  }

  const selectorList = [
    "a[href]", "button", "input", "select", "textarea", "summary",
    "[role='button']", "[role='link']", "[role='tab']", "[role='menuitem']",
    "[role='checkbox']", "[role='radio']", "[role='combobox']", "[role='option']",
    "[contenteditable='true']", "[onclick]",
  ];
  const seen = new Set();
  const lines = [];

  for (const el of document.querySelectorAll(selectorList.join(","))) {
    if (seen.has(el) || !visible(el)) continue;
    seen.add(el);
    if (refs.length >= maxElements) break;
    const ref = refs.push(el) - 1;
    const tag = el.tagName.toLowerCase();
    const parts = [`[${ref}] <${tag}`];
    const type = el.getAttribute("type");
    if (type) parts.push(` type=${type}`);
    const role = el.getAttribute("role");
    if (role) parts.push(` role=${role}`);
    parts.push(">");
    const desc = label(el);
    if (desc) parts.push(` "${desc}"`);
    if (tag === "a") {
      const href = el.getAttribute("href");
      if (href && href.length < 120) parts.push(` -> ${href}`);
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const val = (el.value || "").slice(0, 60);
      if (val) parts.push(` value="${val}"`);
      if (el.checked !== undefined && (type === "checkbox" || type === "radio")) {
        parts.push(el.checked ? " (checked)" : " (unchecked)");
      }
    }
    lines.push(parts.join(""));
  }

  const headings = [];
  for (const h of document.querySelectorAll("h1, h2, h3")) {
    const text = h.innerText.trim().replace(/\s+/g, " ").slice(0, 100);
    if (text) headings.push(`${h.tagName.toLowerCase()}: ${text}`);
    if (headings.length >= 40) break;
  }

  return {
    url: location.href,
    title: document.title,
    headings,
    elements: lines,
    elementCount: refs.length,
  };
  } catch (e) { return { __cc_err: e.message }; }
}

// NOTE: injected functions are serialized standalone by chrome.scripting, so
// pageClick/pageFill each duplicate the ref/selector resolution logic inline —
// they cannot reference shared helpers from this file.
function pageClick(ref, selector) {
  try {
  let el = null;
  if (ref !== null && ref !== undefined) {
    el = (window.__cc_refs || [])[ref];
    if (!el || !el.isConnected) {
      throw new Error(`Ref ${ref} is stale (page changed). Call read_page again to refresh refs.`);
    }
  } else if (selector) {
    el = document.querySelector(selector);
    if (!el) throw new Error(`No element matches selector: ${selector}`);
  } else {
    throw new Error("Provide either ref or selector");
  }
  el.scrollIntoView({ block: "center", inline: "center" });
  const rect = el.getBoundingClientRect();
  const opts = {
    bubbles: true, cancelable: true, view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.click();
  // el.click() dispatches the event but does not move focus the way a real
  // user click does — focus explicitly so press_key/type_text land here.
  if (typeof el.focus === "function") el.focus({ preventScroll: true });
  const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 80);
  return { clicked: `<${el.tagName.toLowerCase()}> "${text}"` };
  } catch (e) { return { __cc_err: e.message }; }
}

function pageFill(ref, selector, value, clear) {
  try {
  let el = null;
  if (ref !== null && ref !== undefined) {
    el = (window.__cc_refs || [])[ref];
    if (!el || !el.isConnected) {
      throw new Error(`Ref ${ref} is stale (page changed). Call read_page again to refresh refs.`);
    }
  } else if (selector) {
    el = document.querySelector(selector);
    if (!el) throw new Error(`No element matches selector: ${selector}`);
  } else {
    throw new Error("Provide either ref or selector");
  }
  el.scrollIntoView({ block: "center" });
  el.focus();

  const tag = el.tagName.toLowerCase();
  if (tag === "select") {
    let matched = false;
    for (const opt of el.options) {
      if (opt.value === value || opt.text.trim() === value) {
        el.value = opt.value;
        matched = true;
        break;
      }
    }
    if (!matched) throw new Error(`No <option> matches "${value}"`);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { filled: `<select> = "${value}"` };
  }

  if (el.isContentEditable) {
    if (clear) el.textContent = "";
    el.textContent += value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    return { filled: `contenteditable = "${value.slice(0, 60)}"` };
  }

  // Use the native setter so frameworks (React/Vue) see the change.
  const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  const newValue = clear ? value : (el.value || "") + value;
  if (setter) setter.call(el, newValue);
  else el.value = newValue;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { filled: `<${tag}${el.type ? ` type=${el.type}` : ""}> = "${String(newValue).slice(0, 60)}"` };
  } catch (e) { return { __cc_err: e.message }; }
}

function pageFind(query, maxResults) {
  try {
  const refs = window.__cc_refs || (window.__cc_refs = []);
  const needle = query.toLowerCase();
  const results = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(needle)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden") return NodeFilter.FILTER_REJECT;
      if (/^(script|style|noscript)$/i.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode()) && results.length < maxResults) {
    const text = node.nodeValue.replace(/\s+/g, " ").trim();
    const idx = text.toLowerCase().indexOf(needle);
    const context = text.slice(Math.max(0, idx - 60), idx + needle.length + 60);
    let clickable = node.parentElement;
    while (clickable && clickable !== document.body) {
      const tag = clickable.tagName.toLowerCase();
      if (tag === "a" || tag === "button" || clickable.getAttribute("role") === "button" || clickable.onclick) break;
      clickable = clickable.parentElement;
    }
    let ref = null;
    if (clickable && clickable !== document.body) {
      ref = refs.push(clickable) - 1;
    }
    results.push({ context: `…${context}…`, ref });
  }
  return { query, matches: results.length, results };
  } catch (e) { return { __cc_err: e.message }; }
}

function pageGetText(maxChars) {
  try {
    const text = (document.body?.innerText || "").trim();
    return {
      url: location.href,
      title: document.title,
      truncated: text.length > maxChars,
      text: text.slice(0, maxChars),
    };
  } catch (e) { return { __cc_err: e.message }; }
}

function pageScroll(direction, amount, selector) {
  try {
  if (selector) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`No element matches selector: ${selector}`);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    return { scrolled: `to ${selector}` };
  }
  const px = amount || Math.round(window.innerHeight * 0.8);
  switch (direction) {
    case "up": window.scrollBy(0, -px); break;
    case "down": window.scrollBy(0, px); break;
    case "top": window.scrollTo(0, 0); break;
    case "bottom": window.scrollTo(0, document.body.scrollHeight); break;
    default: throw new Error(`Unknown direction: ${direction}`);
  }
  return { scrolled: direction, scrollY: Math.round(window.scrollY) };
  } catch (e) { return { __cc_err: e.message }; }
}

function pageWaitCheck(selector) {
  try {
    const el = document.querySelector(selector);
    if (!el) return { found: false };
    const rect = el.getBoundingClientRect();
    return { found: true, visible: rect.width > 0 && rect.height > 0 };
  } catch (e) { return { __cc_err: e.message }; }
}

// ---------------------------------------------------------------------------
// Command handlers (RPC methods exposed to the MCP server)
// ---------------------------------------------------------------------------

const CDP_KEYS = {
  Enter: { keyCode: 13, key: "Enter", code: "Enter", text: "\r" },
  Tab: { keyCode: 9, key: "Tab", code: "Tab" },
  Escape: { keyCode: 27, key: "Escape", code: "Escape" },
  Backspace: { keyCode: 8, key: "Backspace", code: "Backspace" },
  Delete: { keyCode: 46, key: "Delete", code: "Delete" },
  ArrowUp: { keyCode: 38, key: "ArrowUp", code: "ArrowUp" },
  ArrowDown: { keyCode: 40, key: "ArrowDown", code: "ArrowDown" },
  ArrowLeft: { keyCode: 37, key: "ArrowLeft", code: "ArrowLeft" },
  ArrowRight: { keyCode: 39, key: "ArrowRight", code: "ArrowRight" },
  Home: { keyCode: 36, key: "Home", code: "Home" },
  End: { keyCode: 35, key: "End", code: "End" },
  PageUp: { keyCode: 33, key: "PageUp", code: "PageUp" },
  PageDown: { keyCode: 34, key: "PageDown", code: "PageDown" },
  Space: { keyCode: 32, key: " ", code: "Space", text: " " },
};

const handlers = {
  async status() {
    const tabs = await chrome.tabs.query({});
    return {
      connected: true,
      extensionVersion: chrome.runtime.getManifest().version,
      tabCount: tabs.length,
    };
  },

  async navigate(params) {
    const { url, action } = params;
    const tab = await resolveTab(params);
    if (action === "back") {
      await chrome.tabs.goBack(tab.id);
    } else if (action === "forward") {
      await chrome.tabs.goForward(tab.id);
    } else if (action === "reload") {
      await chrome.tabs.reload(tab.id);
    } else {
      if (!url) throw new Error("url is required (or set action to back/forward/reload)");
      const fullUrl = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
      await chrome.tabs.update(tab.id, { url: fullUrl });
    }
    await waitForTabComplete(tab.id);
    await sleep(300);
    const updated = await chrome.tabs.get(tab.id);
    return { tabId: updated.id, url: updated.url, title: updated.title, status: updated.status };
  },

  async read_page(params) {
    const tab = await resolveTab(params);
    return await execInTab(tab, pageReadPage, [params.maxElements || 150]);
  },

  async get_page_text(params) {
    const tab = await resolveTab(params);
    return await execInTab(tab, pageGetText, [params.maxChars || 50000]);
  },

  async find(params) {
    if (!params.query) throw new Error("query is required");
    const tab = await resolveTab(params);
    return await execInTab(tab, pageFind, [params.query, params.maxResults || 20]);
  },

  async click(params) {
    const tab = await resolveTab(params);
    const result = await execInTab(tab, pageClick, [params.ref ?? null, params.selector ?? null]);
    await sleep(300);
    return result;
  },

  async fill(params) {
    if (params.value === undefined) throw new Error("value is required");
    const tab = await resolveTab(params);
    return await execInTab(tab, pageFill, [
      params.ref ?? null,
      params.selector ?? null,
      String(params.value),
      params.clear !== false,
    ]);
  },

  async fill_form(params) {
    if (!Array.isArray(params.fields)) throw new Error("fields array is required");
    const tab = await resolveTab(params);
    const results = [];
    for (const field of params.fields) {
      const r = await execInTab(tab, pageFill, [
        field.ref ?? null,
        field.selector ?? null,
        String(field.value ?? ""),
        field.clear !== false,
      ]);
      results.push(r.filled);
    }
    return { filled: results };
  },

  async press_key(params) {
    if (!params.key) throw new Error("key is required");
    const tab = await resolveTab(params);
    await ensureDebugger(tab.id);
    const known = CDP_KEYS[params.key];
    const single = params.key.length === 1;
    if (!known && !single) {
      throw new Error(`Unsupported key: ${params.key}. Use a single character or one of: ${Object.keys(CDP_KEYS).join(", ")}`);
    }
    let modifiers = 0;
    for (const m of params.modifiers || []) {
      modifiers |= { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 }[m.toLowerCase()] || 0;
    }
    const key = known || { keyCode: params.key.toUpperCase().charCodeAt(0), key: params.key, code: `Key${params.key.toUpperCase()}`, text: params.key };
    const base = {
      modifiers,
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      nativeVirtualKeyCode: key.keyCode,
    };
    await cdp(tab.id, "Input.dispatchKeyEvent", {
      ...base,
      type: key.text && !modifiers ? "keyDown" : "rawKeyDown",
      text: modifiers ? undefined : key.text,
    });
    await cdp(tab.id, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    await sleep(200);
    return { pressed: params.key, modifiers: params.modifiers || [] };
  },

  async type_text(params) {
    if (params.text === undefined) throw new Error("text is required");
    const tab = await resolveTab(params);
    await ensureDebugger(tab.id);
    await cdp(tab.id, "Input.insertText", { text: String(params.text) });
    return { typed: String(params.text).slice(0, 80) };
  },

  async take_screenshot(params) {
    const tab = await resolveTab(params);
    if (params.fullPage) {
      await ensureDebugger(tab.id, ["Page"]);
      const shot = await cdp(tab.id, "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
      });
      return { mimeType: "image/png", base64: shot.data, fullPage: true };
    }
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(150);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return { mimeType: "image/png", base64: dataUrl.split(",", 2)[1], fullPage: false };
  },

  async javascript_eval(params) {
    if (!params.code) throw new Error("code is required");
    const tab = await resolveTab(params);
    await ensureDebugger(tab.id, ["Runtime"]);
    const evalResult = await cdp(tab.id, "Runtime.evaluate", {
      expression: params.code,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      timeout: 15000,
    });
    if (evalResult.exceptionDetails) {
      const d = evalResult.exceptionDetails;
      throw new Error(d.exception?.description || d.text || "Evaluation failed");
    }
    const r = evalResult.result || {};
    return { type: r.type, value: r.value !== undefined ? r.value : r.description ?? null };
  },

  async read_console_messages(params) {
    const tab = await resolveTab(params);
    const session = await ensureDebugger(tab.id, ["Runtime", "Log"]);
    const messages = session.console.slice(-(params.limit || 100));
    const wasEmpty = session.console.length === 0;
    if (params.clear) session.console = [];
    return {
      note: wasEmpty
        ? "No messages captured yet. Capture starts when this tool is first used on a tab; reload the page to capture messages from page load."
        : undefined,
      messages,
    };
  },

  async read_network_requests(params) {
    const tab = await resolveTab(params);
    const session = await ensureDebugger(tab.id, ["Network"]);
    let entries = [...session.network.values()];
    if (params.urlContains) {
      entries = entries.filter((e) => e.url && e.url.includes(params.urlContains));
    }
    const wasEmpty = session.network.size === 0;
    if (params.clear) {
      session.network.clear();
      session.networkOrder = [];
    }
    return {
      note: wasEmpty
        ? "No requests captured yet. Capture starts when this tool is first used on a tab; reload or navigate to capture traffic."
        : undefined,
      requests: entries.slice(-(params.limit || 100)),
    };
  },

  // Scoped to the session's group for the same reason resolveTab is: listing a
  // tab the session cannot touch only leads to a refusal one call later.
  async list_tabs(params) {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const tabs = [];
    for (const win of windows) {
      const groupId = await sessionGroupId(params.__session, win.id);
      if (groupId === null) continue;
      tabs.push(...(await chrome.tabs.query({ groupId })));
    }
    return {
      group: sessionGroupTitle(params.__session),
      note: tabs.length ? undefined : "No tabs in this session's group yet. Use new_tab, or drag a tab into the group in Chrome.",
      tabs: tabs.map((t) => ({
        tabId: t.id,
        title: t.title,
        url: t.url,
        active: t.active,
        windowId: t.windowId,
      })),
    };
  },

  async new_tab(params) {
    const tab = await chrome.tabs.create({ url: params.url || "about:blank", active: true });
    if (params.url) await waitForTabComplete(tab.id);
    await addTabToSessionGroup(tab, params.__session);
    const updated = await chrome.tabs.get(tab.id);
    return { tabId: updated.id, url: updated.url, title: updated.title, groupId: updated.groupId };
  },

  // close_tab and switch_tab used chrome.tabs directly, which is the one way a
  // tool could still reach outside the group — and closing a stranger's tab is
  // the most damaging thing this extension can do. They go through resolveTab
  // like everything else; the tabId guard stays so "no tabId" keeps saying so
  // instead of silently acting on some other tab in the group.
  async close_tab(params) {
    if (!params.tabId) throw new Error("tabId is required");
    const tab = await resolveTab(params);
    await chrome.tabs.remove(tab.id);
    return { closed: tab.id };
  },

  async switch_tab(params) {
    if (!params.tabId) throw new Error("tabId is required");
    const target = await resolveTab(params);
    const tab = await chrome.tabs.update(target.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { tabId: tab.id, url: tab.url, title: tab.title };
  },

  async scroll(params) {
    const tab = await resolveTab(params);
    return await execInTab(tab, pageScroll, [
      params.direction || "down",
      params.amount ?? null,
      params.selector ?? null,
    ]);
  },

  async wait_for(params) {
    if (!params.selector) throw new Error("selector is required");
    const tab = await resolveTab(params);
    const timeoutMs = Math.min(params.timeoutMs || 10000, 30000);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const check = await execInTab(tab, pageWaitCheck, [params.selector]);
      if (check.found && check.visible !== false) {
        return { found: true, waitedMs: Date.now() - start };
      }
      await sleep(250);
    }
    return { found: false, waitedMs: timeoutMs };
  },

  async resize_window(params) {
    const tab = await resolveTab(params);
    await chrome.windows.update(tab.windowId, {
      width: params.width || 1280,
      height: params.height || 800,
      state: "normal",
    });
    return { width: params.width || 1280, height: params.height || 800 };
  },

  async upload_file(params) {
    if (!params.selector || !params.filePath) throw new Error("selector and filePath are required");
    const tab = await resolveTab(params);
    await ensureDebugger(tab.id, ["DOM"]);
    const doc = await cdp(tab.id, "DOM.getDocument", {});
    const node = await cdp(tab.id, "DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: params.selector,
    });
    if (!node.nodeId) throw new Error(`No element matches selector: ${params.selector}`);
    await cdp(tab.id, "DOM.setFileInputFiles", {
      nodeId: node.nodeId,
      files: [params.filePath],
    });
    return { uploaded: params.filePath, selector: params.selector };
  },
};
