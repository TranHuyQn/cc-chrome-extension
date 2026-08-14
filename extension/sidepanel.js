// The side panel's own socket to the bridge. It does not go through the service
// worker: Chrome kills that worker when the window has been hidden a while, and
// losing it mid-turn would lose the stream. This page lives exactly as long as
// the panel is open, which is exactly as long as the chat needs.

const DEFAULT_WS_URL = "ws://127.0.0.1:9876";
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

const CLOSE_REASONS = {
  4001: "Token sai hoặc đã bị thu hồi — mở popup và dán lại URL.",
  4002: "URL thiếu token — mở popup, dán lại URL đầy đủ (dạng ws://127.0.0.1:<port>/ws?token=…, đọc port/token từ ~/.ccchrome.json trên máy chạy bridge).",
  4003: "Origin không hợp lệ.",
  4004: "Server này không bật khung chat. Khung chat chỉ chạy trên bridge của chính máy này — bridge bind loopback, kết nối đến thẳng từ máy này, và không có reverse proxy đứng trước.",
};

const dotEl = document.getElementById("dot");
const groupEl = document.getElementById("group");
const logEl = document.getElementById("log");
const inputEl = document.getElementById("input");
const modelEl = document.getElementById("model");
const stopBtn = document.getElementById("stop");
const attachBtn = document.getElementById("attach");
const newBtn = document.getElementById("newSession");

let ws = null;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let sessionId = null;
// The mcp session id is what the extension hashes into this session's tab group
// name (sessionGroupTitle in background.js). It used to be minted fresh by the
// server on every panel connection, so a bridge restart or a dropped socket
// silently renamed the group and stranded every tab the user had attached —
// while the conversation itself survived via --resume. Remembering it and
// replaying it on `start` is what keeps the two together.
let mcpSessionId = null;
// Storage key for the two ids above. Per window, not extension-global: a panel
// in window A and a panel in window B otherwise loaded the same conversation id
// and both ran `claude --resume` against one on-disk conversation.
let sessionKey = null;
let busy = false;
let streaming = null; // the element currently receiving deltas
// Tracks the last detail line logged by setState, so a backoff loop that
// keeps failing the same way (bridge still down, token still wrong) appends
// one line, not one line per retry forever.
let lastStateDetail = null;

function setState(state, detail = "") {
  dotEl.className = `dot ${state}`;
  if (!detail) {
    lastStateDetail = null;
    return;
  }
  if (detail === lastStateDetail) return;
  lastStateDetail = detail;
  addMessage("error", detail);
}

function addMessage(kind, text) {
  const el = document.createElement("div");
  el.className = kind === "tool" ? "tool" : `msg ${kind}`;
  el.textContent = text;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
  return el;
}

function setBusy(value) {
  busy = value;
  stopBtn.disabled = !value;
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// A side panel belongs to exactly one window, and chrome.windows.getCurrent()
// from this page returns that window — so its id is the natural scope for the
// panel's remembered session. Resolved once and cached: loadState() runs on
// every connect(), and a lookup that failed mid-session must not silently move
// this panel onto a different key.
async function panelSessionKey() {
  if (sessionKey) return sessionKey;
  const win = await chrome.windows.getCurrent().catch(() => null);
  sessionKey = `panelSession.${win?.id ?? "unknown"}`;
  return sessionKey;
}

async function loadState() {
  const key = await panelSessionKey();
  const stored = await chrome.storage.local.get({ wsUrl: DEFAULT_WS_URL, panelModel: "", [key]: null });
  const saved = stored[key] || {};
  sessionId = saved.sessionId || null;
  mcpSessionId = saved.mcpSessionId || null;
  modelEl.value = stored.panelModel || "";
  return stored.wsUrl || DEFAULT_WS_URL;
}

function saveState() {
  if (!sessionKey) return;
  chrome.storage.local.set({ [sessionKey]: { sessionId, mcpSessionId } });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const raw = await loadState();

  let socket;
  try {
    const parsed = new URL(raw);
    parsed.pathname = "/panel";
    const token = parsed.searchParams.get("token");
    parsed.searchParams.delete("token");

    // The stdio bridge's default URL (DEFAULT_WS_URL, ws://127.0.0.1:9876) has
    // no path routing at all -- `new WebSocketServer({ host, port })` with no
    // /panel filter -- so dialing /panel there is not refused with 4004; it
    // lands straight in the extension bridge's own connection handler and
    // evicts the real extension socket (registry.attach() closes it with 4000
    // "replaced by new connection"). A token in the URL is the only
    // client-visible signal that the other end is actually the http bridge
    // (which does have /panel and does require one), so without one this must
    // not dial at all -- not even to find out.
    if (!token) {
      setState(
        "disconnected",
        "Khung chat cần bridge http (có token) chạy trên máy này — mở popup, dán URL dạng ws://127.0.0.1:8787/ws?token=... rồi bấm Lưu & kết nối lại."
      );
      reconnectDelay = RECONNECT_MAX_MS;
      scheduleReconnect();
      return;
    }

    setState("connecting");
    socket = new WebSocket(parsed.toString(), [`ccchrome.token.${token}`]);
  } catch (err) {
    setState("disconnected", String(err));
    scheduleReconnect();
    return;
  }
  ws = socket;

  // Same rule the service worker lives by: the server refuses by completing the
  // handshake and then closing with a code, so `open` fires for refusals too.
  // Only a frame that actually arrived proves the socket.
  let proven = false;

  socket.onmessage = (event) => {
    if (ws !== socket) return;
    if (!proven) {
      proven = true;
      reconnectDelay = RECONNECT_MIN_MS;
      setState("connected");
    }
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handle(msg);
  };

  socket.onclose = (event) => {
    if (ws !== socket) return;
    ws = null;
    setBusy(false);
    // Same class of bug as the two already fixed on "Phiên mới" and the model
    // change: leaving a stale element here means the reconnected socket's first
    // `message` reconciles into a node that is no longer the one being built,
    // and the text disappears with no error.
    streaming = null;
    const reason = CLOSE_REASONS[event.code] ?? (proven ? "" : "Không kết nối được — bridge chưa chạy?");
    setState("disconnected", reason);
    if (CLOSE_REASONS[event.code]) reconnectDelay = RECONNECT_MAX_MS;
    scheduleReconnect();
  };

  socket.onerror = () => {
    if (ws !== socket) return;
    setState("disconnected");
  };
}

function handle(msg) {
  switch (msg.type) {
    case "hello":
      send({ type: "start", sessionId, mcpSessionId, model: modelEl.value || null });
      break;
    case "ready":
      sessionId = msg.sessionId;
      // The server may have refused the replayed id (another live panel holds
      // it) and minted its own, so `ready` is the authority for both ids.
      mcpSessionId = msg.mcpSessionId || mcpSessionId;
      saveState();
      groupEl.textContent = msg.groupTitle || "";
      // "Phiên mới" and a model change both send `start` even while a turn is
      // running; the server disposes that AgentSession, and a disposed
      // session never emits its own turn_end (see AgentSession.emit's
      // `disposed` guard in server/agent.js). busy is otherwise only cleared
      // by turn_end or a socket close, so without this it would stay true
      // forever and every Enter afterward is silently swallowed by
      // `if (!text || busy) return`. ready is the server's honest
      // acknowledgement that a clean session now exists, so it is the right
      // place to reset both.
      setBusy(false);
      streaming = null;
      break;
    case "turn_start":
      setBusy(true);
      streaming = null;
      break;
    case "delta":
      if (!streaming) streaming = addMessage("assistant", "");
      streaming.textContent += msg.text;
      logEl.scrollTop = logEl.scrollHeight;
      break;
    case "message":
      // The buffered message is authoritative; the streamed preview may be a
      // prefix of it, so it is replaced rather than appended to.
      if (streaming) streaming.textContent = msg.text;
      else addMessage("assistant", msg.text);
      streaming = null;
      break;
    case "tool":
      // Does NOT touch `streaming`. When an assistant turn's content blocks
      // arrive as [tool_use, text] (the [text, tool_use] order was already
      // handled correctly, since "message" itself always nulls `streaming`
      // once it finalizes a text block), earlier `delta`s have already built
      // the streaming element; nulling it here on the intervening `tool`
      // event orphaned that element and made the following `message` create
      // a second one with identical text -- the same reply rendered twice.
      // Leaving `streaming` alone lets `message` reconcile into the element
      // the deltas actually went into, whichever order the blocks arrive in.
      // `msg.name` is server-controlled today, but a malformed or future
      // frame with no name must not throw inside onmessage and silently drop
      // the whole event.
      addMessage("tool", `⚙ ${typeof msg.name === "string" ? msg.name.replace(/^mcp__chrome__/, "") : "(không rõ tool)"}`);
      break;
    case "turn_end":
      setBusy(false);
      streaming = null;
      if (!msg.ok) {
        // `error` carries the claude child's last stderr line verbatim — real
        // external process output, never innerHTML'd, always textContent (see
        // addMessage). It passes through unchanged except for one case: a
        // replayed sessionId whose conversation the server no longer has. That
        // is the common failure after reopening the panel days later, so it
        // gets a plain-language nudge instead of leaving the raw CLI error to
        // speak for itself. Every other error stays exactly as received.
        const errorText = msg.error || "Lượt chat thất bại.";
        addMessage("error", errorText);
        if (errorText.includes("No conversation found")) {
          addMessage("error", 'Phiên chat cũ không còn tồn tại trên máy chủ — bấm "Phiên mới" rồi thử lại.');
        }
      }
      break;
    case "attach_tab_result":
      addMessage(msg.ok ? "tool" : "error",
        msg.ok
          ? `✓ Đã đưa vào phiên: ${msg.title || msg.url}`
          : `Không đưa được tab vào phiên: ${msg.error || "không rõ lý do"}`);
      break;
    case "error":
      addMessage("error", msg.message || "Lỗi không rõ từ server.");
      break;
  }
}

inputEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text || busy) return;
  addMessage("user", text);
  inputEl.value = "";
  send({ type: "prompt", text });
});

stopBtn.addEventListener("click", () => send({ type: "stop" }));

attachBtn.addEventListener("click", () => {
  // No windowId: the extension resolves the focused window itself, so a caller
  // cannot name one. See the amendment in Global Constraints.
  send({ type: "attach_tab" });
});

newBtn.addEventListener("click", async () => {
  sessionId = null;
  // The log is cleared right here, synchronously, before the server has
  // disposed the old turn -- a `delta` already in flight for it can still
  // arrive after this click. Without resetting `streaming` too, that late
  // delta would append into an element no longer attached to `logEl`: no
  // error, no visible effect, text silently gone. `ready` (see its handler
  // above) covers the busy/lockup half of disposing a running turn; this
  // covers the stale-DOM-reference half, which `ready` alone does not fix
  // since it can arrive before the very last straggling delta does.
  streaming = null;
  // Only the conversation is new. mcpSessionId is kept on purpose: it names the
  // tab group, so dropping it here would strand the tabs the user attached —
  // "Phiên mới" clears the chat, not the session's tabs (README says so too).
  saveState();
  logEl.textContent = "";
  send({ type: "start", sessionId: null, mcpSessionId, model: modelEl.value || null });
});

modelEl.addEventListener("change", () => {
  // Same stale-reference risk as "Phiên mới" above: a model change also
  // disposes any running turn server-side.
  streaming = null;
  chrome.storage.local.set({ panelModel: modelEl.value });
  send({ type: "start", sessionId, mcpSessionId, model: modelEl.value || null });
});

connect();
