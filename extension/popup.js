const dot = document.getElementById("dot");
const state = document.getElementById("state");
const errorEl = document.getElementById("error");
const wsUrlInput = document.getElementById("wsUrl");

const LABELS = {
  connected: "Đã kết nối với Claude Code",
  connecting: "Đang kết nối…",
  disconnected: "Chưa kết nối (MCP server chưa chạy?)",
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
    if (!wsUrlInput.value) wsUrlInput.value = status.url || "ws://127.0.0.1:9876";
  });
}

document.getElementById("save").addEventListener("click", () => {
  const wsUrl = wsUrlInput.value.trim() || "ws://127.0.0.1:9876";
  chrome.runtime.sendMessage({ type: "setWsUrl", wsUrl }, refresh);
});

refresh();
setInterval(refresh, 1000);
