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

## Cài đặt

### 1. Cài extension vào Chrome

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

## Cấu hình

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `CC_CHROME_PORT` | `9876` | Port WebSocket của server. Đổi thì cũng phải đổi URL trong popup của extension. |
| `CC_CHROME_TIMEOUT_MS` | `45000` | Timeout mỗi lệnh gửi tới extension. |

Đổi port ở phía extension: bấm icon extension → sửa "Địa chỉ MCP server" → **Lưu & kết nối lại**.

## Lưu ý bảo mật

- WebSocket server chỉ bind `127.0.0.1` và chỉ chấp nhận kết nối có origin `chrome-extension://` — process khác trên máy không giả làm Claude Code được, máy khác trong mạng LAN không kết nối được.
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
