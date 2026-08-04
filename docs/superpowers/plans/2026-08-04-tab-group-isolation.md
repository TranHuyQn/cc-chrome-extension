# Kế hoạch thực thi: nhóm tab theo phiên và giới hạn trong nhóm — 3.0.0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mỗi phiên Claude Code có một tab group Chrome riêng; tab do extension mở tự vào group đó; extension chỉ thao tác được trên tab trong group đó.

**Architecture:** Server gắn `session` vào mỗi message gửi xuống extension. Extension tra/tạo group theo tiêu đề `Claude · <4 hex>` trong từng cửa sổ. Toàn bộ 22 tool đã đi qua một hàm `resolveTab()` duy nhất — siết ở đó là đủ, không phải sửa từng handler.

**Tech Stack:** Node ≥18 ESM, `ws` 8, `@modelcontextprotocol/sdk` 1.29, Chrome MV3 (`chrome.tabGroups`), Playwright, ESLint 10.

Spec nguồn: `docs/superpowers/specs/2026-08-04-tab-group-isolation-design.md`

## Global Constraints

- Node ≥ 18, ESM. Không thêm dependency runtime nào cho `server/`.
- Extension là JS thuần, không build step, không bundler.
- Không `console.log` trong `server/*.js` — stdout là kênh giao thức MCP ở stdio mode; log qua `log()` (tức `console.error`).
- Không đụng các hàm `pageXxx` inject vào trang.
- `npm run lint` phải sạch trước mọi commit. Hook `PostToolUse` tự chạy ESLint sau mỗi lần ghi `.js`/`.mjs`.
- Lệnh chạy test trên máy này: `HEADED=1 npm test`, **để `CHROME_PATH` trống**. Chrome stable ≥137 đã bỏ cờ `--load-extension`; Chromium của Playwright vẫn nhận. Service worker không xuất hiện ở headless trên macOS.
- Code và comment tiếng Anh. Commit message tiếng Anh. `README.md` tiếng Việt.
- Ba con số version phải khớp — `test/build.test.mjs` bắt lỗi nếu lệch.
- **Phạm vi khoá:** chỉ ba yêu cầu trong spec. Không thêm tool mới, không thêm nút bật/tắt, không đụng side panel hay phân quyền theo site.

## File Structure

| File | Trách nhiệm | Task |
|---|---|---|
| `test/tabgroups.test.mjs` | **Tạo.** Chứng minh `chrome.tabGroups` dùng được trên Chromium của Playwright | 1 |
| `extension/manifest.json` | **Sửa.** Thêm quyền `tabGroups`; version 3.0.0 | 1, 5 |
| `server/index.js` | **Sửa.** Sinh/lấy session id, gắn vào envelope; VERSION 3.0.0 | 2, 5 |
| `extension/background.js` | **Sửa.** Quản lý group, `resolveTab` siết theo group, thông báo lỗi | 2, 3, 4 |
| `test/e2e.mjs` | **Sửa.** Sửa cho khớp hành vi mới (stdio) | 3, 4 |
| `test/e2e-http.mjs` | **Sửa.** Ca nhiều phiên, ca chặn tab ngoài group, ca kéo tab vào | 3, 4 |
| `test/build.test.mjs` | Không sửa — assertion version đã có sẵn | — |
| `README.md`, `CLAUDE.md` | **Sửa.** Hành vi mới, quyền mới, ghi chú nâng cấp | 5 |

---

### Task 1: Chứng minh `chrome.tabGroups` dùng được, và thêm quyền

Cả thiết kế dựa vào API này. Nếu Chromium của Playwright không có nó thì phải đổi cách kiểm chứng — cần biết trong vài phút, không phải sau khi viết xong hết.

**Files:**
- Create: `test/tabgroups.test.mjs`
- Modify: `extension/manifest.json` (thêm `"tabGroups"` vào `permissions`)
- Modify: `package.json` (script `test:tabgroups`, đưa vào `test`)

**Interfaces:**
- Consumes: không có.
- Produces: npm script `test:tabgroups`; quyền `tabGroups` trong manifest.

- [ ] **Step 1: Thêm quyền vào manifest**

```json
  "permissions": [
    "tabs",
    "scripting",
    "debugger",
    "storage",
    "alarms",
    "tabGroups"
  ],
```

- [ ] **Step 2: Viết probe**

Tạo `test/tabgroups.test.mjs`. Nó nạp extension thật rồi gọi API từ service worker — đúng ngữ cảnh mà code thật sẽ chạy:

```js
// Proves the assumption the whole 3.0.0 design rests on: chrome.tabGroups is
// available to this extension's service worker in the browser the tests use.
// If it is not, per-session tab groups cannot be verified automatically and
// the plan needs rethinking before any of it is built.
//
// Usage: HEADED=1 node test/tabgroups.test.mjs

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

const userDataDir = mkdtempSync(join(tmpdir(), "cc-tabgroups-"));
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

check("chrome.tabGroups exists in the service worker", await sw.evaluate(() => typeof chrome.tabGroups === "object"));
check("chrome.tabs.group exists", await sw.evaluate(() => typeof chrome.tabs.group === "function"));

const result = await sw.evaluate(async () => {
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, { title: "Claude · test", color: "orange" });
  const [found] = await chrome.tabGroups.query({ title: "Claude · test" });
  const after = await chrome.tabs.get(tab.id);
  return { groupId, foundId: found ? found.id : null, foundTitle: found ? found.title : null, tabGroupId: after.groupId };
});

check("tạo được group và gán tab vào", result.groupId >= 0 && result.tabGroupId === result.groupId, JSON.stringify(result));
check("query theo title tìm lại được group", result.foundId === result.groupId, JSON.stringify(result));
check("title đặt được", result.foundTitle === "Claude · test", String(result.foundTitle));

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
await context.close();
rmSync(userDataDir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 3: Thêm npm script**

Trong `package.json`:

```json
    "test:tabgroups": "node test/tabgroups.test.mjs",
```

và đưa `node test/tabgroups.test.mjs` vào chuỗi `test`, ngay sau `test:origin`.

- [ ] **Step 4: Chạy — đây là bước quyết định**

```bash
HEADED=1 npm run test:tabgroups
```

Kỳ vọng: 5 dòng `PASS`, kết thúc `ALL TESTS PASSED`.

**Nếu `chrome.tabGroups exists` FAIL: DỪNG LẠI, báo cáo, không làm tiếp Task 2.**

- [ ] **Step 5: Lint và commit**

```bash
npm run lint
git add extension/manifest.json test/tabgroups.test.mjs package.json
git commit -m "test: prove chrome.tabGroups works before building on it

The 3.0.0 design puts every tab the extension opens into a per-session
group and refuses tabs outside it. All of that rests on chrome.tabGroups
being available to the service worker, which nothing in the suite exercised."
```

---

### Task 2: Đưa định danh phiên xuống extension

**Files:**
- Modify: `server/index.js` — sinh session id, gắn vào envelope
- Modify: `extension/background.js` — nhận và truyền vào params

**Interfaces:**
- Consumes: Task 1.
- Produces: envelope `{type:"request", id, method, params, session}`; trong extension, `params.__session` là chuỗi session id (hoặc `undefined` khi server cũ).

- [ ] **Step 1: Server sinh và gắn session id**

Trong `server/index.js`, thêm ở phạm vi module (cạnh `VERSION`):

```js
// One Chrome tab group per Claude Code session. stdio serves exactly one
// session per process, so a value minted at startup is that session's identity;
// http reuses the MCP session id, which already means the same thing.
const STDIO_SESSION_ID = randomUUID();
```

Sửa `ExtensionConnection.call` để nhận và gắn:

```js
  call(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS, session) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ type: "request", id, method, params, session }));
    });
  }
```

Trong `buildMcpServer`, thêm tham số thứ ba là một ô chứa session id, và dùng nó ở `call`:

```js
function buildMcpServer(getBridge, statusExtra = {}, sessionRef = { id: null }) {
  ...
  const call = (method, args, timeoutMs) => getBridge().call(method, args, timeoutMs, sessionRef.id);
```

Chỗ gọi ở `mainStdio()`:

```js
  const server = buildMcpServer(() => registry.require("default"), { mode: "stdio" }, { id: STDIO_SESSION_ID });
```

Chỗ gọi ở `mainHttp()` — id chỉ có sau khi initialize xong, nên dùng ô có thể ghi sau:

```js
      const sessionRef = { id: null };
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          sessionRef.id = id;
          sessions.set(id, { transport, token, lastSeen: Date.now() });
        },
      });
      ...
      const server = buildMcpServer(() => registry.require(token), { mode: "http", user: name }, sessionRef);
```

- [ ] **Step 2: Extension nhận session id**

Trong `extension/background.js`, sửa `handleRequest` để đưa session vào params — cách này không phải đổi chữ ký của cả 22 handler:

```js
async function handleRequest(msg) {
  const { id, method, params = {}, session } = msg;
  try {
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown method: ${method}`);
    // resolveTab() reads this to find the session's tab group. Injecting it
    // here keeps all 22 handler signatures unchanged.
    params.__session = session;
    const result = await handler(params);
    send({ type: "response", id, result: result ?? { ok: true } });
  } catch (err) {
    send({ type: "response", id, error: { message: err?.message || String(err) } });
  }
}
```

- [ ] **Step 3: Kiểm session id thật sự tới nơi**

Thêm vào `test/e2e-http.mjs`, sau ca `extension connects with alice token`:

```js
// The tab-group feature is per session, so the session id has to reach the
// extension on every request. Read it back through the service worker.
await clientA.callTool({ name: "list_tabs", arguments: {} });
const seenSession = await sw.evaluate(() => self.__cc_lastSession ?? null);
check("session id reaches the extension", typeof seenSession === "string" && seenSession.length > 0, String(seenSession));
```

Và trong `handleRequest` của extension, ngay sau dòng gán `params.__session`, thêm:

```js
    self.__cc_lastSession = session ?? null;
```

- [ ] **Step 4: Chạy**

```bash
npm run lint
HEADED=1 npm run test:http
```

Kỳ vọng: `PASS  session id reaches the extension`, mọi ca cũ vẫn xanh.

- [ ] **Step 5: Commit**

```bash
git add server/index.js extension/background.js test/e2e-http.mjs
git commit -m "feat: tell the extension which session each request belongs to

Tab groups are per session, so the extension needs to know which one is
asking. stdio mints an id at startup because one process serves exactly one
Claude Code session; http reuses the MCP session id."
```

---

### Task 3: Tạo group theo phiên và cho `new_tab` vào group

Đây là yêu cầu 1 và 2 của spec.

**Files:**
- Modify: `extension/background.js`
- Modify: `test/e2e-http.mjs`

**Interfaces:**
- Consumes: `params.__session` từ Task 2.
- Produces: `async function sessionGroupId(session, windowId)` trả về groupId của phiên trong cửa sổ đó, tạo nếu chưa có; `function sessionGroupTitle(session)` trả `Claude · <4 hex>`.

- [ ] **Step 1: Viết ca test thất bại**

Thêm vào cuối `test/e2e-http.mjs`, trước dòng tổng kết:

```js
// --- per-session tab groups -------------------------------------------------

const tabA = JSON.parse(toolText(await clientA.callTool({ name: "new_tab", arguments: { url: `http://127.0.0.1:${HTTP_PORT}/` } })));
const tabA2 = JSON.parse(toolText(await clientA.callTool({ name: "new_tab", arguments: { url: `http://127.0.0.1:${HTTP_PORT}/` } })));
const groupsSame = await sw.evaluate(async ([a, b]) => {
  const ta = await chrome.tabs.get(a), tb = await chrome.tabs.get(b);
  const g = ta.groupId >= 0 ? await chrome.tabGroups.get(ta.groupId) : null;
  return { a: ta.groupId, b: tb.groupId, title: g ? g.title : null, color: g ? g.color : null };
}, [tabA.tabId, tabA2.tabId]);
check("hai tab cùng phiên vào chung một group", groupsSame.a >= 0 && groupsSame.a === groupsSame.b, JSON.stringify(groupsSame));
check("nhãn group đúng định dạng", /^Claude · [0-9a-f]{4}$/.test(groupsSame.title || ""), String(groupsSame.title));
check("group màu cam", groupsSame.color === "orange", String(groupsSame.color));

// clientA2 dùng cùng token nhưng khác MCP session — phải ra group khác
const tabB = JSON.parse(toolText(await clientA2.callTool({ name: "new_tab", arguments: { url: `http://127.0.0.1:${HTTP_PORT}/` } })));
const otherGroup = await sw.evaluate(async (id) => (await chrome.tabs.get(id)).groupId, tabB.tabId);
check("phiên khác thì group khác", otherGroup >= 0 && otherGroup !== groupsSame.a, `${otherGroup} vs ${groupsSame.a}`);
```

- [ ] **Step 2: Chạy để xác nhận fail**

```bash
HEADED=1 npm run test:http
```

Kỳ vọng: `FAIL  hai tab cùng phiên vào chung một group -- {"a":-1,"b":-1,...}` (`-1` nghĩa là tab không thuộc group nào).

- [ ] **Step 3: Cài đặt quản lý group**

Trong `extension/background.js`, thêm sau khối hằng ở đầu file:

```js
const GROUP_COLOR = "orange";

// The group title is the source of truth, not an in-memory map: MV3 kills the
// service worker at will, and re-deriving the group by querying its title
// costs one call and cannot go stale.
function sessionGroupTitle(session) {
  return `Claude · ${String(session || "nosession").replace(/-/g, "").slice(0, 4)}`;
}

// Scoped per window on purpose. chrome.tabs.group moves a tab into the group's
// window, so a window-wide lookup would yank tabs across windows.
async function sessionGroupId(session, windowId) {
  const title = sessionGroupTitle(session);
  const [existing] = await chrome.tabGroups.query({ title, windowId });
  return existing ? existing.id : null;
}

async function addTabToSessionGroup(tab, session) {
  let groupId = await sessionGroupId(session, tab.windowId);
  groupId = groupId === null
    ? await chrome.tabs.group({ tabIds: [tab.id] })
    : await chrome.tabs.group({ tabIds: [tab.id], groupId });
  await chrome.tabGroups.update(groupId, { title: sessionGroupTitle(session), color: GROUP_COLOR });
  return groupId;
}
```

Sửa `handlers.new_tab`:

```js
  async new_tab(params) {
    const tab = await chrome.tabs.create({ url: params.url || "about:blank", active: true });
    if (params.url) await waitForTabComplete(tab.id);
    await addTabToSessionGroup(tab, params.__session);
    const updated = await chrome.tabs.get(tab.id);
    return { tabId: updated.id, url: updated.url, title: updated.title, groupId: updated.groupId };
  },
```

- [ ] **Step 4: Chạy, xác nhận pass**

```bash
npm run lint
HEADED=1 npm run test:http
```

Kỳ vọng: bốn ca mới đều PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/background.js test/e2e-http.mjs
git commit -m "feat: put tabs the extension opens into a per-session group

The group title carries the session id and is the only state: MV3 can kill
the service worker between two calls, and looking the group up by title
survives that without a cache to invalidate.

Lookups are scoped per window because chrome.tabs.group moves a tab into the
group's window — a window-wide lookup would yank tabs between windows."
```

---

### Task 4: Chỉ thao tác trong group

Đây là yêu cầu 3, và là task lớn nhất vì nó đổi hành vi của `navigate` và `list_tabs`, làm hỏng nhiều test hiện có.

**Files:**
- Modify: `extension/background.js` — `resolveTab`, `handlers.list_tabs`
- Modify: `test/e2e.mjs`, `test/e2e-http.mjs`

**Interfaces:**
- Consumes: `sessionGroupId`, `addTabToSessionGroup` từ Task 3.
- Produces: `resolveTab(params)` chỉ trả tab trong group của phiên; ném lỗi có tên nhóm khi bị chặn.

- [ ] **Step 1: Viết ca test thất bại**

Thêm vào `test/e2e-http.mjs`, sau khối của Task 3:

```js
// Yêu cầu 3: tab ngoài group phải bị từ chối, và kéo vào group thì thao tác được.
const outsideId = await sw.evaluate(async (url) => (await chrome.tabs.create({ url, active: false })).id, `http://127.0.0.1:${HTTP_PORT}/`);
await sleep(500);
let blocked = await clientA.callTool({ name: "get_page_text", arguments: { tabId: outsideId } });
check("tab ngoài group bị từ chối", blocked.isError === true, toolText(blocked).slice(0, 160));
check("thông báo lỗi nêu tên nhóm", /Claude · [0-9a-f]{4}/.test(toolText(blocked)), toolText(blocked).slice(0, 160));

// Người dùng kéo tab vào nhóm — mô phỏng bằng chính API Chrome dùng khi kéo.
await sw.evaluate(async ([tabId, groupId]) => { await chrome.tabs.group({ tabIds: [tabId], groupId }); }, [outsideId, groupsSame.a]);
const allowed = await clientA.callTool({ name: "get_page_text", arguments: { tabId: outsideId } });
check("kéo tab vào nhóm thì thao tác được", !allowed.isError, toolText(allowed).slice(0, 160));
```

- [ ] **Step 2: Chạy để xác nhận fail**

```bash
HEADED=1 npm run test:http
```

Kỳ vọng: `FAIL  tab ngoài group bị từ chối` — hiện tại mọi tab đều thao tác được.

- [ ] **Step 3: Siết `resolveTab`**

Thay toàn bộ hàm trong `extension/background.js`:

```js
// Every one of the 22 tools routes through here, which is what makes the
// in-group restriction enforceable in one place. A tab outside the session's
// group is refused with a message that says how to grant access, because the
// fix is a user action in Chrome that Claude cannot perform.
async function resolveTab(params) {
  const session = params.__session;
  const title = sessionGroupTitle(session);

  if (params.tabId) {
    const tab = await chrome.tabs.get(params.tabId).catch(() => null);
    if (!tab) throw new Error(`No tab with id ${params.tabId}`);
    const groupId = await sessionGroupId(session, tab.windowId);
    if (groupId === null || tab.groupId !== groupId) {
      throw new Error(
        `Tab ${params.tabId} is outside the "${title}" tab group. Drag that tab into the group to let me work on it, or call new_tab to open a fresh one.`
      );
    }
    return tab;
  }

  // No tabId: use the session's own tabs, most recently active first.
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  for (const win of windows) {
    const groupId = await sessionGroupId(session, win.id);
    if (groupId === null) continue;
    const tabs = await chrome.tabs.query({ groupId });
    if (tabs.length) return tabs[tabs.length - 1];
  }

  const created = await chrome.tabs.create({ url: "about:blank", active: true });
  await addTabToSessionGroup(created, session);
  return await chrome.tabs.get(created.id);
}
```

- [ ] **Step 4: Giới hạn `list_tabs` theo group**

```js
  async list_tabs(params) {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const tabs = [];
    for (const win of windows) {
      const groupId = await sessionGroupId(params.__session, win.id);
      if (groupId === null) continue;
      tabs.push(...(await chrome.tabs.query({ groupId })));
    }
    return {
      group: sessionGroupTitle(params.__session),
      note: tabs.length ? undefined : "No tabs in this session's group yet. Use new_tab, or drag a tab into the group in Chrome.",
      tabs: tabs.map((t) => ({
        tabId: t.id,
        title: t.title,
        url: t.url,
        active: t.active,
        windowId: t.windowId,
      })),
    };
  },
```

- [ ] **Step 5: Sửa test hiện có cho khớp hành vi mới**

Đây là phần việc nặng nhất. Trong `test/e2e.mjs` và `test/e2e-http.mjs`, mọi ca đang dựa vào việc `navigate` chiếm tab đang mở đều phải đổi sang mở tab qua `new_tab` trước, hoặc chấp nhận rằng `navigate` tự tạo tab trong group.

Cụ thể cần rà:
- Ca `navigate` đầu tiên của mỗi suite: giờ nó tự tạo tab trong group thay vì dùng tab `about:blank` mặc định. Assertion về URL vẫn đúng, nhưng `tabId` trả về sẽ khác.
- Ca `list_tabs`: trước liệt kê mọi tab, giờ chỉ liệt kê tab trong group. Assertion `toolText(r).includes(String(newTabId))` vẫn đúng vì tab đó do `new_tab` tạo nên nằm trong group.
- Ca `switch_tab` / `close_tab` với `tabId` từ `new_tab`: vẫn hợp lệ vì tab nằm trong group.
- Ca dùng `selector` mà không có `tabId`: `resolveTab` giờ trả tab trong group — đảm bảo tab đó là tab vừa navigate tới, không phải tab rỗng.

Chạy từng suite, đọc kỹ từng dòng FAIL, sửa đúng nguyên nhân. **Không nới lỏng assertion để cho qua** — nếu một ca hỏng vì hành vi mới sai chứ không phải vì test cũ lỗi thời, đó là bug cần sửa ở code.

- [ ] **Step 6: Chạy toàn bộ**

```bash
npm run lint
HEADED=1 npm test
```

Kỳ vọng: cả 6 suite `ALL TESTS PASSED`.

- [ ] **Step 7: Commit**

```bash
git add extension/background.js test/e2e.mjs test/e2e-http.mjs
git commit -m "feat: restrict every tool to the session's own tab group

resolveTab() is the single point all 22 tools already route through, so the
restriction lands in one function rather than in each handler.

A tab outside the group is refused with a message naming the group and the
two ways out, because the remedy is a drag in Chrome that Claude cannot
perform itself. navigate without a tabId no longer takes over whatever tab
happened to be in front of the user; it works inside the group and opens a
tab there if the group is empty."
```

---

### Task 5: Version 3.0.0 và tài liệu

**Files:**
- Modify: `extension/manifest.json`, `server/index.js`, `server/package.json`
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Đặt cả ba về 3.0.0**

- [ ] **Step 2: Chạy `npm run test:build`** — assertion khớp version đã có sẵn từ 2.0.0, phải PASS.

- [ ] **Step 3: README**

Thêm mục mô tả hành vi nhóm tab: mỗi phiên một nhóm `Claude · xxxx` màu cam; tab Claude mở tự vào nhóm; Claude chỉ thao tác trong nhóm; kéo tab vào nhóm là cách cấp quyền cho Claude đọc tab đó; nhóm chỉ xuất hiện sau khi Claude mở tab đầu tiên vì Chrome không cho tồn tại nhóm rỗng. Cập nhật bảng cấu hình nếu cần và ghi chú nâng cấp 3.0.0 (cả team phải cài lại extension).

- [ ] **Step 4: CLAUDE.md** — thêm bất biến: mọi tool đi qua `resolveTab()`, và đó là chỗ duy nhất thực thi giới hạn theo group; thêm tool mới phải dùng `resolveTab`, không được tự gọi `chrome.tabs.query`.

- [ ] **Step 5: Chạy toàn bộ và commit**

```bash
npm run lint && HEADED=1 npm test
git add -A
git commit -m "chore: release 3.0.0 with per-session tab group isolation"
```

---

### Task 6: Kiểm chứng cuối và triển khai

- [ ] **Step 1:** `npm run lint` sạch; `HEADED=1 npm test` — 6 suite xanh, ghi lại số PASS từng suite.
- [ ] **Step 2:** `npm run build` — artifact v3.0.0, ghi lại Extension ID, xác nhận `key.pem` là bản cũ (không sinh mới).
- [ ] **Step 3:** `docker build -f deploy/Dockerfile -t cc-bridge:3.0.0 .` và chạy thử `/health` trả `"version":"3.0.0"`.
- [ ] **Step 4:** Đưa lên home server: copy repo, `docker compose up -d --build` trong `deploy/cloudflare`, kiểm `/health` qua `https://cccx.beelyai.com/health`.
- [ ] **Step 5:** Báo Huy: cài lại extension từ `https://cccx.beelyai.com/extension.zip`, vì bản 2.x không có isolation.
