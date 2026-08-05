# Thiết kế: khung chat trong trình duyệt (Chrome side panel) — bản 3.4.0

Ngày: 2026-08-05
Mục tiêu: gõ prompt cho Claude ngay trong Chrome, giống extension Claude for Chrome gốc,
nhưng chạy bằng chính `claude` CLI đã đăng nhập trên máy — không cần API key riêng.

## Bối cảnh và ràng buộc

Hôm nay luồng đi một chiều: Claude Code ở terminal là **não**, extension là **tay**.
Khung chat trong trình duyệt đảo chiều việc đó — browser trở thành nơi khởi phát prompt —
nên câu hỏi đầu tiên là não chạy ở đâu.

Ràng buộc do Huy nêu:

- Dùng **chung tài khoản Claude với team**, và **chỉ được phép đăng nhập qua `claude` CLI**.
  Không có API key riêng để gọi thẳng Anthropic API.
- Panel **chỉ được thao tác trong tab group của phiên**. Không nới lỏng
  `resolveTabInGroup`.
- Triển khai **local, một tiến trình**. Không đụng vào bản deploy production
  (home server `cccb`).
- Làm trên nhánh riêng, Huy tự test kỹ trước khi thông báo cho team.

## Phương án đã loại

| Phương án | Lý do loại |
|---|---|
| Anthropic Messages API + tự viết tool loop | Cần API key riêng. Huy không có. |
| `@anthropic-ai/claude-agent-sdk` | Chỉ là lớp bọc quanh chính `claude` CLI. Repo giữ đúng 3 dependency và không có build step; thêm dep không đổi được gì về khả năng. |
| Panel làm cửa sổ điều khiển phiên terminal qua tmux | Huy đã tự ghi nhận trong `brain/status/cc-remote.md` rằng "điều khiển Claude qua bridge tmux luôn mong manh". |
| Chạy agent trên home server | `claude` chỉ login trên máy Huy. Đặt credential của tài khoản team dùng chung lên một máy chung là quyết định riêng, không gộp vào việc này. |

## Kiến trúc

Một tiến trình `server/index.js --http` bind `127.0.0.1:8787`, ba đường dây:

```
Chrome
├─ background.js ──WS /ws     (token)──┐
└─ sidepanel.js  ──WS /panel  (token)──┤
                                       ▼
                      server/index.js --http  127.0.0.1:8787
                                       │  spawn (một tiến trình con mỗi phiên chat)
                                       ▼
                      claude -p  (stream-json vào/ra)
                                       │  MCP over HTTP
                                       └──► chính nó, /mcp?panel=<panelId>
```

Vòng khép kín cho một lượt chat:

1. Panel gửi `{type:"prompt", text}` qua `/panel`.
2. Server ghi một dòng NDJSON vào stdin của tiến trình `claude` tương ứng.
3. Claude gọi tool chrome qua `/mcp` (HTTP MCP, Bearer token).
4. Server chuyển tiếp lời gọi đó xuống extension qua socket `/ws` **đang có sẵn**.
5. Extension thao tác Chrome bằng `resolveTab()` như mọi tool khác, trả kết quả ngược lên.
6. Server đọc NDJSON từ stdout của `claude`, dịch thành khung tin nhắn, đẩy về panel.

### Vì sao panel có socket riêng `/panel`

`BridgeRegistry.attach()` đóng kết nối cũ khi cùng token nối vào lần nữa. Panel nối vào
`/ws` sẽ đá văng service worker và làm chết toàn bộ đường tool. Nên panel cần endpoint
riêng.

`/panel` **dùng lại nguyên** `originAllowed()`, `tokenFromSubprotocol()`,
`pickSubprotocol()` và bộ close code 4001/4002/4003, nên không phát sinh đường xác thực
thứ hai để phải bảo trì song song.

### Vì sao không relay qua background.js

Cách rẻ hơn về code là panel nói chuyện với service worker qua `chrome.runtime`, rồi
service worker ghép kênh chat lên socket `/ws` sẵn có. Loại vì vòng đời service worker:
Chrome giết nó khi cửa sổ bị ẩn lâu (đã đo được `close=1001, lived=327s` trên bản deploy),
và mất service worker giữa lượt chat là mất luôn stream. Panel là một trang sống, socket
của nó sống đúng bằng thời gian panel mở.

## Phía extension

Không thêm build step. JS thuần, Chrome nạp trực tiếp — như quy ước hiện có.

| File | Thay đổi |
|---|---|
| `manifest.json` | thêm permission `sidePanel`; thêm `"side_panel": {"default_path": "sidepanel.html"}`; version → `3.4.0` |
| `sidepanel.html` | khung chat: danh sách tin nhắn, ô nhập, dropdown model, nút dừng, nút phiên mới, nút "Đưa tab này vào phiên" |
| `sidepanel.js` | đọc `wsUrl` từ `chrome.storage.local` (đúng chỗ popup đang lưu), nối `/panel`, backoff khi rớt — cùng khuôn với `connect()` trong `background.js`, kể cả quy tắc "`open` không phải là bằng chứng kết nối thành công" |
| `popup.html` / `popup.js` | thêm nút **"Mở khung chat"** gọi `chrome.sidePanel.open({windowId})` |
| `background.js` | thêm handler `attach_tab` |

Bấm icon extension vẫn ra popup như cũ. `chrome.sidePanel.open()` bắt buộc phải có user
gesture; cú click trong popup thoả điều kiện đó.

## Phía server: `AgentSession`

Mỗi khung chat là một `AgentSession`, giữ một tiến trình `claude` con:

```
claude -p --output-format stream-json --input-format stream-json
       --include-partial-messages
       --mcp-config '{"mcpServers":{"chrome":{"type":"http",
                      "url":"http://127.0.0.1:<PORT>/mcp?panel=<panelId>",
                      "headers":{"Authorization":"Bearer <token>"}}}}'
       --strict-mcp-config
       --tools ""
       --allowedTools "mcp__chrome"
       --session-id <uuid>
       --model <alias>
       --append-system-prompt "<persona trợ lý duyệt web>"
```

Từng cờ, và vì sao:

- `--tools ""` — **tắt sạch bộ tool có sẵn** (Bash, Read, Write, Edit, WebFetch…).
  Agent trong panel không đụng được filesystem máy Huy. Đây là hàng rào chính.
- `--strict-mcp-config` — chỉ nạp MCP server khai trong `--mcp-config`, bỏ qua mọi MCP
  server khác đã cấu hình sẵn trong máy (atlassian, github, figma…).
- `--allowedTools "mcp__chrome"` — cho phép toàn bộ tool của MCP server tên `chrome`
  mà không hỏi duyệt từng lần. Không cần permission gate riêng vì bộ tool đã bị thu hẹp
  còn đúng 22 tool trình duyệt, và mọi tool đó đều đã bị chặn trong tab group.
  **Phải kiểm chứng ở bước 1 của kế hoạch** rằng dạng rút gọn theo tên server này thực sự
  cho phép cả 22 tool; nếu không, dùng danh sách đầy đủ `mcp__chrome__navigate ...` sinh
  từ chính bảng tool trong `server/index.js`. Không dùng `--dangerously-skip-permissions`
  làm đường vòng.
- `--session-id <uuid>` — uuid gắn với panel, lưu trong `chrome.storage.local`.
- `--model <alias>` — nhận `opus` / `sonnet` / `haiku` từ dropdown.
- **cwd** = `~/.cc-chrome-bridge/panel/` (thư mục rỗng, không có `CLAUDE.md`) để agent
  không nuốt `CLAUDE.md` của workspace và hiểu nhầm nhiệm vụ.

### Nút dừng

Kill tiến trình con. Lượt kế tiếp khởi động lại bằng `--resume <session-id>`. Chọn cách
này thay vì gửi tín hiệu interrupt qua stdin vì `--resume` là cờ có tài liệu, còn control
protocol trên stdin thì không — không đoán.

### Lịch sử hội thoại

Nằm ở Claude Code, không phải ở server. Panel chỉ giữ `sessionId` trong
`chrome.storage.local`; đóng panel mở lại thì `--resume` cùng id. Nút "phiên mới" sinh
uuid mới. Server **không** lưu nội dung hội thoại.

### Cách ly tab — có sẵn, không cần code

Mỗi `AgentSession` nối MCP bằng một phiên riêng, nên nhận một MCP session id riêng, nên
`sessionGroupTitle()` sinh một tab group riêng. Panel và phiên Claude Code ở terminal
không giẫm chân nhau. Không thêm dòng nào cho việc này.

Tham số `?panel=<panelId>` trên URL `/mcp` chỉ để server biết MCP session nào thuộc panel
nào — cần cho nút "Đưa tab này vào phiên" ở dưới. Server ghi lại ánh xạ này trong
`onsessioninitialized`.

## Bảo mật

Bốn invariant hiện có **không đổi một dòng nào**:

| Invariant | Trạng thái |
|---|---|
| Bắt buộc `Origin: chrome-extension://…` | `/panel` dùng lại `originAllowed()` |
| Token đi trong `Sec-WebSocket-Protocol`, không trong query string | như cũ |
| Từ chối bằng close code (4001/4002/4003), không destroy socket | như cũ |
| Mọi tool tới tab qua `resolveTabInGroup()` | không đổi |

### Cửa mới duy nhất: handler `attach_tab`

Panel gửi `{type:"attach_tab"}` — không kèm trường nào. Server chuyển thành một bridge
request `attach_tab` với `session` = MCP session id của agent. Extension **tự** xác định
cửa sổ bằng `chrome.windows.getLastFocused({windowTypes:["normal"]})`, lấy tab đang active
của cửa sổ đó và gọi `addTabToSessionGroup()`.

> **Sửa đổi 2026-08-05.** Bản đầu cho panel gửi `windowId`. Bỏ đi sau khi review chỉ ra:
> window id của Chrome là số nguyên nhỏ tăng dần, nên bất cứ thứ gì có token panel cũng
> quét được `1..N` và hút tab đang active của mọi cửa sổ vào group của nó, rồi đọc sạch
> bằng các tool thông thường. Người gọi không được phép chỉ định cửa sổ.

Đây **không phải** lỗ hổng, mà là phím tắt cho đúng thao tác mà bản 3.0.0 đã coi là hành
vi cấp quyền hợp lệ: spec `2026-08-04-tab-group-isolation-design.md` ghi rõ "kéo tab vào
group chính là cấp quyền". Handler này làm hộ cú kéo đó, và chỉ chạy khi người dùng tự
bấm nút.

Ba điều kiện phải cùng đúng thì `attach_tab` mới chạy:

1. Đến từ socket `/panel` đã qua kiểm tra origin + token.
2. Cửa sổ do chính extension xác định tại thời điểm xử lý, không do người gọi truyền vào.
3. Chỉ tác động lên **tab đang active** của cửa sổ đó, không nhận tab id tuỳ ý.

Điều 3 quan trọng: nếu handler nhận `tabId` tuỳ ý thì nó thành đúng cái lỗ mà 3.0.0 đã
vá ở `close_tab`/`switch_tab`. Phải ghi mục này vào phần "Security invariants" của
`CLAUDE.md`, kèm lý do — không ghi thì người đọc code sau sẽ tưởng invariant bị thủng.

### Chỉ spawn agent khi bind loopback

Server **chỉ được** spawn `claude` khi `HOST` là `127.0.0.1`. Bridge công khai (như
`cccb`) phải từ chối mọi thứ liên quan tới `/panel` và `AgentSession` — nếu không, bất kỳ
ai có token hợp lệ cũng chạy được `claude` trên máy chủ, bằng tài khoản team, không giới
hạn. Đây là điều kiện chặn, không phải khuyến nghị.

## Kiểm thử

| File | Kiểm tra gì |
|---|---|
| `test/panel-auth.test.mjs` | `/panel` từ chối đúng cách: origin sai → 4003, token sai → 4001, thiếu subprotocol → 4002. Theo khuôn `test/origin.test.mjs`. |
| `test/panel-auth.test.mjs` | Server bind `0.0.0.0` phải từ chối `/panel` hoàn toàn (điều kiện loopback ở trên). |
| `test/agent-session.test.mjs` | Thay `claude` bằng một script node giả phát NDJSON có sẵn: kiểm tra dịch sự kiện → khung tin nhắn panel, và nút dừng thực sự kill tiến trình con. |
| `test/build.test.mjs` | `sidepanel.html` và `sidepanel.js` phải có trong zip; ba chỗ version phải khớp `3.4.0`. |

**Giới hạn đã biết, nói thẳng:** Playwright không lái được Chrome side panel. Phần UI của
panel do Huy nghiệm thu tay, không có e2e tự động. Không giả vờ ngược lại trong báo cáo.

## Ba chỗ phải bump version

`extension/manifest.json`, `VERSION` trong `server/index.js`, `server/package.json` — tất
cả lên `3.4.0`. Rồi làm mới `server/package-lock.json` bằng
`npm install --package-lock-only` trong `server/`. `test/build.test.mjs` fail nếu lệch.

## Tài liệu phải sửa

- `README.md` — mục mới về khung chat: cách chạy bridge local, cách mở panel, giới hạn
  (không đọc tab đang xem, phải bấm "Đưa tab này vào phiên").
- `CLAUDE.md` — mục "Security invariants": ghi `attach_tab` và điều kiện loopback.
- `.claude/commands/ccchrome.md` — subcommand `local` hiện đang hướng dẫn chạy stdio
  mode; khung chat cần http mode trên loopback, nên phải bổ sung đường này.

## Cố tình không làm ở v1

- Không đọc tab người dùng đang xem (Huy đã chốt giữ nguyên invariant).
- Không permission gate từng tool — đã chặn ở tầng tool set, gate nữa là thừa.
- Không upload ảnh/file vào khung chat.
- Không đụng home server production.
- Không e2e tự động cho UI panel (Playwright không làm được).
