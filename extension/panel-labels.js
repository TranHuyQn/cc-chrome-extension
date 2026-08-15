// Every user-facing word the activity timeline says, in both languages, plus
// the heuristic that picks between them.
//
// This lives in the extension, not the server, on purpose: the server owns the
// data (pairing tool calls with results, timing, truncation) and this file owns
// the wording. Adding a browser tool later is one row here and nothing at all
// on the server.
//
// One global, assigned from an IIFE. Not a module and not a set of loose
// top-level functions: extension/ has no build step, and eslint (script mode)
// reports a top-level function used only from another file as unused.
window.ccLabels = (() => {
  // Keyed by the bare tool name; the mcp__chrome__ prefix is stripped first.
  const TOOL_LABELS = {
    chrome_status: { vi: "Kiểm tra cầu nối", en: "Bridge status" },
    list_tabs: { vi: "Liệt kê tab", en: "List tabs" },
    new_tab: { vi: "Mở tab", en: "Open tab" },
    close_tab: { vi: "Đóng tab", en: "Close tab" },
    switch_tab: { vi: "Chuyển tab", en: "Switch tab" },
    navigate: { vi: "Mở trang", en: "Navigate" },
    read_page: { vi: "Đọc trang", en: "Read page" },
    get_page_text: { vi: "Đọc nội dung trang", en: "Read page text" },
    find: { vi: "Tìm trên trang", en: "Find on page" },
    click: { vi: "Nhấp", en: "Click" },
    fill: { vi: "Điền ô", en: "Fill field" },
    fill_form: { vi: "Điền biểu mẫu", en: "Fill form" },
    type_text: { vi: "Gõ chữ", en: "Type text" },
    press_key: { vi: "Nhấn phím", en: "Press key" },
    scroll: { vi: "Cuộn trang", en: "Scroll" },
    wait_for: { vi: "Chờ phần tử", en: "Wait for" },
    take_screenshot: { vi: "Chụp màn hình", en: "Screenshot" },
    read_console_messages: { vi: "Đọc console", en: "Read console" },
    read_network_requests: { vi: "Đọc network", en: "Read network" },
    javascript_eval: { vi: "Chạy JS", en: "Run JS" },
    upload_file: { vi: "Tải tệp lên", en: "Upload file" },
    resize_window: { vi: "Đổi cỡ cửa sổ", en: "Resize window" },
  };

  const PHASE_LABELS = {
    requesting: { vi: "Đang gửi yêu cầu", en: "Sending request" },
    thinking: { vi: "Đang suy nghĩ", en: "Thinking" },
    answering: { vi: "Đang trả lời", en: "Answering" },
    working: { vi: "Đang xử lý", en: "Working" },
  };

  const RESULT_LABELS = {
    ok: { vi: "Kết quả", en: "Result" },
    fail: { vi: "Lỗi", en: "Error" },
    aborted: { vi: "Bị gián đoạn", en: "Interrupted" },
    truncated: { vi: "(tham số đã cắt bớt)", en: "(arguments truncated)" },
  };

  // One ordered list for every tool rather than a per-tool mapping: it covers
  // tools nobody has added yet, and there is nothing to keep in sync.
  const SUBTITLE_KEYS = ["url", "query", "text", "value", "key", "code", "selector", "filePath", "direction", "ref"];
  const SUBTITLE_MAX = 60;

  // Vietnamese written with diacritics settles the question outright.
  const VI_MARKS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụỳýỷỹỵ]/i;
  // Vietnamese typed WITHOUT diacritics is extremely common, and is the case
  // that breaks a diacritics-only test: "mo tab github roi tim repo" is ASCII.
  const VI_WORDS = /\b(mo|dong|trang|giup|gium|cho|vao|roi|nhap|bam|tim|kiem|lam|xem|doc|dang|khong|duoc|thu|lai|nay|voi|minh)\b/gi;
  const EN_WORDS = /\b(the|and|please|open|click|find|search|read|check|then|this|that|with|for|you|make|show|about|from|into)\b/gi;

  function bare(name) {
    return String(name ?? "").replace(/^mcp__chrome__/, "");
  }

  function stepLabel(name, locale) {
    const key = bare(name);
    const entry = TOOL_LABELS[key];
    if (!entry) return key || "tool";
    return entry[locale] || entry.vi;
  }

  function phaseLabel(phase, locale) {
    const entry = PHASE_LABELS[phase] || PHASE_LABELS.working;
    return entry[locale] || entry.vi;
  }

  function stepSubtitle(input) {
    if (!input || typeof input !== "object") return "";
    if (input.__truncated) return String(input.__preview || "").slice(0, SUBTITLE_MAX);
    for (const key of SUBTITLE_KEYS) {
      if (input[key] === undefined || input[key] === null) continue;
      const value = String(input[key]);
      if (!value) continue;
      return value.length > SUBTITLE_MAX ? `${value.slice(0, SUBTITLE_MAX)}…` : value;
    }
    return "";
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n}B`;
    return `${(n / 1024).toFixed(1)}KB`;
  }

  function resultHeading(step, locale) {
    const key = step?.aborted ? "aborted" : step?.ok ? "ok" : "fail";
    const word = RESULT_LABELS[key][locale] || RESULT_LABELS[key].vi;
    return step?.size ? `${word} · ${formatSize(step.size)}` : word;
  }

  function formatInput(input, locale) {
    if (!input || typeof input !== "object") return "";
    if (input.__truncated) {
      const note = RESULT_LABELS.truncated[locale] || RESULT_LABELS.truncated.vi;
      return `${input.__preview || ""}\n${note}`;
    }
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return "";
    }
  }

  function count(text, re) {
    return (String(text).match(re) || []).length;
  }

  function detectLocale(text, previous) {
    const fallback = previous === "en" ? "en" : "vi";
    const s = typeof text === "string" ? text : "";
    if (!s) return fallback;
    if (VI_MARKS.test(s)) return "vi";
    const vi = count(s, VI_WORDS);
    const en = count(s, EN_WORDS);
    if (vi > en) return "vi";
    if (en > vi) return "en";
    // Nothing to go on — a URL, a code snippet, one bare word. Flipping the
    // interface on that would be worse than saying nothing.
    return fallback;
  }

  return { stepLabel, phaseLabel, stepSubtitle, formatSize, resultHeading, formatInput, detectLocale };
})();
