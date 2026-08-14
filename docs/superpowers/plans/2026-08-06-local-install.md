# Local-Install Model (3.5.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mỗi người tự chạy bridge trên máy mình như một dịch vụ nền; phân phối qua GitHub Releases; bịt lỗ `javascript_eval` trước khi phát hành.

**Architecture:** Bridge chạy `--http` bind `127.0.0.1:8787` dưới launchd (macOS) / systemd user (Linux). Claude Code nối qua `/mcp`, extension qua `/ws`, side panel qua `/panel` — cùng một tiến trình. Không còn stdio mode, không còn server trung gian.

**Tech Stack:** Node 18+ ESM, `ws`, `@modelcontextprotocol/sdk`, bash, launchd/systemd, Chrome MV3.

**Spec:** `docs/superpowers/specs/2026-08-06-local-install-design.md`

## Global Constraints

- **Không thêm dependency npm mới.** `server/` giữ đúng 3: `@modelcontextprotocol/sdk`, `ws`, `zod`.
- **Không thêm build step cho `extension/`.**
- **Version `3.5.0`** ở ba chỗ: `extension/manifest.json`, `const VERSION` trong `server/index.js`, `server/package.json`; rồi `npm install --package-lock-only` trong `server/`.
- **`npm run lint` phải 0 lỗi.** Hook `PostToolUse` lint mọi file `.js`/`.mjs` ngay sau khi ghi.
- **Không sửa `resolveTabInGroup()`.**
- **Giữ nguyên code server chung** — `/pair`, `tokens.js`, `ratelimit.js`, `CC_CHROME_TRUST_PROXY` không đụng tới. Chỉ bỏ hai endpoint `/install.sh` và `/uninstall.sh`.
- **Không đụng vào phần side panel** (`server/agent.js`, `extension/sidepanel.*`, `/panel`) trừ chỗ plan nói rõ.
- Tài liệu người dùng (`README.md`, `.claude/commands/ccchrome.md`, output của script) **tiếng Việt**. Code, comment, commit message **tiếng Anh**.
- **macOS: test trình duyệt cần `HEADED=1` và để trống `CHROME_PATH`.**
- Test theo khuôn có sẵn: script node thuần, helper `check(name, cond, detail)`, đếm `failures`, `process.exit(failures === 0 ? 0 : 1)`.
- **Script bash phải chạy được với `set -euo pipefail`** và phải idempotent.

## File Structure

| File | Trạng thái | Trách nhiệm |
|---|---|---|
| `extension/background.js` | sửa | 2 chốt bảo mật; `DEFAULT_WS_URL` |
| `server/index.js` | sửa | bỏ `mainStdio()`, bỏ 2 endpoint installer, cảnh báo |
| `scripts/install.sh` | tạo | bộ cài đặt thật (thay bản sinh động) |
| `scripts/uninstall.sh` | tạo | gỡ đúng những gì install tạo |
| `scripts/service-unit.sh` | tạo | sinh nội dung plist/systemd unit, dùng chung cho cả hai script |
| `scripts/build-release.mjs` | tạo | đóng gói tarball kèm `node_modules` |
| `test/security-eval.test.mjs` | tạo | chuỗi 3 lệnh khai thác phải thất bại |
| `test/install.test.mjs` | tạo | install + uninstall trong `HOME` giả |
| `test/e2e.mjs` | sửa | port từ MCP stdio sang MCP http |
| `deploy/chrome-bridge.service` | sửa | thêm cảnh báo mô hình cũ |
| `README.md`, `CLAUDE.md`, `.claude/commands/ccchrome.md` | sửa | tài liệu |

---

### Task 1: Bịt lỗ `javascript_eval` và `navigate`

Làm trước mọi thứ: đây là lỗ đang tồn tại trong bản 3.4.0 vừa merge, và mọi task sau chỉ làm nó lan rộng hơn.

**Files:**
- Modify: `extension/background.js` (`navigate` ~dòng 1028, `javascript_eval` ~dòng 1168)
- Create: `test/security-eval.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `assertScriptableUrl(tab)` và `resolveTab(params)` — đã có trong `extension/background.js`.
- Produces: không có interface mới.

- [ ] **Step 1: Viết test thất bại**

Tạo `test/security-eval.test.mjs`:

```js
// Pins the escape that shipped in 3.3.0 and survived into 3.4.0: three ordinary
// tool calls reached the extension's own privileged realm and read every tab in
// the browser, defeating resolveTabInGroup entirely.
//
//   new_tab                                   -> tab lands in the session group
//   navigate chrome-extension://<id>/popup.html  -> navigate never checked the target
//   javascript_eval chrome.tabs.query({})     -> ran via chrome.debugger, so
//                                                execInTab's guard never applied
//
// Both halves are asserted separately on purpose: removing either guard must
// turn this suite red on its own.
//
// Usage: HEADED=1 node test/security-eval.test.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(root, "extension");

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

const userDataDir = mkdtempSync(join(tmpdir(), "cc-seceval-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: process.env.HEADED !== "1",
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;

  const SESSION = "aaaaaaaa-1111-2222-3333-444444444444";

  // Open a tab inside the session's own group, the way a model legitimately would.
  const opened = await sw.evaluate(async (session) => {
    try {
      return { ok: true, value: await handlers.new_tab({ url: "https://example.com/", __session: session }) };
    } catch (e) { return { ok: false, error: e.message }; }
  }, SESSION);
  check("new_tab opened a tab in the session group", opened.ok, JSON.stringify(opened));
  const tabId = opened.value?.tabId;

  // --- guard 1: navigate must refuse the extension's own origin --------------

  const navigated = await sw.evaluate(async ([session, tid, id]) => {
    try {
      return { ok: true, value: await handlers.navigate({ tabId: tid, url: `chrome-extension://${id}/popup.html`, __session: session }) };
    } catch (e) { return { ok: false, error: e.message }; }
  }, [SESSION, tabId, extensionId]);
  check("navigate refuses a chrome-extension:// target", navigated.ok === false, JSON.stringify(navigated));

  const landed = await sw.evaluate(async (tid) => (await chrome.tabs.get(tid)).url, tabId);
  check("the tab did not move to the extension page", !landed.startsWith("chrome-extension://"), landed);

  // --- guard 2: javascript_eval must refuse an extension page ---------------
  // Reached here by putting the tab on that page directly, bypassing `navigate`,
  // so this guard is proven on its own rather than shielded by guard 1.

  await sw.evaluate(async ([tid, id]) => {
    await chrome.tabs.update(tid, { url: `chrome-extension://${id}/popup.html` });
    await new Promise((r) => setTimeout(r, 1500));
  }, [tabId, extensionId]);

  const evaled = await sw.evaluate(async ([session, tid]) => {
    try {
      return { ok: true, value: await handlers.javascript_eval({ tabId: tid, code: "chrome.tabs.query({}).then(t => t.length)", __session: session }) };
    } catch (e) { return { ok: false, error: e.message }; }
  }, [SESSION, tabId]);
  check("javascript_eval refuses an extension page", evaled.ok === false, JSON.stringify(evaled));
  check("the refusal names the browser-internal rule",
    /browser-internal page/.test(evaled.error || ""), evaled.error);
} finally {
  await context.close().catch(() => {});
  rmSync(userDataDir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Chạy test để chắc chắn nó thất bại**

```bash
HEADED=1 node test/security-eval.test.mjs
```

Kỳ vọng: FAIL ở "navigate refuses…" và "javascript_eval refuses…" — vì hiện tại **cả hai đều thành công**. Nếu chúng đã PASS thì dừng lại và báo: nghĩa là giả định về lỗ này sai.

- [ ] **Step 3: Thêm chốt vào `navigate`**

Trong `extension/background.js`, nhánh `else` của `navigate` (chỗ tính `fullUrl`):

```js
      if (!url) throw new Error("url is required (or set action to back/forward/reload)");
      const fullUrl = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
      // assertScriptableUrl checks where the tab IS, not where it is being sent.
      // Without a check on the destination, a tab already inside the session
      // group could be driven to this extension's own pages, whose realm has
      // chrome.tabs — which is the whole of the in-group restriction, gone.
      if (/^(chrome-extension|devtools):/i.test(fullUrl)) {
        throw new Error(`Cannot navigate to ${fullUrl} (browser-internal page). Use a normal web page.`);
      }
      await chrome.tabs.update(tab.id, { url: fullUrl });
```

- [ ] **Step 4: Thêm chốt vào `javascript_eval`**

```js
  async javascript_eval(params) {
    if (!params.code) throw new Error("code is required");
    const tab = await resolveTab(params);
    // execInTab calls this for chrome.scripting; this handler goes through
    // chrome.debugger instead, so it has to make the same check itself.
    // assertScriptableUrl already covers chrome-extension: — the bug was that
    // nothing here ever called it.
    assertScriptableUrl(tab);
    await ensureDebugger(tab.id, ["Runtime"]);
```

- [ ] **Step 5: Chạy test tới khi xanh**

```bash
HEADED=1 node test/security-eval.test.mjs
```

Kỳ vọng: `ALL TESTS PASSED`.

- [ ] **Step 6: Kiểm chứng từng chốt riêng bằng mutation**

Gỡ **chỉ** chốt trong `navigate`, chạy lại: phải đỏ ở đúng 2 check của guard 1 và xanh ở guard 2. Khôi phục. Gỡ **chỉ** chốt trong `javascript_eval`, chạy lại: phải đỏ ở guard 2. Khôi phục. Ghi cả hai kết quả vào báo cáo — nếu gỡ một chốt mà test vẫn xanh thì chốt đó không được canh.

- [ ] **Step 7: Hồi quy + lint + commit**

```bash
HEADED=1 node test/e2e.mjs && HEADED=1 node test/tabgroups.test.mjs && HEADED=1 node test/attach-tab.test.mjs
npm run lint
```

`test/e2e.mjs` gọi `javascript_eval` và `navigate` trên trang thường — phải vẫn xanh. Nếu đỏ, chốt đã quá tay.

Thêm `"test:seceval": "node test/security-eval.test.mjs"` vào `package.json` và chèn vào chuỗi `test`.

```bash
git add extension/background.js test/security-eval.test.mjs package.json
git commit -m "Close the javascript_eval escape from the extension's own pages

navigate never checked its destination and javascript_eval never called
assertScriptableUrl at all — it goes through chrome.debugger, so execInTab's
guard never applied to it. Three ordinary tool calls therefore reached a realm
holding chrome.tabs, which is the entire in-group restriction. Both halves are
guarded and each is pinned by its own assertion."
```

---

### Task 2: Bỏ stdio mode

**Files:**
- Modify: `server/index.js` (`mainStdio` ~644-672, `PORT` ~34, dòng cuối `if (MODE === "http")`)
- Modify: `extension/background.js` (`DEFAULT_WS_URL` dòng 7, chú thích `isLoopbackUrl` ~181)
- Modify: `test/e2e.mjs`

**Interfaces:**
- Consumes: `buildMcpServer`, `registry` — đã có.
- Produces: server chỉ còn một chế độ; `DEFAULT_WS_URL = "ws://127.0.0.1:8787/ws"`.

- [ ] **Step 1: Port `test/e2e.mjs` sang MCP http**

Thay class `McpClient` tự viết bằng client của SDK, đúng khuôn `test/e2e-http.mjs` đang dùng:

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TOKEN = "e2etoken1234567";
const PORT = 8794;

// The bridge now has exactly one mode: http bound to loopback. It is started as
// a child here rather than spawned per MCP session the way stdio used to be.
const server = spawn(process.execPath, [join(root, "server", "index.js"), "--http"], {
  env: { ...process.env, CC_CHROME_TOKENS: `${TOKEN}=e2e`, CC_CHROME_HOST: "127.0.0.1", CC_CHROME_PORT: String(PORT) },
  stdio: ["ignore", "ignore", "pipe"],
});
server.stderr.setEncoding("utf8");
server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* not up yet */ }
  await sleep(200);
}

const client = new Client({ name: "e2e", version: "1.0.0" }, { capabilities: {} });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
}));
```

Mọi lời gọi `client.callTool("<name>", args)` giữ nguyên — chỉ đường vận chuyển đổi.

Extension trong test này phải trỏ vào bridge mới: sau khi service worker lên, set
`chrome.storage.local.wsUrl = "ws://127.0.0.1:8794/ws?token=e2etoken1234567"` rồi gửi
`{type:"reconnect"}`, giống cách `test/e2e-http.mjs` đang làm.

Cuối cùng phải `server.kill()` trong `finally`, và toàn bộ thân bài phải nằm trong
`try/finally` để một lần timeout không để lại tiến trình giữ cổng 8794.

- [ ] **Step 2: Chạy để thấy nó thất bại**

```bash
HEADED=1 node test/e2e.mjs
```

Kỳ vọng: hỏng ở bước kết nối MCP — server chưa chấp nhận `--http` cùng lúc với cách gọi cũ, hoặc còn sót tham chiếu tới `McpClient`. Đọc lỗi trước khi sửa tiếp.

- [ ] **Step 3: Bỏ `mainStdio` khỏi `server/index.js`**

- Xoá toàn bộ hàm `mainStdio()`.
- Xoá `import { StdioServerTransport } ...` nếu không còn ai dùng.
- Xoá hằng `STDIO_SESSION_ID`.
- Dòng cuối file: thay `if (MODE === "http") await mainHttp(); else await mainStdio();` bằng `await mainHttp();`.
- `PORT`: bỏ nhánh 9876, thành `Number(process.env.CC_CHROME_PORT || 8787)`.
- `MODE`: nếu không còn chỗ nào đọc, xoá luôn. Nếu còn (ví dụ `chrome_status` báo mode), để nguyên giá trị `"http"`.

**Cờ `--http` vẫn phải được chấp nhận** dù giờ là mặc định — mọi tài liệu, unit file và script cũ đều truyền nó, và làm nó thành lỗi sẽ phá những thứ đó mà không được gì.

- [ ] **Step 4: Đổi URL mặc định của extension**

`extension/background.js` dòng 7:

```js
// The bridge has one mode now: http bound to loopback, installed as a per-user
// service. 9876 was the stdio bridge, which no longer exists.
const DEFAULT_WS_URL = "ws://127.0.0.1:8787/ws";
```

Sửa luôn chú thích của `isLoopbackUrl` (~dòng 181) — nó đang mô tả "stdio-mode bridge (ws://127.0.0.1:9876), which has no tokens at all", nay không còn đúng. Giữ nguyên hành vi hàm, chỉ sửa lời giải thích thành: loopback không token vẫn được thử vì bridge local có thể chưa cấu hình token, còn URL từ xa thì thiếu token là chắc chắn bị từ chối.

- [ ] **Step 5: Chạy test tới khi xanh**

```bash
HEADED=1 node test/e2e.mjs
node test/panel-auth.test.mjs && node test/panel-protocol.test.mjs && node test/session-ttl.test.mjs
HEADED=1 node test/origin.test.mjs
```

`test/origin.test.mjs` đang set `wsUrl` thành `ws://127.0.0.1:<PORT>` không path — kiểm xem nó còn chạy không; nếu hỏng vì đổi mặc định thì sửa test cho trỏ đúng, **không** sửa code cho vừa test.

- [ ] **Step 6: Lint + commit**

```bash
npm run lint
git add server/index.js extension/background.js test/e2e.mjs
git commit -m "Remove stdio mode; one bridge, http on loopback

The side panel already required an http bridge, so keeping stdio meant two
setups to document and one of them could not run the panel. It also removes a
known hole: the stdio bridge did no path routing, so a hand-typed /panel URL
landed in the extension bridge's handler and evicted the real connection."
```

---

### Task 3: `scripts/service-unit.sh` — sinh nội dung unit cho launchd và systemd

Tách riêng vì cả `install.sh` lẫn `uninstall.sh` đều cần biết đường dẫn và tên unit; để hai bản sao là cách chắc chắn nhất để chúng lệch nhau.

**Files:**
- Create: `scripts/service-unit.sh`

**Interfaces:**
- Produces, dùng bằng `source`:
  - `cc_platform()` → in `macos` hoặc `linux`, thoát 1 nếu khác.
  - `cc_unit_path()` → đường dẫn tuyệt đối tới file unit của nền tảng hiện tại.
  - `cc_unit_label()` → `com.ccchrome.bridge` (macOS) hoặc `ccchrome-bridge` (Linux).
  - `cc_write_unit <install_dir> <port>` → ghi file unit.
  - `cc_service_start` / `cc_service_stop` → nạp/gỡ, im lặng nếu chưa tồn tại.

- [ ] **Step 1: Viết `scripts/service-unit.sh`**

```bash
#!/usr/bin/env bash
# Shared by install.sh and uninstall.sh. Sourced, never executed directly:
# both scripts need the same unit path and label, and two copies of that
# knowledge is the surest way to have them disagree.

cc_platform() {
  case "$(uname -s)" in
    Darwin) echo macos ;;
    Linux)  echo linux ;;
    *) echo "Chưa hỗ trợ hệ điều hành: $(uname -s)" >&2; return 1 ;;
  esac
}

cc_unit_label() {
  [ "$(cc_platform)" = macos ] && echo "com.ccchrome.bridge" || echo "ccchrome-bridge"
}

cc_unit_path() {
  if [ "$(cc_platform)" = macos ]; then
    echo "$HOME/Library/LaunchAgents/com.ccchrome.bridge.plist"
  else
    echo "$HOME/.config/systemd/user/ccchrome-bridge.service"
  fi
}

# cc_write_unit <install_dir> <port>
cc_write_unit() {
  local dir="$1" port="$2" unit; unit="$(cc_unit_path)"
  mkdir -p "$(dirname "$unit")"
  if [ "$(cc_platform)" = macos ]; then
    cat > "$unit" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ccchrome.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>${dir}/server/index.js</string>
    <string>--http</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CC_CHROME_HOST</key><string>127.0.0.1</string>
    <key>CC_CHROME_PORT</key><string>${port}</string>
    <key>CC_CHROME_TOKENS_FILE</key><string>${dir}/tokens.json</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${dir}/logs/bridge.log</string>
  <key>StandardErrorPath</key><string>${dir}/logs/bridge.err.log</string>
</dict>
</plist>
PLIST
  else
    cat > "$unit" <<UNIT
[Unit]
Description=Claude Code Chrome Bridge
After=default.target

[Service]
ExecStart=$(command -v node) ${dir}/server/index.js --http
Environment=CC_CHROME_HOST=127.0.0.1
Environment=CC_CHROME_PORT=${port}
Environment=CC_CHROME_TOKENS_FILE=${dir}/tokens.json
Restart=always
RestartSec=3
StandardOutput=append:${dir}/logs/bridge.log
StandardError=append:${dir}/logs/bridge.err.log

[Install]
WantedBy=default.target
UNIT
  fi
}

cc_service_start() {
  if [ "$(cc_platform)" = macos ]; then
    launchctl bootout "gui/$(id -u)/com.ccchrome.bridge" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$(cc_unit_path)"
  else
    systemctl --user daemon-reload
    systemctl --user enable --now ccchrome-bridge.service
  fi
}

cc_service_stop() {
  if [ "$(cc_platform)" = macos ]; then
    launchctl bootout "gui/$(id -u)/com.ccchrome.bridge" >/dev/null 2>&1 || true
  else
    systemctl --user disable --now ccchrome-bridge.service >/dev/null 2>&1 || true
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
}
```

- [ ] **Step 2: Kiểm bằng tay rằng nó sinh đúng file**

```bash
cd /Volumes/Data/workspace/projects/personal/cc-chrome-extension
HOME=$(mktemp -d) bash -c 'source scripts/service-unit.sh; cc_write_unit /tmp/ccbridge 8787; echo "--- $(cc_unit_path) ---"; cat "$(cc_unit_path)"'
```

Kỳ vọng trên macOS: in ra plist hợp lệ, có đường dẫn node tuyệt đối, có `KeepAlive`.

Kiểm thêm plist có hợp lệ về cú pháp không:

```bash
HOME=$(mktemp -d) bash -c 'source scripts/service-unit.sh; cc_write_unit /tmp/ccbridge 8787; plutil -lint "$(cc_unit_path)"'
```

Kỳ vọng: `OK`.

- [ ] **Step 3: Commit**

```bash
git add scripts/service-unit.sh
git commit -m "Add shared service-unit helpers for launchd and systemd"
```

---

### Task 4: `scripts/install.sh`

**Files:**
- Create: `scripts/install.sh`
- Create: `test/install.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `scripts/service-unit.sh` (Task 3).
- Produces: 6 hiện vật liệt kê trong spec. Biến môi trường `CC_CHROME_SKIP_SERVICE=1` bỏ qua bước nạp service (chỉ ghi file unit) — **chỉ để test**, vì `launchctl bootstrap` tác động vào phiên đăng nhập thật của máy chạy test.

- [ ] **Step 1: Viết test thất bại**

Tạo `test/install.test.mjs`. Test chạy install rồi uninstall trong một `HOME` giả, nên không đụng gì tới máy thật:

```js
// Runs install.sh and uninstall.sh against a throwaway HOME. Nothing here
// touches the real machine: HOME is a temp dir, and CC_CHROME_SKIP_SERVICE
// keeps launchctl/systemctl out of the user's real login session.
//
// Usage: node test/install.test.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

const fakeHome = mkdtempSync(join(tmpdir(), "cc-install-home-"));
// A stub `claude` on PATH: the installer registers the MCP server through it,
// and the test asserts on what it was asked to do rather than needing the real
// CLI (which would mutate the tester's own MCP config).
const binDir = join(fakeHome, "bin");
mkdirSync(binDir, { recursive: true });
const claudeLog = join(fakeHome, "claude-calls.log");
writeFileSync(join(binDir, "claude"), `#!/usr/bin/env bash\necho "$@" >> "${claudeLog}"\nexit 0\n`, { mode: 0o755 });

const env = {
  ...process.env,
  HOME: fakeHome,
  PATH: `${binDir}:${process.env.PATH}`,
  CC_CHROME_SKIP_SERVICE: "1",
  CC_CHROME_SOURCE: root,     // install from this checkout instead of downloading
};

function run(script, args = []) {
  return execFileSync("bash", [join(root, "scripts", script), ...args], { env, encoding: "utf8" });
}

// --- install ---------------------------------------------------------------

const out = run("install.sh");
const installDir = join(fakeHome, ".cc-chrome-bridge");

check("creates the install directory", existsSync(join(installDir, "server", "index.js")));
check("ships the extension folder", existsSync(join(installDir, "extension", "manifest.json")));
check("ships node_modules", existsSync(join(installDir, "server", "node_modules", "ws")));
check("writes a token file", existsSync(join(fakeHome, ".ccchrome.json")));

const state = JSON.parse(readFileSync(join(fakeHome, ".ccchrome.json"), "utf8"));
check("the token is at least 16 hex chars", /^[0-9a-f]{16,}$/.test(state.token || ""), state.token);

check("installs the slash command", existsSync(join(fakeHome, ".claude", "commands", "ccchrome.md")));

const unit = process.platform === "darwin"
  ? join(fakeHome, "Library", "LaunchAgents", "com.ccchrome.bridge.plist")
  : join(fakeHome, ".config", "systemd", "user", "ccchrome-bridge.service");
check("writes the service unit", existsSync(unit));
check("the unit points at the installed server", readFileSync(unit, "utf8").includes(join(installDir, "server", "index.js")));

const calls = existsSync(claudeLog) ? readFileSync(claudeLog, "utf8") : "";
check("registers the MCP server with Claude Code", /mcp add .*chrome/.test(calls), calls);
check("registers it over http on loopback", /127\.0\.0\.1:8787\/mcp/.test(calls), calls);
check("prints the ws URL for the popup", /ws:\/\/127\.0\.0\.1:8787\/ws\?token=/.test(out), out.slice(-400));
check("tells the user to Load unpacked", /Load unpacked/i.test(out), out.slice(-400));

// --- rerun is an upgrade, not a second install -----------------------------

const before = state.token;
run("install.sh");
const after = JSON.parse(readFileSync(join(fakeHome, ".ccchrome.json"), "utf8")).token;
check("a rerun keeps the existing token", after === before, `${before} -> ${after}`);

// --- uninstall -------------------------------------------------------------

// Runtime data the server (not the installer) creates. Must survive.
mkdirSync(join(installDir, "panel"), { recursive: true });
writeFileSync(join(installDir, "panel", "session.jsonl"), "conversation\n");

const dry = run("uninstall.sh", ["--dry-run"]);
check("dry-run removes nothing", existsSync(join(fakeHome, ".ccchrome.json")));
check("dry-run says what it would remove", /\.ccchrome\.json/.test(dry), dry.slice(0, 400));

run("uninstall.sh");
check("removes the token file", !existsSync(join(fakeHome, ".ccchrome.json")));
check("removes the slash command", !existsSync(join(fakeHome, ".claude", "commands", "ccchrome.md")));
check("removes the service unit", !existsSync(unit));
check("removes the server directory", !existsSync(join(installDir, "server")));
check("KEEPS the panel conversation data", existsSync(join(installDir, "panel", "session.jsonl")));

const un = run("uninstall.sh");
check("a second uninstall reports nothing to do", /0 mục|không còn gì/i.test(un), un.slice(0, 300));
check("and still exits 0", true);

rmSync(fakeHome, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Chạy để thấy nó thất bại**

Test cài từ chính checkout này, và khẳng định `node_modules` có mặt — nên phải cài dependency của server trước, nếu không sẽ đỏ vì lý do chẳng liên quan:

```bash
cd server && npm install && cd ..
node test/install.test.mjs
```

Kỳ vọng: hỏng ngay vì `scripts/install.sh` chưa tồn tại.

- [ ] **Step 3: Viết `scripts/install.sh`**

```bash
#!/usr/bin/env bash
# Claude Code Chrome Bridge — cài đặt trên máy của bạn.
#
# Chạy:  curl -fsSL <release-url>/install.sh | bash
#
# Script này KHÔNG cần quyền root và chỉ ghi vào thư mục home của bạn.
set -euo pipefail

PORT="${CC_CHROME_PORT:-8787}"
INSTALL_DIR="$HOME/.cc-chrome-bridge"
STATE_FILE="$HOME/.ccchrome.json"
COMMAND_DEST="$HOME/.claude/commands/ccchrome.md"

# CC_CHROME_SOURCE lets the test suite install from a checkout instead of
# downloading a release. Unset in normal use.
SOURCE="${CC_CHROME_SOURCE:-}"
RELEASE_URL="${CC_CHROME_RELEASE_URL:-https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/cc-chrome-bridge.tar.gz}"

say() { echo "$@"; }
die() { echo "Lỗi: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "chưa có 'node'. Cài Node.js 18 trở lên rồi chạy lại."
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 18 ] || die "cần Node.js 18 trở lên, máy đang có $(node -v)."

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$script_dir/service-unit.sh"
cc_platform >/dev/null || die "chỉ hỗ trợ macOS và Linux."

upgrade=no
[ -f "$STATE_FILE" ] && upgrade=yes

say "Claude Code Chrome Bridge — $([ $upgrade = yes ] && echo 'nâng cấp' || echo 'cài đặt')"
say ""

# 1. Dừng service cũ trước khi thay mã nguồn, nếu không tiến trình đang chạy
#    vẫn giữ cổng và bản mới không lên được.
if [ "$upgrade" = yes ]; then
  say "→ Dừng dịch vụ đang chạy…"
  [ -n "${CC_CHROME_SKIP_SERVICE:-}" ] || cc_service_stop
fi

# 2. Mã nguồn
say "→ Cài mã nguồn vào $INSTALL_DIR"
mkdir -p "$INSTALL_DIR/logs"
rm -rf "$INSTALL_DIR/server" "$INSTALL_DIR/extension"
if [ -n "$SOURCE" ]; then
  cp -R "$SOURCE/server" "$INSTALL_DIR/server"
  cp -R "$SOURCE/extension" "$INSTALL_DIR/extension"
  cp "$SOURCE/.claude/commands/ccchrome.md" "$INSTALL_DIR/ccchrome.md"
else
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$RELEASE_URL" -o "$tmp/release.tar.gz" || die "không tải được gói phát hành."
  tar -xzf "$tmp/release.tar.gz" -C "$tmp"
  cp -R "$tmp/server" "$INSTALL_DIR/server"
  cp -R "$tmp/extension" "$INSTALL_DIR/extension"
  cp "$tmp/ccchrome.md" "$INSTALL_DIR/ccchrome.md"
fi
[ -d "$INSTALL_DIR/server/node_modules" ] || die "gói phát hành thiếu node_modules."

# 3. Token — giữ nguyên khi nâng cấp, để khỏi phải dán lại URL vào popup.
if [ "$upgrade" = yes ]; then
  TOKEN="$(node -p "require('$STATE_FILE').token")"
  say "→ Giữ token cũ"
else
  TOKEN="$(openssl rand -hex 16)"
  say "→ Sinh token mới"
fi
node -e "require('fs').writeFileSync('$STATE_FILE', JSON.stringify({ token: '$TOKEN', port: $PORT }, null, 2) + '\n')"
node -e "require('fs').writeFileSync('$INSTALL_DIR/tokens.json', JSON.stringify({ '$TOKEN': 'local' }, null, 2) + '\n')"

# 4. Service
say "→ Cài dịch vụ nền"
cc_write_unit "$INSTALL_DIR" "$PORT"
if [ -n "${CC_CHROME_SKIP_SERVICE:-}" ]; then
  say "  (bỏ qua bước nạp dịch vụ — CC_CHROME_SKIP_SERVICE)"
else
  cc_service_start
  say "→ Chờ bridge sẵn sàng…"
  ok=no
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ok=yes; break; fi
    sleep 0.5
  done
  [ "$ok" = yes ] || die "bridge không lên sau 20 giây. Xem log: $INSTALL_DIR/logs/bridge.err.log"
fi

# 5. Slash command
mkdir -p "$(dirname "$COMMAND_DEST")"
cp "$INSTALL_DIR/ccchrome.md" "$COMMAND_DEST"
say "→ Đã cài lệnh /ccchrome"

# 6. Đăng ký MCP với Claude Code
if command -v claude >/dev/null 2>&1; then
  claude mcp remove --scope user chrome >/dev/null 2>&1 || true
  claude mcp add --scope user --transport http chrome \
    "http://127.0.0.1:$PORT/mcp" --header "Authorization: Bearer $TOKEN" >/dev/null
  say "→ Đã đăng ký MCP server 'chrome' với Claude Code"
else
  say "→ Không thấy lệnh 'claude' — bỏ qua đăng ký MCP. Cài Claude Code rồi chạy lại script này."
fi

say ""
say "Xong. Còn hai việc bạn phải tự làm trong Chrome:"
say ""
say "  1. Mở chrome://extensions → bật Developer mode → Load unpacked"
say "     → chọn thư mục:  $INSTALL_DIR/extension"
say ""
say "  2. Bấm icon extension, dán URL này vào ô địa chỉ rồi bấm 'Lưu & kết nối lại':"
say "     ws://127.0.0.1:$PORT/ws?token=$TOKEN"
say ""
say "  Badge chuyển 'on' màu xanh là xong. Mở khung chat bằng nút 'Mở khung chat' trong popup."
say ""
say "  Gỡ cài đặt:  bash $INSTALL_DIR/uninstall.sh"
```

Dòng cuối script nhắc người dùng chạy `bash $INSTALL_DIR/uninstall.sh`, nên hai file đó phải nằm sẵn ở đấy. Thêm ngay sau khối cài mã nguồn (trước dòng kiểm `node_modules`):

```bash
if [ -n "$SOURCE" ]; then
  cp "$SOURCE/scripts/uninstall.sh" "$SOURCE/scripts/service-unit.sh" "$INSTALL_DIR/"
else
  cp "$tmp/uninstall.sh" "$tmp/service-unit.sh" "$INSTALL_DIR/"
fi
chmod +x "$INSTALL_DIR/uninstall.sh"
```

- [ ] **Step 4: Chạy test**

```bash
node test/install.test.mjs
```

Phần install phải xanh; phần uninstall còn đỏ (Task 5 làm). Chưa commit vội — Task 5 hoàn tất mới có bộ test xanh trọn vẹn. Nếu muốn commit sớm thì tách assertion uninstall ra khỏi file, nhưng **không** được xoá chúng.

---

### Task 5: `scripts/uninstall.sh`

**Files:**
- Create: `scripts/uninstall.sh`
- Modify: `package.json`

**Interfaces:**
- Consumes: `scripts/service-unit.sh` (Task 3), bố cục do `install.sh` tạo (Task 4).
- Produces: hỗ trợ `--dry-run`; idempotent; thoát 0 khi không còn gì để gỡ.

- [ ] **Step 1: Viết `scripts/uninstall.sh`**

```bash
#!/usr/bin/env bash
# Gỡ mọi thứ install.sh đã tạo trên máy này, theo đúng thứ tự ngược lại.
#
#   bash uninstall.sh --dry-run   # chỉ liệt kê, không xoá gì
#   bash uninstall.sh
set -euo pipefail

DRY=no
[ "${1:-}" = "--dry-run" ] && DRY=yes

INSTALL_DIR="$HOME/.cc-chrome-bridge"
STATE_FILE="$HOME/.ccchrome.json"
COMMAND_DEST="$HOME/.claude/commands/ccchrome.md"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$script_dir/service-unit.sh"

removed=0
note() { echo "  - $1"; }
gone() { removed=$((removed + 1)); }

echo "Claude Code Chrome Bridge — gỡ cài đặt$([ $DRY = yes ] && echo ' (dry-run)')"
echo ""

# 1. Dịch vụ TRƯỚC TIÊN. Xoá thư mục trước khi dừng dịch vụ sẽ để lại một tiến
#    trình mồ côi vẫn giữ cổng 8787, và lần cài sau chết vì EADDRINUSE — lỗi mà
#    người dùng không có cách nào tự chẩn đoán.
unit="$(cc_unit_path)"
if [ -f "$unit" ]; then
  note "dịch vụ nền: $unit"
  if [ "$DRY" = no ]; then
    [ -n "${CC_CHROME_SKIP_SERVICE:-}" ] || cc_service_stop
    rm -f "$unit"
  fi
  gone
fi

# 2. Đăng ký MCP
if command -v claude >/dev/null 2>&1 && claude mcp get chrome >/dev/null 2>&1; then
  note "đăng ký MCP 'chrome' trong Claude Code"
  [ "$DRY" = no ] && { claude mcp remove --scope user chrome >/dev/null 2>&1 || true; }
  gone
fi

# 3. Slash command
if [ -f "$COMMAND_DEST" ]; then
  note "lệnh /ccchrome: $COMMAND_DEST"
  [ "$DRY" = no ] && rm -f "$COMMAND_DEST"
  gone
fi

# 4. Token
if [ -f "$STATE_FILE" ]; then
  note "token: $STATE_FILE"
  [ "$DRY" = no ] && rm -f "$STATE_FILE"
  gone
fi

# 5. Mã nguồn — nhưng KHÔNG đụng panel/, đó là lịch sử hội thoại do server tạo
#    lúc chạy, không phải thứ install.sh tạo ra.
for sub in server extension logs ccchrome.md tokens.json uninstall.sh service-unit.sh; do
  if [ -e "$INSTALL_DIR/$sub" ]; then
    note "$INSTALL_DIR/$sub"
    [ "$DRY" = no ] && rm -rf "${INSTALL_DIR:?}/$sub"
    gone
  fi
done
# Xoá thư mục gốc chỉ khi đã rỗng — panel/ còn thì giữ nguyên cả thư mục.
[ "$DRY" = no ] && rmdir "$INSTALL_DIR" 2>/dev/null || true

echo ""
if [ "$removed" -eq 0 ]; then
  echo "Không còn gì để gỡ (0 mục)."
else
  echo "$([ $DRY = yes ] && echo 'Sẽ gỡ' || echo 'Đã gỡ') $removed mục."
fi

if [ -d "$INSTALL_DIR/panel" ]; then
  echo ""
  echo "Còn lại lịch sử hội thoại của khung chat (KHÔNG bị xoá):"
  echo "  $INSTALL_DIR/panel"
  echo "  Muốn xoá luôn:  rm -rf $INSTALL_DIR/panel"
fi

echo ""
echo "Script không gỡ được extension khỏi Chrome — Chrome không cho phép. Tự làm:"
echo "  Mở chrome://extensions → tìm 'Claude Code Chrome Bridge' → bấm Remove"
```

- [ ] **Step 2: Chạy test tới khi xanh**

```bash
node test/install.test.mjs
```

Kỳ vọng: `ALL TESTS PASSED`, gồm cả `KEEPS the panel conversation data`.

- [ ] **Step 3: Kiểm chứng thứ tự gỡ service bằng mutation**

Đổi tạm `uninstall.sh` cho khối xoá mã nguồn chạy **trước** khối dịch vụ. Test hiện tại có bắt được không? Nếu **không**, thêm một assertion vào `test/install.test.mjs` bắt được: ví dụ cho `cc_service_stop` ghi một dòng mốc thời gian vào file log, và khẳng định dòng đó xuất hiện trước khi thư mục biến mất. Rồi khôi phục thứ tự đúng. **Không được bỏ qua bước này** — thứ tự là lý do chính khối đó tồn tại, và một thứ tự không được canh sẽ bị ai đó sắp lại cho "gọn".

- [ ] **Step 4: Lint, thêm script, commit**

`package.json`: thêm `"test:install": "node test/install.test.mjs"` và chèn vào chuỗi `test`.

```bash
npm run lint
git add scripts/install.sh scripts/uninstall.sh test/install.test.mjs package.json
git commit -m "Add the local installer and uninstaller

The bridge now runs as a per-user service, so install.sh is a real file rather
than a string the server generates. uninstall.sh reverses exactly what it
created, in reverse order — the service first, because removing the directory
under a running process leaves an orphan holding port 8787 and the next install
dies on EADDRINUSE with nothing to point the user at."
```

---

### Task 6: Gói phát hành

**Files:**
- Create: `scripts/build-release.mjs`
- Modify: `package.json`
- Modify: `test/build.test.mjs`

**Interfaces:**
- Consumes: `scripts/build-extension.mjs` đã có (sinh `dist/extension.zip`).
- Produces: `dist/cc-chrome-bridge.tar.gz`.

- [ ] **Step 1: Thêm khẳng định vào `test/build.test.mjs`**

Sau khối kiểm zip hiện có:

```js
// --- release tarball --------------------------------------------------------

execFileSync("node", [join(root, "scripts", "build-release.mjs")], { stdio: "inherit" });
const tarPath = join(root, "dist", "cc-chrome-bridge.tar.gz");
check("release tarball exists", existsSync(tarPath));

const listing = execFileSync("tar", ["-tzf", tarPath], { encoding: "utf8" });
for (const required of [
  "server/index.js",
  "server/agent.js",
  "server/node_modules/ws/package.json",
  "extension/manifest.json",
  "extension/sidepanel.html",
  "install.sh",
  "uninstall.sh",
  "service-unit.sh",
  "ccchrome.md",
]) {
  check(`tarball contains ${required}`, listing.includes(required), listing.slice(0, 500));
}
```

Cần thêm `existsSync` vào import `node:fs` của file đó nếu chưa có.

- [ ] **Step 2: Chạy để thấy nó thất bại**

```bash
HEADED=1 node test/build.test.mjs
```

Kỳ vọng: hỏng vì `scripts/build-release.mjs` chưa có.

- [ ] **Step 3: Viết `scripts/build-release.mjs`**

```js
// Packages everything a machine needs to run the bridge locally into one
// tarball for GitHub Releases. node_modules ships inside it on purpose: the
// installer then needs neither npm nor network, and every machine runs the
// same three dependencies rather than whatever npm resolves that day.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, cpSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const stage = join(dist, "release-stage");

if (!existsSync(join(root, "server", "node_modules"))) {
  console.error("server/node_modules is missing — run `npm install` inside server/ first.");
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

cpSync(join(root, "server"), join(stage, "server"), { recursive: true });
cpSync(join(root, "extension"), join(stage, "extension"), { recursive: true });
for (const f of ["install.sh", "uninstall.sh", "service-unit.sh"]) {
  copyFileSync(join(root, "scripts", f), join(stage, f));
}
copyFileSync(join(root, ".claude", "commands", "ccchrome.md"), join(stage, "ccchrome.md"));

// -C stage so paths inside the archive are relative to the install root.
execFileSync("tar", ["-czf", join(dist, "cc-chrome-bridge.tar.gz"), "-C", stage, "."], { stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });
console.log("wrote dist/cc-chrome-bridge.tar.gz");
```

- [ ] **Step 4: Chạy tới khi xanh**

```bash
cd server && npm install && cd ..
HEADED=1 node test/build.test.mjs
```

- [ ] **Step 5: Kiểm gói cài được thật**

```bash
H=$(mktemp -d); T=$(mktemp -d)
tar -xzf dist/cc-chrome-bridge.tar.gz -C "$T"
HOME="$H" CC_CHROME_SKIP_SERVICE=1 CC_CHROME_SOURCE="$T" bash "$T/install.sh" | tail -12
ls "$H/.cc-chrome-bridge"
```

Kỳ vọng: in ra hướng dẫn Load unpacked, thư mục có `server/` và `extension/`. Đây là lần duy nhất kiểm được rằng nội dung tarball thật sự cài được, chứ không chỉ có mặt trong danh sách file.

- [ ] **Step 6: Thêm script và commit**

`package.json`: `"build:release": "node scripts/build-release.mjs"`.

```bash
git add scripts/build-release.mjs test/build.test.mjs package.json
git commit -m "Package a self-contained release tarball

node_modules ships inside it so the installer needs neither npm nor network,
and every machine ends up on the same three dependencies."
```

---

### Task 7: Version 3.5.0, bỏ 2 endpoint installer, tài liệu

**Files:**
- Modify: `extension/manifest.json`, `server/index.js`, `server/package.json`, `server/package-lock.json`
- Modify: `server/index.js` (bỏ `installScript`, `uninstallScript`, 2 handler endpoint)
- Modify: `deploy/chrome-bridge.service`
- Modify: `README.md`, `CLAUDE.md`, `.claude/commands/ccchrome.md`
- Modify: `test/e2e-http.mjs`

**Interfaces:** không có interface code mới.

- [ ] **Step 1: Bỏ hai endpoint installer**

Trong `server/index.js`: xoá hàm `installScript()`, `uninstallScript()`, và hai khối handler `if (req.method === "GET" && url.pathname === "/install.sh")` / `"/uninstall.sh"`. Bỏ hai dòng quảng cáo chúng trong log khởi động.

`test/e2e-http.mjs` có **14 test cho `/uninstall.sh`** và vài test cho `/install.sh` — xoá đúng những test đó, giữ nguyên phần còn lại của file. Đừng xoá cả file.

Lý do ghi vào commit message: hai endpoint này sinh script theo URL server, nên với mô hình mới chúng sẽ sinh ra bản cài đặt sai.

- [ ] **Step 2: Cảnh báo trong `deploy/chrome-bridge.service`**

Thêm vào đầu file, ngay dưới dòng mô tả sẵn có:

```
# ⚠️  MÔ HÌNH CŨ — không còn dùng từ 3.5.0.
# Từ 3.5.0 mỗi người tự chạy bridge trên máy mình (xem scripts/install.sh).
# File này giữ lại cho ai vẫn đang chạy mô hình server chung.
# Lưu ý: unit này đặt CC_CHROME_HOST=127.0.0.1 vì có reverse proxy đứng trước —
# đó KHÔNG phải là "chỉ máy này gọi được", và /panel sẽ từ chối (mã 4004) vì
# cổng chặn còn kiểm địa chỉ peer và các header X-Forwarded-*.
```

- [ ] **Step 3: Bump version lên 3.5.0**

- `extension/manifest.json`: `"version": "3.5.0"`
- `server/index.js`: `const VERSION = "3.5.0";`
- `server/package.json`: `"version": "3.5.0"`

```bash
cd server && npm install --package-lock-only && cd ..
grep -h '"version"' extension/manifest.json server/package.json; grep '^const VERSION' server/index.js
```

- [ ] **Step 4: Viết lại `.claude/commands/ccchrome.md`**

Subcommand `connect` (pairing với server từ xa) và `local` (stdio) đều không còn đúng. Viết lại thành:

- `status` — đọc `~/.ccchrome.json`, gọi `/health`, báo bridge sống không và extension đã nối chưa
- `install` — chỉ đường tới `scripts/install.sh`, không tự chạy
- `restart` — dừng/khởi động lại dịch vụ nền theo nền tảng
- `logs` — in mấy chục dòng cuối `~/.cc-chrome-bridge/logs/bridge.err.log`

Giữ tiếng Việt. Đây là **bề mặt sản phẩm** được `install.sh` chép vào máy người dùng, không phải công cụ nội bộ.

- [ ] **Step 5: Viết lại phần cài đặt trong `README.md`**

Bỏ mọi hướng dẫn về server chung, pairing secret, `/ccchrome connect`, stdio mode. Thay bằng:

- Một lệnh `curl … | bash`
- Hai việc tự làm trong Chrome (Load unpacked + dán URL)
- Cách gỡ: `bash ~/.cc-chrome-bridge/uninstall.sh`, và nói rõ nó **không** gỡ được extension
- Nói rõ `panel/` không bị xoá và xoá bằng lệnh nào
- Mục xử lý sự cố: xem log ở đâu, khởi động lại dịch vụ thế nào

Giữ nguyên mục "Lưu ý bảo mật" hiện có và **bổ sung** hai dòng: `javascript_eval`/`navigate` nay từ chối trang của chính extension; và bridge chỉ nghe trên loopback.

- [ ] **Step 6: Cập nhật `CLAUDE.md`**

- Mục "Setup and commands": bỏ stdio mode, mô tả một chế độ duy nhất.
- Mục "Security invariants": **xoá mục "Known hole"** về `javascript_eval` (đã bịt ở Task 1) và thay bằng một dòng ghi rằng hai chốt đó tồn tại và test nào canh chúng.
- Thêm một dòng: `server/index.js` không còn `mainStdio()`; cổng mặc định là 8787.

- [ ] **Step 7: Chạy toàn bộ test**

```bash
HEADED=1 npm test
npm run lint
```

Kỳ vọng: mọi bộ `ALL TESTS PASSED`, exit 0. Trên macOS **không** đặt `CHROME_PATH`.

- [ ] **Step 8: Build và commit**

```bash
npm run build && npm run build:release && ls -la dist/
git add -A
git commit -m "Release 3.5.0: local install, no shared bridge

Drops the two installer endpoints with it: they generated a script from the
server's own URL, so under this model they would have handed users an installer
for an architecture that no longer exists."
```

---

## Sau khi xong

Đừng merge và đừng phát hành cho team cho tới khi Huy nghiệm thu tay:

1. Cài thật bằng `install.sh` trên máy sạch (hoặc `HOME` giả), xác nhận dịch vụ tự chạy **sau khi khởi động lại máy** — đây là thứ không test tự động được.
2. Xác nhận panel và tool chạy qua bridge do dịch vụ khởi động.
3. Chạy `uninstall.sh`, xác nhận máy sạch và `panel/` còn nguyên.
4. Tạo GitHub Release, tải `install.sh` từ URL thật và cài lại một lần nữa từ đầu.
