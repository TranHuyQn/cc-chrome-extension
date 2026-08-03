# Kế hoạch thực thi: gia cố bảo mật bản 2.0.0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vá 5 vấn đề bảo mật/độ bền trong Claude Code Chrome Bridge và đưa repo về trạng thái sẵn sàng deploy staging.

**Architecture:** Không đổi kiến trúc ba tầng (Claude Code → MCP server → extension). Mọi thay đổi nằm ở tầng bắt tay WebSocket, vòng đời MCP session, và cách phân phối token. `server/index.js` được tách thành ba file theo trách nhiệm: `tokens.js` (kho token), `ratelimit.js` (chống dò secret), `index.js` (phần còn lại).

**Tech Stack:** Node.js ≥18 ESM, `ws` 8, `@modelcontextprotocol/sdk` 1.29, zod 3, Chrome MV3 (JS thuần, không build step), Playwright cho e2e, ESLint 10 flat config.

Spec nguồn: `docs/superpowers/specs/2026-08-03-security-hardening-design.md`

## Global Constraints

- Node ≥ 18, toàn bộ ESM. Không thêm dependency runtime nào cho `server/` — chỉ dùng built-in của Node cộng `ws`, `zod`, `@modelcontextprotocol/sdk` đã có.
- `ws` chỉ được thêm vào `test/package.json`, không vào `server/package.json`.
- Extension là JS thuần, không có build step. Không được thêm bundler.
- Trong stdio mode, stdout là kênh giao thức MCP — chỉ log qua `log()` (tức `console.error`). Không `console.log` trong `server/*.js`.
- Hàm inject vào trang (`pageXxx` trong `extension/background.js`) không được đụng tới trong kế hoạch này.
- `npm run lint` phải sạch trước mọi commit. Hook `PostToolUse` trong `.claude/settings.json` đã tự chạy ESLint sau mỗi lần ghi file `.js`/`.mjs` — sửa hết lỗi nó báo trước khi đi tiếp.
- Toàn bộ test đang có phải tiếp tục pass sau mỗi task. Đó là lưới an toàn cho việc tách file.
- Code và comment viết bằng tiếng Anh. Commit message tiếng Anh. Tài liệu người dùng (`README.md`) tiếng Việt.
- Lệnh chạy test trên máy này: `HEADED=1 npm test`, **để `CHROME_PATH` trống**. Google Chrome bản stable ≥137 đã bỏ cờ `--load-extension`/`--disable-extensions-except` nên không nạp được extension unpacked; Playwright's Chromium (đã có sẵn trong cache máy) vẫn nhận. Extension service worker cũng không xuất hiện ở chế độ headless trên macOS, nên bắt buộc `HEADED=1`. Phát hiện ở Task 1, ghi chi tiết trong `CLAUDE.md`.
- Ba con số version phải khớp nhau ở mọi thời điểm sau Task 8: `extension/manifest.json`, hằng `VERSION` trong `server/index.js`, `server/package.json`.

## File Structure

| File | Trách nhiệm | Task |
|---|---|---|
| `server/tokens.js` | **Tạo.** Class `TokenStore`: nạp token tĩnh, cấp/thu hồi token động, lưu bền vững | 2 |
| `server/ratelimit.js` | **Tạo.** Class `RateLimiter` + hàm `clientIp` | 6 |
| `server/index.js` | **Sửa.** Bắt tay WebSocket, định nghĩa 23 tool, vòng đời MCP session | 2,3,4,6,7,8 |
| `extension/background.js` | **Sửa.** Gửi token qua subprotocol, dịch close code thành thông báo tiếng Việt | 4,5 |
| `test/origin.test.mjs` | **Tạo.** Chứng minh Chrome gửi `Origin`, và client không phải extension bị chặn | 1,3 |
| `test/session-ttl.test.mjs` | **Tạo.** Vòng đời MCP session, không cần Chromium | 7 |
| `test/e2e.mjs` | **Sửa.** `CHROME_PATH`, ca kiểm origin ở stdio mode | 1,3 |
| `test/e2e-http.mjs` | **Sửa.** `CHROME_PATH`, subprotocol, close code, rate-limit, trần token | 1,3,4,5,6 |
| `test/build.test.mjs` | **Sửa.** `CHROME_PATH`, kiểm ba version khớp nhau | 1,8 |
| `test/package.json` | **Sửa.** Thêm `ws` | 1 |
| `package.json` | **Sửa.** Thêm script `test:origin`, `test:session`, cập nhật `test` | 1,7 |
| `deploy/Dockerfile` | **Sửa.** `COPY server/*.js` thay vì chỉ `index.js` | 2 |
| `deploy/docker-compose.yml` | **Sửa.** Thêm `CC_CHROME_TRUST_PROXY=1` | 6 |
| `deploy/chrome-bridge.service` | **Sửa.** Thêm `CC_CHROME_TRUST_PROXY=1` | 6 |
| `README.md` | **Sửa.** Sửa khẳng định sai về bảo mật, bổ sung 4 biến môi trường, ghi chú nâng cấp 2.0.0 | 3,6,7,8 |
| `CLAUDE.md` | **Sửa.** Cập nhật mục "Security invariants" | 8 |

---

### Task 1: Cho test chạy được trên máy dev và chứng minh giả định về Origin

Toàn bộ mô hình xác thực dựa trên việc Chrome gửi `Origin: chrome-extension://<id>`. Task này chứng minh điều đó trước khi Task 3 dựa vào nó. Nếu giả định sai, dừng lại và báo — cả kế hoạch phải thiết kế lại.

**Files:**
- Modify: `test/e2e.mjs:151-158`, `test/e2e-http.mjs:125-132`, `test/build.test.mjs:56-63`
- Modify: `test/package.json`
- Modify: `package.json`
- Create: `test/origin.test.mjs`

**Interfaces:**
- Consumes: không có.
- Produces: biến môi trường `CHROME_PATH` (đường dẫn Chrome, rỗng thì để Playwright tự lo) và `HEADED=1` (chạy có giao diện) dùng chung cho mọi file test. Script npm `test:origin`.

- [ ] **Step 1: Thêm `ws` vào dependency của test**

Sửa `test/package.json` thành:

```json
{
  "name": "cc-bridge-e2e",
  "private": true,
  "type": "module",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "playwright": "^1.50.0",
    "ws": "^8.18.0"
  }
}
```

Lý do cần: các ca kiểm origin cần một WebSocket client thuần Node, và `ws` không gửi header `Origin` — đúng thứ cần để chứng minh kết nối không phải extension bị chặn.

Chạy: `cd test && npm install && cd ..`

- [ ] **Step 2: Bỏ hardcode đường dẫn Chromium ở cả ba file test**

Trong `test/e2e.mjs`, `test/e2e-http.mjs`, `test/build.test.mjs`, thay dòng

```js
  headless: true,
  executablePath: "/opt/pw-browsers/chromium",
```

bằng

```js
  headless: process.env.HEADED !== "1",
  // CI points CHROME_PATH at its own Chromium; without it Playwright uses the
  // browser it manages itself.
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
```

- [ ] **Step 3: Viết test chứng minh Chrome gửi Origin**

Tạo `test/origin.test.mjs`:

```js
// Proves the invariant the entire auth model rests on: Chrome sends
// `Origin: chrome-extension://<id>` when the extension's service worker opens a
// WebSocket. If this ever stopped being true, every connection would be
// rejected once the origin check is mandatory.
//
// Usage: CHROME_PATH="..." node test/origin.test.mjs

import { WebSocketServer } from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(root, "extension");
const PORT = 9879;

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const seenOrigins = [];
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
wss.on("connection", (socket, req) => {
  seenOrigins.push(req.headers.origin ?? null);
  socket.close();
});

const userDataDir = mkdtempSync(join(tmpdir(), "cc-origin-probe-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: process.env.HEADED !== "1",
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
await sw.evaluate(async (wsUrl) => {
  await chrome.storage.local.set({ wsUrl });
}, `ws://127.0.0.1:${PORT}`);
await sw.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "reconnect" }, r)));

for (let i = 0; i < 40 && seenOrigins.length === 0; i++) await sleep(250);

check("extension opened a websocket connection", seenOrigins.length > 0);
check(
  "Chrome sends a chrome-extension:// Origin header",
  String(seenOrigins[0] || "").startsWith("chrome-extension://"),
  `origin=${JSON.stringify(seenOrigins[0])}`
);

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);

await context.close();
wss.close();
rmSync(userDataDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 4: Thêm script npm**

Trong `package.json`, phần `scripts`, thêm `test:origin` và đưa nó vào `test`:

```json
    "test:build": "node test/build.test.mjs",
    "test:origin": "node test/origin.test.mjs",
    "test:stdio": "node test/e2e.mjs",
    "test:http": "node test/e2e-http.mjs",
    "test": "node test/build.test.mjs && node test/origin.test.mjs && node test/e2e.mjs && node test/e2e-http.mjs"
```

- [ ] **Step 5: Chạy test origin — đây là bước quyết định của cả kế hoạch**

Chạy:

```bash
HEADED=1 npm run test:origin
```

Kỳ vọng: cả hai dòng `PASS`, kết thúc `ALL TESTS PASSED`.

**Nếu FAIL ở dòng "extension opened a websocket connection"** — nhiều khả năng Chrome ở chế độ headless không nạp extension. Chạy lại với `HEADED=1`:

```bash
HEADED=1 npm run test:origin
```

Nếu bản headed pass, ghi lại trong `CLAUDE.md` rằng test cần `HEADED=1` trên máy này và dùng biến đó cho mọi bước sau.

**Nếu FAIL ở dòng "Chrome sends a chrome-extension:// Origin header"** — giả định nền của cả kế hoạch sai. **DỪNG LẠI, báo cáo, không làm tiếp Task 2.**

- [ ] **Step 6: Chạy lại toàn bộ test cũ để chắc chắn không hỏng gì**

Chạy:

```bash
HEADED=1 npm test
```

Kỳ vọng: cả bốn suite in `ALL TESTS PASSED`.

- [ ] **Step 7: Lint và commit**

```bash
npm run lint
git add test/ package.json
git commit -m "test: make browser path configurable and prove Chrome sends Origin

The three suites hardcoded a CI-only Chromium path, so nothing could be
verified on a developer machine. They now read CHROME_PATH and fall back to
Playwright's own browser.

Adds a probe that asserts Chrome sends Origin: chrome-extension:// from the
service worker — the assumption the upcoming mandatory origin check depends on."
```

---

### Task 2: Tách `TokenStore` sang `server/tokens.js`

Refactor thuần, không đổi hành vi. Làm sớm để các task sau có chỗ đặt code mới mà không phình `index.js`.

**Files:**
- Create: `server/tokens.js`
- Modify: `server/index.js:22-26` (import), `:48-129` (xoá class), `:572` (khởi tạo)
- Modify: `deploy/Dockerfile:5`

**Interfaces:**
- Consumes: không có.
- Produces: `export class TokenStore` với constructor `new TokenStore(log)` trong đó `log` là `(...args) => void`. Thành viên công khai: `size` (getter, số), `pairSecret` (string|null), `stateFile` (string), `has(token) → boolean`, `get(token) → string|undefined`, `names() → string[]`, `pair(name) → string`, `revoke(token) → boolean` (ném `Error` nếu là token tĩnh).

- [ ] **Step 1: Tạo `server/tokens.js`**

Cắt nguyên class `TokenStore` từ `server/index.js` (dòng 48–129) sang file mới, thêm import và tham số `log`:

```js
// Token storage for http mode: static tokens configured by the admin, plus
// dynamic tokens issued on demand by the self-service /pair endpoint.
//
//   CC_CHROME_TOKENS:      "token1=alice,token2=bob"  (name optional)
//   CC_CHROME_TOKENS_FILE: path to a JSON file { "token1": "alice", ... }
//   CC_CHROME_PAIR_SECRET: team secret; enables POST /pair
//   CC_CHROME_STATE_FILE:  where dynamic tokens are persisted

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

export class TokenStore {
  constructor(log) {
    this.log = log;
    this.static = new Map();
    this.dynamic = new Map();
    this.pairSecret = process.env.CC_CHROME_PAIR_SECRET || null;
    this.stateFile = process.env.CC_CHROME_STATE_FILE || "./ccchrome-tokens.json";

    if (process.env.CC_CHROME_TOKENS_FILE) {
      const parsed = JSON.parse(readFileSync(process.env.CC_CHROME_TOKENS_FILE, "utf8"));
      for (const [token, name] of Object.entries(parsed)) this.static.set(token, String(name));
    }
    if (process.env.CC_CHROME_TOKENS) {
      for (const entry of process.env.CC_CHROME_TOKENS.split(",")) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf("=");
        if (eq > 0) this.static.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
        else this.static.set(trimmed, trimmed.slice(0, 6));
      }
    }
    for (const token of this.static.keys()) {
      if (token.length < 8) {
        log(`FATAL: token '${token.slice(0, 2)}...' is shorter than 8 chars. Generate strong tokens, e.g.: openssl rand -hex 16`);
        process.exit(1);
      }
    }
    if (this.pairSecret && this.pairSecret.length < 12) {
      log("FATAL: CC_CHROME_PAIR_SECRET must be at least 12 chars. Generate one with: openssl rand -hex 16");
      process.exit(1);
    }
    if (this.pairSecret && existsSync(this.stateFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.stateFile, "utf8"));
        for (const [token, name] of Object.entries(parsed)) this.dynamic.set(token, String(name));
        if (this.dynamic.size) log(`Restored ${this.dynamic.size} paired token(s) from ${this.stateFile}`);
      } catch (err) {
        log(`WARNING: could not read state file ${this.stateFile}: ${err.message}`);
      }
    }
  }

  get size() {
    return this.static.size + this.dynamic.size;
  }

  has(token) {
    return this.static.has(token) || this.dynamic.has(token);
  }

  get(token) {
    return this.static.get(token) ?? this.dynamic.get(token);
  }

  names() {
    return [...this.static.values(), ...this.dynamic.values()];
  }

  persist() {
    try {
      writeFileSync(this.stateFile, JSON.stringify(Object.fromEntries(this.dynamic), null, 2));
    } catch (err) {
      this.log(`WARNING: could not persist tokens to ${this.stateFile}: ${err.message}`);
    }
  }

  pair(name) {
    const token = randomBytes(16).toString("hex");
    this.dynamic.set(token, name);
    this.persist();
    this.log(`Paired new token for '${name}' (${this.dynamic.size} dynamic token(s) total)`);
    return token;
  }

  revoke(token) {
    if (this.static.has(token)) {
      throw new Error("This token is configured statically (CC_CHROME_TOKENS); remove it from the server config instead.");
    }
    const existed = this.dynamic.delete(token);
    if (existed) this.persist();
    return existed;
  }
}
```

- [ ] **Step 2: Xoá class khỏi `server/index.js` và import vào**

Xoá toàn bộ khối dòng 36–129 (comment header của mục "Tokens" + class `TokenStore`). Thêm vào cụm import ở đầu file:

```js
import { TokenStore } from "./tokens.js";
```

Sửa dòng khởi tạo trong `mainHttp()` từ `const tokens = new TokenStore();` thành:

```js
  const tokens = new TokenStore(log);
```

Gỡ những import giờ không còn dùng ở `index.js`: kiểm tra `readFileSync`, `writeFileSync`, `existsSync`, `randomBytes` còn được dùng ở đâu nữa không — `readFileSync`/`existsSync` vẫn dùng cho endpoint tải extension, `randomBytes` vẫn dùng để sinh tên mặc định ở `/pair`, `writeFileSync` thì không còn. ESLint sẽ báo import thừa; xoá theo đúng những gì nó báo.

- [ ] **Step 3: Sửa Dockerfile để copy cả thư mục server**

`deploy/Dockerfile`, đổi dòng `COPY server/index.js ./` thành:

```dockerfile
COPY server/*.js ./
```

Đây là chỗ e2e test **không** bắt được lỗi (test chạy trực tiếp bằng node, không qua Docker), nên Step 5 phải build image thật.

- [ ] **Step 4: Chạy toàn bộ test**

```bash
npm run lint
HEADED=1 npm test
```

Kỳ vọng: lint sạch, cả bốn suite `ALL TESTS PASSED`. Refactor thuần nên không được có bất kỳ thay đổi kết quả nào.

- [ ] **Step 5: Build Docker image và kiểm `/health`**

Cần OrbStack đang chạy. Nếu `docker info` báo lỗi, nhờ Huy mở OrbStack rồi chạy lại.

```bash
docker build -f deploy/Dockerfile -t cc-bridge-test .
docker run --rm -d --name cc-bridge-check -p 8799:8787 \
  -e CC_CHROME_TOKENS=test-token-0123456789=tester cc-bridge-test
sleep 2
curl -sS http://127.0.0.1:8799/health
docker rm -f cc-bridge-check
```

Kỳ vọng: `curl` trả `{"ok":true,"version":"...","extensionsConnected":0}`. Nếu container chết ngay với `Cannot find module './tokens.js'` thì Dockerfile chưa được sửa đúng.

- [ ] **Step 6: Commit**

```bash
git add server/tokens.js server/index.js deploy/Dockerfile
git commit -m "refactor: extract TokenStore into server/tokens.js

Pure move, no behavior change. index.js was 784 lines and the upcoming
rate limiter and session sweeper would push it past 950.

The Dockerfile copied only index.js, so it now copies server/*.js —
a mistake the e2e suites cannot catch because they run node directly."
```

---

### Task 3: Bắt buộc Origin hợp lệ

**Files:**
- Modify: `server/index.js` — thêm helper `originAllowed`, sửa handler `connection` (stdio) và `upgrade` (http)
- Modify: `test/e2e.mjs` — ca kiểm client không có Origin bị chặn
- Modify: `test/origin.test.mjs` — không đổi (đã xong ở Task 1)
- Modify: `README.md` — mục "Lưu ý bảo mật"

**Interfaces:**
- Consumes: `TokenStore` từ Task 2.
- Produces: `function originAllowed(origin: string): boolean` ở phạm vi module trong `index.js`; hằng `EXTENSION_ID` đọc từ `CC_CHROME_EXTENSION_ID`. Close code `4003` = "origin not allowed".

- [ ] **Step 1: Viết ca test thất bại ở stdio mode**

Trong `test/e2e.mjs`, thêm import ở đầu file:

```js
import WebSocket from "ws";
```

Thêm khối này ngay trước phần `// error paths` (khoảng dòng 274):

```js
// A non-extension local process must not be able to drive the browser. The `ws`
// client sends no Origin header, which is exactly the case that used to slip
// through.
const rawCloseCode = await new Promise((resolve) => {
  const raw = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
  raw.on("close", (code) => resolve(code));
  raw.on("error", () => resolve(-1));
  setTimeout(() => resolve(0), 5000);
});
check("raw ws client without Origin is rejected with 4003", rawCloseCode === 4003, `code=${rawCloseCode}`);
```

- [ ] **Step 2: Chạy test để xác nhận nó fail**

```bash
HEADED=1 npm run test:stdio
```

Kỳ vọng: `FAIL  raw ws client without Origin is rejected with 4003  -- code=0` (kết nối được chấp nhận, không bị đóng). Đây chính là lỗ hổng, giờ đã có bằng chứng.

- [ ] **Step 3: Thêm helper kiểm origin vào `server/index.js`**

Đặt ngay sau dòng khai báo `const log = ...` (khoảng dòng 34):

```js
// Only the Chrome extension may drive the bridge. An absent Origin used to slip
// through this check, which let any local process connect and control the
// browser. Optionally pin to one extension id for a tighter guarantee — left
// unset by default because a Load-unpacked extension gets a path-derived id
// that differs from the signed .crx build.
const EXTENSION_ID = process.env.CC_CHROME_EXTENSION_ID || null;

function originAllowed(origin) {
  if (!origin.startsWith("chrome-extension://")) return false;
  return EXTENSION_ID ? origin === `chrome-extension://${EXTENSION_ID}` : true;
}
```

- [ ] **Step 4: Siết check ở stdio mode**

Trong `mainStdio()`, thay khối `wss.on("connection", ...)`:

```js
  wss.on("connection", (socket, req) => {
    const origin = req.headers.origin || "";
    if (!originAllowed(origin)) {
      log(`Rejected connection from origin: ${origin || "(none)"}`);
      socket.close(4003, "origin not allowed");
      return;
    }
    registry.attach(socket, "default", "local");
  });
```

- [ ] **Step 5: Siết check ở http mode, đổi cách từ chối**

Trong `mainHttp()`, thay toàn bộ handler `httpServer.on("upgrade", ...)`:

```js
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    // Rejections complete the handshake and then close with a specific code.
    // A browser cannot read the HTTP status of a failed upgrade, so destroying
    // the socket would reach the extension as an indistinguishable 1006 — the
    // user would see "server not running" for what is really a config error.
    // A rejected socket is never registered, so it can do nothing meanwhile.
    const reject = (code, reason) => {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(code, reason));
    };

    const origin = req.headers.origin || "";
    if (!originAllowed(origin)) {
      log(`Rejected ws upgrade from origin: ${origin || "(none)"}`);
      return reject(4003, "origin not allowed");
    }

    const token = url.searchParams.get("token");
    if (!token || !tokens.has(token)) {
      log("Rejected ws upgrade: bad token");
      return reject(4001, "invalid token");
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      registry.attach(ws, token, tokens.get(token));
    });
  });
```

Ghi chú: đường token vẫn đọc từ query ở bước này — Task 4 sẽ đổi. Tách hai việc để mỗi task có một lý do thất bại duy nhất.

- [ ] **Step 6: Chạy test, xác nhận pass**

```bash
npm run lint
HEADED=1 npm test
```

Kỳ vọng: `PASS  raw ws client without Origin is rejected with 4003`, và toàn bộ suite còn lại vẫn `ALL TESTS PASSED` — đặc biệt là extension thật vẫn kết nối được ở cả `e2e.mjs` lẫn `e2e-http.mjs`.

- [ ] **Step 7: Sửa khẳng định sai trong README**

Trong `README.md`, mục "Lưu ý bảo mật", thay gạch đầu dòng đầu tiên:

```markdown
- WebSocket server chỉ bind `127.0.0.1` và **bắt buộc** kết nối phải có origin `chrome-extension://` — process khác trên máy (script Node, curl…) không giả làm extension được, máy khác trong mạng LAN không kết nối được. Muốn siết thêm, đặt `CC_CHROME_EXTENSION_ID=<id>` để chỉ chấp nhận đúng một extension (ID in ra khi chạy `npm run build`).
```

- [ ] **Step 8: Commit**

```bash
git add server/index.js test/e2e.mjs README.md
git commit -m "fix: reject websocket connections without a chrome-extension Origin

An empty Origin bypassed the check, so any local process could connect to
the bridge and drive Chrome — while the README promised the opposite.

http mode now completes the handshake before closing with code 4003 instead
of destroying the socket: browsers cannot read the status of a failed
upgrade, so a destroyed socket is indistinguishable from an unreachable
server."
```

---

### Task 4: Chuyển token sang WebSocket subprotocol

**Files:**
- Modify: `server/index.js` — `handleProtocols`, `tokenFromSubprotocol`, `authToken`, handler `upgrade`
- Modify: `extension/background.js:47-58` (hàm `connect`)
- Modify: `test/e2e-http.mjs` — ca kiểm subprotocol và close code

**Interfaces:**
- Consumes: `originAllowed`, `reject(code, reason)` từ Task 3.
- Produces: hằng `SUBPROTOCOL_PREFIX = "ccchrome.token."`; `function tokenFromSubprotocol(req): string|null`; `authToken(req)` (bỏ tham số `url`). Close code `4001` = token sai, `4002` = thiếu subprotocol.

- [ ] **Step 1: Viết ca test thất bại**

Trong `test/e2e-http.mjs`, thêm import đầu file:

```js
import WebSocket from "ws";
```

Thêm helper ngay sau khai báo `sleep` (khoảng dòng 34):

```js
// Opens a raw websocket and resolves with the close code, so tests can assert
// exactly why the server refused.
function rawWsCloseCode(url, { origin, protocols } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, protocols, origin ? { headers: { origin } } : undefined);
    ws.on("open", () => { ws.close(); resolve(0); });
    ws.on("close", (code) => resolve(code));
    ws.on("error", () => resolve(-1));
    setTimeout(() => resolve(-2), 5000);
  });
}

const EXT_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
```

Thêm khối kiểm ngay trước phần `// --- extension package downloads`:

```js
// --- websocket auth moved out of the URL ------------------------------------

const base = `ws://127.0.0.1:${MCP_PORT}/ws`;

check(
  "token in the query string is refused",
  (await rawWsCloseCode(`${base}?token=${TOKEN_B}`, { origin: EXT_ORIGIN })) === 4002,
  "expected close 4002"
);
check(
  "valid token in the subprotocol is accepted",
  (await rawWsCloseCode(base, { origin: EXT_ORIGIN, protocols: [`ccchrome.token.${TOKEN_B}`] })) === 0,
  "expected the connection to open"
);
check(
  "bad token in the subprotocol is refused",
  (await rawWsCloseCode(base, { origin: EXT_ORIGIN, protocols: ["ccchrome.token.nope-000000"] })) === 4001,
  "expected close 4001"
);
check(
  "missing Origin is refused even with a valid token",
  (await rawWsCloseCode(base, { protocols: [`ccchrome.token.${TOKEN_B}`] })) === 4003,
  "expected close 4003"
);
```

- [ ] **Step 2: Chạy test để xác nhận fail**

```bash
HEADED=1 npm run test:http
```

Kỳ vọng: `FAIL  token in the query string is refused` (hiện vẫn được chấp nhận, trả 0) và `FAIL  valid token in the subprotocol is accepted` (server chưa đọc subprotocol nên trả 4001).

- [ ] **Step 3: Đọc token từ subprotocol ở server**

Trong `server/index.js`, thêm cạnh helper `originAllowed`:

```js
// Browsers cannot set custom headers on a WebSocket, so the token travels in
// Sec-WebSocket-Protocol rather than the query string — a query string ends up
// verbatim in every reverse-proxy access log.
const SUBPROTOCOL_PREFIX = "ccchrome.token.";

function tokenFromSubprotocol(req) {
  const header = req.headers["sec-websocket-protocol"] || "";
  for (const raw of header.split(",")) {
    const proto = raw.trim();
    if (proto.startsWith(SUBPROTOCOL_PREFIX)) return proto.slice(SUBPROTOCOL_PREFIX.length);
  }
  return null;
}

// `ws` omits Sec-WebSocket-Protocol from the 101 response unless a protocol is
// selected here, and a browser that offered protocols and got none back fails
// the handshake with no usable error. Both modes install this: stdio normally
// sees no subprotocol, but a local URL that still carries ?token= would make
// the extension offer one.
function pickSubprotocol(protocols) {
  for (const proto of protocols) {
    if (proto.startsWith(SUBPROTOCOL_PREFIX)) return proto;
  }
  return false;
}
```

- [ ] **Step 4: Cho `ws` echo lại subprotocol ở cả hai mode**

Đây là chỗ dễ sai nhất của cả kế hoạch. Trong `mainHttp()`, sửa khai báo `wss`:

```js
  const wss = new WebSocketServer({ noServer: true, handleProtocols: pickSubprotocol });
```

Và trong `mainStdio()`, sửa khai báo `wss`:

```js
  const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT, handleProtocols: pickSubprotocol });
```

- [ ] **Step 5: Đổi handler `upgrade` sang dùng subprotocol**

Thay hai khối lấy token trong handler `upgrade` (phần Task 3 để lại):

```js
    const token = tokenFromSubprotocol(req);
    if (!token) {
      log("Rejected ws upgrade: no token subprotocol (extension older than 2.0.0?)");
      return reject(4002, "missing token subprotocol");
    }
    if (!tokens.has(token)) {
      log("Rejected ws upgrade: bad token");
      return reject(4001, "invalid token");
    }
```

- [ ] **Step 6: Bỏ nốt đường token qua query ở `/mcp`**

Sửa `authToken` trong `mainHttp()`:

```js
  const authToken = (req) => {
    const token = bearerOf(req);
    return token && tokens.has(token) ? token : null;
  };
```

Sửa cả ba chỗ gọi từ `authToken(req, url)` thành `authToken(req)` (endpoint `/pair/status`, `DELETE /pair`, và `/mcp`).

- [ ] **Step 7: Extension gửi token qua subprotocol**

Trong `extension/background.js`, hàm `connect`, thay khối tạo socket:

```js
  let socket;
  try {
    // The user pastes a URL that still carries ?token=... — strip it and send
    // the token as a subprotocol so it never appears in a proxy access log.
    const parsed = new URL(wsUrl);
    const token = parsed.searchParams.get("token");
    parsed.searchParams.delete("token");
    socket = token
      ? new WebSocket(parsed.toString(), [`ccchrome.token.${token}`])
      : new WebSocket(parsed.toString());
  } catch (err) {
    setStatus("disconnected", { lastError: String(err) });
    scheduleReconnect();
    return;
  }
```

- [ ] **Step 8: Chạy toàn bộ test**

```bash
npm run lint
HEADED=1 npm test
```

Kỳ vọng: bốn ca mới đều PASS, và — quan trọng nhất — `extension connects with alice token` trong `e2e-http.mjs` vẫn PASS. Ca đó dùng URL `ws://127.0.0.1:PORT/ws?token=...` không đổi, nên nó đang chứng minh đúng luồng người dùng thật: URL cũ vẫn dán được, token đi qua subprotocol.

Nếu `extension connects with alice token` FAIL trong khi ca raw-ws subprotocol PASS, gần như chắc chắn là `handleProtocols` chưa được khai báo đúng ở Step 4 — browser fail handshake còn client `ws` thì không.

- [ ] **Step 9: Commit**

```bash
git add server/index.js extension/background.js test/e2e-http.mjs
git commit -m "fix: carry the websocket token in a subprotocol, not the query string

Caddy logs the full request URI, so every connection wrote the member's
token into the access log. Browsers cannot set headers on a WebSocket, so
the token now travels in Sec-WebSocket-Protocol.

The extension strips ?token= from whatever URL the user pasted, so nobody
has to change what is saved in the popup. The query-string path is gone
from /mcp as well; every client already used Authorization: Bearer."
```

---

### Task 5: Extension hiện đúng lý do bị từ chối

**Files:**
- Modify: `extension/background.js:85-91` (`socket.onclose`)
- Modify: `test/e2e-http.mjs` — ca kiểm popup hiện lỗi

**Interfaces:**
- Consumes: close code 4001/4002/4003 từ Task 3 và 4.
- Produces: hằng `CLOSE_REASONS` (map số → chuỗi tiếng Việt) trong `background.js`. `status.lastError` chứa lý do đọc được.

- [ ] **Step 1: Viết ca test thất bại**

Trong `test/e2e-http.mjs`, thêm khối này ngay sau bốn ca của Task 4:

```js
// The popup is the only place a member can see why the bridge will not
// connect, so a rejected handshake must reach it as a readable reason rather
// than the generic "is the MCP server running?".
const extensionId = new URL(sw.url()).host;
await sw.evaluate(async (wsUrl) => {
  await chrome.storage.local.set({ wsUrl });
}, `ws://127.0.0.1:${MCP_PORT}/ws?token=definitely-not-a-real-token`);

const popup = await context.newPage();
await popup.goto(`chrome-extension://${extensionId}/popup.html`);
let popupError = "";
for (let i = 0; i < 40; i++) {
  popupError = await popup.textContent("#error");
  if (popupError && popupError.trim()) break;
  await sleep(250);
}
check("popup explains a rejected token", /[Tt]oken/.test(popupError), `popup #error = ${JSON.stringify(popupError)}`);
await popup.close();
```

- [ ] **Step 2: Chạy test để xác nhận fail**

```bash
HEADED=1 npm run test:http
```

Kỳ vọng: `FAIL  popup explains a rejected token` — popup hiện rỗng hoặc "websocket error (is the MCP server running?)", không có chữ "token".

- [ ] **Step 3: Dịch close code thành thông báo trong extension**

Trong `extension/background.js`, thêm ngay sau khối hằng ở đầu file (sau `NETWORK_BUFFER_MAX`):

```js
// The server refuses a handshake by closing with one of these codes. Without
// this mapping every refusal reaches the user as a generic socket error, and a
// misconfigured token looks exactly like a server that is not running.
const CLOSE_REASONS = {
  4001: "Token sai hoặc đã bị thu hồi — chạy lại /ccchrome connect",
  4002: "Extension đã cũ so với server — tải lại bản mới rồi Load unpacked đè lên",
  4003: "Server từ chối: origin không hợp lệ",
};
```

Thay `socket.onclose`:

```js
  socket.onclose = (event) => {
    if (ws !== socket) return;
    clearInterval(keepaliveTimer);
    const reason = CLOSE_REASONS[event.code];
    setStatus("disconnected", reason ? { lastError: reason } : {});
    ws = null;
    scheduleReconnect();
  };
```

- [ ] **Step 4: Chạy toàn bộ test**

```bash
npm run lint
HEADED=1 npm test
```

Kỳ vọng: `PASS  popup explains a rejected token`, mọi suite khác vẫn xanh.

Lưu ý: ca test này để extension ở trạng thái token sai. Nếu có ca nào phía sau cần extension kết nối lại, phải trỏ `wsUrl` về token hợp lệ trước — kiểm tra thứ tự khi chạy.

- [ ] **Step 5: Commit**

```bash
git add extension/background.js test/e2e-http.mjs
git commit -m "feat: show why the bridge refused to connect in the popup

There are now three distinct refusal reasons, all of which used to surface
as 'websocket error (is the MCP server running?)'. A member hitting a
revoked token had no way to tell that from a server outage."
```

---

### Task 6: Rate-limit `/pair` và giới hạn số token

**Files:**
- Create: `server/ratelimit.js`
- Modify: `server/tokens.js` — thêm getter `dynamicSize`
- Modify: `server/index.js` — endpoint `POST /pair`
- Modify: `test/e2e-http.mjs` — hai khối test mới, và biến môi trường của server test
- Modify: `deploy/docker-compose.yml`, `deploy/chrome-bridge.service`, `README.md`

**Interfaces:**
- Consumes: `TokenStore` từ Task 2.
- Produces: `export class RateLimiter` với constructor `new RateLimiter({ limit: number, windowMs: number })` và các phương thức `retryAfter(key) → number` (0 nghĩa là cho phép, >0 là số giây phải chờ), `fail(key) → void`, `reset(key) → void`. `export function clientIp(req, trustProxy) → string`. Getter `TokenStore.dynamicSize → number`.

- [ ] **Step 1: Viết ca test thất bại**

Trong `test/e2e-http.mjs`, thêm `CC_CHROME_MAX_TOKENS: "2"` vào `env` của `serverProc` (khoảng dòng 58–66):

```js
  env: {
    ...process.env,
    CC_CHROME_PORT: String(MCP_PORT),
    CC_CHROME_HOST: "127.0.0.1",
    CC_CHROME_TOKENS: `${TOKEN_A}=alice,${TOKEN_B}=bob`,
    CC_CHROME_PAIR_SECRET: PAIR_SECRET,
    CC_CHROME_STATE_FILE: stateFile,
    CC_CHROME_DIST_DIR: join(root, "dist"),
    CC_CHROME_MAX_TOKENS: "2",
  },
```

Thêm hai khối này ở **cuối file**, ngay trước dòng `console.log` tổng kết. Đặt cuối vì cả hai đều làm bẩn trạng thái server (đầy trần token, khoá IP), sẽ phá các ca khác nếu đặt trước.

```js
// --- pairing abuse limits ---------------------------------------------------

// Dynamic tokens are capped so a leaked secret cannot be turned into an
// unbounded token factory. carol's token was revoked above, so the store is
// empty again and the cap of 2 applies cleanly from here.
async function pairAs(name) {
  return await fetch(`http://127.0.0.1:${MCP_PORT}/pair`, {
    method: "POST",
    headers: { authorization: `Bearer ${PAIR_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}
check("pair below the cap succeeds", (await pairAs("cap-one")).status === 200);
check("pair at the cap succeeds", (await pairAs("cap-two")).status === 200);
const overCap = await pairAs("cap-three");
check("pair beyond CC_CHROME_MAX_TOKENS is refused", overCap.status === 429, `status=${overCap.status}`);

// The pairing secret is the one value a human chooses, so it is the one worth
// throttling. Tokens are 128-bit random and not worth guessing.
const attemptStatuses = [];
let sawRateLimit = false;
let retryAfter = null;
for (let i = 0; i < 14; i++) {
  const attempt = await fetch(`http://127.0.0.1:${MCP_PORT}/pair`, {
    method: "POST",
    headers: { authorization: "Bearer wrong-secret-000000", "content-type": "application/json" },
    body: "{}",
  });
  attemptStatuses.push(attempt.status);
  if (attempt.status === 429) {
    sawRateLimit = true;
    retryAfter = attempt.headers.get("retry-after");
    break;
  }
}
check("repeated bad pairing secrets get rate limited", sawRateLimit, attemptStatuses.join(","));
check("rate limited response carries Retry-After", !!retryAfter && Number(retryAfter) > 0, `retry-after=${retryAfter}`);
```

- [ ] **Step 2: Chạy test để xác nhận fail**

```bash
HEADED=1 npm run test:http
```

Kỳ vọng: `FAIL  pair beyond CC_CHROME_MAX_TOKENS is refused  -- status=200` và `FAIL  repeated bad pairing secrets get rate limited  -- 401,401,401,...`.

- [ ] **Step 3: Tạo `server/ratelimit.js`**

```js
// Fixed-window rate limiting for the pairing endpoint. Tokens are 128-bit
// random values not worth guessing; the pairing secret is chosen by a human and
// only required to be 12 characters, so it is the value that needs throttling.

export class RateLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map(); // key -> { count, resetAt }
    setInterval(() => this.sweep(), windowMs).unref();
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }

  // 0 when the caller may proceed, otherwise the seconds left to wait.
  retryAfter(key) {
    const entry = this.hits.get(key);
    if (!entry) return 0;
    const now = Date.now();
    if (entry.resetAt <= now) {
      this.hits.delete(key);
      return 0;
    }
    if (entry.count < this.limit) return 0;
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  }

  fail(key) {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count++;
    }
  }

  reset(key) {
    this.hits.delete(key);
  }
}

// X-Forwarded-For is trivially forged, so it is honored only when the operator
// states this process really is behind a proxy that sets it. Otherwise an
// attacker would bypass the limiter by sending a different value every request.
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) return String(forwarded).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}
```

- [ ] **Step 4: Thêm getter `dynamicSize` vào `TokenStore`**

Trong `server/tokens.js`, thêm ngay dưới getter `size`:

```js
  get dynamicSize() {
    return this.dynamic.size;
  }
```

- [ ] **Step 5: Nối rate limiter vào `POST /pair`**

Trong `server/index.js`, thêm import:

```js
import { RateLimiter, clientIp } from "./ratelimit.js";
```

Trong `mainHttp()`, ngay sau khối khởi tạo `tokens`, thêm:

```js
  const TRUST_PROXY = process.env.CC_CHROME_TRUST_PROXY === "1";
  const MAX_TOKENS = Number(process.env.CC_CHROME_MAX_TOKENS || 100);
  const pairLimiter = new RateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 });
  if (tokens.pairSecret && !TRUST_PROXY) {
    log("Note: CC_CHROME_TRUST_PROXY is not set, so /pair rate limiting keys on the socket address.");
    log("      Behind a reverse proxy that is the proxy itself — set CC_CHROME_TRUST_PROXY=1 there.");
  }
```

Thay khối `if (url.pathname === "/pair" && req.method === "POST")`:

```js
    if (url.pathname === "/pair" && req.method === "POST") {
      if (!tokens.pairSecret) return json(res, 404, { error: "pairing disabled on this server (CC_CHROME_PAIR_SECRET not set)" });

      const ip = clientIp(req, TRUST_PROXY);
      const wait = pairLimiter.retryAfter(ip);
      if (wait > 0) {
        res.setHeader("retry-after", String(wait));
        return json(res, 429, { error: `too many failed pairing attempts; retry in ${wait}s` });
      }
      if (!isPairSecret(bearerOf(req))) {
        pairLimiter.fail(ip);
        log(`Failed pairing attempt from ${ip}`);
        return json(res, 401, { error: "bad pairing secret. Send 'Authorization: Bearer <CC_CHROME_PAIR_SECRET>'." });
      }
      pairLimiter.reset(ip);

      if (tokens.dynamicSize >= MAX_TOKENS) {
        return json(res, 429, { error: `token limit reached (${MAX_TOKENS}); ask the admin to revoke unused tokens or raise CC_CHROME_MAX_TOKENS` });
      }

      let body = {};
      try {
        body = (await readBody(req)) || {};
      } catch {
        return json(res, 400, { error: "invalid JSON body" });
      }
      const name = String(body.name || "").trim().slice(0, 40) || `user-${randomBytes(2).toString("hex")}`;
      const token = tokens.pair(name);
      return json(res, 200, { token, name, ...publicUrls(req, token) });
    }
```

- [ ] **Step 6: Chạy toàn bộ test**

```bash
npm run lint
HEADED=1 npm test
```

Kỳ vọng: bốn ca mới PASS, mọi ca cũ vẫn PASS.

- [ ] **Step 7: Đặt sẵn `CC_CHROME_TRUST_PROXY` trong cấu hình deploy**

`deploy/docker-compose.yml`, trong `environment` của service `chrome-bridge`, thêm dòng:

```yaml
      CC_CHROME_TRUST_PROXY: "1"
```

`deploy/chrome-bridge.service`, thêm sau dòng `Environment=CC_CHROME_HOST=127.0.0.1`:

```ini
# Server đứng sau reverse proxy (Caddy/nginx) nên IP thật nằm ở X-Forwarded-For.
Environment=CC_CHROME_TRUST_PROXY=1
```

- [ ] **Step 8: Bổ sung bảng cấu hình trong README**

Thêm ba dòng vào bảng "Cấu hình" trong `README.md`:

```markdown
| `CC_CHROME_TRUST_PROXY` | — | Đặt `1` khi server đứng sau reverse proxy: rate-limit đọc IP thật từ `X-Forwarded-For`. Không đặt thì dùng IP socket. |
| `CC_CHROME_MAX_TOKENS` | `100` | Trần số token động, chặn việc biến secret bị lộ thành máy phát token. |
| `CC_CHROME_EXTENSION_ID` | — | Chỉ chấp nhận đúng một extension ID (ID in ra khi `npm run build`). Không đặt thì chấp nhận mọi `chrome-extension://`. |
```

Và một đoạn ngắn dưới mục "Quản lý token":

```markdown
- `/pair` bị giới hạn 10 lần sai secret trong 15 phút cho mỗi IP; vượt thì trả 429 kèm `Retry-After`. Nếu server đứng sau proxy mà quên đặt `CC_CHROME_TRUST_PROXY=1`, mọi người sẽ bị tính chung một IP (IP của proxy) — server có log cảnh báo lúc khởi động.
```

- [ ] **Step 9: Commit**

```bash
git add server/ratelimit.js server/tokens.js server/index.js test/e2e-http.mjs deploy/ README.md
git commit -m "feat: rate limit /pair and cap the number of dynamic tokens

The pairing secret is admin-chosen and only required to be 12 characters,
so it is the one value in the system worth guessing. Ten failures per IP
per 15 minutes now yields 429 with Retry-After.

X-Forwarded-For is only trusted when CC_CHROME_TRUST_PROXY=1, so exposing
the port directly cannot be used to bypass the limiter with a forged
header. Both deploy configs set it."
```

---

### Task 7: Dọn MCP session hết hạn

**Files:**
- Modify: `server/index.js` — `sessions`, endpoint `/health`, timer quét
- Create: `test/session-ttl.test.mjs`
- Modify: `package.json` — script `test:session`
- Modify: `README.md` — bảng cấu hình

**Interfaces:**
- Consumes: không có.
- Produces: `/health` trả thêm trường `mcpSessions: number`. Biến `CC_CHROME_SESSION_TTL_MS` (mặc định `1800000`).

- [ ] **Step 1: Viết test thất bại**

Tạo `test/session-ttl.test.mjs` — không cần Chromium, chỉ kiểm vòng đời session:

```js
// MCP sessions used to live forever: a client that vanished without closing
// left its transport in the map for the lifetime of the process. This runs a
// server with a two-second TTL and checks the session is actually reaped.
//
// Usage: node test/session-ttl.test.mjs   (requires `npm install` in test/ and server/)

import { spawn } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8789;
const TOKEN = "ttl-test-token-0123456789";

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const health = async () => await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();

const serverProc = spawn("node", [join(root, "server", "index.js"), "--http"], {
  env: {
    ...process.env,
    CC_CHROME_PORT: String(PORT),
    CC_CHROME_HOST: "127.0.0.1",
    CC_CHROME_TOKENS: `${TOKEN}=ttl-tester`,
    CC_CHROME_SESSION_TTL_MS: "2000",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

let up = false;
for (let i = 0; i < 40; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) { up = true; break; }
  } catch {}
  await sleep(250);
}
check("server is up", up);
if (!up) process.exit(1);

check("no sessions before any client connects", (await health()).mcpSessions === 0, JSON.stringify(await health()));

const client = new Client({ name: "ttl-test", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
}));
await client.listTools();
check("session is tracked after connecting", (await health()).mcpSessions === 1, JSON.stringify(await health()));

// The client stops talking without closing — exactly the leak this fixes.
await sleep(6000);
const after = await health();
check("idle session is reaped after the TTL", after.mcpSessions === 0, JSON.stringify(after));

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
serverProc.kill();
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Thêm script npm rồi chạy để xác nhận fail**

Trong `package.json`:

```json
    "test:session": "node test/session-ttl.test.mjs",
    "test": "node test/build.test.mjs && node test/origin.test.mjs && node test/e2e.mjs && node test/e2e-http.mjs && node test/session-ttl.test.mjs"
```

Chạy: `npm run test:session`

Kỳ vọng: `FAIL  no sessions before any client connects  -- {"ok":true,...}` — `/health` chưa có trường `mcpSessions` nên so sánh với `0` là `undefined === 0` → false.

- [ ] **Step 3: Ghi nhận hoạt động và dọn session hết hạn**

Trong `server/index.js`, `mainHttp()`, thay dòng khai báo `sessions` và thêm timer ngay dưới:

```js
  const SESSION_TTL_MS = Number(process.env.CC_CHROME_SESSION_TTL_MS || 30 * 60 * 1000);
  const sessions = new Map(); // mcp-session-id -> { transport, token, lastSeen }

  // A client that disappears without closing (laptop shut, session killed) used
  // to leave its transport here forever.
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastSeen <= SESSION_TTL_MS) continue;
      log(`Closing MCP session ${id}: idle for more than ${SESSION_TTL_MS}ms`);
      sessions.delete(id);
      try { session.transport.close(); } catch {}
    }
  }, Math.min(5 * 60 * 1000, SESSION_TTL_MS)).unref();
```

Sửa `onsessioninitialized`:

```js
        onsessioninitialized: (id) => sessions.set(id, { transport, token, lastSeen: Date.now() }),
```

Trong nhánh xử lý request đã có `sessionId`, thêm ngay sau kiểm tra token khớp:

```js
        session.lastSeen = Date.now();
```

Đặt sau dòng `if (session.token !== token) { ... }` và trước dòng đọc `body`.

- [ ] **Step 4: Đưa số session vào `/health`**

Sửa endpoint `/health`:

```js
    if (url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        version: VERSION,
        extensionsConnected: [...registry.connections.values()].filter((c) => c.connected).length,
        mcpSessions: sessions.size,
      });
    }
```

- [ ] **Step 5: Chạy test**

```bash
npm run lint
npm run test:session
```

Kỳ vọng: cả bốn dòng PASS. Ca cuối chứng minh session idle bị dọn — mất khoảng 8 giây.

- [ ] **Step 6: Chạy toàn bộ test**

```bash
HEADED=1 npm test
```

Kỳ vọng: năm suite đều `ALL TESTS PASSED`.

- [ ] **Step 7: Ghi biến mới vào README**

Thêm dòng vào bảng "Cấu hình":

```markdown
| `CC_CHROME_SESSION_TTL_MS` | `1800000` | Session MCP không hoạt động quá lâu sẽ bị đóng và dọn. |
```

- [ ] **Step 8: Commit**

```bash
git add server/index.js test/session-ttl.test.mjs package.json README.md
git commit -m "fix: reap idle MCP sessions instead of leaking them

A client that vanished without closing left its transport in the session
map for the life of the process. Sessions now carry lastSeen and a sweeper
closes anything idle past CC_CHROME_SESSION_TTL_MS.

/health reports mcpSessions so the leak is observable from outside."
```

---

### Task 8: Đồng bộ version 2.0.0 và cập nhật tài liệu

**Files:**
- Modify: `extension/manifest.json:4`, `server/index.js:32`, `server/package.json:3`
- Modify: `test/build.test.mjs` — assertion ba version khớp
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: không có.
- Produces: không có API mới. Bất biến: ba con số version luôn khớp, có test bảo vệ.

- [ ] **Step 1: Viết assertion thất bại**

Trong `test/build.test.mjs`, thêm ngay sau khối `// --- zip contents`:

```js
// --- version consistency ----------------------------------------------------

// Three files carried three different versions before 2.0.0 and nothing caught
// it. chrome_status reports the server number while the build names artifacts
// after the manifest, so a mismatch is invisible until someone debugs remotely.
const serverPkg = JSON.parse(readFileSync(join(root, "server", "package.json"), "utf8"));
const serverSource = readFileSync(join(root, "server", "index.js"), "utf8");
const serverVersion = (serverSource.match(/^const VERSION = "([^"]+)";$/m) || [])[1];
check("server/index.js declares a VERSION", !!serverVersion, 'no `const VERSION = "..."` line found');
check(
  "manifest, server VERSION and server package.json agree",
  manifest.version === serverVersion && manifest.version === serverPkg.version,
  `manifest=${manifest.version} index.js=${serverVersion} package.json=${serverPkg.version}`
);
```

- [ ] **Step 2: Chạy để xác nhận fail**

```bash
HEADED=1 npm run test:build
```

Kỳ vọng: `FAIL  manifest, server VERSION and server package.json agree  -- manifest=1.1.0 index.js=1.2.0 package.json=1.0.0`.

- [ ] **Step 3: Đặt cả ba về 2.0.0**

- `extension/manifest.json`: `"version": "2.0.0"`
- `server/index.js`: `const VERSION = "2.0.0";`
- `server/package.json`: `"version": "2.0.0"`

- [ ] **Step 4: Chạy toàn bộ test**

```bash
npm run lint
HEADED=1 npm test
```

Kỳ vọng: năm suite `ALL TESTS PASSED`, trong đó có dòng version mới.

- [ ] **Step 5: Ghi chú nâng cấp bắt buộc trong README**

Thêm mục này ngay dưới tiêu đề chính của `README.md`, trước phần "Kiến trúc":

```markdown
> **Nâng lên 2.0.0 — bắt buộc cập nhật cả hai phía.** Token giờ đi qua WebSocket
> subprotocol thay vì query string, nên extension 1.x **không** kết nối được
> server 2.0.0 và ngược lại. Sau khi deploy server, mọi thành viên phải tải lại
> `extension.zip` và Load unpacked đè lên bản cũ. URL đã lưu trong popup không
> cần đổi — extension tự tách token ra khỏi URL.
```

- [ ] **Step 6: Cập nhật mục bất biến bảo mật trong CLAUDE.md**

Thay toàn bộ mục "Security invariants — do not relax without being asked" trong `CLAUDE.md`:

```markdown
## Security invariants — do not relax without being asked

- Both modes require `Origin: chrome-extension://…` on the WebSocket handshake.
  An absent Origin is a rejection, not a pass — that hole let any local process
  drive the browser. `CC_CHROME_EXTENSION_ID` optionally pins one extension id.
- The http-mode token travels in `Sec-WebSocket-Protocol` (`ccchrome.token.<t>`),
  never in the query string, because reverse proxies log the full URI. The
  server must echo the selected subprotocol via `handleProtocols` or browsers
  fail the handshake with no usable error.
- Refusals complete the handshake and close with a code (4001 bad token, 4002
  missing subprotocol, 4003 bad origin) so the extension can explain itself.
  Destroying the socket reaches the browser as an indistinguishable 1006.
- `POST /pair` is rate limited per IP. `X-Forwarded-For` is honored only when
  `CC_CHROME_TRUST_PROXY=1`, otherwise a forged header would bypass the limiter.
- Tokens ≥ 8 chars, pair secret ≥ 12 — the server rejects weaker values on
  purpose. Dynamic tokens are capped by `CC_CHROME_MAX_TOKENS`.
- The deploy path assumes TLS terminates at Caddy (`deploy/`); port 8787 is
  never exposed directly.
```

- [ ] **Step 7: Commit**

```bash
git add extension/manifest.json server/index.js server/package.json test/build.test.mjs README.md CLAUDE.md
git commit -m "chore: release 2.0.0 with matching version numbers everywhere

manifest said 1.1.0, the server reported 1.2.0 and package.json said 1.0.0.
build.test now fails if the three ever diverge again.

Major bump because the websocket handshake changed: a 1.x extension cannot
talk to a 2.0.0 server."
```

---

### Task 9: Kiểm chứng cuối trước khi bàn giao staging

Không viết code. Chạy đủ mọi thứ một lượt trên trạng thái cuối cùng và dựng bằng chứng để Huy deploy.

**Files:** không sửa file nào.

**Interfaces:**
- Consumes: toàn bộ Task 1–8.
- Produces: `dist/extension.zip` + `dist/extension.crx` phiên bản 2.0.0, và một bản tóm tắt trạng thái.

- [ ] **Step 1: Lint sạch**

```bash
npm run lint
```

Kỳ vọng: không in ra gì, exit 0.

- [ ] **Step 2: Toàn bộ test từ trạng thái sạch**

```bash
HEADED=1 npm test
```

Kỳ vọng: năm suite, mỗi suite kết thúc `ALL TESTS PASSED`. Ghi lại số ca PASS của từng suite để đưa vào báo cáo.

- [ ] **Step 3: Build package extension**

```bash
npm run build
```

Kỳ vọng: in `Built Claude Code Chrome Bridge v2.0.0`, sinh `dist/claude-code-chrome-bridge-v2.0.0.zip`, `dist/extension.zip`, và hai file `.crx` tương ứng. Ghi lại **Extension ID** in ra — Huy cần nó nếu muốn đặt `CC_CHROME_EXTENSION_ID` trên staging.

- [ ] **Step 4: Build Docker image và kiểm bằng container thật**

```bash
docker build -f deploy/Dockerfile -t cc-bridge:2.0.0 .
docker run --rm -d --name cc-bridge-staging-check -p 8799:8787 \
  -e CC_CHROME_PAIR_SECRET=staging-check-secret-0123 \
  -e CC_CHROME_TRUST_PROXY=1 \
  cc-bridge:2.0.0
sleep 2
curl -sS http://127.0.0.1:8799/health
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8799/pair \
  -H 'Authorization: Bearer wrong-secret-here' -H 'content-type: application/json' -d '{}'
docker rm -f cc-bridge-staging-check
```

Kỳ vọng: `/health` trả `{"ok":true,"version":"2.0.0","extensionsConnected":0,"mcpSessions":0}`, và lệnh `/pair` sai secret trả `401`.

- [ ] **Step 5: Kiểm lại git đang sạch và lịch sử đúng**

```bash
git status --short
git log --oneline -9
```

Kỳ vọng: `git status` không còn gì ngoài `dist/` (đã gitignore). Lịch sử có đủ tám commit của Task 1–8 cộng commit spec.

- [ ] **Step 6: Báo cáo cho Huy**

Tổng hợp và gửi:

- Năm suite test đã pass, kèm số ca của từng suite
- Version 2.0.0, Extension ID in ra lúc build
- Đường dẫn `dist/extension.zip` để phân phối cho team
- Biến môi trường mới cần đặt trên staging: `CC_CHROME_TRUST_PROXY=1` (đã có sẵn trong docker-compose), tuỳ chọn `CC_CHROME_EXTENSION_ID`, `CC_CHROME_MAX_TOKENS`, `CC_CHROME_SESSION_TTL_MS`
- **Điều duy nhất máy local không kiểm chứng được:** Caddy có forward header `Sec-WebSocket-Protocol` khi proxy upgrade hay không. Cách kiểm trên staging: sau khi deploy, dán URL `wss://<domain>/ws?token=<token>` vào popup extension; badge chuyển `on` xanh là Caddy forward đúng. Nếu badge đỏ và popup hiện "Token sai hoặc đã bị thu hồi" trong khi token đúng, nghĩa là header bị strip — khi đó phương án dự phòng là chuyển sang auth-after-connect (đã cân nhắc ở vòng thiết kế, xem spec mục "Rủi ro còn lại")
- Nhắc lại: mọi thành viên phải cài lại extension, bản 1.x không nối được server 2.0.0
