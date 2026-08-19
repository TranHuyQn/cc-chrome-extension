const dot = document.getElementById("dot");
const state = document.getElementById("state");
const errorEl = document.getElementById("error");
const wsUrlInput = document.getElementById("wsUrl");
const portHint = document.getElementById("portHint");

// The installer's own default. Only ever used to fill an empty box — whatever
// the user has already saved wins, and an upgrade never moves an existing
// machine's port (see scripts/install.sh).
const DEFAULT_WS_URL = "ws://127.0.0.1:23949";

const LABELS = {
  connected: "Đã kết nối với Claude Code",
  connecting: "Đang kết nối…",
  disconnected: "Chưa kết nối",
};

function refresh() {
  chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
    if (chrome.runtime.lastError || !status) {
      state.textContent = "Service worker đang khởi động…";
      return;
    }
    dot.className = `dot ${status.state}`;
    state.textContent = LABELS[status.state] || status.state;
    errorEl.textContent = status.lastError || "";
    // Shown only while disconnected, and it names the port on purpose: the most
    // common cause of a badge that never turns green is a URL pointing at a port
    // nothing is listening on any more, and the extension has no way to discover
    // the right one — it can only say where the answer is written down.
    portHint.hidden = status.state !== "disconnected";
    if (!wsUrlInput.value) wsUrlInput.value = status.url || DEFAULT_WS_URL;
  });
}

document.getElementById("save").addEventListener("click", () => {
  const wsUrl = wsUrlInput.value.trim() || DEFAULT_WS_URL;
  chrome.runtime.sendMessage({ type: "setWsUrl", wsUrl }, refresh);
});

refresh();
setInterval(refresh, 1000);

// chrome.sidePanel.open() requires a user gesture, and a click inside the popup
// is one. Opening from the service worker instead throws.
document.getElementById("openPanel").addEventListener("click", async () => {
  const { id } = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: id });
  window.close();
});
