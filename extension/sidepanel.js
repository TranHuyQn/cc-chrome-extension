// The side panel's own socket to the bridge. It does not go through the service
// worker: Chrome kills that worker when the window has been hidden a while, and
// losing it mid-turn would lose the stream. This page lives exactly as long as
// the panel is open, which is exactly as long as the chat needs.

// The installer's default, so a panel with nothing stored at least dials the
// right place. It used to be 9876 — the removed stdio bridge's port, with
// nothing behind it since before 1.0.0.
const DEFAULT_WS_URL = "ws://127.0.0.1:23949";
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
const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("statusText");
const statusTimeEl = document.getElementById("statusTime");
const updateEl = document.getElementById("update");
const updateTextEl = document.getElementById("updateText");
const updateActionEl = document.getElementById("updateAction");
const jumpEl = document.getElementById("jumpToBottom");

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
// The Markdown SOURCE behind `streaming`. Before the panel rendered Markdown the
// bubble was the only copy of a reply in flight and flushStreamingEntry() read
// it back with `streaming.textContent`. Rendered nodes cannot give that back —
// `## Nguyên nhân` returns as `Nguyên nhân`, a fenced block returns without its
// fence — so the journal would record a mangled reply and only show it days
// later, on the next reopen. Keeping the source in a variable is what makes the
// two readings independent again.
let streamingText = "";
// One re-render per animation frame, not one per delta: a delta can arrive many
// times a second and each one re-parses the whole reply.
let streamFrame = 0;
// The journal entry backing `streaming`, if any -- see the `message` case in
// handle() and the resize() comment in panel-journal.js. Kept separate from
// `streaming` (the DOM element) because the two are nulled together but read
// differently: this one is mutated and resize()d, the element's textContent
// is written directly.
let streamingEntry = null;
// Tracks the last detail line logged by setState, so a backoff loop that
// keeps failing the same way (bridge still down, token still wrong) appends
// one line, not one line per retry forever.
let lastStateDetail = null;
// The event shape this panel understands. The server still speaks the old one
// to a panel that does not say this, because a bridge is upgraded by the
// installer while the extension only changes when the user reloads it.
const PROTOCOL = 2;

// step id -> the row rendering it. Rows outlive their event: step_start creates
// one, step_args fills its subtitle, step_end finishes it, and any of the three
// can arrive while the user scrolls elsewhere.
let steps = new Map();
let phase = null;
let phaseStartedAt = 0;
let tickTimer = null;
// Follows the language of what the user typed, and only governs the activity
// wording — buttons and connection errors stay Vietnamese.
let locale = "vi";
// Only on the first load. connect() calls loadState() on every reconnect, and
// adopting the stored value there would overwrite a locale detected from what
// the user has been typing this whole session — then persist that overwrite on
// the next `ready`.
let localeInitialized = false;

// Whether the log should follow new content. The user scrolling up turns this
// off, and it stays off until they come back to the bottom or press the button:
// yanking someone away from the message they are reading is the defect this
// exists to remove.
//
// 24px of slack, not 0: a scrolling box does not always land on an exact
// integer (fractional device pixels, a mid-flight smooth scroll), and demanding
// equality would drop out of follow mode at the bottom of the log.
let stick = true;
const STICK_SLACK_PX = 24;

function atBottom() {
  return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight <= STICK_SLACK_PX;
}

function updateJumpButton() {
  jumpEl.hidden = stick;
}

// Unconditional. Used where the user's own action means they want the live end:
// sending a message, and the one-off scroll after a journal replay.
function scrollToBottom() {
  logEl.scrollTop = logEl.scrollHeight;
  stick = true;
  updateJumpButton();
}

// Everything the SERVER causes goes through here instead.
function scrollIfSticking() {
  if (!stick) return;
  logEl.scrollTop = logEl.scrollHeight;
}

logEl.addEventListener("scroll", () => {
  stick = atBottom();
  updateJumpButton();
});

jumpEl.addEventListener("click", scrollToBottom);

// null = chưa hỏi, "available" = có bản mới, "running" = đang cài,
// "reload" = cài xong chờ nạp lại, "failed" = hỏng.
let updateState = null;
let updateLatest = null;

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
  el.className = kind === "tool" ? "tool" : kind === "stats" ? "stats" : `msg ${kind}`;
  if (kind === "assistant") setMarkdown(el, text);
  else el.textContent = text;
  logEl.appendChild(el);
  scrollIfSticking();
  return el;
}

// Only the assistant's bubbles. What the user typed is left exactly as typed:
// reinterpreting their own words as a document would show them a different
// message from the one the server received.
function setMarkdown(el, source) {
  el.textContent = "";
  el.appendChild(ccMarkdown.toDom(source, document));
}

// Every path that abandons a stream comes through here, rather than each one
// remembering three variables. Before this existed there were nine separate
// `streaming = null` sites and adding a tenth that forgot the source text would
// have journalled the wrong thing from that path only — the kind of gap that
// shows up in one user's log and nobody else's.
function resetStream() {
  streaming = null;
  streamingText = "";
  if (streamFrame) {
    cancelAnimationFrame(streamFrame);
    streamFrame = 0;
  }
}

function scheduleStreamRender() {
  if (streamFrame) return;
  streamFrame = requestAnimationFrame(() => {
    streamFrame = 0;
    if (!streaming) return;
    setMarkdown(streaming, streamingText);
    scrollIfSticking();
  });
}

function formatMs(ms) {
  if (typeof ms !== "number" || !isFinite(ms)) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Built element by element, never innerHTML: `summary` is page text a website
// controls, and it is also what a user is most likely to be looking at.
function addStep(id, name) {
  const el = document.createElement("div");
  el.className = "step running";

  const head = document.createElement("div");
  head.className = "step-head";
  const icon = document.createElement("span");
  icon.className = "step-icon";
  icon.textContent = "●";
  const label = document.createElement("span");
  label.className = "step-label";
  label.textContent = ccLabels.stepLabel(name, locale);
  const sub = document.createElement("span");
  sub.className = "step-sub";
  const time = document.createElement("span");
  time.className = "step-time";
  head.append(icon, label, sub, time);

  const detail = document.createElement("pre");
  detail.className = "step-detail";
  detail.hidden = true;
  head.addEventListener("click", () => { detail.hidden = !detail.hidden; });

  el.append(head, detail);
  logEl.appendChild(el);
  scrollIfSticking();
  steps.set(id, { el, icon, label, sub, time, detail, name });
  return el;
}

function fillStepArgs(id, input) {
  const step = steps.get(id);
  if (!step) return;
  step.sub.textContent = ccLabels.stepSubtitle(input);
  step.detail.textContent = ccLabels.formatInput(input, locale);
}

function finishStep(msg) {
  const step = steps.get(msg.id);
  if (!step) return;
  steps.delete(msg.id);
  step.el.classList.remove("running");
  step.el.classList.add(msg.ok ? "ok" : "fail");
  step.icon.textContent = msg.aborted ? "⦸" : msg.ok ? "✓" : "✗";
  step.time.textContent = formatMs(msg.ms);
  const heading = ccLabels.resultHeading(msg, locale);
  const body = msg.summary ? `\n${msg.summary}` : "";
  step.detail.textContent = `${step.detail.textContent}\n\n${heading}${body}`.trim();
}

// A turn can die without the server closing its steps: a disposed AgentSession
// emits nothing (see the `ready` comment), which is what a model change or a
// dropped socket produces. Nothing else will ever close these rows, and a
// leftover entry would make paintStatus name a dead turn's tool during the
// NEXT turn.
function sweepOpenSteps() {
  for (const id of [...steps.keys()]) finishStep({ id, ok: false, aborted: true, ms: null });
}

// A stream can end without a `message`: a dropped socket, a model change, a
// disposed session. The placeholder is already in the journal holding "", so
// whatever reached the screen has to be copied into it before the reference is
// dropped — otherwise reopening the panel shows an empty bubble where the text
// was.
function flushStreamingEntry() {
  if (!streamingEntry) return;
  const text = streamingText;
  if (text) {
    streamingEntry.text = text;
    ccJournal.resize(streamingEntry);
  }
  streamingEntry = null;
}

// One timer for the whole panel, not one per row: what has to move is the
// single number the user is watching, and a second interval per step would
// stack up over a long turn.
function startTicking() {
  if (tickTimer) return;
  tickTimer = setInterval(paintStatus, 1000);
}

function stopTicking() {
  if (!tickTimer) return;
  clearInterval(tickTimer);
  tickTimer = null;
}

function paintStatus() {
  if (!busy) {
    statusEl.classList.remove("on");
    stopTicking();
    return;
  }
  // A running tool outranks any phase: it is the more specific truth.
  const running = [...steps.values()].at(-1);
  statusTextEl.textContent = running
    ? ccLabels.stepLabel(running.name, locale)
    : ccLabels.phaseLabel(phase, locale);
  statusTimeEl.textContent = `${Math.max(0, Math.round((Date.now() - phaseStartedAt) / 1000))}s`;
  statusEl.classList.add("on");
}

function setBusy(value) {
  busy = value;
  stopBtn.disabled = !value;
}

// Update status describes the machine RIGHT NOW, not the conversation, so it is
// drawn directly here rather than through record()/ccJournal — a replayed
// "Có bản 1.2.1" from a week-old journal entry would be a lie the next time the
// panel opens.
function showUpdate(state, text, actionLabel) {
  updateState = state;
  updateEl.hidden = false;
  updateEl.classList.toggle("failed", state === "failed");
  updateTextEl.textContent = text;
  updateActionEl.hidden = !actionLabel;
  updateActionEl.textContent = actionLabel || "";
}

function hideUpdate() {
  updateState = null;
  updateEl.hidden = true;
}

const UPDATE_STEP_TEXT = {
  downloading: "Đang tải bản mới…",
  verifying: "Đang kiểm tra gói tải về…",
  extracting: "Đang giải nén và kiểm tra gói…",
  installing: "Đang cài… bridge sẽ khởi động lại",
};

// Guards against two overlapping polls: a retry from the "failed" state (see
// the click handler below) can fire update_start again while an earlier
// waitForNewVersion() from a previous attempt is still polling /health, and
// two loops racing to call showUpdate() would make the banner flicker between
// two different outcomes at random.
let updatePolling = false;

// The socket dies when the installer stops the service, so the only way to learn
// the outcome is to ask /health directly. 90s is deliberate: the runner waits 30s
// for health before it even begins rolling back, so the panel's ceiling has to
// cover a full install AND a full rollback.
async function waitForNewVersion(expected) {
  if (updatePolling) return;
  updatePolling = true;
  try {
    const raw = (await chrome.storage.local.get({ wsUrl: DEFAULT_WS_URL })).wsUrl;
    let health;
    try {
      const parsed = new URL(raw);
      health = `http://${parsed.hostname}:${parsed.port}/health`;
    } catch {
      showUpdate("failed", "Không đọc được địa chỉ bridge để kiểm tra kết quả.", "");
      return;
    }
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch(health, { cache: "no-store" });
        const body = await res.json();
        if (body?.version === expected) {
          showUpdate("reload", `Đã cài ${expected}. Nạp lại extension để dùng giao diện mới.`, "Nạp lại extension");
          return;
        }
      } catch { /* bridge is restarting — that is the expected state here */ }
    }
    showUpdate("failed",
      "Quá 90 giây chưa thấy bản mới chạy. Mở terminal và chạy lại lệnh cài trong README.", "");
  } finally {
    updatePolling = false;
  }
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

async function panelJournalKey() {
  const key = await panelSessionKey();
  return key.replace("panelSession.", "panelLog.");
}

// Replayed before the socket is dialled, so the log is never briefly blank and
// a live event can never interleave into the middle of the replay. Callers
// must await loadState() first -- `locale` has to be the persisted one before
// a single row is drawn, or the replay renders tool labels in the wrong
// language and nothing ever repaints them once connect() loads the real value.
async function restore() {
  const entries = await ccJournal.load(await panelJournalKey());
  for (const entry of entries) {
    // ccJournal.load only checks that the stored value is an array, never its
    // elements -- a corrupt or foreign entry must not throw and abort the
    // whole restore (see the try/catch around this call in the startup IIFE).
    if (!entry || typeof entry !== "object" || typeof entry.type !== "string") continue;
    render(entry);
  }
  // A step still open in the journal belonged to a process that is certainly
  // dead — the panel was closed. Close it now rather than leaving a row that
  // pulses forever.
  sweepOpenSteps();
  resetStream();
  streamingEntry = null;
  // A reopened panel starts at the live end, whatever the user's scroll
  // position was when they closed it.
  scrollToBottom();
}

async function loadState() {
  const key = await panelSessionKey();
  const stored = await chrome.storage.local.get({ wsUrl: DEFAULT_WS_URL, panelModel: "", [key]: null });
  const saved = stored[key] || {};
  sessionId = saved.sessionId || null;
  mcpSessionId = saved.mcpSessionId || null;
  // Reopening the panel otherwise replays an English conversation with
  // Vietnamese tool labels: `locale` has to survive alongside the ids it sits
  // next to, or it silently reverts every time. Only on the FIRST load though
  // -- connect() calls loadState() again on every reconnect, and adopting the
  // stored value there would clobber a locale detected live from what the
  // user has typed since, then persist that clobber on the next `ready`.
  if (!localeInitialized) {
    locale = saved.locale === "en" ? "en" : "vi";
    localeInitialized = true;
  }
  modelEl.value = stored.panelModel || "";
  return stored.wsUrl || DEFAULT_WS_URL;
}

function saveState() {
  if (!sessionKey) return;
  chrome.storage.local.set({ [sessionKey]: { sessionId, mcpSessionId, locale } });
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
  let raw;
  try {
    raw = await loadState();
  } catch (err) {
    // Storage can reject on an invalidated extension context. Falling back to
    // the default URL is better than returning: returning leaves no socket and
    // no reconnect timer, which is indistinguishable from a hung panel.
    console.warn("[panel] không đọc được cấu hình:", err);
    raw = DEFAULT_WS_URL;
  }

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
        "Khung chat cần bridge http (có token) chạy trên máy này — mở popup, dán URL dạng ws://127.0.0.1:23949/ws?token=... rồi bấm Lưu & kết nối lại."
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
    flushStreamingEntry();
    resetStream();
    // A dropped socket is the other path (besides a model change) where a
    // disposed AgentSession never gets to send its own step_end -- see the
    // comment on `turn_start` in handle(). Without this, reconnecting mid-turn
    // left a pulsing row that the next turn's paintStatus would misreport as
    // still running.
    sweepOpenSteps();
    stopTicking();
    statusEl.classList.remove("on");
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

// Everything that puts something on screen. Separate from handle() because the
// journal replays these same objects on open, and a replay must not re-send
// `start`, reset busy, or reschedule anything.
function render(msg) {
  switch (msg.type) {
    case "user":
      addMessage("user", msg.text);
      break;
    case "delta":
      if (!streaming) {
        streaming = addMessage("assistant", "");
        streamingText = "";
      }
      streamingText += msg.text;
      scheduleStreamRender();
      break;
    case "message":
      // The buffered message is authoritative; the streamed preview may be a
      // prefix of it, so it is replaced rather than appended to.
      if (streaming) setMarkdown(streaming, msg.text);
      else addMessage("assistant", msg.text);
      resetStream();
      break;
    case "step_start":
      // Deliberately does NOT touch `streaming` — see the comment on the old
      // `tool` case: blocks can arrive as [tool_use, text], and orphaning the
      // element the deltas built made the same reply render twice.
      addStep(msg.id, msg.name);
      break;
    case "step_args":
      fillStepArgs(msg.id, msg.input);
      break;
    case "step_end":
      finishStep(msg);
      break;
    case "turn_stats": {
      const bits = [];
      if (typeof msg.ms === "number") bits.push(formatMs(msg.ms));
      if (typeof msg.outputTokens === "number") bits.push(`${msg.outputTokens} token`);
      if (bits.length) addMessage("stats", bits.join(" · "));
      break;
    }
    case "error-line":
      addMessage("error", msg.text);
      break;
    case "tool":
      // A bridge older than this panel still speaks the pre-timeline shape.
      addMessage("tool", `⚙ ${typeof msg.name === "string" ? msg.name.replace(/^mcp__chrome__/, "") : "(không rõ tool)"}`);
      break;
  }
}

// Draw it and remember it. Anything that goes through here comes back when the
// panel is reopened.
function record(msg) {
  ccJournal.push(msg);
  render(msg);
}

function handle(msg) {
  switch (msg.type) {
    case "hello":
      send({ type: "start", sessionId, mcpSessionId, model: modelEl.value || null, protocol: PROTOCOL });
      break;
    case "ready":
      sessionId = msg.sessionId;
      // The server may have refused the replayed id (another live panel holds
      // it) and minted its own, so `ready` is the authority for both ids.
      mcpSessionId = msg.mcpSessionId || mcpSessionId;
      saveState();
      groupEl.textContent = msg.groupTitle || "";
      // "Phiên mới" and a model change both send `start` even while a turn is
      // running; the server disposes that AgentSession, and a disposed session
      // never emits its own turn_end (see AgentSession.emit's `disposed` guard
      // in server/agent.js). busy is otherwise only cleared by turn_end or a
      // socket close, so without this it would stay true forever and every
      // Enter afterward is silently swallowed by `if (!text || busy) return`.
      setBusy(false);
      // A model change or "Phiên mới" can dispose a turn mid-stream, and this
      // is the frame that confirms it: flush whatever reached the screen into
      // the journal before dropping the reference, or reopening the panel
      // shows an empty bubble where the partial reply was.
      flushStreamingEntry();
      resetStream();
      send({ type: "update_check" });
      break;
    case "update_status": {
      // The reload prompt outranks any status. After a successful install the
      // reconnecting socket asks again, the new bridge answers "no update
      // available", and the old code hid the one button the user still has to
      // press — usually within seconds of it appearing.
      if (updateState === "reload") break;
      // A panel that just connected asks once; nothing here is journalled,
      // because it describes the machine right now, not the conversation.
      // `lastResult.step` may be "rolled-back", "already-running", "crashed",
      // "failed-no-backup" or "handover-failed" (the last one written by the
      // bridge itself, not the runner, when the runner could not be spawned at
      // all) -- all are failures, so `ok === false` is the only
      // distinction that matters, and `reason` carries the full explanation
      // (recovery paths included) for every one of them.
      //
      // A version that just failed is still GitHub's newest tag, so `available`
      // is true immediately after a rollback. Checking it first would replace
      // the recovery instructions -- the only text naming the backup and log
      // paths -- with a retry button. The failure has to win.
      //
      // Unless the machine is now RUNNING that version: then the record is
      // stale (a later attempt worked, or the user installed by hand), and
      // showing it would be reporting an old failure as current.
      const failed = msg.lastResult
        && msg.lastResult.ok === false
        && msg.lastResult.version !== msg.current;
      if (failed) {
        updateLatest = msg.available ? msg.latest : null;
        showUpdate("failed", msg.lastResult.reason || "Lần cập nhật trước thất bại.",
          msg.available && msg.latest ? "Thử lại" : "");
      } else if (msg.available && msg.latest) {
        updateLatest = msg.latest;
        showUpdate("available", `Có bản ${msg.latest} (đang chạy ${msg.current}).`, "Cập nhật");
      } else {
        hideUpdate();
      }
      break;
    }
    case "update_progress":
      showUpdate("running", UPDATE_STEP_TEXT[msg.step] || "Đang cập nhật…", "");
      if (msg.step === "installing" && updateLatest) waitForNewVersion(updateLatest);
      break;
    case "update_failed":
      showUpdate("failed", msg.reason || "Cập nhật thất bại.", "");
      break;
    case "turn_start":
      // A disposed AgentSession emits nothing at all (see the comment on
      // `ready` above), so a model change or a dropped socket can end a turn
      // without ever sending step_end for its open rows. Sweep them here too,
      // not just in those two spots: whichever one actually fires, the NEXT
      // turn must not inherit a pulsing row from the one before it.
      sweepOpenSteps();
      setBusy(true);
      // Same stale-reference risk as `ready`, model change, and socket close
      // above/below: flush whatever reached the screen into the journal
      // before dropping the reference. Unreachable today (a new turn requires
      // busy === false, and every path that clears it already flushes), kept
      // for symmetry with those other four sites so the invariant holds even
      // if a future path clears busy differently. flushStreamingEntry()
      // already nulls streamingEntry itself.
      flushStreamingEntry();
      resetStream();
      phase = null;
      phaseStartedAt = Date.now();
      startTicking();
      paintStatus();
      break;
    case "phase":
      phase = msg.phase;
      // The clock measures the CURRENT state, not the whole turn: "Đang suy
      // nghĩ… 40s" when 38 of those were a tool call would be a lie.
      phaseStartedAt = Date.now();
      paintStatus();
      break;
    case "delta":
      // Deltas are a live preview, deliberately NOT journalled: `message`
      // carries the same text authoritatively a moment later, and journalling
      // both would double the log on reopen. What IS journalled here is a
      // placeholder the first delta of a bubble creates, so the bubble holds
      // its true position relative to the tool rows around it instead of
      // sinking below them on replay -- `message` below fills in the real
      // text on the same entry.
      if (!streaming) {
        streamingEntry = { type: "message", text: "" };
        ccJournal.push(streamingEntry);
      }
      render(msg);
      break;
    case "message":
      if (streamingEntry) {
        streamingEntry.text = msg.text;
        ccJournal.resize(streamingEntry);
        streamingEntry = null;
        render(msg);
      } else {
        record(msg);
      }
      break;
    case "step_start":
      record(msg);
      phaseStartedAt = Date.now();
      paintStatus();
      break;
    case "step_args":
      record(msg);
      break;
    case "step_end":
      record(msg);
      phaseStartedAt = Date.now();
      paintStatus();
      break;
    case "turn_stats":
      record(msg);
      break;
    case "tool":
      record(msg);
      break;
    case "turn_end":
      // A turn killed mid-sentence leaves text on screen that `message` never
      // arrived to confirm. Keep it, or reopening the panel loses it. The
      // placeholder already holds the right position (pushed on the first
      // delta above), so this updates it in place rather than pushing a
      // second entry for the same bubble.
      flushStreamingEntry();
      setBusy(false);
      resetStream();
      stopTicking();
      paintStatus();
      if (!msg.ok) {
        // `error` carries the claude child's last stderr line verbatim — real
        // external process output, never innerHTML'd, always textContent.
        const errorText = msg.error || "Lượt chat thất bại.";
        record({ type: "error-line", text: errorText });
        if (errorText.includes("No conversation found")) {
          record({ type: "error-line", text: 'Phiên chat cũ không còn tồn tại trên máy chủ — bấm "Phiên mới" rồi thử lại.' });
        }
      }
      break;
    case "attach_tab_result":
      // Deliberately unjournalled, unlike error-line: this describes the
      // CURRENT live connection ("✓ Đã đưa vào phiên"), and replaying it days
      // later would claim a tab attachment as present tense that is not true
      // anymore.
      addMessage(msg.ok ? "tool" : "error",
        msg.ok
          ? `✓ Đã đưa vào phiên: ${msg.title || msg.url}`
          : `Không đưa được tab vào phiên: ${msg.error || "không rõ lý do"}`);
      break;
    case "error":
      // Same reasoning as attach_tab_result: a transport-level error about
      // this socket, not part of the conversation, so it stays unjournalled.
      addMessage("error", msg.message || "Lỗi không rõ từ server.");
      break;
  }
}

inputEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text || busy) return;
  locale = ccLabels.detectLocale(text, locale);
  saveState();
  record({ type: "user", text });
  inputEl.value = "";
  send({ type: "prompt", text });
  scrollToBottom();
});

stopBtn.addEventListener("click", () => send({ type: "stop" }));

updateActionEl.addEventListener("click", () => {
  // "failed" shows this button ("Thử lại") only when a newer release is still
  // available -- see the update_status handler above -- so it starts an update
  // exactly the way "available" does.
  if (updateState === "available" || updateState === "failed") {
    send({ type: "update_start" });
    showUpdate("running", UPDATE_STEP_TEXT.downloading, "");
    return;
  }
  if (updateState === "reload") {
    // Reloading destroys this page, which is why it is a button and not
    // automatic: the user picks the moment, after they have read the result.
    chrome.runtime.reload();
  }
});

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
  resetStream();
  streamingEntry = null;
  // Only the conversation is new. mcpSessionId is kept on purpose: it names the
  // tab group, so dropping it here would strand the tabs the user attached —
  // "Phiên mới" clears the chat, not the session's tabs (README says so too).
  saveState();
  ccJournal.clear();
  steps = new Map();
  logEl.textContent = "";
  send({ type: "start", sessionId: null, mcpSessionId, model: modelEl.value || null, protocol: PROTOCOL });
});

modelEl.addEventListener("change", () => {
  // Same stale-reference risk as "Phiên mới" above: a model change also
  // disposes any running turn server-side.
  flushStreamingEntry();
  resetStream();
  // Same leak as socket.onclose: a disposed AgentSession never sends step_end
  // for whatever was still running, so this turn's rows would otherwise
  // pulse forever and paintStatus would misreport them during the next turn.
  sweepOpenSteps();
  chrome.storage.local.set({ panelModel: modelEl.value });
  send({ type: "start", sessionId, mcpSessionId, model: modelEl.value || null, protocol: PROTOCOL });
});

(async () => {
  // The journal is a nicety; the socket is the product. A corrupt journal
  // entry, a storage error, or a failed lookup must never cost the user their
  // connection -- before this file gained a journal, connect() was
  // unconditional, and it stays that way. loadState() runs here (not only
  // inside connect()) so `locale` is the persisted one BEFORE restore() draws
  // a single row; connect() below reloads the same state harmlessly when it
  // actually dials.
  try {
    // A journal for a window that no longer exists can never be replayed --
    // a reopened window gets a fresh id, so its own journal (keyed by that
    // new id) is what will ever be read. The old key is not merely stale, it
    // is unreachable: nothing in this file ever looks it up again. Chrome
    // window ids climb monotonically within a browser session and nothing
    // else in this extension prunes panelLog.* keys, so left alone they
    // accumulate forever against chrome.storage.local's ~10MB quota (this
    // extension does not request unlimitedStorage). Deliberately scoped to
    // panelLog.* only -- panelSession.* keys are tiny, pre-existing, and a
    // window id can be reused across browser restarts in ways that make
    // pruning them a different question from this one.
    const live = new Set((await chrome.windows.getAll()).map((w) => `panelLog.${w.id}`));
    const all = await chrome.storage.local.get(null);
    const dead = Object.keys(all).filter((k) => k.startsWith("panelLog.") && !live.has(k));
    if (dead.length) await chrome.storage.local.remove(dead);
    await loadState();
    await restore();
  } catch (err) {
    console.warn("[panel] không đọc lại được nhật ký:", err);
  }
  connect();
})();
