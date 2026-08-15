# Panel Activity Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Khung chat side panel hiển thị agent đang làm gì theo thời gian thực — đang chờ API, đang suy nghĩ, đang chạy tool nào, tool đó xong hay lỗi — và vẽ lại được lịch sử khi mở lại panel.

**Architecture:** Server (`server/agent.js`) dịch NDJSON của `claude` thành sự kiện có cấu trúc: ghép `tool_use_id` giữa lúc gọi và lúc có kết quả, đo thời gian, cắt kết quả trước khi ra socket. Extension (`extension/sidepanel.js` + 2 file mới) giữ bảng chữ nghĩa hai ngôn ngữ và toàn bộ việc vẽ. `server/index.js` chỉ thêm một dòng chuyển tiếp số hiệu giao thức — nó đã có `onEvent: (event) => send(event)`.

**Tech Stack:** Node ESM (server, test), JavaScript classic script không build step (extension), `ws`, Playwright (chỉ cho verify thủ công).

**Spec:** `docs/superpowers/specs/2026-08-15-panel-activity-timeline-design.md`

## Global Constraints

- **Không thêm build step cho `extension/`.** Extension là JS thuần Chrome nạp trực tiếp. File mới nạp bằng thẻ `<script>` trong `sidepanel.html`.
- **Chia sẻ code giữa file extension phải qua một global object duy nhất.** Đã kiểm chứng: `npx eslint` báo lỗi `no-unused-vars` cho hàm top-level khai báo ở file A dùng ở file B. Khuôn mẫu bắt buộc: `window.ccX = (() => { … return { … }; })();`
- **`npm run lint` phải giữ 0 lỗi.** Hook `PostToolUse` trong `.claude/settings.json` lint mọi file `.js`/`.mjs` ngay sau khi ghi.
- **Nội dung do trang web sinh ra không bao giờ được đưa vào DOM bằng `innerHTML`.** `summary` của `step_end` là văn bản trang web thật. Chỉ dùng `textContent` / `createElement`.
- **Tiếng Việt cho UI người dùng, tiếng Anh cho code + comment + commit message.** Ngoại lệ duy nhất trong đợt này: bảng nhãn ở `extension/panel-labels.js` chứa cả chuỗi `vi` và `en`.
- **Ba file phải khớp version** (`test/build.test.mjs` canh): `extension/manifest.json`, `VERSION` trong `server/index.js`, `server/package.json`. Đích đợt này: **1.1.0**.
- **Không handler nào được cướp focus.** Đợt này không thêm handler nào trong `extension/background.js`, nên ràng buộc này chỉ để nhắc: đừng đụng vào đó.
- **Sự kiện mới phải đi qua `AgentSession.emit()`**, không gọi `this.onEvent` trực tiếp — chốt `this.disposed` nằm trong `emit()`.

---

### Task 1: Fixture NDJSON thật cho đường tool

**Files:**
- Create: `test/fixtures/claude-stream-tool.ndjson`

**Interfaces:**
- Produces: `test/fixtures/claude-stream-tool.ndjson` — transcript NDJSON thật, chứa `stream_event/content_block_start:tool_use`, `input_json_delta`, `assistant` với block `tool_use` có `input` đầy đủ, `user` với `tool_result` dạng **chuỗi**, `system/status:requesting`, và `result`. Task 2–3 phát lại file này.

Fixture sẵn có `test/fixtures/claude-stream.ndjson` giữ nguyên, không sửa: nó là bản chụp thật của một tool **MCP**, nên `tool_result.content` ở đó là **mảng**. Hai fixture cùng tồn tại để phủ cả hai dạng đã đo.

- [ ] **Step 1: Chụp transcript thật**

Chạy trong một thư mục tạm bất kỳ (KHÔNG chạy trong repo — `--setting-sources project` sẽ nạp settings của repo):

```bash
cd "$(mktemp -d)"
printf 'Think carefully first about which command to use, then run the bash command: echo hello-probe. Then tell me exactly what it printed.' \
  | claude -p --output-format stream-json --verbose --include-partial-messages \
      --setting-sources project --allowedTools "Bash" \
      --session-id "$(uuidgen | tr 'A-Z' 'a-z')" > raw.ndjson
wc -l raw.ndjson
```

Lệnh này gọi model thật (đo lần trước: ~6 giây, ~$0.08). Không có cách nào lấy được hình dạng thật mà không gọi thật — đó là lý do fixture tồn tại.

- [ ] **Step 2: Lọc bỏ dòng nhiễu chứa đường dẫn máy**

Dòng `system:init` mang `cwd`, danh sách skill/agent/slash-command của máy đang chạy. Nó không liên quan gì đến thứ đang test và không nên nằm trong repo. Giữ đúng các loại dòng mà `translate()` đọc:

```bash
node -e '
const fs = require("fs");
const keep = fs.readFileSync("raw.ndjson", "utf8").split("\n").filter(Boolean).filter((line) => {
  const e = JSON.parse(line);
  if (e.type === "system") return e.subtype === "status";
  return ["stream_event", "assistant", "user", "result"].includes(e.type);
});
fs.writeFileSync("claude-stream-tool.ndjson", keep.join("\n") + "\n");
console.log("kept", keep.length);
'
```

- [ ] **Step 3: Xác nhận fixture chứa đủ 5 hình dạng cần thiết**

Nếu CLI đã đổi format kể từ lần đo 2026-08-15, bước này phải đỏ — đó là mục đích của nó:

```bash
node -e '
const fs = require("fs");
const L = fs.readFileSync("claude-stream-tool.ndjson", "utf8").split("\n").filter(Boolean).map(JSON.parse);
const has = {
  blockStart: L.some((e) => e.type === "stream_event" && e.event?.type === "content_block_start" && e.event.content_block?.type === "tool_use" && e.event.content_block.id && e.event.content_block.name),
  argsDelta: L.some((e) => e.type === "stream_event" && e.event?.delta?.type === "input_json_delta"),
  toolUse: L.some((e) => e.type === "assistant" && (e.message?.content || []).some((b) => b.type === "tool_use" && b.id && b.input)),
  textDelta: L.some((e) => e.type === "stream_event" && e.event?.delta?.type === "text_delta"),
  stringResult: L.some((e) => e.type === "user" && (e.message?.content || []).some((b) => b.type === "tool_result" && typeof b.content === "string")),
  status: L.some((e) => e.type === "system" && e.subtype === "status" && e.status === "requesting"),
  result: L.some((e) => e.type === "result" && typeof e.duration_ms === "number"),
};
console.log(has);
const missing = Object.entries(has).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) { console.error("MISSING:", missing.join(", ")); process.exit(1); }
console.log("fixture OK");
'
```

Kỳ vọng: in `fixture OK`, exit 0.

- [ ] **Step 4: Chép vào repo và commit**

```bash
cp claude-stream-tool.ndjson /path/to/repo/test/fixtures/claude-stream-tool.ndjson
cd /path/to/repo
git add test/fixtures/claude-stream-tool.ndjson
git commit -m "test: capture a real tool-calling transcript as a fixture

Every shape the timeline depends on, from a real CLI 2.1.197 run:
content_block_start carries tool id+name early, input_json_delta streams the
args, the assistant block carries the full input, tool_result carries
tool_use_id and is_error, and system/status:requesting marks waiting-on-API.

Keeps the existing claude-stream.ndjson untouched: that one is a real MCP tool
call, where tool_result.content is an ARRAY. This one is a built-in tool, where
it is a plain STRING. Both shapes ship, so both get covered.

The system:init line is dropped — it carries the capturing machine's cwd and
its whole skill/agent list, none of which the translation layer reads."
```

---

### Task 2: Hàm thuần cắt và chuẩn hoá dữ liệu tool

**Files:**
- Modify: `server/agent.js` (thêm hằng số + 3 hàm export, ngay trước `export class AgentSession`)
- Test: `test/agent-session.test.mjs` (thêm khối mới ở cuối, trước `rmSync(workdir…)`)

**Interfaces:**
- Produces:
  - `STEP_SUMMARY_MAX = 800`, `STEP_ERROR_SUMMARY_MAX = 2000`, `STEP_INPUT_MAX = 2000`
  - `toolResultText(content: string | array | object | null) => string`
  - `summarizeResult(text: string, ok: boolean) => { summary: string, size: number }`
  - `clipInput(input: object | null) => object` — trả về chính `input` khi JSON ≤ 2000 ký tự, ngược lại `{ __truncated: true, __preview: string }`
- Task 3 gọi cả ba. Task 7 (panel) đọc `__truncated` / `__preview`.

- [ ] **Step 1: Viết test thất bại**

Thêm vào `test/agent-session.test.mjs`, ngay trước dòng `rmSync(workdir, { recursive: true, force: true });`:

```js
// --- 10. cắt và chuẩn hoá dữ liệu tool -------------------------------------
//
// tool_result.content có hai dạng, cả hai đều đo được ngày 2026-08-15 trên CLI
// 2.1.197: chuỗi thuần (tool built-in) và mảng content block (tool MCP — tức là
// mọi tool mà panel thật sự dùng). Bỏ sót dạng mảng thì mọi kết quả tool chrome
// hiện "[object Object]".
{
  check("toolResultText passes a plain string through", toolResultText("hello") === "hello");
  check(
    "toolResultText joins an MCP content array",
    toolResultText([{ type: "text", text: "a" }, { type: "text", text: "b" }]) === "a\nb",
    toolResultText([{ type: "text", text: "a" }, { type: "text", text: "b" }]),
  );
  check("toolResultText survives null", toolResultText(null) === "");
  check("toolResultText survives a block with no text", toolResultText([{ type: "image" }]) === "");

  const long = "x".repeat(5000);
  const okCut = summarizeResult(long, true);
  check("a successful result is cut at 800", okCut.summary.length === STEP_SUMMARY_MAX + 1, String(okCut.summary.length));
  check("the cut is marked with an ellipsis", okCut.summary.endsWith("…"), okCut.summary.slice(-3));
  check("the real size travels even though the text was cut", okCut.size === 5000, String(okCut.size));

  const failCut = summarizeResult(long, false);
  check("a FAILING result gets more room, because that is the text the user must read",
    failCut.summary.length === STEP_ERROR_SUMMARY_MAX + 1, String(failCut.summary.length));

  const short = summarizeResult("ngắn", true);
  check("a short result is not cut and gets no ellipsis", short.summary === "ngắn", short.summary);
  check("size is measured in bytes, not characters", summarizeResult("é", true).size === 2, String(summarizeResult("é", true).size));

  check("clipInput keeps a small input as an object, so the panel can read args.url",
    clipInput({ url: "https://example.com" }).url === "https://example.com",
    JSON.stringify(clipInput({ url: "https://example.com" })));
  const big = clipInput({ code: "y".repeat(4000) });
  check("clipInput degrades a huge input to a preview", big.__truncated === true, JSON.stringify(big).slice(0, 80));
  check("that preview is bounded", big.__preview.length === STEP_INPUT_MAX, String(big.__preview?.length));
  check("clipInput survives null", JSON.stringify(clipInput(null)) === "{}", JSON.stringify(clipInput(null)));
}
```

Sửa dòng import ở đầu file `test/agent-session.test.mjs`:

```js
import {
  AgentSession, buildSpawn, winQuote, claudeBinFromEnv, panelHooksFrom,
  toolResultText, summarizeResult, clipInput,
  STEP_SUMMARY_MAX, STEP_ERROR_SUMMARY_MAX, STEP_INPUT_MAX,
} from "../server/agent.js";
```

- [ ] **Step 2: Chạy để xác nhận đỏ**

Run: `npm run test:agent`
Expected: FAIL — `SyntaxError: The requested module '../server/agent.js' does not provide an export named 'toolResultText'`

- [ ] **Step 3: Cài đặt tối thiểu**

Thêm vào `server/agent.js`, ngay trước `export class AgentSession {`:

```js
// A tool result can be hundreds of KB of page text. The panel puts what it
// receives into the DOM and keeps it in its journal, so the cut happens here,
// before it crosses the socket — not in the browser.
export const STEP_SUMMARY_MAX = 800;
// A failure is the one case the user actually has to read, so it gets more room.
export const STEP_ERROR_SUMMARY_MAX = 2000;
export const STEP_INPUT_MAX = 2000;

// `tool_result.content` has two shapes, both measured on 2026-08-15 against CLI
// 2.1.197: a plain string for built-in tools, and an array of content blocks for
// MCP tools — which is every tool this panel actually uses. Missing the array
// case renders "[object Object]" for every chrome tool.
export function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "string" ? block : block?.text ?? ""))
      .join("\n");
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

export function summarizeResult(text, ok) {
  const max = ok ? STEP_SUMMARY_MAX : STEP_ERROR_SUMMARY_MAX;
  return {
    // The real size travels separately so the panel can say "12.4KB" even
    // though only the first slice of it arrived.
    summary: text.length > max ? `${text.slice(0, max)}…` : text,
    size: Buffer.byteLength(text, "utf8"),
  };
}

// Kept as an object rather than a pre-rendered string: the panel reads
// well-known keys (url, query, ref…) to build the one-line subtitle under a
// step. Only when the whole thing is too big does it degrade to a flat preview.
export function clipInput(input) {
  let json;
  try {
    json = JSON.stringify(input ?? {});
  } catch {
    return { __truncated: true, __preview: "" };
  }
  if (json === undefined) return {};
  if (json.length <= STEP_INPUT_MAX) return input ?? {};
  return { __truncated: true, __preview: json.slice(0, STEP_INPUT_MAX) };
}
```

- [ ] **Step 4: Chạy để xác nhận xanh**

Run: `npm run test:agent`
Expected: PASS toàn bộ khối 10, và mọi khối cũ vẫn PASS.

- [ ] **Step 5: Lint và commit**

```bash
npm run lint
git add server/agent.js test/agent-session.test.mjs
git commit -m "feat(agent): clip and normalize tool payloads before they leave the server

toolResultText handles both measured shapes of tool_result.content — a plain
string from built-in tools and a content array from MCP tools. Every tool the
panel actually calls is MCP, so the array case is the one that matters.

summarizeResult cuts at 800 chars, or 2000 when the tool failed, because a
failure is the text the user has to read. The real byte size travels alongside
the cut text so the panel can still say how big the result was.

clipInput keeps small inputs as objects so the panel can read args.url for a
subtitle, and degrades anything huge to a bounded preview."
```

---

### Task 3: Máy trạng thái bước trong AgentSession

**Files:**
- Modify: `server/agent.js` — constructor, `send()`, `translate()`, thêm 4 method
- Test: `test/agent-session.test.mjs` — sửa khối 1, thêm khối 11 và 12

**Interfaces:**
- Consumes: `toolResultText`, `summarizeResult`, `clipInput` (Task 2)
- Produces — sự kiện `AgentSession` phát ra qua `emit()`:
  - `{ type: "step_start", id: string, name: string }`
  - `{ type: "step_args", id: string, input: object }`
  - `{ type: "step_end", id: string, ok: boolean, ms: number, summary: string, size: number, aborted?: true }`
  - `{ type: "phase", phase: "requesting" | "thinking" | "answering" }`
  - `{ type: "turn_stats", ms: number|null, costUsd: number|null, inputTokens: number|null, outputTokens: number|null }`
  - Tuỳ chọn constructor mới: `protocol: number` (mặc định `1`). Khi `< 2`, vẫn phát `{ type: "tool", name }` như cũ.
- Task 4 truyền `protocol` vào. Task 7 vẽ đúng các sự kiện trên.

- [ ] **Step 1: Sửa khẳng định "no event type outside the contract" ở khối 1**

Khối 1 hiện liệt kê đúng 5 loại và sẽ đỏ ngay khi có loại mới. Trong `test/agent-session.test.mjs`, thay:

```js
  check("no event type outside the contract",
    events.every((e) => ["turn_start", "delta", "message", "tool", "turn_end"].includes(e.type)),
    JSON.stringify([...new Set(events.map((e) => e.type))]));
```

bằng:

```js
  check("no event type outside the contract",
    events.every((e) => [
      "turn_start", "delta", "message", "tool", "turn_end",
      "step_start", "step_args", "step_end", "phase", "turn_stats",
    ].includes(e.type)),
    JSON.stringify([...new Set(events.map((e) => e.type))]));
```

- [ ] **Step 2: Viết test thất bại cho việc ghép cặp bước**

Thêm vào `test/agent-session.test.mjs` trước `rmSync(workdir…)`:

```js
// --- 11. một lượt có gọi tool sinh ra timeline đầy đủ ------------------------
//
// Phát lại bản chụp thật ở test/fixtures/claude-stream-tool.ndjson (Task 1).
// Điều đang test là việc GHÉP CẶP: step_start và step_end phải cùng một id, và
// step_end không bao giờ được đến trước step_start của nó.
{
  const toolFixture = join(root, "test", "fixtures", "claude-stream-tool.ndjson");
  const { session, events } = makeSession({ env: { CC_FAKE_FIXTURE: toolFixture } });
  session.send("chạy thử");
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);

  const starts = events.filter((e) => e.type === "step_start");
  const ends = events.filter((e) => e.type === "step_end");
  check("a tool call opens a step", starts.length >= 1, JSON.stringify(starts));
  check("that step is named", typeof starts[0]?.name === "string" && starts[0].name.length > 0, JSON.stringify(starts[0]));
  check("the step closes", ends.length === starts.length, `${starts.length} starts vs ${ends.length} ends`);
  check("it closes under the SAME id it opened with",
    ends.every((e) => starts.some((s) => s.id === e.id)),
    JSON.stringify({ starts: starts.map((s) => s.id), ends: ends.map((e) => e.id) }));
  check("step_end never precedes its own step_start",
    ends.every((e) => events.indexOf(events.find((x) => x.type === "step_start" && x.id === e.id)) < events.indexOf(e)),
    JSON.stringify(events.map((e) => `${e.type}:${e.id ?? ""}`)));
  check("a successful tool reports ok", ends[0]?.ok === true, JSON.stringify(ends[0]));
  check("and reports how long it took", typeof ends[0]?.ms === "number" && ends[0].ms >= 0, JSON.stringify(ends[0]));
  check("the tool's arguments arrive",
    events.some((e) => e.type === "step_args" && e.id === starts[0].id && e.input && typeof e.input === "object"),
    JSON.stringify(events.filter((e) => e.type === "step_args")));

  check("waiting on the API is reported as a phase",
    events.some((e) => e.type === "phase" && e.phase === "requesting"),
    JSON.stringify(events.filter((e) => e.type === "phase")));
  check("answering is reported as a phase",
    events.some((e) => e.type === "phase" && e.phase === "answering"),
    JSON.stringify(events.filter((e) => e.type === "phase")));
  check("the turn's own numbers arrive at the end",
    events.some((e) => e.type === "turn_stats" && typeof e.ms === "number"),
    JSON.stringify(events.filter((e) => e.type === "turn_stats")));
  session.dispose();
}

// --- 11b. tool MCP: content là MẢNG, không phải chuỗi ------------------------
//
// claude-stream.ndjson là bản chụp một tool MCP thật, tức đúng dạng mà panel
// chạy vào hằng ngày. Nếu toolResultText bỏ sót nhánh mảng thì summary ở đây là
// "[object Object]" — im lặng, không lỗi, và chỉ lộ ra khi người dùng nhìn.
{
  const { session, events } = makeSession();
  session.send("gọi tool mcp");
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);
  const end = events.find((e) => e.type === "step_end");
  check("an MCP tool result closes its step", !!end, JSON.stringify(events.map((e) => e.type)));
  check("its summary is real text, not [object Object]",
    typeof end?.summary === "string" && !end.summary.includes("[object Object]"),
    JSON.stringify(end?.summary?.slice(0, 120)));
  session.dispose();
}

// --- 11c. không có step_end mồ côi ------------------------------------------
//
// Nếu CLI ngừng gửi content_block_start (chạy không có --include-partial-messages,
// hoặc format đổi ở bản sau), tool_result vẫn phải đóng được một bước — server tự
// mở bù. Panel giữ Map<id, element>; một step_end cho id chưa từng thấy sẽ rơi
// vào hư không và người dùng mất hẳn dòng đó.
{
  const { session, events } = makeSession();
  session.send("khởi động");
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);
  const before = events.length;
  session.onStdout(JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_never_announced", content: "xong" }] },
  }) + "\n");
  const added = events.slice(before);
  check("an unannounced tool_result still opens a step first",
    added[0]?.type === "step_start" && added[0].id === "toolu_never_announced",
    JSON.stringify(added));
  check("and then closes it",
    added[1]?.type === "step_end" && added[1].id === "toolu_never_announced",
    JSON.stringify(added));
  session.dispose();
}

// --- 11d. dừng giữa chừng phải đóng mọi bước còn treo -----------------------
//
// Bấm Dừng khi read_page đang chạy: tool_result sẽ không bao giờ đến. Không quét
// dọn thì dòng đó quay ⠹ vĩnh viễn — đúng cái triệu chứng mà cả tính năng này
// sinh ra để xoá.
{
  const { session, events } = makeSession();
  session.send("mở một bước rồi bỏ dở");
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);
  // Mở một bước bằng tay, rồi kết thúc lượt mà không có tool_result cho nó.
  session.onStdout(JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_dangling", name: "mcp__chrome__read_page", input: {} } },
  }) + "\n");
  const before = events.length;
  session.endTurn({ ok: false, error: "đã dừng theo yêu cầu" });
  const added = events.slice(before);
  check("ending a turn closes every step still open",
    added.some((e) => e.type === "step_end" && e.id === "toolu_dangling" && e.aborted === true),
    JSON.stringify(added));
  check("the abort is closed BEFORE turn_end, so the panel never sees a turn end with a step still running",
    added.findIndex((e) => e.type === "step_end") < added.findIndex((e) => e.type === "turn_end"),
    JSON.stringify(added.map((e) => e.type)));
  session.dispose();
}

// --- 12. giao thức: panel cũ vẫn nhận sự kiện `tool` cũ ---------------------
//
// Người dùng nâng bridge nhưng chưa reload extension là đường đi thật. Bỏ hẳn
// `tool` thì panel cũ không hiện gì; phát cả hai cho panel mới thì mỗi tool ra
// hai dòng. Trường `protocol` trong `start` quyết định.
{
  const toolFixture = join(root, "test", "fixtures", "claude-stream-tool.ndjson");
  const { session, events } = makeSession({ env: { CC_FAKE_FIXTURE: toolFixture } });
  session.send("panel cũ");
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);
  check("protocol 1 (the default) still emits the legacy tool event",
    events.some((e) => e.type === "tool"), JSON.stringify(events.map((e) => e.type)));
  session.dispose();

  const events2 = [];
  const modern = new AgentSession({
    sessionId: "77777777-6666-5555-4444-333333333333",
    mcpUrl: "http://127.0.0.1:8787/mcp?panel=test",
    allowedTools: "mcp__chrome",
    cwd: workdir,
    protocol: 2,
    claudeBin: process.execPath,
    claudeArgsPrefix: [fakeClaude],
    env: { CC_FAKE_FIXTURE: toolFixture },
    onEvent: (event) => events2.push(event),
    log: () => {},
  });
  modern.send("panel mới");
  for (let i = 0; i < 100 && !events2.some((e) => e.type === "turn_end"); i++) await sleep(50);
  check("protocol 2 drops the legacy tool event", !events2.some((e) => e.type === "tool"),
    JSON.stringify(events2.map((e) => e.type)));
  check("but still gets the step events", events2.some((e) => e.type === "step_start"),
    JSON.stringify(events2.map((e) => e.type)));
  modern.dispose();
}
```

- [ ] **Step 3: Chạy để xác nhận đỏ**

Run: `npm run test:agent`
Expected: FAIL — khối 11 báo `a tool call opens a step` sai (không có `step_start` nào), và khối 11d ném `session.endTurn is not a function`.

- [ ] **Step 4: Thêm trạng thái vào constructor**

Trong `server/agent.js`, thêm `protocol = 1,` vào danh sách destructure của constructor (đặt ngay sau `resuming = false,`):

```js
    resuming = false,
    // Panel protocol version, replayed by the panel in `start`. 1 = the
    // pre-timeline panel, which only understands `tool`. Anything ≥ 2 gets the
    // step events instead. A bridge is upgraded independently of the extension,
    // so both have to keep working.
    protocol = 1,
```

Gán trong thân constructor, ngay sau `this.systemPrompt = systemPrompt;`:

```js
    this.protocol = protocol;
```

Thêm vào cụm khởi tạo state, ngay sau `this.buffer = "";`:

```js
    // tool_use_id -> { name, t0 }. The only thing that can pair "Claude called
    // read_page" with "read_page came back", because those arrive as two
    // unrelated top-level lines several seconds apart.
    this.steps = new Map();
    // Last phase reported to the panel, so a transition is emitted once rather
    // than on every delta.
    this.phase = null;
```

- [ ] **Step 5: Reset trạng thái ở đầu mỗi lượt**

Trong `send()`, ngay sau `this.buffer = "";`:

```js
    this.steps.clear();
    this.phase = null;
```

- [ ] **Step 6: Thêm 4 method**

Thêm vào `server/agent.js` ngay sau method `emit(event)`:

```js
  setPhase(phase) {
    if (this.phase === phase) return;
    this.phase = phase;
    if (phase) this.emit({ type: "phase", phase });
  }

  startStep(id, name) {
    if (!id || this.steps.has(id)) return;
    this.steps.set(id, { name, t0: performance.now() });
    // A running step outranks any phase in the panel's status bar. Clearing it
    // also matters for the NEXT transition: the CLI sends status:requesting
    // again for the following API round trip, and setPhase only emits on change.
    this.phase = null;
    this.emit({ type: "step_start", id, name });
  }

  endStep(block) {
    const id = block.tool_use_id;
    if (!id) return;
    // Never a step_end the panel has no row for. If content_block_start never
    // arrived — a CLI run without --include-partial-messages, or a future format
    // change — open the step here so every pair is complete. The panel keys its
    // rows by id; an unmatched step_end would vanish with no error.
    if (!this.steps.has(id)) this.startStep(id, block.name || "tool");
    const started = this.steps.get(id);
    this.steps.delete(id);
    const ok = block.is_error !== true;
    const { summary, size } = summarizeResult(toolResultText(block.content), ok);
    this.emit({
      type: "step_end",
      id,
      ok,
      ms: Math.round(performance.now() - started.t0),
      summary,
      size,
    });
  }

  // Every way a turn can end goes through here. A step whose tool_result never
  // arrives — stop button, crashed child, killed process — still closes, so the
  // panel never spins a row forever. That symptom is the whole reason this
  // feature exists; leaving one behind here would recreate it.
  endTurn(payload) {
    for (const [id, step] of this.steps) {
      this.emit({
        type: "step_end",
        id,
        ok: false,
        aborted: true,
        ms: Math.round(performance.now() - step.t0),
        summary: "",
        size: 0,
      });
    }
    this.steps.clear();
    this.phase = null;
    this.emit({ type: "turn_end", ...payload });
  }
```

- [ ] **Step 7: Định tuyến mọi lối kết thúc lượt qua `endTurn`**

Trong `server/agent.js`, thay **cả ba** chỗ phát `turn_end`:

1. Trong `send()`, nhánh binary không tồn tại:
```js
      this.emit({ type: "turn_end", ok: false, error: this.missingClaudeMessage() });
```
→
```js
      this.endTurn({ ok: false, error: this.missingClaudeMessage() });
```

2. Trong `child.on("error", …)`:
```js
      this.emit({ type: "turn_end", ok: false, error: message });
```
→
```js
      this.endTurn({ ok: false, error: message });
```

3. Trong `child.on("close", …)` — cả ba nhánh:
```js
      if (this.stopping) {
        this.endTurn({ ok: false, error: "đã dừng theo yêu cầu" });
      } else if (code === 0) {
        this.endTurn({ ok: true });
      } else {
        const cause = this.lastStderrLine;
        this.endTurn({
          ok: false,
          error: cause ? `claude thoát với mã ${code}: ${cause}` : `claude thoát với mã ${code}`,
        });
      }
```

- [ ] **Step 8: Viết lại `translate()`**

Thay toàn bộ thân method `translate(event)` trong `server/agent.js` bằng:

```js
  translate(event) {
    if (event.type === "stream_event") {
      const inner = event.event;
      // The earliest moment the tool is knowable: id and name arrive here,
      // before the arguments have finished streaming. Measured 2026-08-15.
      if (inner?.type === "content_block_start" && inner.content_block?.type === "tool_use") {
        this.startStep(inner.content_block.id, inner.content_block.name);
        return;
      }
      const delta = inner?.delta;
      if (delta?.type === "text_delta" && delta.text) {
        this.setPhase("answering");
        this.emit({ type: "delta", text: delta.text });
        return;
      }
      if (delta?.type === "thinking_delta") {
        // The `thinking` field is ALWAYS the empty string on CLI 2.1.197 —
        // measured twice, ultrathink included. The only information here is
        // that thinking is happening at all, so that is all that is reported.
        this.setPhase("thinking");
      }
      return;
    }
    if (event.type === "system" && event.subtype === "status" && event.status === "requesting") {
      this.setPhase("requesting");
      return;
    }
    if (event.type === "assistant") {
      for (const block of event.message?.content || []) {
        if (block.type === "text" && block.text) {
          this.emit({ type: "message", text: block.text });
        } else if (block.type === "tool_use" && block.name) {
          // Idempotent: content_block_start has usually opened this step
          // already. When partial messages are off, this is where it opens.
          this.startStep(block.id, block.name);
          this.emit({ type: "step_args", id: block.id, input: clipInput(block.input) });
          // A panel that predates the timeline only understands this one.
          if (this.protocol < 2) this.emit({ type: "tool", name: block.name });
        }
        // A "thinking" block carries no text (see translate's thinking_delta
        // branch); anything newer than this probe is skipped rather than thrown
        // on, since Anthropic's block-type surface is larger than one fixture.
      }
      return;
    }
    if (event.type === "user") {
      // Tool results come back as a `user` message. This is the ONLY line that
      // says a tool finished, and dropping it is why the panel used to go quiet.
      for (const block of event.message?.content || []) {
        if (block.type === "tool_result") this.endStep(block);
      }
      return;
    }
    if (event.type === "result") {
      this.emit({
        type: "turn_stats",
        ms: event.duration_ms ?? null,
        costUsd: event.total_cost_usd ?? null,
        inputTokens: event.usage?.input_tokens ?? null,
        outputTokens: event.usage?.output_tokens ?? null,
      });
      return;
    }
    // "rate_limit_event", the other "system" subtypes (hook noise, init) and
    // any unrecognised top-level type carry nothing the panel renders.
  }
```

- [ ] **Step 9: Chạy để xác nhận xanh**

Run: `npm run test:agent`
Expected: PASS toàn bộ, kể cả mọi khối cũ (1–9).

- [ ] **Step 10: Lint và commit**

```bash
npm run lint
git add server/agent.js test/agent-session.test.mjs
git commit -m "feat(agent): pair tool calls with their results into timeline events

The panel had no way to learn that a tool finished: translate() dropped the
`user` line carrying tool_result, which is the only place tool_use_id appears a
second time. So a tool row appeared and then sat there forever, identical to a
dead process.

AgentSession now keeps Map<tool_use_id, {name, t0}> and emits step_start /
step_args / step_end, plus phase transitions and end-of-turn stats. Four rules
make it safe: a step_end for an unknown id opens its own step first; ending a
turn closes every step still open with aborted:true; results are cut before they
cross the socket; and timing is measured here rather than guessed in the browser.

The legacy `tool` event is still emitted for protocol < 2, so a bridge upgraded
ahead of its extension keeps working."
```

---

### Task 4: Server chuyển tiếp số hiệu giao thức

**Files:**
- Modify: `server/index.js` (chỗ `panel.agent = new AgentSession({…})` trong `handlePanelMessage`, quanh dòng 979)
- Test: `test/panel-protocol.test.mjs`

**Interfaces:**
- Consumes: tuỳ chọn `protocol` của `AgentSession` (Task 3)
- Produces: panel gửi `{type:"start", …, protocol: 2}` thì mọi sự kiện của lượt đó là sự kiện mới, không còn `tool`.

- [ ] **Step 1: Viết test thất bại**

Thêm vào `test/panel-protocol.test.mjs`, ngay trước phần `// --- teardown ---`:

```js
// --- the panel's protocol version decides which event shape it gets ----------
//
// A bridge and an extension are upgraded independently: the installer replaces
// the bridge, but the extension only changes when the user reloads it in
// chrome://extensions. Both directions have to keep working, so the panel says
// which shape it understands and the server obeys.
{
  const modern = new WebSocket(`ws://127.0.0.1:${PORT}/panel`, [`ccchrome.token.${TOKEN}`], { origin: ORIGIN });
  const modernFrames = [];
  modern.on("message", (raw) => modernFrames.push(JSON.parse(raw.toString())));
  await new Promise((res) => modern.on("open", res));
  await sleep(300);
  modern.send(JSON.stringify({ type: "start", sessionId: null, mcpSessionId: null, model: null, protocol: 2 }));
  await sleep(500);
  modern.send(JSON.stringify({ type: "prompt", text: "xin chào" }));
  for (let i = 0; i < 100 && !modernFrames.some((f) => f.type === "turn_end"); i++) await sleep(50);

  check("a protocol-2 panel gets step events",
    modernFrames.some((f) => f.type === "step_start"),
    JSON.stringify(modernFrames.map((f) => f.type)));
  check("a protocol-2 panel gets no legacy tool event",
    !modernFrames.some((f) => f.type === "tool"),
    JSON.stringify(modernFrames.map((f) => f.type)));
  check("its step closes under the same id",
    modernFrames.some((f) => f.type === "step_end" &&
      modernFrames.some((s) => s.type === "step_start" && s.id === f.id)),
    JSON.stringify(modernFrames.filter((f) => f.type.startsWith("step"))));
  modern.close();
  await sleep(200);
}
```

`test/fake-claude-mcp.mjs` hiện chỉ phát `assistant` (không có `content_block_start`), nên đường "step_end mồ côi tự mở bù" của Task 3 chính là thứ làm test này xanh — đó là chủ ý, nó chứng minh đường lui hoạt động qua cả stack thật.

Nhưng fake hiện KHÔNG phát `user`/`tool_result`, nên `step_end` sẽ không bao giờ đến. Sửa `test/fake-claude-mcp.mjs`, thay khối `emit` cuối bằng:

```js
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const toolUseId = "toolu_fake_0001";
emit({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: toolUseId, name: `mcp__chrome__${toolName}`, input: {} }] },
});
// The tool result: the line that tells the panel the tool finished. Shaped like
// a real MCP result — content is an ARRAY, not a string.
emit({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text: "ok" }], is_error: false }] },
});
emit({ type: "assistant", message: { content: [{ type: "text", text: "xong" }] } });
process.exit(0);
```

- [ ] **Step 2: Chạy để xác nhận đỏ**

Run: `npm run test:panelproto`
Expected: FAIL — `a protocol-2 panel gets step events` sai, và `a protocol-2 panel gets no legacy tool event` sai (server bỏ qua trường `protocol`, nên vẫn phát `tool`).

- [ ] **Step 3: Cài đặt tối thiểu**

Trong `server/index.js`, trong `handlePanelMessage`, thêm một dòng vào object truyền cho `new AgentSession({…})` — đặt ngay sau `systemPrompt: PANEL_SYSTEM_PROMPT,`:

```js
        // Which event shape this panel understands. Absent = 1 = an extension
        // that predates the activity timeline and only renders `tool`.
        protocol: Number(msg.protocol) || 1,
```

- [ ] **Step 4: Chạy để xác nhận xanh**

Run: `npm run test:panelproto`
Expected: PASS toàn bộ file, kể cả mọi khẳng định cũ về mcp session id.

- [ ] **Step 5: Lint và commit**

```bash
npm run lint
git add server/index.js test/panel-protocol.test.mjs test/fake-claude-mcp.mjs
git commit -m "feat(panel): let the panel declare which event shape it understands

The bridge is upgraded by the installer; the extension only changes when the
user reloads it. Dropping the legacy `tool` event outright would leave an
un-reloaded panel rendering nothing at all, and emitting both shapes would give
an upgraded panel two rows per tool call. The panel now says protocol: 2 in
start and the server sends one shape or the other.

fake-claude-mcp now emits the tool_result line too, in the array-content shape a
real MCP tool returns — without it no step could ever close in this suite."
```

---

### Task 5: Bảng chữ nghĩa và nhận diện ngôn ngữ

**Files:**
- Create: `extension/panel-labels.js`
- Create: `test/panel-labels.test.mjs`
- Modify: `package.json` (thêm `test:labels`, ghép vào `test`)

**Interfaces:**
- Produces global `window.ccLabels` với:
  - `stepLabel(name: string, locale: "vi"|"en") => string`
  - `stepSubtitle(input: object) => string`
  - `phaseLabel(phase: string, locale) => string`
  - `resultHeading(step: {ok, size, aborted}, locale) => string`
  - `formatInput(input: object, locale) => string`
  - `formatSize(bytes: number) => string`
  - `detectLocale(text: string, previous: "vi"|"en") => "vi"|"en"`
- Task 7 gọi tất cả.

- [ ] **Step 1: Viết test thất bại**

Create `test/panel-labels.test.mjs`:

```js
// Usage: node test/panel-labels.test.mjs
//
// extension/panel-labels.js is a classic browser script, not a module: it
// assigns one global (window.ccLabels) and has no imports. So it is testable
// from Node by evaluating it against a stand-in `window` — no browser, no
// Playwright, and therefore fast enough to sit in `npm test`.
//
// Locale detection is the reason this file exists. It is a heuristic, and a
// heuristic without a table of cases is just a guess that nobody can check.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

const sandbox = { window: {} };
sandbox.globalThis = sandbox;
runInNewContext(readFileSync(join(root, "extension", "panel-labels.js"), "utf8"), sandbox);
const ccLabels = sandbox.window.ccLabels;

check("the file exposes exactly one global", !!ccLabels, JSON.stringify(Object.keys(sandbox.window)));

// --- tool labels -------------------------------------------------------------

check("a known tool gets a Vietnamese label", ccLabels.stepLabel("read_page", "vi") === "Đọc trang", ccLabels.stepLabel("read_page", "vi"));
check("and an English one", ccLabels.stepLabel("read_page", "en") === "Read page", ccLabels.stepLabel("read_page", "en"));
check("the mcp__chrome__ prefix is stripped", ccLabels.stepLabel("mcp__chrome__new_tab", "vi") === "Mở tab", ccLabels.stepLabel("mcp__chrome__new_tab", "vi"));
check("an unknown tool falls back to its own name rather than a blank row",
  ccLabels.stepLabel("mcp__chrome__some_future_tool", "vi") === "some_future_tool",
  ccLabels.stepLabel("mcp__chrome__some_future_tool", "vi"));
check("a missing name never renders undefined",
  typeof ccLabels.stepLabel(undefined, "vi") === "string" && !ccLabels.stepLabel(undefined, "vi").includes("undefined"),
  ccLabels.stepLabel(undefined, "vi"));

// --- subtitles ---------------------------------------------------------------

check("a url is the subtitle when there is one", ccLabels.stepSubtitle({ url: "https://example.com" }) === "https://example.com", ccLabels.stepSubtitle({ url: "https://example.com" }));
check("a query wins when there is no url", ccLabels.stepSubtitle({ query: "đăng nhập", maxResults: 5 }) === "đăng nhập", ccLabels.stepSubtitle({ query: "đăng nhập" }));
check("a ref is shown when that is all there is", ccLabels.stepSubtitle({ ref: 12 }) === "12", ccLabels.stepSubtitle({ ref: 12 }));
check("no interesting key means no subtitle", ccLabels.stepSubtitle({ maxElements: 150 }) === "", ccLabels.stepSubtitle({ maxElements: 150 }));
check("an empty input is safe", ccLabels.stepSubtitle(undefined) === "", ccLabels.stepSubtitle(undefined));
check("a long subtitle is cut", ccLabels.stepSubtitle({ text: "z".repeat(200) }).length <= 61, String(ccLabels.stepSubtitle({ text: "z".repeat(200) }).length));

// --- sizes -------------------------------------------------------------------

check("bytes under 1KB are shown as bytes", ccLabels.formatSize(512) === "512B", ccLabels.formatSize(512));
check("a big result is shown in KB", ccLabels.formatSize(12700) === "12.4KB", ccLabels.formatSize(12700));

// --- locale detection --------------------------------------------------------
//
// The trap this table exists for: Vietnamese is very often typed without
// diacritics. Detecting on diacritics alone would read "mo tab github roi tim
// repo" as English and flip the whole status bar mid-conversation.

check("diacritics settle it immediately", ccLabels.detectLocale("mở tab github", "en") === "vi");
check("Vietnamese typed WITHOUT diacritics is still Vietnamese",
  ccLabels.detectLocale("mo tab github roi tim repo", "en") === "vi",
  ccLabels.detectLocale("mo tab github roi tim repo", "en"));
check("plain English is English", ccLabels.detectLocale("open the console and check for errors", "vi") === "en",
  ccLabels.detectLocale("open the console and check for errors", "vi"));
check("an ambiguous prompt keeps the previous language", ccLabels.detectLocale("github.com", "en") === "en");
check("and keeps it the other way too", ccLabels.detectLocale("github.com", "vi") === "vi");
check("an empty prompt keeps the previous language", ccLabels.detectLocale("", "en") === "en");
check("a non-string never throws", ccLabels.detectLocale(null, "vi") === "vi");

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Chạy để xác nhận đỏ**

Run: `node test/panel-labels.test.mjs`
Expected: FAIL — `ENOENT … extension/panel-labels.js`

- [ ] **Step 3: Cài đặt tối thiểu**

Create `extension/panel-labels.js`:

```js
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
```

- [ ] **Step 4: Chạy để xác nhận xanh**

Run: `node test/panel-labels.test.mjs`
Expected: `ALL TESTS PASSED`

- [ ] **Step 5: Ghép vào `npm test`**

Trong `package.json`, thêm script:

```json
    "test:labels": "node test/panel-labels.test.mjs",
```

và chèn `node test/panel-labels.test.mjs && ` vào đầu chuỗi `"test"` (ngay trước `node test/agent-session.test.mjs`).

- [ ] **Step 6: Lint và commit**

```bash
npm run lint
npm run test:labels
git add extension/panel-labels.js test/panel-labels.test.mjs package.json
git commit -m "feat(panel): tool labels, phases and locale detection

The wording lives in the extension, not the server: the server owns pairing,
timing and truncation, this owns what the user reads. A new browser tool is one
row here and nothing on the server.

Locale follows the prompt, and detection scores un-accented Vietnamese words as
well as diacritics — 'mo tab github roi tim repo' is ASCII, and a
diacritics-only test would read it as English and flip the status bar
mid-conversation. Ambiguous input keeps the previous language rather than
guessing.

Exposed as one window global from an IIFE: extension/ has no build step, and
eslint in script mode reports a top-level function used only from another file
as unused."
```

---

### Task 6: Nhật ký có trần dung lượng

**Files:**
- Create: `extension/panel-journal.js`
- Create: `test/panel-journal.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces global `window.ccJournal`:
  - `load(key: string) => Promise<Array>` — nạp từ `chrome.storage.local`, nhớ `key` cho mọi lần ghi sau
  - `push(entry: object) => void` — thêm, cắt theo trần, hẹn giờ ghi
  - `clear() => void`
  - `entries() => Array`
  - Hằng số `MAX_ENTRIES = 400`, `MAX_BYTES = 512 * 1024`
- Task 7 gọi cả bốn.

- [ ] **Step 1: Viết test thất bại**

Create `test/panel-journal.test.mjs`:

```js
// Usage: node test/panel-journal.test.mjs
//
// Same trick as test/panel-labels.test.mjs: extension/panel-journal.js is a
// classic browser script, so it runs in a Node vm against a stand-in `window`
// and a stand-in `chrome.storage.local`. What is under test is the cap — an
// unbounded journal would grow until chrome.storage.local throws QUOTA_BYTES,
// and it would do it silently, in the background, days into a session.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = {};
const sandbox = {
  window: {},
  setTimeout,
  clearTimeout,
  chrome: {
    storage: {
      local: {
        get: async (defaults) => {
          const out = {};
          for (const key of Object.keys(defaults)) out[key] = key in store ? store[key] : defaults[key];
          return out;
        },
        set: async (obj) => { Object.assign(store, obj); },
      },
    },
  },
};
sandbox.globalThis = sandbox;
runInNewContext(readFileSync(join(root, "extension", "panel-journal.js"), "utf8"), sandbox);
const ccJournal = sandbox.window.ccJournal;

check("the file exposes exactly one global", !!ccJournal, JSON.stringify(Object.keys(sandbox.window)));

// --- load / push / persist ---------------------------------------------------

store["panelLog.7"] = [{ type: "user", text: "câu cũ" }];
const loaded = await ccJournal.load("panelLog.7");
check("load returns what was stored", loaded.length === 1 && loaded[0].text === "câu cũ", JSON.stringify(loaded));

ccJournal.push({ type: "message", text: "câu mới" });
check("push appends in memory immediately", ccJournal.entries().length === 2, String(ccJournal.entries().length));
check("writing is debounced, not synchronous", store["panelLog.7"].length === 1, String(store["panelLog.7"].length));
await sleep(700);
check("and lands after the debounce", store["panelLog.7"].length === 2, String(store["panelLog.7"].length));

// --- the cap -----------------------------------------------------------------

await ccJournal.load("panelLog.cap");
for (let i = 0; i < ccJournal.MAX_ENTRIES + 50; i++) ccJournal.push({ type: "message", text: `n${i}` });
check("the entry cap holds", ccJournal.entries().length === ccJournal.MAX_ENTRIES, String(ccJournal.entries().length));
check("the OLDEST entries are the ones dropped", ccJournal.entries()[0].text === "n50", ccJournal.entries()[0].text);

await ccJournal.load("panelLog.bytes");
const fat = { type: "step_end", summary: "z".repeat(50 * 1024) };
for (let i = 0; i < 40; i++) ccJournal.push({ ...fat });
const bytes = JSON.stringify(ccJournal.entries()).length;
check("the byte cap holds even when the entry count would not", bytes <= ccJournal.MAX_BYTES, String(bytes));
check("but it never empties the journal completely", ccJournal.entries().length >= 1, String(ccJournal.entries().length));

// A single entry larger than the whole budget must not spin the trim loop into
// an empty journal — the newest entry always survives.
await ccJournal.load("panelLog.huge");
ccJournal.push({ type: "message", text: "y".repeat(ccJournal.MAX_BYTES * 2) });
check("one oversized entry still leaves exactly itself", ccJournal.entries().length === 1, String(ccJournal.entries().length));

// --- clear -------------------------------------------------------------------

await ccJournal.load("panelLog.7");
ccJournal.clear();
check("clear empties memory", ccJournal.entries().length === 0, String(ccJournal.entries().length));
await sleep(50);
check("and storage", (store["panelLog.7"] || []).length === 0, JSON.stringify(store["panelLog.7"]));

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Chạy để xác nhận đỏ**

Run: `node test/panel-journal.test.mjs`
Expected: FAIL — `ENOENT … extension/panel-journal.js`

- [ ] **Step 3: Cài đặt tối thiểu**

Create `extension/panel-journal.js`:

```js
// What the panel has already drawn, kept so reopening the panel does not show a
// blank log for a conversation the server is perfectly happy to --resume.
//
// Stored in the extension rather than rebuilt from the CLI's own transcript
// files: this survives a bridge restart, it is exactly what the user saw, and
// it does not depend on an internal file format that has already changed once
// (tool_result.content is a string in one CLI path and an array in another).
//
// Keyed per window by the caller, the same way panelSession.<windowId> is: two
// panels in two Chrome windows are two conversations.
window.ccJournal = (() => {
  // Two caps, because either one alone is escapable: 400 tiny entries is
  // nothing, and one step_end carrying a summary is not.
  const MAX_ENTRIES = 400;
  const MAX_BYTES = 512 * 1024;
  const SAVE_DEBOUNCE_MS = 500;

  let key = null;
  let entries = [];
  // Size of each entry, kept alongside rather than recomputed: trimming would
  // otherwise re-stringify the whole journal on every single push.
  let sizes = [];
  let bytes = 0;
  let saveTimer = null;

  function trim() {
    while (entries.length > 1 && (entries.length > MAX_ENTRIES || bytes > MAX_BYTES)) {
      bytes -= sizes.shift();
      entries.shift();
    }
  }

  function schedule() {
    if (saveTimer || !key) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (key) chrome.storage.local.set({ [key]: entries });
    }, SAVE_DEBOUNCE_MS);
  }

  async function load(storageKey) {
    key = storageKey;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const got = await chrome.storage.local.get({ [key]: [] });
    entries = Array.isArray(got[key]) ? got[key] : [];
    sizes = entries.map((entry) => JSON.stringify(entry).length);
    bytes = sizes.reduce((sum, n) => sum + n, 0);
    return entries;
  }

  function push(entry) {
    let size;
    try {
      size = JSON.stringify(entry).length;
    } catch {
      return; // not storable, so not worth keeping
    }
    entries.push(entry);
    sizes.push(size);
    bytes += size;
    trim();
    schedule();
  }

  function clear() {
    entries = [];
    sizes = [];
    bytes = 0;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (key) chrome.storage.local.set({ [key]: [] });
  }

  return { load, push, clear, entries: () => entries, MAX_ENTRIES, MAX_BYTES };
})();
```

- [ ] **Step 4: Chạy để xác nhận xanh**

Run: `node test/panel-journal.test.mjs`
Expected: `ALL TESTS PASSED`

- [ ] **Step 5: Ghép vào `npm test` rồi commit**

Trong `package.json` thêm `"test:journal": "node test/panel-journal.test.mjs",` và chèn `node test/panel-journal.test.mjs && ` vào đầu chuỗi `"test"`.

```bash
npm run lint
npm run test:journal
git add extension/panel-journal.js test/panel-journal.test.mjs package.json
git commit -m "feat(panel): a capped journal of what the panel already drew

Reopening the panel showed a blank log for a conversation the server resumes
happily, so the user could not see what they had already been told. The journal
is stored in the extension rather than rebuilt from the CLI transcript: it
survives a bridge restart, it is exactly what was on screen, and it does not
depend on a CLI-internal format that has already changed shape once.

Two caps, because either alone is escapable — 400 entries is nothing when they
are tiny, and one step_end summary is not. Entry sizes are tracked incrementally
so trimming does not re-stringify the whole journal on every push."
```

---

### Task 7: Timeline, dải trạng thái và nhật ký trong panel

**Files:**
- Modify: `extension/sidepanel.html` (thẻ `<script>`, CSS, phần tử `#status`)
- Modify: `extension/sidepanel.js`

**Interfaces:**
- Consumes: `window.ccLabels` (Task 5), `window.ccJournal` (Task 6), các sự kiện của Task 3
- Produces: `handle(msg)` vẫn là global (Task 8 và `test/verify-sidepanel.mjs` gọi thẳng), thêm global `render(msg, replay)`

- [ ] **Step 1: Nạp hai file mới và thêm khung trạng thái**

Trong `extension/sidepanel.html`, thay dòng script cuối:

```html
  <script src="sidepanel.js"></script>
```

bằng:

```html
  <script src="panel-labels.js"></script>
  <script src="panel-journal.js"></script>
  <script src="sidepanel.js"></script>
```

Thứ tự bắt buộc: `sidepanel.js` chạy ngay khi nạp và đọc hai global kia.

Thêm phần tử trạng thái vào `<footer>`, ngay trước `<div class="toolbar">`:

```html
    <div id="status"><span id="statusText"></span><span id="statusTime"></span></div>
```

- [ ] **Step 2: Thêm CSS**

Thêm vào khối `<style>` trong `extension/sidepanel.html`, sau dòng `.tool { … }`:

```css
    .step { font-size: 11px; border-left: 2px solid #3a3a3a; padding-left: 8px; }
    .step-head { display: flex; gap: 6px; align-items: baseline; cursor: pointer; }
    .step-icon { width: 1em; flex: none; text-align: center; }
    .step-label { font-weight: 600; flex: none; }
    .step-sub { color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .step-time { margin-left: auto; color: #777; flex: none; }
    .step.running { color: #d97757; }
    .step.running .step-icon { animation: ccpulse 1s ease-in-out infinite; }
    .step.ok .step-icon { color: #188038; }
    .step.fail { color: #f28b82; }
    .step-detail {
      margin: 4px 0 0; padding: 6px; background: #222; border-radius: 4px; color: #bbb;
      white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow: auto;
      font-family: ui-monospace, monospace; font-size: 11px;
    }
    .stats { font-size: 11px; color: #666; }
    @keyframes ccpulse { 50% { opacity: .25; } }
    #status { display: none; gap: 6px; font-size: 11px; color: #d97757; padding: 0 2px 6px; }
    #status.on { display: flex; }
    #statusTime { margin-left: auto; color: #777; }
```

- [ ] **Step 3: Thêm trạng thái và tham chiếu DOM vào `sidepanel.js`**

Trong `extension/sidepanel.js`, thêm sau `const newBtn = document.getElementById("newSession");`:

```js
const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("statusText");
const statusTimeEl = document.getElementById("statusTime");
```

Thêm sau `let lastStateDetail = null;`:

```js
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
```

- [ ] **Step 4: Thêm các hàm vẽ**

Thêm vào `extension/sidepanel.js` ngay sau hàm `addMessage`:

```js
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
  logEl.scrollTop = logEl.scrollHeight;
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
```

- [ ] **Step 5: Tách `render()` ra khỏi `handle()`**

Thêm vào `extension/sidepanel.js` ngay trước hàm `handle`:

```js
// Everything that puts something on screen. Separate from handle() because the
// journal replays these same objects on open, and a replay must not re-send
// `start`, reset busy, or reschedule anything.
function render(msg) {
  switch (msg.type) {
    case "user":
      addMessage("user", msg.text);
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
```

Trong `addMessage`, cho phép lớp `stats`:

```js
function addMessage(kind, text) {
  const el = document.createElement("div");
  el.className = kind === "tool" ? "tool" : kind === "stats" ? "stats" : `msg ${kind}`;
  el.textContent = text;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
  return el;
}
```

- [ ] **Step 6: Nối `handle()` vào `render`/`record`**

Thay toàn bộ hàm `handle(msg)` trong `extension/sidepanel.js` bằng:

```js
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
      streaming = null;
      break;
    case "turn_start":
      setBusy(true);
      streaming = null;
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
      // both would double the log on reopen.
      render(msg);
      break;
    case "message":
      record(msg);
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
      // arrived to confirm. Keep it, or reopening the panel loses it.
      if (streaming && streaming.textContent) ccJournal.push({ type: "message", text: streaming.textContent });
      setBusy(false);
      streaming = null;
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
```

- [ ] **Step 7: Nạp lại nhật ký khi mở panel**

Thêm vào `extension/sidepanel.js` ngay sau hàm `panelSessionKey()`:

```js
async function panelJournalKey() {
  const key = await panelSessionKey();
  return key.replace("panelSession.", "panelLog.");
}

// Replayed before the socket is dialled, so the log is never briefly blank and
// a live event can never interleave into the middle of the replay.
async function restore() {
  const entries = await ccJournal.load(await panelJournalKey());
  for (const entry of entries) render(entry);
  // A step still open in the journal belonged to a process that is certainly
  // dead — the panel was closed. Close it now rather than leaving a row that
  // pulses forever.
  for (const id of [...steps.keys()]) {
    finishStep({ id, ok: false, aborted: true, ms: null });
  }
  streaming = null;
}
```

Thay dòng cuối file `connect();` bằng:

```js
(async () => {
  await restore();
  connect();
})();
```

- [ ] **Step 8: Xoá nhật ký khi bắt đầu phiên mới, và đổi ngôn ngữ theo prompt**

Trong handler của `inputEl` keydown, thay:

```js
  addMessage("user", text);
  inputEl.value = "";
  send({ type: "prompt", text });
```

bằng:

```js
  locale = ccLabels.detectLocale(text, locale);
  record({ type: "user", text });
  inputEl.value = "";
  send({ type: "prompt", text });
```

Trong handler của `newBtn`, thêm `ccJournal.clear();` ngay trước `logEl.textContent = "";`, và thêm `protocol: PROTOCOL` vào frame `start`:

```js
  ccJournal.clear();
  steps = new Map();
  logEl.textContent = "";
  send({ type: "start", sessionId: null, mcpSessionId, model: modelEl.value || null, protocol: PROTOCOL });
```

Trong handler của `modelEl` change, thêm `protocol: PROTOCOL` vào frame `start`:

```js
  send({ type: "start", sessionId, mcpSessionId, model: modelEl.value || null, protocol: PROTOCOL });
```

Trong `socket.onclose`, thêm dọn dẹp trạng thái timeline sau `streaming = null;`:

```js
    stopTicking();
    statusEl.classList.remove("on");
```

- [ ] **Step 9: Lint**

Run: `npm run lint`
Expected: 0 lỗi. Nếu eslint báo `ccLabels`/`ccJournal` is not defined, KHÔNG thêm `/* global */` — sửa bằng cách thêm hai global vào `eslint.config.mjs` trong khối `files: ["extension/**/*.js"]`:

```js
        chrome: "readonly",
        ccLabels: "readonly",
        ccJournal: "readonly",
```

- [ ] **Step 10: Chạy toàn bộ suite tự động**

Run: `npm test`
Expected: mọi suite xanh. Không suite nào trong `npm test` nạp `sidepanel.js` trong trình duyệt, nên bước này chỉ chứng minh không hồi quy — phần DOM do Task 8 phủ.

- [ ] **Step 11: Commit**

```bash
git add extension/sidepanel.html extension/sidepanel.js eslint.config.mjs
git commit -m "feat(panel): draw the activity timeline and a live status bar

Every step gets a row that opens the moment Claude decides to call the tool,
fills in its arguments, and closes with a tick or a cross and how long it took.
Clicking it shows the arguments and the (server-truncated) result. Under the
input, one line says what is happening right now — sending, thinking, the tool
by name, answering — with a second counter that keeps moving, which is the
signal that was missing entirely.

render() is split out of handle() because the journal replays these same objects
when the panel reopens, and a replay must not re-send start or touch busy.
Deltas are drawn but not journalled: `message` restates the same text
authoritatively, and keeping both would double the log on reopen.

step_start deliberately leaves `streaming` alone, for the same reason the old
`tool` case did: blocks can arrive as [tool_use, text], and orphaning the
element the deltas built rendered the reply twice."
```

---

### Task 8: Kiểm chứng DOM trong verify-sidepanel

**Files:**
- Modify: `test/verify-sidepanel.mjs`

**Interfaces:**
- Consumes: `handle()` global của Task 7

Chạy tay, không nằm trong `npm test` (file này spawn `claude` thật). Các mục thêm dưới đây gọi thẳng `handle()` nên không tốn token.

- [ ] **Step 1: Thêm các mục kiểm chứng timeline**

Thêm vào `test/verify-sidepanel.mjs`, ngay sau mục F6, trước phần `// --- small fixes: never render the literal string "undefined" ---`:

```js
  // --- T1: một bước chạy rồi xong ------------------------------------------
  // Đây là toàn bộ lý do tính năng tồn tại: một dòng phải chuyển từ "đang chạy"
  // sang "xong", nhìn thấy được, không cần đọc log server.
  /* eslint-disable no-undef */
  await f6Page.evaluate(() => {
    handle({ type: "turn_start" });
    handle({ type: "phase", phase: "requesting" });
    handle({ type: "step_start", id: "t1", name: "mcp__chrome__read_page" });
    handle({ type: "step_args", id: "t1", input: { url: "https://example.com" } });
  });
  /* eslint-enable no-undef */
  const t1Running = await f6Page.$$eval(".step.running .step-label", (els) => els.map((e) => e.textContent));
  check("T1: a started step renders a running row with a Vietnamese label",
    t1Running.includes("Đọc trang"), JSON.stringify(t1Running));
  const t1Sub = await f6Page.$eval(".step .step-sub", (el) => el.textContent);
  check("T1: its arguments become the subtitle", t1Sub === "https://example.com", t1Sub);
  const t1Status = await f6Page.$eval("#statusText", (el) => el.textContent);
  check("T1: the status bar names the running tool, not the phase", t1Status === "Đọc trang", t1Status);

  /* eslint-disable no-undef */
  await f6Page.evaluate(() => {
    handle({ type: "step_end", id: "t1", ok: true, ms: 1234, summary: "URL: https://example.com", size: 12700 });
  });
  /* eslint-enable no-undef */
  const t1Done = await f6Page.$eval(".step", (el) => ({ cls: el.className, icon: el.querySelector(".step-icon").textContent, time: el.querySelector(".step-time").textContent }));
  check("T1: the step ends as ok, with a tick and its duration",
    t1Done.cls.includes("ok") && !t1Done.cls.includes("running") && t1Done.icon === "✓" && t1Done.time === "1.2s",
    JSON.stringify(t1Done));

  // --- T2: một lượt bị bỏ dở không để lại dòng quay mãi ---------------------
  /* eslint-disable no-undef */
  await f6Page.evaluate(() => {
    handle({ type: "step_start", id: "t2", name: "mcp__chrome__get_page_text" });
    handle({ type: "step_end", id: "t2", ok: false, aborted: true, ms: 800, summary: "", size: 0 });
    handle({ type: "turn_end", ok: false, error: "đã dừng theo yêu cầu" });
  });
  /* eslint-enable no-undef */
  const stillRunning = await f6Page.$$eval(".step.running", (els) => els.length);
  check("T2: no row is left spinning after the turn ends", stillRunning === 0, String(stillRunning));
  const statusHidden = await f6Page.$eval("#status", (el) => el.className);
  check("T2: the status bar switches itself off", !statusHidden.includes("on"), statusHidden);

  // --- T3: kết quả tool không bao giờ được diễn giải thành HTML -------------
  // `summary` là văn bản do trang web sinh ra. Đây là chỗ duy nhất trong panel
  // mà nội dung của một trang lạ đi thẳng vào DOM.
  /* eslint-disable no-undef */
  await f6Page.evaluate(() => {
    handle({ type: "step_start", id: "t3", name: "mcp__chrome__get_page_text" });
    handle({ type: "step_end", id: "t3", ok: true, ms: 10, summary: "<img src=x onerror=\"window.__ccXss = 1\">", size: 40 });
  });
  /* eslint-enable no-undef */
  const xss = await f6Page.evaluate(() => window.__ccXss);
  check("T3: a tool result containing markup is inserted as text, not parsed", xss === undefined, String(xss));

  // --- T4 + T5: ngôn ngữ bám theo prompt, và nhật ký vẽ lại được ------------
  //
  // Hai mục này chạy trên một panel CỐ Ý không kết nối được: wsUrl bị trỏ vào
  // một cổng không có ai nghe. Lý do là để Enter thật sự chạy qua handler thật
  // (nơi đặt locale và ghi nhật ký) mà `send()` không gửi được gì đi — nếu socket
  // mở, dòng đó sẽ khởi động một lượt `claude` thật, tốn usage và bắn sự kiện
  // vào giữa các khẳng định dưới đây. Nhật ký không phụ thuộc socket, nên phần
  // đang test vẫn chạy đầy đủ.
  await sw.evaluate(async () => {
    await chrome.storage.local.set({ wsUrl: "ws://127.0.0.1:1/ws?token=offline-on-purpose" });
  });

  const t4Page = await context.newPage();
  await t4Page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await t4Page.waitForSelector("#input");
  await t4Page.fill("#input", "open the console and check for errors");
  await t4Page.press("#input", "Enter");
  /* eslint-disable no-undef */
  await t4Page.evaluate(() => {
    handle({ type: "turn_start" });
    handle({ type: "step_start", id: "t4", name: "mcp__chrome__read_console_messages" });
  });
  /* eslint-enable no-undef */
  const t4En = await t4Page.$eval("#statusText", (el) => el.textContent);
  check("T4: an English prompt switches the activity wording to English", t4En === "Read console", t4En);
  const t4Buttons = await t4Page.$eval("#newSession", (el) => el.textContent);
  check("T4: but the buttons stay Vietnamese, per the repo convention", t4Buttons === "Phiên mới", t4Buttons);

  // Nhật ký ghi có debounce 500ms (SAVE_DEBOUNCE_MS trong panel-journal.js).
  // Mở trang mới trước khi nó kịp ghi thì T5 đỏ vì lý do không liên quan.
  await t4Page.waitForTimeout(900);

  // Chỉ chứng minh được bằng một trang MỚI trên CÙNG cửa sổ: cùng windowId, nên
  // cùng khoá panelLog.<windowId>.
  const t5Page = await context.newPage();
  await t5Page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await t5Page.waitForSelector("#input");
  const t5Text = await t5Page.textContent("#log");
  check("T5: reopening the panel replays what was already drawn",
    t5Text.includes("open the console and check for errors"), t5Text.slice(0, 200));
  const t5Interrupted = await t5Page.$$eval(".step", (els) => els.map((e) => e.querySelector(".step-icon").textContent));
  check("T5: a step left open when the panel closed comes back marked interrupted, not running",
    t5Interrupted.includes("⦸"), JSON.stringify(t5Interrupted));
  const t5Running = await t5Page.$$eval(".step.running", (els) => els.length);
  check("T5: and nothing is left pulsing after a replay", t5Running === 0, String(t5Running));

  // Trả lại URL thật cho mọi trang mở sau, và dọn nhật ký test khỏi
  // chrome.storage.local của hồ sơ Chromium tạm này.
  await sw.evaluate(async (wsUrl) => {
    await chrome.storage.local.set({ wsUrl });
    const all = await chrome.storage.local.get(null);
    const logKeys = Object.keys(all).filter((k) => k.startsWith("panelLog."));
    if (logKeys.length) await chrome.storage.local.remove(logKeys);
  }, `ws://127.0.0.1:${MCP_PORT}/ws?token=${TOKEN}`);
```

- [ ] **Step 2: Chạy**

Run: `npm run verify:sidepanel`
Expected: mọi mục T1–T5 PASS, và mọi mục F1–F6 cũ vẫn PASS. Lệnh này mở Chromium thật và gọi `claude` thật cho các mục chat trực tiếp — tốn usage thật, chạy có người ngồi xem.

- [ ] **Step 3: Commit**

```bash
npm run lint
git add test/verify-sidepanel.mjs
git commit -m "test(panel): cover the timeline in the manual side-panel verifier

Five sections driving handle() directly, so they cost no tokens and do not
depend on what a live model happens to do: a step going from running to done
with its duration, a turn that ends without leaving a row spinning, a tool
result containing markup landing as text rather than being parsed, the activity
wording following an English prompt while the buttons stay Vietnamese, and the
journal replaying into a freshly opened panel with any unfinished step marked
interrupted."
```

---

### Task 9: Phiên bản, tài liệu, chạy toàn bộ

**Files:**
- Modify: `extension/manifest.json`, `server/index.js`, `server/package.json`, `server/package-lock.json`
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: mọi task trước

- [ ] **Step 1: Bump ba file version lên 1.1.0**

`extension/manifest.json`: `"version": "1.1.0"`
`server/index.js`: `const VERSION = "1.1.0";`
`server/package.json`: `"version": "1.1.0"`

Rồi:

```bash
cd server && npm install --package-lock-only && cd ..
```

- [ ] **Step 2: Chạy test build để xác nhận ba file khớp**

Run: `npm run test:build`
Expected: PASS, kể cả khẳng định ba file cùng version.

- [ ] **Step 3: Ghi tài liệu**

Thêm vào `CLAUDE.md`, trong mục "Side panel chat operational notes", một đoạn mới:

```markdown
- The panel's activity timeline is a **two-sided contract with one owner per
  half**: `AgentSession.translate()` in `server/agent.js` owns the data — it
  pairs `tool_use_id` between the `content_block_start`/`assistant` lines and
  the `user` line carrying `tool_result`, times each step, and truncates
  results before they cross the socket — while `extension/panel-labels.js` owns
  every user-facing word. Adding a browser tool means adding one row to
  `TOOL_LABELS`; it means nothing on the server. Two invariants keep the UI
  honest and are easy to break: a `tool_result` for an id the server never
  announced must open its own `step_start` first (the panel keys rows by id and
  would silently drop an unmatched `step_end`), and **every** path that ends a
  turn must go through `AgentSession.endTurn()`, which closes any step still
  open with `aborted: true`. Miss the second and a killed turn leaves a row
  pulsing forever — which is the exact symptom the timeline was built to remove.
- `thinking` blocks from `claude -p --output-format stream-json` **always carry
  an empty string** — measured twice on CLI 2.1.197, including under
  `ultrathink`, where the model plainly did think (a 2462-character answer
  followed). The count of `thinking_delta` events is still non-zero, so "the
  model is thinking" is knowable and "what it is thinking" is not. The panel
  therefore reports a *phase*, never reasoning text. Do not add a collapsible
  thinking box back without re-measuring first.
- The panel keeps its own journal of what it drew (`extension/panel-journal.js`,
  `panelLog.<windowId>` in `chrome.storage.local`, capped at 400 entries /
  512KB) and replays it before dialling the socket, because a reopened panel
  otherwise showed a blank log for a conversation the server resumes happily.
  It is NOT synchronised with the CLI's own transcript: clearing one does not
  clear the other. `delta` events are drawn but never journalled — `message`
  restates the same text authoritatively, and journalling both doubles the log
  on reopen.
- The panel declares `protocol: 2` in its `start` frame. A bridge is upgraded by
  the installer while the extension only changes when the user reloads it in
  `chrome://extensions`, so the server still emits the pre-timeline `tool` event
  to anything that does not ask for 2. Do not delete that branch.
```

Thêm vào `README.md`, trong phần mô tả khung chat, một đoạn tiếng Việt:

```markdown
Khung chat hiện tiến trình theo thời gian thực: mỗi lần Claude gọi một công cụ trình duyệt
sẽ có một dòng riêng, mở ra ngay lúc nó quyết định gọi, và đóng lại bằng ✓ hoặc ✗ kèm thời
gian chạy. Bấm vào dòng đó để xem tham số và kết quả (kết quả đã được cắt bớt ở server).
Dải chữ ngay trên ô nhập luôn cho biết đang ở giai đoạn nào — đang gửi yêu cầu, đang suy
nghĩ, đang chạy công cụ nào, đang trả lời — kèm số giây trôi.

Ngôn ngữ của phần chữ mô tả hoạt động bám theo ngôn ngữ bạn gõ: nhắn tiếng Việt thì hiện
"Đang suy nghĩ", nhắn tiếng Anh thì hiện "Thinking". Nút bấm vẫn giữ tiếng Việt.

Đóng panel rồi mở lại sẽ thấy lại toàn bộ nội dung đã trao đổi. Bấm "Phiên mới" mới xoá.
```

- [ ] **Step 4: Chạy toàn bộ**

```bash
npm run lint
npm test
```

Expected: 0 lỗi lint, mọi suite PASS. Trên macOS đây là bản chạy đầy đủ — nhớ rằng `test/install-windows.test.mjs` tự bỏ qua với exit 0 ngoài Windows, nên một lần xanh ở đây chưa từng chạm vào file `.ps1` nào.

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json server/index.js server/package.json server/package-lock.json README.md CLAUDE.md
git commit -m "1.1.0: the panel shows what the agent is doing

Sending a prompt used to be followed by nothing at all — measured 2.2s to first
token on a trivial prompt, far longer for a real page read — with no way to tell
a working agent from a hung one. Now every tool call is a row that opens when
Claude decides to make it and closes with a tick, a cross and a duration, and a
line above the input names the current phase with a counter that keeps moving.

Documents the two invariants that keep it honest (open a step before closing an
unannounced one; end every turn through endTurn so nothing is left spinning),
the measured fact that the CLI never emits thinking text, and why the panel
keeps its own journal instead of reading the CLI's transcripts."
```

---

## Ghi chú cho người thực thi

- **Thứ tự bắt buộc**: Task 1 → 2 → 3 → 4, vì Task 3 phát lại fixture của Task 1 và dùng hàm của Task 2. Task 5 và 6 độc lập với nhau và với 1–4 — chạy song song được. Task 7 cần 3, 5, 6. Task 8 cần 7. Task 9 cuối cùng.
- **Task 1 gọi model thật.** Không có cách nào khác để lấy hình dạng thật; đó là điểm của fixture.
- **`npm test` không nạp `sidepanel.js` trong trình duyệt.** Xanh hết vẫn chưa chứng minh gì về DOM của panel — đó là việc của Task 8, chạy tay.
- **Nếu Step 3 của Task 1 đỏ** (CLI đã đổi format), DỪNG và báo lại. Kế hoạch này xây trên hình dạng đo ngày 2026-08-15; format khác thì thiết kế phải xem lại chứ không phải sửa test cho vừa.
