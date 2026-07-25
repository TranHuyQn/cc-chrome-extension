---
description: Kết nối Claude Code với Chrome Bridge (tự sinh token, ghép với extension)
argument-hint: connect [server-url] | status | disconnect | local
allowed-tools: Bash(curl:*), Bash(claude mcp:*), Bash(cat:*), Bash(mkdir:*), Bash(sleep:*), Bash(node:*), Read, Write
---

Bạn đang quản lý kết nối giữa Claude Code và **Claude Code Chrome Bridge** (extension điều khiển Chrome qua MCP server). File trạng thái cục bộ: `~/.ccchrome.json` với nội dung `{"serverUrl": "...", "token": "...", "name": "..."}`.

Subcommand người dùng gõ: `$ARGUMENTS` (không có thì coi là `connect`).

## `connect [server-url]`

Mục tiêu: tự sinh token trên server, cấu hình MCP cho Claude Code, và chờ extension kết nối.

1. **Xác định server URL** theo thứ tự ưu tiên: đối số thứ 2 → trường `serverUrl` trong `~/.ccchrome.json` → biến môi trường `CCCHROME_SERVER`. Không tìm thấy thì hỏi người dùng (ví dụ `https://chrome.example.com`). Bỏ dấu `/` cuối.

2. **Nếu đã có token cũ** trong `~/.ccchrome.json`: kiểm tra còn hợp lệ không bằng
   `curl -sS -H "Authorization: Bearer <token>" <serverUrl>/pair/status`.
   Nếu trả về JSON có `name` (HTTP 200) thì **dùng lại token đó**, bỏ qua bước 3–4 (không sinh token mới khi token cũ còn dùng được).

3. **Sinh token mới**: cần pairing secret của team — lấy từ biến môi trường `CCCHROME_PAIR_SECRET`, không có thì hỏi người dùng (admin cấp, chính là `CC_CHROME_PAIR_SECRET` trên server). Rồi gọi:
   ```
   curl -sS -X POST <serverUrl>/pair \
     -H "Authorization: Bearer <pair-secret>" \
     -H "content-type: application/json" \
     -d '{"name": "<tên người dùng, hỏi hoặc lấy $USER>"}'
   ```
   Kết quả JSON gồm `token`, `name`, `mcpUrl`, `wsUrl`. Nếu 401: secret sai. Nếu 404: server chưa bật pairing (`CC_CHROME_PAIR_SECRET` chưa đặt) — báo người dùng liên hệ admin.
   **Không bao giờ in pairing secret ra màn hình**; token cá nhân thì in được (người dùng cần dán nó vào extension).

4. **Lưu trạng thái**: ghi `~/.ccchrome.json` chứa `serverUrl`, `token`, `name`.

5. **Đăng ký MCP server** (bỏ qua nếu đã có — kiểm tra bằng `claude mcp get chrome`):
   ```
   claude mcp add --scope user --transport http chrome <serverUrl>/mcp --header "Authorization: Bearer <token>"
   ```
   Nếu đã tồn tại với token khác: `claude mcp remove --scope user chrome` rồi add lại.

6. **Hướng dẫn nối extension**: in cho người dùng (dùng `wsUrl` từ bước 3, hoặc tự ghép `wss://<host>/ws?token=<token>`):
   - Mở Chrome → bấm icon **Claude Code Chrome Bridge**
   - Dán `<wsUrl>` vào ô "Địa chỉ MCP server" → bấm **Lưu & kết nối lại**
   - Badge chuyển `on` màu xanh là xong

7. **Chờ extension kết nối**: poll tối đa ~2 phút:
   ```
   for i in $(seq 1 40); do
     curl -sS -H "Authorization: Bearer <token>" <serverUrl>/pair/status | grep -q '"extensionConnected":true' && echo CONNECTED && break
     sleep 3
   done
   ```
   - Nếu `CONNECTED`: báo thành công 🎉 và nhắc: **tool chrome chỉ xuất hiện ở phiên Claude Code mới** — thoát và chạy lại `claude` (hoặc `/mcp` để kiểm tra) nếu phiên hiện tại chưa thấy server `chrome`.
   - Nếu hết giờ: token và cấu hình vẫn đã xong, chỉ còn thiếu bước dán URL vào extension — in lại `wsUrl` và hướng dẫn, bảo người dùng chạy `/ccchrome status` sau khi dán.

## `status`

Đọc `~/.ccchrome.json`; không có thì báo "chưa kết nối, chạy `/ccchrome connect`". Có thì gọi `GET <serverUrl>/pair/status` với Bearer token và báo cáo: server sống không, `extensionConnected` true/false, tên người dùng. Kiểm tra thêm `claude mcp get chrome` để xác nhận MCP đã đăng ký. Nếu `extensionConnected` là false, in lại `wsUrl` và hướng dẫn dán vào popup extension.

## `disconnect`

1. Đọc `~/.ccchrome.json` (không có thì chỉ chạy bước 3).
2. Thu hồi token trên server: `curl -sS -X DELETE -H "Authorization: Bearer <token>" <serverUrl>/pair` (lỗi cũng không sao — token tĩnh do admin cấp thì server sẽ từ chối, cứ tiếp tục).
3. `claude mcp remove --scope user chrome` và xóa `~/.ccchrome.json`.
4. Báo người dùng có thể xóa URL trong popup extension nếu muốn.

## `local`

Chạy không cần VPS (server stdio trên máy này):
1. Hỏi/tìm đường dẫn repo `cc-chrome-extension` (thử thư mục hiện tại trước — tìm `server/index.js` có chuỗi `claude-code-chrome-mcp`).
2. Nếu `server/node_modules` chưa có: chạy `npm install` trong `server/`.
3. `claude mcp add --scope user chrome -- node <đường-dẫn-tuyệt-đối>/server/index.js`
4. Nhắc: mở Chrome với extension đã cài (Load unpacked), URL mặc định `ws://127.0.0.1:9876` là dùng được ngay; khởi động lại phiên `claude` để thấy tools.

## Lưu ý chung

- Luôn dùng đúng URL/token đã lưu, đừng tự bịa.
- Mọi lệnh curl thêm `--max-time 10`.
- Kết thúc bằng tóm tắt ngắn: trạng thái hiện tại + bước tiếp theo (nếu còn).
