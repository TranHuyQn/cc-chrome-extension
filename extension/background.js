// Claude Code Chrome Bridge - background service worker.
//
// Connects to the local MCP bridge server over WebSocket and executes
// browser-automation commands (navigate, click, fill, screenshot, ...)
// using chrome.tabs / chrome.scripting / chrome.debugger.

// The bridge has one mode now: http bound to loopback, installed as a per-user
// service. 9876 was the stdio bridge, which no longer exists.
const DEFAULT_WS_URL = "ws://127.0.0.1:23949/ws";
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
  4001: "Token sai hoặc đã bị thu hồi — mở popup, kiểm tra lại URL đã dán, hoặc chạy lại lệnh cài (bash ~/.cc-chrome-bridge/uninstall.sh rồi cài lại) để lấy token mới",
  4002: "URL thiếu token, hoặc extension cũ hơn server — kiểm tra URL đã có ?token=… chưa, rồi tải lại extension từ <server>/extension.zip nếu vẫn lỗi",
  4003: "Server từ chối: origin không hợp lệ",
};

// Refusals: the server will keep refusing until a human changes something, so
// retrying every second helps nobody.
const REFUSAL_CODES = new Set([4001, 4002, 4003]);

const MISSING_TOKEN_REASON =
  "URL thiếu token — server từ xa cần dạng wss://<domain>/ws?token=…; hỏi người quản lý server đó để lấy URL đầy đủ";

const GROUP_COLOR = "orange";

// Orange viewport frame that tells the user Claude is driving this tab.
// The idle timeout lives in the page (see pageShowBorder), not here: Chrome
// terminates this service worker at will, and a timer held on this side would
// leave a permanent ghost frame on the user's page every time that happens.
//
// 30s, not 2s: the extension only ever sees individual tool calls, and the gap
// between them is not the tool's duration — it also carries the round trip to
// the bridge and the time Claude spends reading the result and deciding what
// to do next. Measured against the live http deployment, consecutive calls
// landed 13-14s apart while the tool itself waited 7s. A window shorter than
// that gap makes the frame blink off and on through one continuous working
// session, which reads as a glitch.
//
// This is a tuned compromise, not a fix: nothing bounds the gap between calls,
// so a long enough pause still blinks, and the cost runs the other way — the
// frame outlives the last call by up to 30s. So the frame means "Claude was
// working here recently"; only its absence is a hard statement.
const BORDER_ID = "__cc_border";
const BORDER_IDLE_MS = 30000;

// Passed to pageShowBorder as one object because injected functions may not
// close over anything — every value they use has to arrive as an argument.
//
// There is deliberately no solid edge. A hard line reads as a rendering fault
// on the page; what marks the tab is a wash of colour strongest at the very
// edge and gone by ~110px in. Three stacked inset shadows do that better than
// one: a single large-blur shadow falls off too evenly and still shows where
// it stops, while layering a tight bright one over two wide faint ones gives a
// falloff that has no visible end.
const BORDER_RGB = "232, 113, 10";
const BORDER_LOOK = {
  rgb: BORDER_RGB,
  glow: [
    { blur: 16, spread: 0, alpha: 0.5 },
    { blur: 48, spread: 8, alpha: 0.28 },
    { blur: 110, spread: 24, alpha: 0.12 },
  ],
};

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

// Regroups unconditionally: if `tab` already belongs to a different live
// session's group, chrome.tabs.group() below silently pulls it out of that
// group and into this one. Both the tab's original session and this one only
// ever get a tab here through a user-initiated action (new_tab / attach_tab),
// so a user moving their own tab between two of their own sessions is
// acceptable — there is no guard against it on purpose, but it is easy to
// miss on a first read.
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

// A loopback URL is tried even with no token — the server always requires
// auth to even start (see the FATAL check in server/index.js's mainHttp), so
// a token-less bridge cannot exist; connecting without one just lets the
// server's own 4002 explain the problem instead of the extension guessing
// here. A remote URL without a token skips the round trip: it can only ever
// be refused.
function isLoopbackUrl(parsed) {
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

// attach_tab is the one tool that reaches a tab outside the session's group,
// and it exists for a button the user presses in the side panel. But `handlers`
// is dispatched by method name from whatever arrives on /ws, so proving the
// model cannot reach it says nothing about the *server*: on a shared bridge,
// whoever controls that process could call attach_tab on every member and pull
// their currently-focused tab — banking, email — into a group it can then read,
// with no user action at all.
//
// The side panel only works against a bridge on this machine (see
// panelRefusalReason() in server/index.js), so refusing attach_tab on any other
// bridge costs nothing legitimate and removes that reach entirely. Read from
// storage rather than the in-memory `wsUrl` so the guard does not depend on
// which connection attempt happens to have run last.
async function assertLoopbackBridge() {
  const { wsUrl: configured } = await chrome.storage.local.get({ wsUrl: DEFAULT_WS_URL });
  let parsed = null;
  try {
    parsed = new URL(configured);
  } catch { /* unparseable is not loopback */ }
  if (!parsed || !isLoopbackUrl(parsed)) {
    throw new Error(
      "attach_tab is only available on a bridge running on this machine (127.0.0.1/::1). " +
      `This extension is configured for ${configured || "(no URL)"}, so the request was refused.`
    );
  }
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
    // tabGroupIsolation is declared, not inferred. The server used to read it
    // off the version number ("major >= 3"), which stopped meaning anything
    // when the project renumbered to 1.0.0 for its first published release —
    // every current extension then looked older than the isolation it in fact
    // enforces. A capability flag cannot go stale that way.
    send({
      type: "hello",
      client: "claude-code-chrome-bridge",
      version: chrome.runtime.getManifest().version,
      tabGroupIsolation: true,
    });
    // The server answers `ping` with `pong`, so this turns "proven" into a
    // sub-second signal instead of waiting a whole keepalive period.
    send({ type: "ping" });
    // The fast path only — see the cc-keepalive alarm below for why this timer
    // is not enough on its own.
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
//
// TWO keepalives on purpose — do not delete either as redundant:
//
// * The setInterval in socket.onopen is the fast path. At 20s it beats the
//   alarm's 30s floor whenever Chrome is in the foreground, and it costs
//   nothing.
// * This alarm is the throttling-proof floor. Once Chrome's window has been
//   hidden for ~5 minutes it applies intensive throttling and checks timers
//   only about once a minute, so the 20s interval stops landing inside the 30s
//   window a service worker needs to stay considered active. Chrome then kills
//   the worker, which closes the websocket with 1001 — measured on the live
//   deployment as `close=1001, lived=327s, silent_for=47s`. Chrome's own MV3
//   migration guide says it outright: setTimeout/setInterval "can fail in
//   service workers because the timers are canceled whenever the service worker
//   is terminated. You'll need to replace them with alarms."
//
// chrome.alarms is not throttled the same way, so sending the ping from here
// too keeps traffic on the wire when the interval has been throttled into
// uselessness. 0.5 minutes is Chrome's minimum period — it cannot go lower.
chrome.alarms.create("cc-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "cc-keepalive") return;
  // An open socket needs a ping, not a reconnect; connect() returns early for
  // one anyway, so it would otherwise be a wasted wakeup.
  if (ws && ws.readyState === WebSocket.OPEN) send({ type: "ping" });
  connect();
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
async function resolveTabInGroup(params) {
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

  // active: false — this fallback runs on any tabId-less tool call made
  // before the session has opened anything, so jumping to the front here
  // would steal the user's focus just as often as new_tab would.
  const created = await chrome.tabs.create({ url: "about:blank", active: false });
  await addTabToSessionGroup(created, session);
  return await chrome.tabs.get(created.id);
}

// Painting is deliberately not awaited and its rejection is swallowed:
// chrome:// pages, the PDF viewer and about:blank cannot be injected into, and
// an indicator failure must never become a tool error.
function paintBorder(tabId) {
  chrome.scripting
    .executeScript({ target: { tabId }, func: pageShowBorder, args: [BORDER_ID, BORDER_IDLE_MS, BORDER_LOOK] })
    .catch(() => {});
}

// Awaited by take_screenshot, which must not capture the frame.
async function clearBorder(tabId) {
  await chrome.scripting
    .executeScript({ target: { tabId }, func: pageHideBorder, args: [BORDER_ID] })
    .catch(() => {});
}

// Every tool reaches its tab through here, so this wrapper is the only place
// the indicator has to be triggered — a new handler gets it by following the
// existing rule that it must call resolveTab().
async function resolveTab(params) {
  const tab = await resolveTabInGroup(params);
  paintBorder(tab.id);
  return tab;
}

// One list, two rules. A page under these schemes is browser-internal: no tool
// may run code in it (assertScriptableUrl), and no tool may send a tab to one
// (assertNavigableUrl). They started as two separate regexes and immediately
// disagreed — one carried /i and the other did not, one listed two schemes and
// the other five — which is exactly how one guard quietly stops covering what
// its twin covers. about:blank is the deliberate exception on both sides:
// resolveTab opens one when the session's group is empty and new_tab defaults
// to it.
const INTERNAL_URL_RE = /^(chrome|chrome-extension|devtools|edge|about):/i;

function isInternalUrl(url) {
  const u = url || "";
  // The exemption is case-insensitive because INTERNAL_URL_RE is. Matching the
  // scheme loosely but the exemption strictly refuses "About:Blank" while
  // allowing "about:blank" — one rule disagreeing with itself, which is where
  // the next drift starts.
  return INTERNAL_URL_RE.test(u) && !/^about:blank/i.test(u);
}

// navigate and new_tab must agree on what a scheme-less url means. new_tab did
// not prefix at all, and chrome.tabs.create resolves a relative url against the
// EXTENSION's own base — so a bare "popup.html" opened this extension's own
// page with nothing scheme-shaped in the payload to notice.
function normalizeTargetUrl(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
}

// tab.url is where the tab IS. tab.pendingUrl is where Chrome is already taking
// it, and it is the only field set while a navigation is in flight. Claude Code
// issues independent tool calls concurrently (see the groupLocks comment
// above), and this check runs a full chrome.debugger attach + Runtime.enable
// before Runtime.evaluate reaches the renderer — so a concurrent navigate onto
// an extension page would otherwise slip an eval into the privileged realm.
function assertScriptableUrl(tab) {
  for (const url of [tab.url, tab.pendingUrl]) {
    if (isInternalUrl(url)) {
      throw new Error(`Cannot run scripts on ${url} (browser-internal page). Navigate to a normal web page first.`);
    }
  }
}

// The destination counterpart: assertScriptableUrl inspects where a tab is,
// which says nothing about where it is being sent. A tab already inside the
// session group that lands on this extension's own pages puts chrome.tabs
// within reach, and that is the whole of the in-group restriction — so both
// doors into a tab's url, navigate and new_tab, go through here.
function assertNavigableUrl(url) {
  if (isInternalUrl(url)) {
    throw new Error(`Cannot navigate to ${url} (browser-internal page). Use a normal web page.`);
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

// Appended to documentElement, not body, so it stays out of read_page,
// get_page_text and find results. Styles are set property-by-property with
// "important" and no <style> element is inserted, so a page with a strict
// style-src CSP is unaffected.
//
// The host itself carries the same forced-style treatment as the frame
// inside it. Without that, ordinary non-malicious page CSS can hurt the
// signal in the dangerous direction (silently no frame while Claude is
// driving): a `[aria-hidden="true"] { display: none }` rule is a real
// in-the-wild pattern and would drop the shadow tree with it, and a blanket
// `div { transform: ... }` rule would turn the host into a containing block
// for its `position: fixed` shadow content, collapsing the frame onto the
// host's own 0-height box. Inline "important" outranks an author stylesheet's
// "important" regardless of selector specificity, so forcing these
// properties here closes that off.
//
// This is a defense against page CSS only, not against page JavaScript: the
// shadow root has to stay `mode: "open"` (the e2e test reads
// `host.shadowRoot` from the main world, and would go blind under `closed`),
// so a page script can still reach in and delete the frame in one line.
// `data-cc-frame` on the frame element exists so the reuse check below can
// tell a gutted or decoy host from a real one and rebuild instead of quietly
// reusing it — full tamper-proofing is impossible in a DOM the page also
// controls, so healing on the next paint is the achievable goal, not
// prevention.
function pageShowBorder(id, idleMs, look) {
  try {
    // getElementById would only ever see the FIRST id="__cc_border" in tree
    // order. A page that plants a decoy earlier in the tree (e.g. as the
    // first child of <body>, ahead of the real host on documentElement)
    // would make a getElementById-based rebuild remove the decoy and append
    // a second real host next to the orphaned original — and the idle timer
    // below, and pageHideBorder, would then only ever clear one of the two,
    // leaving a ghost frame behind. Sweeping every match with
    // querySelectorAll keeps that from happening: every host is inspected,
    // at most one intact one survives, everything else is removed.
    let host = null;
    for (const candidate of document.querySelectorAll("#" + id)) {
      const intact = !!(
        candidate.shadowRoot &&
        candidate.shadowRoot.firstElementChild &&
        candidate.shadowRoot.firstElementChild.getAttribute("data-cc-frame") === "1"
      );
      if (intact && !host) {
        host = candidate;
      } else {
        candidate.remove();
      }
    }
    if (!host) {
      host = document.createElement("div");
      host.id = id;
      host.setAttribute("aria-hidden", "true");
      const hostStyle = {
        display: "block",
        position: "fixed",
        top: "0",
        left: "0",
        width: "0",
        height: "0",
        margin: "0",
        padding: "0",
        border: "0",
        "pointer-events": "none",
        visibility: "visible",
        opacity: "1",
        transform: "none",
        filter: "none",
        contain: "none",
        "z-index": "2147483647",
      };
      for (const prop of Object.keys(hostStyle)) host.style.setProperty(prop, hostStyle[prop], "important");
      const frame = document.createElement("div");
      frame.setAttribute("data-cc-frame", "1");
      const style = {
        position: "fixed",
        top: "0",
        left: "0",
        right: "0",
        bottom: "0",
        border: "0",
        "border-radius": "0",
        "box-sizing": "border-box",
        "box-shadow": look.glow
          .map((layer) => `inset 0 0 ${layer.blur}px ${layer.spread}px rgba(${look.rgb}, ${layer.alpha})`)
          .join(", "),
        "pointer-events": "none",
        margin: "0",
        padding: "0",
        "z-index": "2147483647",
      };
      for (const prop of Object.keys(style)) frame.style.setProperty(prop, style[prop], "important");
      host.attachShadow({ mode: "open" }).appendChild(frame);
      document.documentElement.appendChild(host);
    }
    // window here is the isolated world's global, which persists between
    // executeScript calls on the same frame and is invisible to page scripts.
    clearTimeout(window.__cc_borderTimer);
    window.__cc_borderTimer = setTimeout(() => {
      // Same reasoning as the sweep above: clear every host with this id,
      // not just the one getElementById would have found.
      for (const el of document.querySelectorAll("#" + id)) el.remove();
    }, idleMs);
    return { shown: true };
  } catch (e) {
    return { __cc_err: e.message };
  }
}

function pageHideBorder(id) {
  try {
    clearTimeout(window.__cc_borderTimer);
    for (const el of document.querySelectorAll("#" + id)) el.remove();
    return { hidden: true };
  } catch (e) {
    return { __cc_err: e.message };
  }
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
      const fullUrl = normalizeTargetUrl(url);
      assertNavigableUrl(fullUrl);
      await chrome.tabs.update(tab.id, { url: fullUrl });
    }
    await waitForTabComplete(tab.id);
    await sleep(300);
    // The load replaced the document, taking the frame with it.
    paintBorder(tab.id);
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
    // Same fix as javascript_eval: this reaches chrome.debugger, so execInTab's
    // guard never applied to it. Injecting keystrokes into a privileged page has
    // no legitimate use — into this extension's own options UI it means Tab and
    // Enter onto "Lưu & kết nối lại", repointing the bridge at an arbitrary
    // endpoint, and that setting persists in chrome.storage.
    assertScriptableUrl(tab);
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
    // See press_key: typing into a browser-internal page is the other half of
    // repointing this extension's own "Địa chỉ MCP server" field.
    assertScriptableUrl(tab);
    await ensureDebugger(tab.id);
    await cdp(tab.id, "Input.insertText", { text: String(params.text) });
    return { typed: String(params.text).slice(0, 80) };
  },

  async take_screenshot(params) {
    const tab = await resolveTab(params);
    // The missing assertScriptableUrl here is a decision, not an oversight, and
    // adding one "for consistency" with press_key/type_text/javascript_eval/
    // upload_file would be a regression in usefulness for no security gain.
    // Those four MUTATE a privileged page — injecting keystrokes, script or a
    // file selection into this extension's own options UI repoints the bridge
    // persistently, and there is no legitimate use for it. Capturing pixels
    // mutates nothing, and screenshotting an internal page is sometimes
    // genuinely useful when diagnosing. The line the guards follow is
    // mutate-vs-capture, not which Chrome API a handler happens to use — both
    // branches below reach chrome.debugger the way those four do and both
    // still carry no guard on purpose.
    //
    // Screenshots are used to inspect real visual defects (spacing, colour,
    // overflow). A fake orange edge in every image would corrupt that, so the
    // frame comes off for the capture and goes straight back on.
    //
    // Both branches now go through CDP Page.captureScreenshot instead of
    // chrome.tabs.captureVisibleTab. That older API can only capture the tab
    // that is ACTIVE in its window, so the default branch used to force the
    // target tab active first (chrome.tabs.update(tab.id, {active:true})) —
    // measured (focus-investigation.md) to steal whatever other tab the
    // owner had open in that same window, every time. Page.captureScreenshot
    // has no such requirement; it captures the given tab directly regardless
    // of which tab is active. captureBeyondViewport is the only difference
    // between the two branches — omitted here, that's what "default
    // (non-fullPage)" means: just the visible viewport.
    //
    // Cost accepted, not overlooked: every default screenshot now attaches
    // the debugger, so Chrome shows its "is debugging this browser" infobar
    // on that tab, not just for eval/console/network/upload calls as before.
    // That's judged worth it — an infobar is not focus theft, and this
    // extension already pays that cost for four other tools. Deliberately no
    // fallback to the old activate-and-capture path if the attach fails (e.g.
    // DevTools already owns this tab's debugger): falling back would quietly
    // reintroduce the exact steal this fix removes. The caller gets a clear
    // error telling it what to do instead.
    try {
      await ensureDebugger(tab.id, ["Page"]);
    } catch (err) {
      // Two different causes land here and need different advice. A
      // chrome:// tab already failed before this change too (chrome.debugger
      // simply cannot attach there, ever — "Cannot access a chrome:// URL"),
      // so that is not a regression, just a message that must not blame
      // DevTools for something DevTools had nothing to do with. Anything
      // else (most commonly: DevTools, or another extension, already has
      // this tab's debugger) IS the real trade-off this fix accepts.
      const hint = /cannot access a chrome:\/\/ url/i.test(err.message || "")
        ? "This is a browser-internal page; chrome.debugger cannot attach to chrome:// pages at all, regardless of this tool."
        : "Close DevTools (or any other debugger session) on this tab and try again.";
      throw new Error(
        `Cannot take a screenshot without activating the tab: the debugger could not attach (${err.message}). ${hint}`,
        { cause: err }
      );
    }
    await clearBorder(tab.id);
    try {
      const shot = await cdp(tab.id, "Page.captureScreenshot", {
        format: "png",
        ...(params.fullPage ? { captureBeyondViewport: true } : {}),
      });
      return { mimeType: "image/png", base64: shot.data, fullPage: !!params.fullPage };
    } finally {
      paintBorder(tab.id);
    }
  },

  async javascript_eval(params) {
    if (!params.code) throw new Error("code is required");
    const tab = await resolveTab(params);
    // execInTab calls this for chrome.scripting; this handler goes through
    // chrome.debugger instead, so it has to make the same check itself.
    // assertScriptableUrl already covers chrome-extension: — the bug was that
    // nothing here ever called it.
    assertScriptableUrl(tab);
    await ensureDebugger(tab.id, ["Runtime"]);
    // ensureDebugger is a full chrome.debugger.attach + Runtime.enable round
    // trip on first use, and tool calls arrive concurrently, so the snapshot
    // resolveTab handed back can be stale by the time the evaluate would reach
    // the renderer. Re-read live state and re-assert against it here.
    assertScriptableUrl(await chrome.tabs.get(tab.id));
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
    // This is the second door onto a tab's url and it needs the same
    // destination check navigate has: new_tab({url:"chrome-extension://<id>/…"})
    // put this extension's own page inside the session group in a single call.
    // normalizeTargetUrl covers the quieter half — chrome.tabs.create resolves
    // a relative url against the extension's own base, so a bare "popup.html"
    // did it with nothing scheme-shaped in the payload.
    const url = params.url ? normalizeTargetUrl(params.url) : "about:blank";
    assertNavigableUrl(url);
    // active: false — tabs Claude opens must not steal the user's focus.
    // switch_tab is the tool for making a tab the visible one in its window;
    // nothing here, switch_tab included, brings Chrome forward over another
    // application any more.
    const tab = await chrome.tabs.create({ url, active: false });
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
    // Activates the tab inside its own window and stops there. The window
    // raise this used to do (chrome.windows.update({focused:true})) pulled the
    // owner out of whatever application they were in, every call -- the same
    // complaint filed against the original Claude in Chrome extension
    // (anthropics/claude-code#39696, #39707). It was documented here as an
    // intended exception for two revisions; the owner ruled it a defect. Tab
    // activation stays because it IS the tool: when the owner next looks at
    // that window, the tab they asked for is the one showing.
    const tab = await chrome.tabs.update(target.id, { active: true });
    return { tabId: tab.id, url: tab.url, title: tab.title };
  },

  // The one deliberate way a tab outside the session group gets in. It is not a
  // relaxation of the in-group rule: 3.0.0 already treats dragging a tab into
  // the group as the user granting access, and this does that drag for them
  // when they press the button in the side panel.
  //
  // It takes no parameters at all — never a windowId, and never a tabId. An
  // earlier version accepted a caller-supplied windowId; Chrome window ids
  // are small sequential integers, so a local process holding the panel
  // token could enumerate 1..N and pull an *arbitrary* window's active tab
  // into its group, not just the one the user meant to share. The fix is not
  // a stricter validator, it is removing the parameter: the extension finds
  // the window the user is actually looking at itself, at the moment the
  // button is pressed, so there is nothing left for a caller to name.
  attach_tab: async (params) => {
    await assertLoopbackBridge();
    // No `if (!win)` guard here: chrome.windows.getLastFocused() rejects
    // (with "No last-focused window") rather than resolving to a falsy
    // value when nothing matches windowTypes, so a truthiness check on its
    // result can never fire — dead code that lies to the next reader about
    // there being a recoverable case here.
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    if (!tab) throw new Error(`No active tab in window ${win.id}`);
    assertScriptableUrl(tab);
    const groupId = await addTabToSessionGroup(tab, params.__session);
    return { ok: true, tabId: tab.id, groupId, title: tab.title, url: tab.url };
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
    // state:"normal" must only be sent when the window is actually
    // minimized. Measured directly (see focus-investigation.md): that field
    // alone -- even width/height with no `state` steal nothing -- raises
    // whatever window it's sent to, 3/3, EVEN when the window is already
    // normal (a same-value transition). Sending it unconditionally on every
    // call is exactly what made resize_window one of the two handlers that
    // could bring a background window forward while the owner was working in
    // another one. switch_tab was the other, and it no longer does either --
    // no handler raises a window now, which test/focus.test.mjs's all-handler
    // sweep asserts against every one of them.
    const win = await chrome.windows.get(tab.windowId);
    await chrome.windows.update(tab.windowId, {
      width: params.width || 1280,
      height: params.height || 800,
      ...(win.state === "minimized" ? { state: "normal" } : {}),
    });
    return { width: params.width || 1280, height: params.height || 800 };
  },

  async upload_file(params) {
    if (!params.selector || !params.filePath) throw new Error("selector and filePath are required");
    const tab = await resolveTab(params);
    // The fourth mutating debugger tool, guarded for the same reason as
    // press_key/type_text/javascript_eval. On a browser-internal page the
    // attach, DOM.getDocument and DOM.querySelector all succeed today and only
    // DOM.setFileInputFiles fails, with "Node is not a file input element" —
    // that is a coincidence of the current HTML (neither popup.html nor
    // sidepanel.html happens to contain a file input), not a guard, and it
    // stops holding the day one of them does.
    assertScriptableUrl(tab);
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
