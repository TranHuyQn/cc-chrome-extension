# Claude Code Chrome Bridge

Extension thay thế cho **Claude in Chrome** chính thức, dành cho team dùng chung tài khoản Claude **chỉ với Claude Code** (không đăng nhập được claude.ai). Extension gốc bắt buộc đăng nhập claude.ai trong browser; bản bridge này thì **không cần bất kỳ đăng nhập nào** — Claude Code điều khiển Chrome thông qua một MCP server chạy local trên máy bạn.

## Kiến trúc

```
Claude Code ──(MCP / stdio)──► MCP server (Node.js) ──(WebSocket, chỉ localhost)──► Chrome Extension (MV3)
                                                                                        │
                                                                          chrome.tabs / chrome.scripting
                                                                          chrome.debugger (CDP)
```

- **`extension/`** — Chrome extension (Manifest V3). Service worker kết nối tới MCP server qua WebSocket `ws://127.0.0.1:9876`, tự động reconnect, và thực thi các lệnh điều khiển browser.
- **`server/`** — MCP server (Node.js ≥ 18). Claude Code nói chuyện với nó qua stdio; mỗi tool call được chuyển tiếp tới extension và trả kết quả về.

Mọi kết nối chỉ nằm trong `127.0.0.1` — không có dữ liệu nào gửi ra ngoài, không cần tài khoản Anthropic trong browser.

Ngoài chế độ local, server còn có chế độ `--http` để chạy tập trung trên VPS cho cả team (xem [Triển khai lên VPS](#triển-khai-lên-vps-cho-cả-team)):

```
Claude Code (mỗi người) ──(MCP / Streamable HTTP + Bearer token)──► MCP server trên VPS
Chrome Extension (mỗi người) ──(wss://vps/ws?token=...)────────────────────┘
```

Server ghép cặp theo **token**: lệnh từ Claude Code của ai điều khiển đúng Chrome của người đó. Chrome vẫn chạy trên máy từng người — VPS chỉ host phần trung gian.

## Cài đặt

### 1. Cài extension vào Chrome

**Cách A — từ file đóng gói (khuyên dùng cho team):** admin build một lần:

```bash
npm install && npm run build   # tạo dist/extension.zip + dist/extension.crx
```

rồi phân phối cho team (gửi file, hoặc để server VPS phục vụ tại `https://<domain>/extension.zip` — xem phần VPS). Thành viên:

1. Tải `extension.zip` về và **giải nén** ra một thư mục cố định (đừng xóa sau khi cài)
2. Mở `chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn thư mục vừa giải nén

File `.crx` (đã ký, CRX3): trên **Linux** kéo thả thẳng vào `chrome://extensions` là cài được. Trên **Windows/macOS** Chrome chặn `.crx` ngoài Web Store — extension sẽ bị vô hiệu hóa sau khi cài — trừ khi máy được quản lý bằng enterprise policy (`ExtensionInstallAllowlist` với extension ID in ra lúc build, `ExtensionInstallForcelist` nếu muốn tự cài). Vì vậy với team thường, dùng file zip + Load unpacked là thực tế nhất; muốn hết hẳn cảnh Developer mode thì publish lên Chrome Web Store dạng **unlisted** (chỉ ai có link mới thấy).

Lưu ý cho admin: `key.pem` sinh ra ở lần build đầu (đã gitignore) quyết định **extension ID** — giữ và backup file này để mọi bản build sau giữ nguyên ID.

**Cách B — trực tiếp từ source:**

1. Mở `chrome://extensions`
2. Bật **Developer mode** (góc phải trên)
3. Bấm **Load unpacked** → chọn thư mục `extension/` của repo này
4. Icon "Claude Code Chrome Bridge" xuất hiện trên thanh công cụ. Badge đỏ `×` = chưa kết nối (bình thường, vì server chưa chạy).

### 2. Cài dependencies cho MCP server

```bash
cd server
npm install
```

### 3. Đăng ký MCP server với Claude Code

Cách 1 — đăng ký global (dùng ở mọi project):

```bash
claude mcp add --scope user chrome -- node /duong-dan-tuyet-doi/toi/cc-chrome-extension/server/index.js
```

Cách 2 — theo project: tạo file `.mcp.json` ở gốc project (xem mẫu `mcp.example.json`):

```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": ["/duong-dan-tuyet-doi/toi/cc-chrome-extension/server/index.js"]
    }
  }
}
```

### 4. Dùng

1. Mở Chrome (extension đã cài)
2. Chạy `claude` — Claude Code tự khởi động MCP server, extension tự kết nối trong ~1 giây (badge chuyển `on` màu xanh)
3. Ra lệnh bình thường, ví dụ: *"mở github.com và chụp màn hình"*, *"đọc trang hiện tại rồi điền form đăng ký"*

Kiểm tra kết nối trong Claude Code: gõ `/mcp` → chọn `chrome` → xem tools, hoặc bảo Claude gọi tool `chrome_status`.

## Tools cung cấp cho Claude Code

| Nhóm | Tool | Chức năng |
|---|---|---|
| Điều hướng | `navigate` | Mở URL / back / forward / reload, chờ trang load xong |
| Đọc trang | `read_page` | Cấu trúc trang + các element tương tác (kèm số `ref` để click/fill) |
| | `get_page_text` | Toàn bộ text hiển thị của trang |
| | `find` | Tìm text trên trang, trả về ngữ cảnh + ref của element click được |
| Tương tác | `click`, `fill`, `fill_form` | Click / điền form theo `ref` hoặc CSS selector (bắn event chuẩn, tương thích React/Vue) |
| | `press_key`, `type_text` | Phím thật qua debugger API (Enter, Tab, phím tắt, gõ text) |
| | `scroll`, `wait_for` | Cuộn trang, chờ element xuất hiện |
| | `upload_file` | Gắn file vào `<input type=file>` |
| Quan sát | `take_screenshot` | Chụp PNG viewport hoặc cả trang |
| | `javascript_eval` | Chạy JavaScript trong trang, trả kết quả |
| | `read_console_messages` | Đọc console log/warn/error + exception |
| | `read_network_requests` | Đọc request mạng (URL, status, size, lỗi) |
| Tab/cửa sổ | `list_tabs`, `new_tab`, `close_tab`, `switch_tab`, `resize_window` | Quản lý tab và cửa sổ |
| Khác | `chrome_status` | Kiểm tra extension đã kết nối chưa |

## Triển khai lên VPS cho cả team

Chế độ `--http` cho phép cả team dùng chung **một** server: mỗi thành viên được cấp một token, Claude Code và extension của họ cùng dùng token đó để server ghép cặp đúng người — không ai điều khiển được browser của người khác.

### Trên VPS (Docker + Caddy, tự động HTTPS)

```bash
git clone <repo> && cd cc-chrome-extension/deploy

# Sinh token cho từng thành viên
openssl rand -hex 16   # chạy mỗi lần cho một người

cat > .env <<'EOF'
DOMAIN=chrome.example.com
CC_CHROME_TOKENS=a1b2c3...=alice,d4e5f6...=bob
EOF

docker compose up -d --build
curl https://chrome.example.com/health   # {"ok":true,...}
```

Yêu cầu: domain đã trỏ về IP VPS, mở port 80/443. Không muốn Docker thì dùng `deploy/chrome-bridge.service` (systemd) + Caddy/nginx làm TLS proxy — **bắt buộc có HTTPS/WSS**, đừng expose port 8787 trần ra internet.

Sau khi build extension (`npm run build`), server VPS còn phục vụ file cài đặt tại `https://chrome.example.com/extension.zip` và `/extension.crx` (compose đã mount sẵn `dist/`) — thành viên mới chỉ cần một đường link.

### Trên máy mỗi thành viên — cách nhanh: `/ccchrome connect`

Cài slash command một lần:

```bash
bash scripts/install-command.sh   # copy .claude/commands/ccchrome.md vào ~/.claude/commands/
```

Rồi trong Claude Code:

```
/ccchrome connect https://chrome.example.com
```

Lệnh sẽ hỏi pairing secret (admin cấp — chính là `CC_CHROME_PAIR_SECRET` trên server), sau đó **tự động**: sinh token riêng qua `POST /pair`, chạy `claude mcp add` với token đó, in URL `wss://.../ws?token=...` để dán vào popup extension, và chờ đến khi extension kết nối thành công. Các subcommand khác:

- `/ccchrome status` — kiểm tra server + extension đã nối chưa
- `/ccchrome disconnect` — thu hồi token trên server và gỡ cấu hình MCP
- `/ccchrome local` — cấu hình chạy local không cần VPS

Lưu ý: cần bật pairing trên server bằng `CC_CHROME_PAIR_SECRET` (xem `.env` ở trên). Token sinh động được lưu bền vững trong `CC_CHROME_STATE_FILE` nên restart server không mất.

### Trên máy mỗi thành viên — cách thủ công

1. Cài extension như hướng dẫn ở trên (Load unpacked)
2. Bấm icon extension → đổi URL thành `wss://chrome.example.com/ws?token=<token-của-mình>` → **Lưu & kết nối lại** (badge chuyển `on` xanh)
3. Đăng ký với Claude Code:

```bash
claude mcp add --scope user --transport http chrome \
  https://chrome.example.com/mcp \
  --header "Authorization: Bearer <token-của-mình>"
```

Một người mở nhiều phiên Claude Code cùng lúc vẫn ổn — tất cả phiên cùng token dùng chung browser của người đó.

### Quản lý token

- **Tự phục vụ**: đặt `CC_CHROME_PAIR_SECRET` trên server → thành viên tự lấy token bằng `/ccchrome connect`; thu hồi bằng `/ccchrome disconnect` (hoặc `DELETE /pair`).
- **Thủ công**: sửa `CC_CHROME_TOKENS` trong `.env` rồi `docker compose up -d` (restart server).
- Token dài tối thiểu 8 ký tự, pairing secret tối thiểu 12 (server từ chối giá trị yếu); nên dùng `openssl rand -hex 16`.
- Có thể dùng file thay cho biến môi trường: `CC_CHROME_TOKENS_FILE=/path/tokens.json` với nội dung `{"<token>": "<tên>"}`.

## Cấu hình

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `CC_CHROME_MODE` | `stdio` | `http` để chạy chế độ VPS (hoặc thêm cờ `--http`). |
| `CC_CHROME_PORT` | `9876` (stdio) / `8787` (http) | Port WebSocket (stdio) hoặc port HTTP server (http mode). |
| `CC_CHROME_HOST` | `127.0.0.1` (stdio) / `0.0.0.0` (http) | Địa chỉ bind. |
| `CC_CHROME_TOKENS` | — | Token tĩnh ở http mode: `token1=tên1,token2=tên2`. |
| `CC_CHROME_TOKENS_FILE` | — | Thay thế: file JSON `{"token": "tên"}`. |
| `CC_CHROME_PAIR_SECRET` | — | Bật pairing tự phục vụ (`POST /pair`, dùng bởi `/ccchrome connect`). Http mode cần ít nhất token tĩnh hoặc pair secret. |
| `CC_CHROME_STATE_FILE` | `./ccchrome-tokens.json` | Nơi lưu bền vững token sinh động. |
| `CC_CHROME_TIMEOUT_MS` | `45000` | Timeout mỗi lệnh gửi tới extension. |

Đổi port ở phía extension: bấm icon extension → sửa "Địa chỉ MCP server" → **Lưu & kết nối lại**.

## Lưu ý bảo mật

- WebSocket server chỉ bind `127.0.0.1` và **bắt buộc** kết nối phải có origin `chrome-extension://` — process khác trên máy (script Node, curl…) không giả làm extension được, máy khác trong mạng LAN không kết nối được. Muốn siết thêm, đặt `CC_CHROME_EXTENSION_ID=<id>` để chỉ chấp nhận đúng một extension (ID in ra khi chạy `npm run build`).
- Extension có quyền `<all_urls>` + `debugger` (giống extension gốc của Anthropic) — Claude Code sẽ thao tác được trên **mọi trang đang mở, kể cả tab đã đăng nhập**. Khuyến nghị dùng một Chrome profile riêng cho automation nếu không muốn Claude đụng vào tài khoản cá nhân.
- Khi tool dùng debugger API (screenshot full page, eval, phím, console, network), Chrome hiện thanh thông báo *"... started debugging this browser"* — bình thường, đừng bấm Cancel khi đang chạy.

## Chạy test

Test E2E khởi động Chromium thật (nạp extension) + MCP server thật và gọi đủ các tool qua giao thức MCP stdio:

```bash
cd test && npm install && cd ..
node test/e2e.mjs
```

Yêu cầu: có Chromium/Chrome trên máy. Test dùng `executablePath: /opt/pw-browsers/chromium` (môi trường CI); trên máy cá nhân sửa `test/e2e.mjs` cho trỏ đúng Chrome, hoặc bỏ `executablePath` để Playwright tự tải browser.

## Troubleshooting

| Triệu chứng | Cách xử lý |
|---|---|
| Tool báo "Chrome extension is not connected" | Mở Chrome, bấm icon extension xem trạng thái; bấm **Lưu & kết nối lại**. Kiểm tra `claude` đang chạy (server chỉ sống cùng phiên Claude Code). |
| Badge đỏ mãi không xanh | Port lệch nhau — xem popup extension và `CC_CHROME_PORT`. Hoặc port bị process khác chiếm (server sẽ log `port already in use` vào stderr). |
| "Cannot run scripts on chrome://..." | Trang nội bộ của Chrome không cho inject script — chuyển sang tab web thường. |
| Console/network trả rỗng | Việc thu thập chỉ bắt đầu từ lần gọi tool đầu tiên trên tab đó — reload trang rồi đọc lại. |
| Click/fill báo "Ref N is stale" | Trang đã thay đổi — gọi `read_page` lại để lấy ref mới. |
