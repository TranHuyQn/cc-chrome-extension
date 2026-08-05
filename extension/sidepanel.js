// The side panel's own socket to the bridge. It does not go through the service
// worker: Chrome kills that worker when the window has been hidden a while, and
// losing it mid-turn would lose the stream. This page lives exactly as long as
// the panel is open, which is exactly as long as the chat needs.

const DEFAULT_WS_URL = "ws://127.0.0.1:9876";
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

const CLOSE_REASONS = {
  4001: "Token sai hoặc đã bị thu hồi — mở popup và dán lại URL.",
  4002: "URL thiếu token — chạy /ccchrome connect để lấy URL đầy đủ.",
  4003: "Origin không hợp lệ.",
  4004: "Server này không bật khung chat. Khung chat chỉ chạy trên bridge nội bộ (127.0.0.1).",
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
let busy = false;
let streaming = null; // the element currently receiving deltas

function setState(state, detail = "") {
  dotEl.className = `dot ${state}`;
  if (detail) addMessage("error", detail);
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

async function loadState() {
  const stored = await chrome.storage.local.get({ wsUrl: DEFAULT_WS_URL, panelSessionId: null, panelModel: "" });
  sessionId = stored.panelSessionId;
  modelEl.value = stored.panelModel || "";
  return stored.wsUrl || DEFAULT_WS_URL;
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
  setState("connecting");

  let socket;
  try {
    const parsed = new URL(raw);
    parsed.pathname = "/panel";
    const token = parsed.searchParams.get("token");
    parsed.searchParams.delete("token");
    socket = token
      ? new WebSocket(parsed.toString(), [`ccchrome.token.${token}`])
      : new WebSocket(parsed.toString());
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
      send({ type: "start", sessionId, model: modelEl.value || null });
      break;
    case "ready":
      sessionId = msg.sessionId;
      chrome.storage.local.set({ panelSessionId: sessionId });
      groupEl.textContent = msg.groupTitle || "";
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
      addMessage("tool", `⚙ ${msg.name.replace(/^mcp__chrome__/, "")}`);
      streaming = null;
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
        msg.ok ? `✓ Đã đưa vào phiên: ${msg.title || msg.url}` : `Không đưa được tab vào phiên: ${msg.error}`);
      break;
    case "error":
      addMessage("error", msg.message);
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
  await chrome.storage.local.remove("panelSessionId");
  logEl.textContent = "";
  send({ type: "start", sessionId: null, model: modelEl.value || null });
});

modelEl.addEventListener("change", () => {
  chrome.storage.local.set({ panelModel: modelEl.value });
  send({ type: "start", sessionId, model: modelEl.value || null });
});

connect();
