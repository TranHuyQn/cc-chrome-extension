# Side Panel Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm khung chat Claude ngay trong Chrome (side panel), chạy bằng chính `claude` CLI đã đăng nhập trên máy — không cần API key riêng.

**Architecture:** Bridge server chạy `--http` trên loopback mở thêm một WebSocket endpoint `/panel` cho side panel. Mỗi panel có một `AgentSession` spawn một tiến trình `claude -p --output-format stream-json` cho mỗi lượt chat; tiến trình đó gọi ngược lại chính bridge qua `/mcp` để lấy 22 tool trình duyệt. MCP session id được server cấp trước và giữ cố định theo panel, nên mọi lượt chat của một panel dùng chung một tab group.

**Tech Stack:** Node 18+ ESM (không thêm dependency), `ws`, `@modelcontextprotocol/sdk`, Chrome MV3 `chrome.sidePanel`, JS thuần cho extension.

**Spec:** `docs/superpowers/specs/2026-08-05-sidepanel-chat-design.md`

## Global Constraints

- **Không thêm dependency npm mới** vào `server/`. Giữ đúng 3: `@modelcontextprotocol/sdk`, `ws`, `zod`.
- **Không thêm build step cho `extension/`.** JS thuần, Chrome nạp trực tiếp.
- **Version `3.4.0`** ở đúng ba chỗ: `extension/manifest.json`, `const VERSION` trong `server/index.js`, `server/package.json`. Rồi `npm install --package-lock-only` trong `server/`.
- **`npm run lint` phải 0 lỗi.** Hook `PostToolUse` trong `.claude/settings.json` lint mọi file `.js`/`.mjs` ngay sau khi ghi — sửa hết những gì nó báo trước khi đi tiếp.
- **Không sửa `resolveTabInGroup()`** trong `extension/background.js`. Một dòng cũng không.
- **Chỉ spawn `claude` khi `HOST` là loopback** (`127.0.0.1` / `localhost` / `::1`). Bridge công khai phải từ chối `/panel`.
- **`attach_tab` chỉ nhận `windowId`, không bao giờ nhận `tabId`.** Nhận `tabId` tuỳ ý là tái tạo đúng lỗ hổng bản 3.0.0 đã vá ở `close_tab`/`switch_tab`.
- **`attach_tab` không được đăng ký làm MCP tool** trong `buildMcpServer()`. Nó chỉ tồn tại trên đường panel → server → extension.
- Tài liệu người dùng (`README.md`, UI panel, `.claude/commands/ccchrome.md`) **tiếng Việt**. Code, comment, commit message **tiếng Anh**.
- **Trên macOS chạy test trình duyệt phải có `HEADED=1` và để trống `CHROME_PATH`.**
- Test viết theo khuôn có sẵn: script node thuần, helper `check(name, cond, detail)`, đếm `failures`, `process.exit(failures === 0 ? 0 : 1)`. Không thêm test framework.

## File Structure

| File | Trạng thái | Trách nhiệm |
|---|---|---|
| `server/agent.js` | tạo | `AgentSession`: spawn `claude`, tách NDJSON, dịch sự kiện, dừng |
| `server/index.js` | sửa | endpoint `/panel`, chặn loopback, MCP session id cấp trước, định tuyến `attach_tab` |
| `extension/sidepanel.html` | tạo | khung chat |
| `extension/sidepanel.js` | tạo | socket `/panel`, render tin nhắn, nút bấm |
| `extension/background.js` | sửa | handler `attach_tab` |
| `extension/popup.html` / `popup.js` | sửa | nút "Mở khung chat" |
| `extension/manifest.json` | sửa | permission `sidePanel`, khai báo `side_panel`, version |
| `test/fixtures/claude-stream.ndjson` | tạo | transcript thật ghi ở Task 1, làm fixture cho Task 2 |
| `test/fake-claude.mjs` | tạo | `claude` giả phát lại fixture, dùng cho test `AgentSession` |
| `test/agent-session.test.mjs` | tạo | dịch sự kiện + nút dừng |
| `test/panel-auth.test.mjs` | tạo | từ chối origin/token/subprotocol + chặn loopback |
| `test/build.test.mjs` | sửa | thêm file panel vào danh sách bắt buộc trong zip |
| `README.md`, `CLAUDE.md`, `.claude/commands/ccchrome.md` | sửa | tài liệu |

`scripts/build-extension.mjs` duyệt đệ quy thư mục `extension/`, nên file mới **tự động** vào zip — không phải sửa build script.

---

### Task 1: Kiểm chứng `claude` headless trước khi viết code

Spec bắt buộc bước này: phải biết chắc dạng `--allowedTools` nào mở được cả 22 tool, và phải có transcript NDJSON thật để làm fixture. **Không đoán** — mọi task sau dựa vào kết quả ở đây.

**Files:**
- Create: `test/fixtures/claude-stream.ndjson`
- Create: `docs/superpowers/plans/notes/2026-08-05-claude-headless-probe.md`

**Interfaces:**
- Consumes: không có.
- Produces: `test/fixtures/claude-stream.ndjson` (transcript NDJSON thật, có ít nhất một lượt gọi tool); file ghi chú chốt giá trị chính xác của cờ `--allowedTools` mà Task 2 sẽ dùng.

- [ ] **Step 1: Tạo thư mục làm việc rỗng cho agent**

```bash
mkdir -p ~/.cc-chrome-bridge/panel
ls -a ~/.cc-chrome-bridge/panel
```

Phải rỗng, và **không có `CLAUDE.md`**. Nếu có thì xoá — agent panel không được nuốt CLAUDE.md của workspace.

- [ ] **Step 2: Kiểm tra luồng cơ bản — prompt qua stdin, output NDJSON**

```bash
cd ~/.cc-chrome-bridge/panel
SID=$(uuidgen | tr 'A-Z' 'a-z')
echo "Trả lời đúng một từ: chào" | claude -p \
  --output-format stream-json \
  --include-partial-messages \
  --tools "" \
  --strict-mcp-config \
  --session-id "$SID" \
  > /tmp/probe-a.ndjson 2>/tmp/probe-a.err
echo "exit=$?"; wc -l /tmp/probe-a.ndjson; head -3 /tmp/probe-a.ndjson
```

Kỳ vọng: `exit=0`, file có nhiều dòng JSON, mỗi dòng một object có trường `type`.

Ghi lại vào file notes: **danh sách các giá trị `type` xuất hiện**, chạy
`jq -r .type /tmp/probe-a.ndjson | sort | uniq -c`.

Nếu prompt qua stdin không chạy, thử dạng đối số: `claude -p "..." --output-format stream-json ...` và ghi rõ dạng nào chạy được — Task 2 sẽ dùng đúng dạng đó.

- [ ] **Step 3: Kiểm tra `--resume` giữ được ngữ cảnh giữa hai tiến trình**

```bash
cd ~/.cc-chrome-bridge/panel
echo "Tôi tên là Huy. Chỉ trả lời: ok" | claude -p --output-format stream-json \
  --tools "" --strict-mcp-config --session-id "$SID" > /tmp/probe-b1.ndjson
echo "Tôi tên gì?" | claude -p --output-format stream-json \
  --tools "" --strict-mcp-config --resume "$SID" > /tmp/probe-b2.ndjson
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' /tmp/probe-b2.ndjson
```

Kỳ vọng: câu trả lời có chữ "Huy". Đây là bằng chứng kiến trúc một-tiến-trình-mỗi-lượt dùng được. **Nếu không giữ được ngữ cảnh, dừng lại và báo Huy** — phải đổi sang `--input-format stream-json` giữ tiến trình sống, và Task 2 phải viết lại.

- [ ] **Step 4: Chạy bridge local ở http mode**

Mở một terminal riêng, để chạy nền suốt Task 1:

```bash
cd /Volumes/Data/workspace/projects/personal/cc-chrome-extension
CC_CHROME_TOKENS="probetoken12345=probe" CC_CHROME_HOST=127.0.0.1 \
  node server/index.js --http
```

Kiểm tra ở terminal khác: `curl -s http://127.0.0.1:8787/health` phải trả JSON có `"ok":true`.

- [ ] **Step 5: Kiểm tra dạng rút gọn của `--allowedTools`**

```bash
cd ~/.cc-chrome-bridge/panel
SID2=$(uuidgen | tr 'A-Z' 'a-z')
echo "Gọi tool chrome_status một lần rồi in nguyên văn kết quả JSON. Không làm gì khác." | claude -p \
  --output-format stream-json \
  --strict-mcp-config \
  --mcp-config '{"mcpServers":{"chrome":{"type":"http","url":"http://127.0.0.1:8787/mcp","headers":{"Authorization":"Bearer probetoken12345"}}}}' \
  --tools "" \
  --allowedTools "mcp__chrome" \
  --session-id "$SID2" \
  > /tmp/probe-c.ndjson 2>/tmp/probe-c.err
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name' /tmp/probe-c.ndjson
```

Kỳ vọng: in ra `mcp__chrome__chrome_status`, và trong `/tmp/probe-c.ndjson` có kết quả tool chứ không phải lời từ chối vì thiếu quyền.

`chrome_status` trả lời được ngay cả khi extension chưa kết nối, nên bước này không cần Chrome đang mở.

- [ ] **Step 6: Nếu dạng rút gọn không chạy, dựng danh sách đầy đủ**

Chỉ làm khi Step 5 thất bại. Sinh danh sách tên tool từ chính source, không gõ tay:

```bash
cd /Volumes/Data/workspace/projects/personal/cc-chrome-extension
grep -oE '^\s*tool\("([a-z_]+)"' server/index.js | grep -oE '"[a-z_]+"' | tr -d '"' \
  | sed 's/^/mcp__chrome__/' | paste -sd, -
```

Chạy lại Step 5 với `--allowedTools "<danh-sách-vừa-sinh>"`. **Không được dùng `--dangerously-skip-permissions` làm đường vòng** — nó bỏ mọi kiểm tra, không chỉ kiểm tra tool.

- [ ] **Step 7: Lưu fixture**

```bash
cd /Volumes/Data/workspace/projects/personal/cc-chrome-extension
mkdir -p test/fixtures
cp /tmp/probe-c.ndjson test/fixtures/claude-stream.ndjson
wc -l test/fixtures/claude-stream.ndjson
```

Trước khi commit, mở file và **xoá mọi thứ nhạy cảm**: token `probetoken12345`, đường dẫn tuyệt đối có tên máy, cwd. Thay bằng chuỗi giả cùng độ dài.

- [ ] **Step 8: Ghi notes**

Tạo `docs/superpowers/plans/notes/2026-08-05-claude-headless-probe.md` gồm đúng bốn mục:

1. Dạng truyền prompt dùng được (stdin hay đối số) — kết quả Step 2.
2. Bảng các giá trị `type` trong NDJSON và ý nghĩa từng loại — kết quả Step 2.
3. `--resume` có giữ ngữ cảnh không — kết quả Step 3, ghi cả câu trả lời thật.
4. Giá trị `--allowedTools` đã xác nhận — kết quả Step 5 hoặc Step 6, ghi nguyên văn chuỗi sẽ dùng trong code.

- [ ] **Step 9: Commit**

```bash
git add test/fixtures/claude-stream.ndjson docs/superpowers/plans/notes/2026-08-05-claude-headless-probe.md
git commit -m "Record a real headless claude transcript to build the panel against

The stream-json event shapes and the --allowedTools form that actually opens
the chrome MCP tools are both things the plan refused to guess. This captures
them from a live run so the translator is written against real output."
```

---

### Task 2: `AgentSession` — spawn, dịch sự kiện, dừng

**Files:**
- Create: `server/agent.js`
- Create: `test/fake-claude.mjs`
- Create: `test/agent-session.test.mjs`
- Modify: `package.json` (thêm script `test:agent`)

**Interfaces:**
- Consumes: `test/fixtures/claude-stream.ndjson` từ Task 1.
- Produces:
  - `class AgentSession` export từ `server/agent.js`.
  - Constructor: `new AgentSession({ sessionId, model, token, mcpUrl, allowedTools, cwd, claudeBin, claudeArgsPrefix, env, onEvent, log })`.
  - `sessionId: string` (uuid), `model: string|null`, `token: string` (Bearer token đưa vào `--mcp-config`), `mcpUrl: string`, `allowedTools: string`, `cwd: string`, `claudeBin: string` (mặc định `"claude"`), `claudeArgsPrefix: string[]` (mặc định `[]`, chỉ để test chèn đường dẫn script giả), `env: object` (mặc định `{}`, trộn lên `process.env`), `onEvent: (event) => void`, `log: (...args) => void`.
  - Task 4 bổ sung thêm một tham số `systemPrompt: string|null`. Task 2 chưa cần.
  - Phương thức: `send(text: string): void`, `stop(): boolean`, `dispose(): void`, getter `busy: boolean`.
  - `onEvent` nhận đúng các object sau, không có dạng nào khác:
    - `{ type: "turn_start" }`
    - `{ type: "delta", text: string }`
    - `{ type: "message", text: string }`
    - `{ type: "tool", name: string }`
    - `{ type: "turn_end", ok: boolean, error?: string }`

- [ ] **Step 1: Viết `claude` giả phát lại fixture**

Tạo `test/fake-claude.mjs`:

```js
// Stands in for the `claude` binary in AgentSession tests. It replays a real
// transcript captured in Task 1 instead of imitating a shape we invented, so a
// change in the CLI's output surfaces as a test failure rather than as a panel
// that silently renders nothing.
//
// Behaviour is steered by env vars so one file covers every case:
//   CC_FAKE_FIXTURE  path to the NDJSON transcript to replay (required)
//   CC_FAKE_DELAY_MS pause between lines, so a test can kill it mid-stream
//   CC_FAKE_ARGV     path to write the received argv to, for flag assertions

import { readFileSync, writeFileSync } from "node:fs";

if (process.env.CC_FAKE_ARGV) {
  writeFileSync(process.env.CC_FAKE_ARGV, JSON.stringify(process.argv.slice(2)));
}

// Drain stdin so a parent that writes the prompt there never blocks on a full pipe.
process.stdin.resume();
process.stdin.on("data", () => {});

const lines = readFileSync(process.env.CC_FAKE_FIXTURE, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0);

const delay = Number(process.env.CC_FAKE_DELAY_MS || 0);

for (const line of lines) {
  process.stdout.write(line + "\n");
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
}
process.exit(0);
```

- [ ] **Step 2: Viết test thất bại**

Tạo `test/agent-session.test.mjs`. Bốn khẳng định: dịch được text, nhận ra tool call, dựng đúng cờ, dừng được giữa chừng.

```js
// Usage: node test/agent-session.test.mjs
//
// Runs AgentSession against a fake `claude` that replays the transcript captured
// in Task 1. No real model call, no network — this is about the translation
// layer and the process lifecycle, which are the parts that break silently.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { AgentSession } from "../server/agent.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "test", "fixtures", "claude-stream.ndjson");
const fakeClaude = join(root, "test", "fake-claude.mjs");

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const workdir = mkdtempSync(join(tmpdir(), "cc-agent-test-"));

function makeSession(extra = {}) {
  const events = [];
  const session = new AgentSession({
    sessionId: "11111111-2222-3333-4444-555555555555",
    model: "sonnet",
    mcpUrl: "http://127.0.0.1:8787/mcp?panel=test",
    allowedTools: "mcp__chrome",
    cwd: workdir,
    claudeBin: process.execPath,
    claudeArgsPrefix: [fakeClaude],
    env: { CC_FAKE_FIXTURE: fixture, ...(extra.env || {}) },
    onEvent: (event) => events.push(event),
    log: () => {},
  });
  return { session, events };
}

// --- 1. a whole turn translates into panel events ---------------------------

{
  const { session, events } = makeSession();
  session.send("xin chào");
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);

  check("emits turn_start first", events[0]?.type === "turn_start", JSON.stringify(events[0]));
  check("emits at least one assistant message", events.some((e) => e.type === "message" && e.text.length > 0));
  check("emits a tool event naming the chrome tool",
    events.some((e) => e.type === "tool" && e.name.includes("chrome")),
    JSON.stringify(events.filter((e) => e.type === "tool")));
  check("ends with turn_end ok", events.at(-1)?.type === "turn_end" && events.at(-1)?.ok === true,
    JSON.stringify(events.at(-1)));
  check("no event type outside the contract",
    events.every((e) => ["turn_start", "delta", "message", "tool", "turn_end"].includes(e.type)),
    JSON.stringify([...new Set(events.map((e) => e.type))]));
  session.dispose();
}

// --- 2. the argv carries the flags the design depends on --------------------

{
  const argvFile = join(workdir, "argv.json");
  const { session, events } = makeSession({ env: { CC_FAKE_ARGV: argvFile } });
  session.send("xin chào");
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);

  const argv = JSON.parse(readFileSync(argvFile, "utf8"));
  const flat = argv.join(" ");
  check("passes --print", argv.includes("-p") || argv.includes("--print"), flat);
  check("asks for stream-json output", flat.includes("--output-format stream-json"), flat);
  check("disables every built-in tool", argv.includes("--tools") && argv[argv.indexOf("--tools") + 1] === "", flat);
  check("uses strict mcp config", argv.includes("--strict-mcp-config"), flat);
  check("allows the chrome mcp tools", flat.includes("mcp__chrome"), flat);
  check("first turn opens the session id, not a resume",
    argv.includes("--session-id") && !argv.includes("--resume"), flat);
  session.dispose();
}

// --- 3. the second turn resumes instead of starting over --------------------

{
  const argvFile = join(workdir, "argv2.json");
  const { session, events } = makeSession({ env: { CC_FAKE_ARGV: argvFile } });
  session.send("lượt một");
  for (let i = 0; i < 100 && !events.some((e) => e.type === "turn_end"); i++) await sleep(50);
  session.send("lượt hai");
  for (let i = 0; i < 100 && events.filter((e) => e.type === "turn_end").length < 2; i++) await sleep(50);

  const argv = JSON.parse(readFileSync(argvFile, "utf8"));
  check("second turn resumes the same session",
    argv.includes("--resume") && argv[argv.indexOf("--resume") + 1] === "11111111-2222-3333-4444-555555555555",
    argv.join(" "));
  session.dispose();
}

// --- 4. stop() actually kills the child -------------------------------------

{
  const { session, events } = makeSession({ env: { CC_FAKE_DELAY_MS: "200" } });
  session.send("chạy dài");
  await sleep(300);
  check("busy while the child runs", session.busy === true);
  const stopped = session.stop();
  check("stop() reports it killed something", stopped === true);
  for (let i = 0; i < 60 && session.busy; i++) await sleep(50);
  check("not busy after stop", session.busy === false);
  check("turn_end reports failure after a stop",
    events.at(-1)?.type === "turn_end" && events.at(-1)?.ok === false,
    JSON.stringify(events.at(-1)));
  session.dispose();
}

rmSync(workdir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 3: Chạy test để chắc chắn nó thất bại**

```bash
node test/agent-session.test.mjs
```

Kỳ vọng: `ERR_MODULE_NOT_FOUND` cho `../server/agent.js`. Nếu thất bại vì lý do khác thì đọc kỹ trước khi viết code.

- [ ] **Step 4: Viết `server/agent.js`**

```js
// One AgentSession per side panel. Each chat turn spawns a fresh `claude -p`
// child; the child exits when the turn ends, and the next turn resumes the same
// Claude session by id.
//
// One process per turn rather than one long-lived process on purpose: --resume
// is a documented flag, whereas driving a live child would mean writing to a
// stdin control protocol that is not. It also makes the stop button trivially
// correct — killing the child is the whole implementation.
//
// The Claude session id is stable for the panel's lifetime, so history survives
// across turns even though the process does not.

import { spawn } from "node:child_process";

export class AgentSession {
  constructor({
    sessionId,
    model = null,
    mcpUrl,
    allowedTools,
    cwd,
    claudeBin = "claude",
    claudeArgsPrefix = [],
    env = {},
    onEvent,
    log = () => {},
  }) {
    this.sessionId = sessionId;
    this.model = model;
    this.mcpUrl = mcpUrl;
    this.allowedTools = allowedTools;
    this.cwd = cwd;
    this.claudeBin = claudeBin;
    this.claudeArgsPrefix = claudeArgsPrefix;
    this.env = env;
    this.onEvent = onEvent;
    this.log = log;

    this.child = null;
    this.buffer = "";
    // A turn that has already started must --resume; the very first one has no
    // conversation to resume into and would fail.
    this.started = false;
    this.stopping = false;
  }

  get busy() {
    return this.child !== null;
  }

  mcpConfig() {
    return JSON.stringify({
      mcpServers: {
        chrome: {
          type: "http",
          url: this.mcpUrl,
          headers: { Authorization: `Bearer ${this.token}` },
        },
      },
    });
  }

  buildArgs() {
    const args = [
      ...this.claudeArgsPrefix,
      "-p",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--strict-mcp-config",
      "--mcp-config", this.mcpConfig(),
      // Every built-in tool off: this agent has no business reading or writing
      // the user's filesystem, and the browser tools all arrive over MCP.
      "--tools", "",
      "--allowedTools", this.allowedTools,
    ];
    if (this.model) args.push("--model", this.model);
    if (this.started) args.push("--resume", this.sessionId);
    else args.push("--session-id", this.sessionId);
    return args;
  }

  send(text) {
    if (this.child) throw new Error("A turn is already running; stop it first.");
    this.stopping = false;
    this.buffer = "";
    this.onEvent({ type: "turn_start" });

    const child = spawn(this.claudeBin, this.buildArgs(), {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.started = true;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => this.log("[claude stderr]", chunk.trimEnd()));

    child.on("error", (err) => {
      this.child = null;
      this.onEvent({ type: "turn_end", ok: false, error: err.message });
    });

    child.on("close", (code) => {
      this.child = null;
      if (this.stopping) {
        this.onEvent({ type: "turn_end", ok: false, error: "đã dừng theo yêu cầu" });
      } else if (code === 0) {
        this.onEvent({ type: "turn_end", ok: true });
      } else {
        this.onEvent({ type: "turn_end", ok: false, error: `claude thoát với mã ${code}` });
      }
    });

    child.stdin.write(text);
    child.stdin.end();
  }

  onStdout(chunk) {
    this.buffer += chunk;
    // NDJSON: one JSON object per line, and a chunk boundary can land anywhere,
    // so the tail is kept until its newline arrives.
    let index;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // A malformed line is not worth killing the turn over; the transcript is
        // the CLI's to define and an unknown shape may simply be newer than us.
        this.log("[claude] unparseable stdout line:", line.slice(0, 200));
        continue;
      }
      this.translate(event);
    }
  }

  translate(event) {
    if (event.type === "stream_event") {
      const delta = event.event?.delta;
      if (delta?.type === "text_delta" && delta.text) {
        this.onEvent({ type: "delta", text: delta.text });
      }
      return;
    }
    if (event.type === "assistant") {
      for (const block of event.message?.content || []) {
        if (block.type === "text" && block.text) {
          this.onEvent({ type: "message", text: block.text });
        } else if (block.type === "tool_use" && block.name) {
          this.onEvent({ type: "tool", name: block.name });
        }
      }
      return;
    }
    // "system", "user" (tool results) and "result" carry nothing the panel
    // renders — the final text already arrived as an assistant message.
  }

  stop() {
    if (!this.child) return false;
    this.stopping = true;
    this.child.kill("SIGTERM");
    return true;
  }

  dispose() {
    this.stopping = true;
    if (this.child) this.child.kill("SIGKILL");
    this.child = null;
  }
}
```

- [ ] **Step 5: Sửa hai chỗ chưa khớp**

`mcpConfig()` ở trên dùng `this.token` nhưng constructor không nhận `token`. Thêm `token` vào constructor (`this.token = token;`) và vào danh sách tham số. Test không truyền `token` nên giá trị sẽ là `undefined` — chấp nhận được vì `claude` giả không đọc config, nhưng phải thêm tham số thì code thật mới chạy.

Đồng thời chỉnh `translate()` cho khớp **đúng các giá trị `type` đã ghi ở Task 1 Step 8 mục 2**. Nếu transcript thật dùng tên khác, sửa theo transcript — fixture là nguồn sự thật, không phải đoạn code mẫu này.

- [ ] **Step 6: Chạy test tới khi xanh**

```bash
node test/agent-session.test.mjs
```

Kỳ vọng: `ALL TESTS PASSED`. Nếu khẳng định về `tool` thất bại vì fixture không có lượt gọi tool nào, quay lại Task 1 Step 5 ghi transcript có gọi tool — **không** sửa test cho dễ qua.

- [ ] **Step 7: Lint**

```bash
npm run lint
```

Kỳ vọng: 0 lỗi.

- [ ] **Step 8: Thêm script test và commit**

Trong `package.json`, thêm `"test:agent": "node test/agent-session.test.mjs"` và chèn `node test/agent-session.test.mjs &&` vào đầu chuỗi `"test"`.

```bash
git add server/agent.js test/fake-claude.mjs test/agent-session.test.mjs package.json
git commit -m "Add AgentSession: one claude child per chat turn

Spawning per turn and resuming by session id keeps the stop button honest — a
kill is the entire implementation — and avoids driving an undocumented stdin
control protocol. Built-in tools are switched off outright so the panel agent
cannot touch the filesystem."
```

---

### Task 3: Endpoint `/panel` — xác thực và chặn loopback

**Files:**
- Modify: `server/index.js` (khối `mainHttp`, phần `httpServer.on("upgrade")` quanh dòng 1156-1193)
- Create: `test/panel-auth.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `originAllowed()`, `tokenFromSubprotocol()`, `pickSubprotocol()`, `tokens` — đã có sẵn trong `server/index.js`.
- Produces:
  - Hàm module-scope `isLoopbackHost(host: string): boolean` trong `server/index.js`.
  - Hằng module-scope `const AGENT_ENABLED = isLoopbackHost(HOST);`
  - Endpoint WebSocket `/panel`, cùng bộ close code với `/ws` cộng thêm **4004 = panel bị tắt trên bridge không phải loopback**.
  - `panels: Map<string, { id, ws, token, agent, mcpSessionId }>` trong `mainHttp` — Task 4 và Task 5 đều đọc map này.

- [ ] **Step 1: Viết test thất bại**

Tạo `test/panel-auth.test.mjs`:

```js
// The /panel socket is a second door into the same process, so it must refuse
// exactly like /ws does — same origin rule, same token rule, same close codes —
// plus one rule of its own: a bridge that is not bound to loopback must not
// expose it at all, because behind it sits a process spawn on the host.
//
// Usage: node test/panel-auth.test.mjs

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "paneltoken12345";
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(host, port) {
  const child = spawn(process.execPath, [join(root, "server", "index.js"), "--http"], {
    env: {
      ...process.env,
      CC_CHROME_TOKENS: `${TOKEN}=panel`,
      CC_CHROME_HOST: host,
      CC_CHROME_PORT: String(port),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", () => {});
  return child;
}

async function waitForHealth(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  return false;
}

// Resolves with the close code, so a refusal is observable the way the panel
// itself observes it — a browser cannot read the HTTP status of a failed upgrade.
function connectPanel(port, { origin = ORIGIN, token = TOKEN, subprotocol = true } = {}) {
  return new Promise((resolve) => {
    const protocols = subprotocol ? [`ccchrome.token.${token}`] : [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/panel`, protocols, { headers: { origin } });
    const done = (value) => { try { ws.close(); } catch { /* already closing */ } resolve(value); };
    ws.on("close", (code) => resolve({ closed: code }));
    ws.on("error", () => resolve({ closed: 1006 }));
    ws.on("message", (data) => done({ message: JSON.parse(data.toString()) }));
    setTimeout(() => done({ timeout: true }), 5000);
  });
}

// --- loopback bridge: the normal case ---------------------------------------

const PORT = 8791;
const server = startServer("127.0.0.1", PORT);
check("loopback server came up", await waitForHealth(PORT));

check("good origin + good token is accepted",
  (await connectPanel(PORT)).message !== undefined,
  "expected a server hello frame");

check("bad token closes with 4001",
  (await connectPanel(PORT, { token: "wrongtoken12345" })).closed === 4001);

check("missing subprotocol closes with 4002",
  (await connectPanel(PORT, { subprotocol: false })).closed === 4002);

check("non-extension origin closes with 4003",
  (await connectPanel(PORT, { origin: "https://evil.example.com" })).closed === 4003);

check("absent origin closes with 4003",
  (await connectPanel(PORT, { origin: "" })).closed === 4003);

server.kill();
await sleep(500);

// --- public bridge: /panel must not exist -----------------------------------

const PUBLIC_PORT = 8792;
const publicServer = startServer("0.0.0.0", PUBLIC_PORT);
check("public server came up", await waitForHealth(PUBLIC_PORT));

check("a non-loopback bridge refuses /panel with 4004",
  (await connectPanel(PUBLIC_PORT)).closed === 4004,
  "a public bridge must never spawn claude on the host");

publicServer.kill();

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Chạy test để chắc chắn nó thất bại**

```bash
node test/panel-auth.test.mjs
```

Kỳ vọng: các khẳng định về `/panel` FAIL với `closed: 1006` (upgrade handler hiện tại `socket.destroy()` mọi pathname khác `/ws`).

- [ ] **Step 3: Thêm `isLoopbackHost` và `AGENT_ENABLED`**

Trong `server/index.js`, ngay sau khối khai báo `HOST` (quanh dòng 32), thêm:

```js
// The panel spawns `claude` on this host with the team's logged-in account, so
// it exists only on a bridge nobody else can reach. A public deployment keeps
// serving tools and refuses the panel outright — see /panel below.
function isLoopbackHost(host) {
  const bare = String(host || "").replace(/^\[|\]$/g, "");
  return bare === "127.0.0.1" || bare === "localhost" || bare === "::1";
}
const AGENT_ENABLED = isLoopbackHost(HOST);
```

- [ ] **Step 4: Tách nhánh `/panel` trong upgrade handler**

Trong `mainHttp`, thay khối `httpServer.on("upgrade", ...)` hiện tại. Phần kiểm tra origin/token dùng chung cho cả hai đường, đúng một bản:

```js
  // WebSocket endpoints: /ws for the extension bridge, /panel for the side panel
  // chat. Two servers, one gate — both go through the same origin and token
  // checks, so there is only ever one auth path to keep honest.
  const wss = new WebSocketServer({ noServer: true, handleProtocols: pickSubprotocol });
  const panelWss = new WebSocketServer({ noServer: true, handleProtocols: pickSubprotocol });
  const panels = new Map(); // panelId -> PanelConnection (filled in by /panel below)

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const isPanel = url.pathname === "/panel";
    if (url.pathname !== "/ws" && !isPanel) {
      socket.destroy();
      return;
    }

    const server = isPanel ? panelWss : wss;

    // Rejections complete the handshake and then close with a specific code.
    // A browser cannot read the HTTP status of a failed upgrade, so destroying
    // the socket would reach the extension as an indistinguishable 1006 — the
    // user would see "server not running" for what is really a config error.
    // A rejected socket is never registered, so it can do nothing meanwhile.
    const reject = (code, reason) => {
      server.handleUpgrade(req, socket, head, (ws) => ws.close(code, reason));
    };

    // Checked before origin and token on purpose: on a public bridge the panel
    // does not exist, and saying so is not a credential leak.
    if (isPanel && !AGENT_ENABLED) {
      log(`Rejected /panel upgrade: bridge is bound to ${HOST}, not loopback`);
      return reject(4004, "panel disabled on a non-loopback bridge");
    }

    const origin = req.headers.origin || "";
    if (!originAllowed(origin)) {
      log(`Rejected ws upgrade from origin: ${origin || "(none)"}`);
      return reject(4003, "origin not allowed");
    }

    const token = tokenFromSubprotocol(req);
    if (!token) {
      log("Rejected ws upgrade: no token subprotocol (extension older than 2.0.0?)");
      return reject(4002, "missing token subprotocol");
    }
    if (!tokens.has(token)) {
      log("Rejected ws upgrade: bad token");
      return reject(4001, "invalid token");
    }

    server.handleUpgrade(req, socket, head, (ws) => {
      if (isPanel) attachPanel(ws, token);
      else registry.attach(ws, token, tokens.get(token));
    });
  });
```

- [ ] **Step 5: Thêm `attachPanel` tối thiểu**

Đặt ngay trên `httpServer.on("upgrade", ...)` trong `mainHttp`. Task 4 sẽ mở rộng; bây giờ chỉ cần chào để test phân biệt được chấp nhận với từ chối:

```js
  // A panel proves itself by receiving a frame, mirroring the rule the extension
  // already lives by: `open` fires for refusals too, so only a message from the
  // server is evidence of a live socket.
  function attachPanel(ws, token) {
    const panelId = randomUUID();
    const panel = { id: panelId, ws, token, agent: null, mcpSessionId: null };
    panels.set(panelId, panel);
    log(`[panel ${panelId.slice(0, 8)}] connected`);

    ws.on("close", () => {
      panels.delete(panelId);
      if (panel.agent) panel.agent.dispose();
      log(`[panel ${panelId.slice(0, 8)}] disconnected`);
    });
    ws.on("error", (err) => log(`[panel ${panelId.slice(0, 8)}] socket error:`, err.message));

    ws.send(JSON.stringify({ type: "hello", panelId, version: VERSION }));
  }
```

- [ ] **Step 6: Chạy test tới khi xanh**

```bash
node test/panel-auth.test.mjs
```

Kỳ vọng: `ALL TESTS PASSED`, 7 dòng PASS.

- [ ] **Step 7: Xác nhận không làm hỏng đường cũ**

```bash
node test/ratelimit.test.mjs && node test/session-ttl.test.mjs && node test/reconnect-grace.test.mjs
HEADED=1 node test/e2e-http.mjs
```

Kỳ vọng: tất cả `ALL TESTS PASSED`. Đây là hồi quy cho việc tách `wss` thành hai.

- [ ] **Step 8: Lint và commit**

```bash
npm run lint
git add server/index.js test/panel-auth.test.mjs package.json
git commit -m "Add the /panel websocket endpoint behind a loopback gate

The side panel needs its own socket: joining /ws would evict the service
worker's bridge connection, since attach() replaces a connection on token
collision. A bridge not bound to loopback refuses /panel with 4004 — behind it
sits a claude spawn on the host, under the team's shared login."
```

Trong `package.json` thêm `"test:panel": "node test/panel-auth.test.mjs"` và chèn vào chuỗi `"test"`.

---

### Task 4: Nối `AgentSession` vào `/panel`

**Files:**
- Modify: `server/index.js` (`attachPanel`, khối `/mcp` quanh dòng 1128-1140)

**Interfaces:**
- Consumes: `AgentSession` từ Task 2; `panels` map và `attachPanel` từ Task 3.
- Produces: giao thức panel ↔ server, cố định như sau.

  Panel → server:
  - `{ type: "start", sessionId: string|null, model: string|null }`
  - `{ type: "prompt", text: string }`
  - `{ type: "stop" }`
  - `{ type: "attach_tab", windowId: number }` (Task 5 hiện thực đầu extension)

  Server → panel:
  - `{ type: "hello", panelId, version }`
  - `{ type: "ready", sessionId, model, groupTitle }`
  - `{ type: "turn_start" }` / `{ type: "delta", text }` / `{ type: "message", text }` / `{ type: "tool", name }` / `{ type: "turn_end", ok, error? }`
  - `{ type: "attach_tab_result", ok, error?, title?, url? }`
  - `{ type: "error", message }`

- [ ] **Step 1: Cấp trước MCP session id cho panel**

**Đây là điều kiện đúng đắn, không phải tối ưu.** Mỗi lượt chat là một tiến trình `claude` mới, nên là một lần initialize MCP mới. Nếu để `sessionIdGenerator: randomUUID` như hiện tại, mỗi lượt sẽ nhận một session id khác nhau → `sessionGroupTitle()` sinh một tab group khác nhau → sang lượt hai Claude mất quyền vào chính những tab nó vừa mở ở lượt một.

Trong khối `/mcp` của `mainHttp`, thay đoạn tạo transport (dòng ~1130-1137):

```js
      // New session (initialize request).
      const body = await readBody(req);
      const sessionRef = { id: null };
      // A panel keeps one MCP session id for its whole life even though it
      // spawns a fresh `claude` per turn. The id decides the tab group name, so
      // letting each turn generate its own would hand every turn a brand new
      // group and lock Claude out of the tabs it opened a moment earlier.
      const panelId = url.searchParams.get("panel");
      const panel = panelId ? panels.get(panelId) : null;
      if (panelId && !panel) {
        return json(res, 404, { error: "unknown panel id" });
      }
      if (panel && panel.token !== token) {
        return json(res, 403, { error: "panel belongs to a different token" });
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => (panel ? panel.mcpSessionId : randomUUID()),
        onsessioninitialized: (id) => {
          sessionRef.id = id;
          // The previous turn's transport still holds this id. Close it first,
          // or its entry is silently overwritten and never cleaned up.
          const previous = sessions.get(id);
          if (previous && previous.transport !== transport) {
            try { previous.transport.close(); } catch { /* already gone */ }
          }
          sessions.set(id, { transport, token, lastSeen: Date.now() });
        },
      });
```

`panel.mcpSessionId` được cấp ở Step 2.

- [ ] **Step 2: Mở rộng `attachPanel`**

Thay thân `attachPanel` bằng bản đầy đủ:

```js
  const PANEL_CWD = join(homedir(), ".cc-chrome-bridge", "panel");
  // Everything under here is derived from the design's tool-set decision: the
  // agent gets the chrome MCP tools and nothing else.
  const PANEL_ALLOWED_TOOLS = process.env.CC_CHROME_PANEL_TOOLS || "mcp__chrome";
  const PANEL_SYSTEM_PROMPT =
    "Bạn là trợ lý duyệt web chạy trong khung chat bên cạnh trình duyệt Chrome của người dùng. " +
    "Bạn chỉ có các tool điều khiển trình duyệt, không đọc/ghi được file trên máy. " +
    "Bạn chỉ thao tác được trên các tab nằm trong tab group của phiên này; " +
    "muốn làm việc trên một trang người dùng đang mở, hãy bảo họ bấm nút \"Đưa tab này vào phiên\". " +
    "Trả lời ngắn gọn bằng tiếng Việt.";

  function attachPanel(ws, token) {
    const panelId = randomUUID();
    const panel = {
      id: panelId,
      ws,
      token,
      agent: null,
      // Chosen here, handed to the MCP transport when the child initializes.
      mcpSessionId: randomUUID(),
    };
    panels.set(panelId, panel);
    log(`[panel ${panelId.slice(0, 8)}] connected`);

    const send = (obj) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    };

    ws.on("close", () => {
      panels.delete(panelId);
      if (panel.agent) panel.agent.dispose();
      log(`[panel ${panelId.slice(0, 8)}] disconnected`);
    });
    ws.on("error", (err) => log(`[panel ${panelId.slice(0, 8)}] socket error:`, err.message));

    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      try {
        await handlePanelMessage(panel, msg, send);
      } catch (err) {
        send({ type: "error", message: err.message });
      }
    });

    ws.send(JSON.stringify({ type: "hello", panelId, version: VERSION }));
  }

  async function handlePanelMessage(panel, msg, send) {
    if (msg.type === "start") {
      if (panel.agent) panel.agent.dispose();
      mkdirSync(PANEL_CWD, { recursive: true });
      const sessionId = msg.sessionId || randomUUID();
      panel.agent = new AgentSession({
        sessionId,
        model: msg.model || null,
        token: panel.token,
        mcpUrl: `http://127.0.0.1:${PORT}/mcp?panel=${panel.id}`,
        allowedTools: PANEL_ALLOWED_TOOLS,
        cwd: PANEL_CWD,
        systemPrompt: PANEL_SYSTEM_PROMPT,
        onEvent: (event) => send(event),
        log,
      });
      send({
        type: "ready",
        sessionId,
        model: msg.model || null,
        groupTitle: `Claude · ${panel.mcpSessionId.replace(/-/g, "").slice(0, 4)}`,
      });
      return;
    }

    if (!panel.agent) throw new Error("Chưa khởi tạo phiên — gửi 'start' trước.");

    if (msg.type === "prompt") {
      const text = String(msg.text || "").trim();
      if (!text) return;
      if (panel.agent.busy) throw new Error("Claude đang chạy — bấm dừng trước đã.");
      panel.agent.send(text);
      return;
    }

    if (msg.type === "stop") {
      panel.agent.stop();
      return;
    }

    if (msg.type === "attach_tab") {
      const result = await attachPanelTab(panel, msg.windowId);
      send({ type: "attach_tab_result", ...result });
      return;
    }
  }
```

`groupTitle` phải khớp **từng ký tự** với `sessionGroupTitle()` trong `extension/background.js` (dòng 92): `` `Claude · ${String(session).replace(/-/g, "").slice(0, 4)}` ``. Panel hiện chuỗi này cho người dùng biết tab group của mình tên gì.

- [ ] **Step 3: Thêm import**

Đầu `server/index.js`, bổ sung vào các import có sẵn:

```js
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { AgentSession } from "./agent.js";
```

`mkdirSync` có thể phải gộp vào dòng `import { ... } from "node:fs"` đang có — kiểm tra trước khi thêm dòng mới, tránh import trùng.

- [ ] **Step 4: Thêm `systemPrompt` vào `AgentSession`**

`server/agent.js` chưa nhận `systemPrompt`. Thêm vào constructor và vào `buildArgs()`:

```js
    if (this.systemPrompt) args.push("--append-system-prompt", this.systemPrompt);
```

Đặt trước nhánh `--resume`/`--session-id`.

- [ ] **Step 5: Thêm stub `attachPanelTab`**

Task 5 hiện thực thật. Bây giờ để nó báo lỗi rõ ràng thay vì `ReferenceError`:

```js
  async function attachPanelTab(_panel, _windowId) {
    return { ok: false, error: "chưa hiện thực" };
  }
```

- [ ] **Step 6: Kiểm tra bằng tay, có ghi lại kết quả**

Chạy bridge:

```bash
CC_CHROME_TOKENS="paneltoken12345=huy" CC_CHROME_HOST=127.0.0.1 node server/index.js --http
```

Ở terminal khác, nối như panel và chạy một lượt thật:

```bash
node -e '
const WebSocket = require("/Volumes/Data/workspace/projects/personal/cc-chrome-extension/server/node_modules/ws");
const ws = new WebSocket("ws://127.0.0.1:8787/panel", ["ccchrome.token.paneltoken12345"], {
  headers: { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" },
});
ws.on("message", (d) => {
  const m = JSON.parse(d);
  console.log(m.type, m.text || m.name || m.error || "");
  if (m.type === "hello") ws.send(JSON.stringify({ type: "start", sessionId: null, model: "sonnet" }));
  if (m.type === "ready") { console.log("group:", m.groupTitle); ws.send(JSON.stringify({ type: "prompt", text: "Gọi tool chrome_status rồi tóm tắt một câu." })); }
  if (m.type === "turn_end") process.exit(m.ok ? 0 : 1);
});
'
```

Kỳ vọng, theo thứ tự: `hello` → `ready` kèm `group: Claude · xxxx` → `turn_start` → vài `delta` → `tool mcp__chrome__chrome_status` → `message` → `turn_end`, thoát mã 0.

Nếu `turn_end` báo lỗi, đọc log stderr của server (`[claude stderr]`) trước khi sửa gì.

- [ ] **Step 7: Lint và commit**

```bash
npm run lint
git add server/index.js server/agent.js
git commit -m "Drive AgentSession from the panel socket

The panel's MCP session id is chosen up front and reused by every turn. A fresh
id per turn would rename the tab group each time and lock Claude out of the tabs
it had just opened, which is a correctness bug, not a cosmetic one."
```

---

### Task 5: Nút "Đưa tab này vào phiên"

**Files:**
- Modify: `extension/background.js` (thêm vào object `handlers`, quanh dòng 984)
- Modify: `server/index.js` (`attachPanelTab`)

**Interfaces:**
- Consumes: `addTabToSessionGroup(tab, session)` và `assertScriptableUrl(tab)` — đã có trong `background.js`; `registry.require(token)` và `conn.call(method, params, timeoutMs, session)` — đã có trong `server/index.js`.
- Produces: bridge method `attach_tab`, nhận `{ windowId: number }`, trả `{ ok: true, tabId, groupId, title, url }`.

- [ ] **Step 1: Thêm handler vào `extension/background.js`**

Chèn vào object `handlers`, cạnh các handler tab khác:

```js
  // The one deliberate way a tab outside the session group gets in. It is not a
  // relaxation of the in-group rule: 3.0.0 already treats dragging a tab into
  // the group as the user granting access, and this does that drag for them
  // when they press the button in the side panel.
  //
  // It takes a windowId and never a tabId. A caller-supplied tabId would rebuild
  // exactly the hole that close_tab and switch_tab had before 3.0.0 — reach any
  // tab in the browser — except this one would also grant permanent access.
  attach_tab: async (params) => {
    const windowId = Number(params.windowId);
    if (!Number.isInteger(windowId)) {
      throw new Error("attach_tab requires a numeric windowId");
    }
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (!tab) throw new Error(`No active tab in window ${windowId}`);
    assertScriptableUrl(tab);
    const groupId = await addTabToSessionGroup(tab, params.__session);
    return { ok: true, tabId: tab.id, groupId, title: tab.title, url: tab.url };
  },
```

**Không** thêm tool tương ứng trong `buildMcpServer()`. Method này chỉ tồn tại trên đường panel → server → extension; Claude không được tự gọi nó, nếu không thì nó tự cấp quyền cho chính mình.

- [ ] **Step 2: Hiện thực `attachPanelTab` trong `server/index.js`**

Thay stub ở Task 4 Step 5:

```js
  // Reaches the extension over the bridge socket the same way a tool call does,
  // but carries the panel's own MCP session id so the tab lands in the panel's
  // group rather than the terminal session's.
  async function attachPanelTab(panel, windowId) {
    if (!Number.isInteger(Number(windowId))) {
      return { ok: false, error: "thiếu windowId" };
    }
    try {
      const conn = await registry.require(panel.token);
      const result = await conn.call(
        "attach_tab",
        { windowId: Number(windowId) },
        REQUEST_TIMEOUT_MS,
        panel.mcpSessionId
      );
      return { ok: true, title: result.title, url: result.url };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
```

- [ ] **Step 3: Kiểm tra bằng tay trong Chrome thật**

Cài extension bản đang sửa (`chrome://extensions` → Reload thư mục `extension/`), trỏ popup vào `ws://127.0.0.1:8787/ws?token=paneltoken12345`, chạy bridge như Task 4 Step 6. Rồi:

```bash
node -e '
const WebSocket = require("/Volumes/Data/workspace/projects/personal/cc-chrome-extension/server/node_modules/ws");
const ws = new WebSocket("ws://127.0.0.1:8787/panel", ["ccchrome.token.paneltoken12345"], {
  headers: { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" },
});
ws.on("message", (d) => {
  const m = JSON.parse(d);
  console.log(JSON.stringify(m));
  if (m.type === "hello") ws.send(JSON.stringify({ type: "start", sessionId: null, model: null }));
  if (m.type === "ready") ws.send(JSON.stringify({ type: "attach_tab", windowId: Number(process.argv[1]) }));
  if (m.type === "attach_tab_result") process.exit(m.ok ? 0 : 1);
});
' <windowId>
```

Lấy `<windowId>` bằng cách mở console của service worker (`chrome://extensions` → Service worker) và chạy `chrome.windows.getCurrent().then(w => console.log(w.id))`.

Kỳ vọng: tab đang active bị kéo vào một tab group màu cam tên `Claude · xxxx`, và `attach_tab_result` có `ok: true` kèm đúng tiêu đề trang.

Kiểm tra thêm **ca phải hỏng**: chuyển sang tab `chrome://settings` rồi chạy lại — phải trả `ok: false` với thông báo về trang nội bộ của trình duyệt, chứ không phải kéo tab vào group.

- [ ] **Step 4: Lint và commit**

```bash
npm run lint
git add extension/background.js server/index.js
git commit -m "Add attach_tab: the button that grants Claude one tab

Takes a windowId and acts on that window's active tab only. Accepting a caller
supplied tabId would rebuild the pre-3.0.0 hole where a tool could reach any tab
in the browser, and this one would grant lasting access rather than one action.
Deliberately not registered as an MCP tool: Claude must not grant itself tabs."
```

---

### Task 6: Side panel UI

**Files:**
- Create: `extension/sidepanel.html`
- Create: `extension/sidepanel.js`
- Modify: `extension/manifest.json`
- Modify: `extension/popup.html`, `extension/popup.js`

**Interfaces:**
- Consumes: giao thức panel ↔ server từ Task 4; `chrome.storage.local.wsUrl` do popup ghi.
- Produces: `extension/sidepanel.html` mở được qua `chrome.sidePanel.open({ windowId })`.

- [ ] **Step 1: Khai báo side panel trong manifest**

Trong `extension/manifest.json`: thêm `"sidePanel"` vào mảng `permissions`, và thêm khối cùng cấp với `"action"`:

```json
  "side_panel": {
    "default_path": "sidepanel.html"
  },
```

Chưa đổi `version` — Task 7 làm việc đó cùng một lúc với server.

- [ ] **Step 2: Thêm nút mở panel vào popup**

Trong `extension/popup.html`, chèn ngay sau nút `save`:

```html
  <button id="openPanel">Mở khung chat</button>
```

Trong `extension/popup.js`, thêm vào cuối file:

```js
// chrome.sidePanel.open() requires a user gesture, and a click inside the popup
// is one. Opening from the service worker instead throws.
document.getElementById("openPanel").addEventListener("click", async () => {
  const { id } = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: id });
  window.close();
});
```

- [ ] **Step 3: Viết `extension/sidepanel.html`**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    :root { color-scheme: dark; }
    body {
      font-family: system-ui, sans-serif;
      margin: 0; height: 100vh; display: flex; flex-direction: column;
      background: #1a1a1a; color: #eee; font-size: 13px;
    }
    header {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; border-bottom: 1px solid #333;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #b3261e; flex: none; }
    .dot.connected { background: #188038; }
    .dot.connecting { background: #e8a100; }
    select, button {
      background: #2a2a2a; color: #eee; border: 1px solid #444;
      border-radius: 4px; font-size: 12px; padding: 4px 8px; cursor: pointer;
    }
    button.primary { background: #d97757; border-color: #d97757; color: #fff; }
    button:disabled { opacity: .45; cursor: default; }
    #group { font-size: 11px; color: #888; margin-left: auto; }
    #log { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
    .msg { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
    .msg.user { align-self: flex-end; background: #2f2f2f; padding: 6px 10px; border-radius: 10px; max-width: 85%; }
    .msg.error { color: #f28b82; }
    .tool { font-size: 11px; color: #d97757; }
    footer { border-top: 1px solid #333; padding: 8px; }
    .toolbar { display: flex; gap: 6px; margin-bottom: 6px; }
    textarea {
      width: 100%; box-sizing: border-box; resize: none; min-height: 56px;
      background: #2a2a2a; color: #eee; border: 1px solid #444;
      border-radius: 6px; padding: 8px; font: inherit;
    }
  </style>
</head>
<body>
  <header>
    <div class="dot" id="dot"></div>
    <select id="model">
      <option value="">Model mặc định</option>
      <option value="opus">Opus</option>
      <option value="sonnet">Sonnet</option>
      <option value="haiku">Haiku</option>
    </select>
    <span id="group"></span>
  </header>

  <div id="log"></div>

  <footer>
    <div class="toolbar">
      <button id="attach">Đưa tab này vào phiên</button>
      <button id="newSession">Phiên mới</button>
      <button id="stop" disabled>Dừng</button>
    </div>
    <textarea id="input" placeholder="Nhắn cho Claude… (Enter để gửi)"></textarea>
  </footer>

  <script src="sidepanel.js"></script>
</body>
</html>
```

- [ ] **Step 4: Viết `extension/sidepanel.js`**

```js
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
      if (!msg.ok) addMessage("error", msg.error || "Lượt chat thất bại.");
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

attachBtn.addEventListener("click", async () => {
  const { id } = await chrome.windows.getCurrent();
  send({ type: "attach_tab", windowId: id });
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
```

- [ ] **Step 5: Chạy lint**

```bash
npm run lint
```

Kỳ vọng: 0 lỗi. `sidepanel.js` khớp block `extension/**/*.js` trong `eslint.config.mjs`, đã có sẵn globals của browser.

- [ ] **Step 6: Nghiệm thu tay trong Chrome**

Playwright không lái được side panel, nên bước này là bằng chứng duy nhất cho phần UI. Làm đủ, đừng bỏ qua.

1. Chạy bridge: `CC_CHROME_TOKENS="paneltoken12345=huy" CC_CHROME_HOST=127.0.0.1 node server/index.js --http`
2. `chrome://extensions` → Reload extension.
3. Bấm icon → dán `ws://127.0.0.1:8787/ws?token=paneltoken12345` → **Lưu & kết nối lại** → badge xanh `on`.
4. Bấm icon lần nữa → **Mở khung chat**. Panel mở bên phải, chấm xanh, có tên tab group ở góc phải header.
5. Gõ `Mở tab mới vào example.com rồi tóm tắt trang đó` → Enter.
   Kỳ vọng: hiện `⚙ new_tab`, `⚙ get_page_text`, chữ chảy dần, kết thúc bằng một đoạn tóm tắt. Tab mới nằm trong tab group cam đúng tên hiển thị ở header.
6. Gõ một prompt dài rồi bấm **Dừng** giữa chừng → phải dừng ngay, hiện dòng đỏ "đã dừng theo yêu cầu", nút Dừng mờ đi.
7. Mở một trang bất kỳ ở tab khác, quay lại panel bấm **Đưa tab này vào phiên** → dòng `✓ Đã đưa vào phiên: <tiêu đề>`, tab bị kéo vào group cam.
8. Đóng panel, mở lại → hỏi `Nãy tôi vừa nhờ bạn làm gì?` → phải nhớ được (bằng chứng `--resume` chạy).
9. Bấm **Phiên mới** → log trống, hỏi lại câu trên → phải không nhớ.

Ghi lại kết quả từng bước 1-9 vào báo cáo. Bước nào hỏng thì dừng và báo, đừng đi tiếp.

- [ ] **Step 7: Commit**

```bash
git add extension/sidepanel.html extension/sidepanel.js extension/manifest.json extension/popup.html extension/popup.js
git commit -m "Add the side panel chat UI

The panel holds its own socket and its own reconnect backoff, including the rule
that an open event is not proof of a connection — the server refuses by closing
with a code after a completed handshake, so only a received frame counts."
```

---

### Task 7: Version 3.4.0, test đóng gói, tài liệu

**Files:**
- Modify: `extension/manifest.json`, `server/index.js`, `server/package.json`, `server/package-lock.json`
- Modify: `test/build.test.mjs`
- Modify: `README.md`, `CLAUDE.md`, `.claude/commands/ccchrome.md`

**Interfaces:**
- Consumes: mọi thứ từ Task 1-6.
- Produces: không có interface code mới.

- [ ] **Step 1: Thêm file panel vào test đóng gói**

Trong `test/build.test.mjs` dòng 34, đổi danh sách file bắt buộc:

```js
for (const required of ["manifest.json", "background.js", "popup.html", "popup.js", "sidepanel.html", "sidepanel.js", "icons/icon128.png"]) {
```

Thêm ngay sau khối kiểm tra version (sau dòng 53) một khẳng định nữa — manifest thiếu khai báo side panel thì zip vẫn hợp lệ về hình thức nhưng khung chat không mở được, và không có gì bắt lỗi đó:

```js
check("manifest declares the side panel", zippedManifest.side_panel?.default_path === "sidepanel.html",
  JSON.stringify(zippedManifest.side_panel));
check("manifest requests the sidePanel permission", (zippedManifest.permissions || []).includes("sidePanel"),
  JSON.stringify(zippedManifest.permissions));
```

- [ ] **Step 2: Chạy test đóng gói để thấy nó thất bại**

```bash
HEADED=1 node test/build.test.mjs
```

Kỳ vọng: PASS hết (Task 6 đã thêm cả file lẫn khai báo manifest). Nếu FAIL thì Task 6 làm thiếu — sửa ở đây.

- [ ] **Step 3: Bump ba chỗ version lên 3.4.0**

- `extension/manifest.json`: `"version": "3.4.0"`
- `server/index.js`: `const VERSION = "3.4.0";` (dòng 45)
- `server/package.json`: `"version": "3.4.0"`

```bash
cd server && npm install --package-lock-only && cd ..
grep -n '"version"' extension/manifest.json server/package.json; grep -n '^const VERSION' server/index.js
```

- [ ] **Step 4: Chạy toàn bộ test**

```bash
HEADED=1 npm test && node test/agent-session.test.mjs && node test/panel-auth.test.mjs
```

Kỳ vọng: mọi bộ đều `ALL TESTS PASSED`. Trên macOS **không** đặt `CHROME_PATH`.

- [ ] **Step 5: Ghi mục khung chat vào README**

Thêm một mục mới vào `README.md` (tiếng Việt), nội dung tối thiểu:

- Cách chạy bridge local: `CC_CHROME_TOKENS="<token>=<tên>" CC_CHROME_HOST=127.0.0.1 node server/index.js --http`, và lưu ý **phải là 127.0.0.1** thì khung chat mới bật.
- Cách mở: bấm icon extension → **Mở khung chat**.
- Giới hạn, nói thẳng: Claude **không đọc được tab bạn đang xem**; muốn nó làm việc trên trang nào thì bấm **Đưa tab này vào phiên**.
- Agent trong panel **không đọc/ghi được file trên máy** (`--tools ""`).
- Lịch sử hội thoại nằm ở Claude Code, server không lưu.
- Biến môi trường mới: `CC_CHROME_PANEL_TOOLS` (mặc định `mcp__chrome`) — thêm vào bảng biến môi trường sẵn có.

- [ ] **Step 6: Ghi vào mục "Security invariants" của `CLAUDE.md`**

Thêm hai gạch đầu dòng vào mục đó, tiếng Anh như phần còn lại của file:

```markdown
- The side panel gets its own `/panel` websocket rather than sharing `/ws`,
  because `registry.attach()` closes the previous connection on token collision
  and the panel would evict the service worker's bridge. It reuses the same
  origin check, the same `Sec-WebSocket-Protocol` token, and the same refusal
  codes, plus 4004 for a bridge that is not bound to loopback. `/panel` and the
  `AgentSession` spawn behind it exist **only** when `HOST` is loopback — a
  public bridge that spawned `claude` would let anyone holding a valid token run
  the team's logged-in account on the host.
- `attach_tab` in `extension/background.js` is the one sanctioned way a tab
  outside the session group gets in, and it is not an MCP tool — Claude cannot
  call it, only the user pressing the panel button can. It takes a `windowId`
  and acts on that window's active tab; it must never accept a caller-supplied
  `tabId`, which would rebuild the pre-3.0.0 hole with the added twist of
  granting lasting access rather than a single action.
```

- [ ] **Step 7: Bổ sung `.claude/commands/ccchrome.md`**

Subcommand `local` hiện hướng dẫn chạy stdio mode, mà khung chat cần http mode trên loopback. Thêm vào cuối mục `## \`local\`` một nhánh mới: cách chạy http mode trên `127.0.0.1` với `CC_CHROME_TOKENS`, URL để dán vào popup, và câu nhắc rằng khung chat chỉ có ở chế độ này.

- [ ] **Step 8: Build lại và commit**

```bash
npm run build && ls -la dist/
git add -A
git commit -m "Release 3.4.0: in-browser side panel chat

Also pins the packaging test to the side panel: a zip missing sidepanel.html or
a manifest missing the side_panel declaration used to look perfectly valid while
the chat simply refused to open."
```

---

## Sau khi xong

Đừng gộp vào `main` và đừng deploy lên home server. Huy tự test kỹ trước rồi mới quyết định thông báo cho team. Nếu cần review, chạy `superpowers:requesting-code-review` **sau khi** Huy xác nhận chạy ổn — quy ước làm việc của Huy là verify trước, code-review sau.
