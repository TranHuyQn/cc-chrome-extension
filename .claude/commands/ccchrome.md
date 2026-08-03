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
   Kết quả JSON gồm `token`, `name`, `mcpUrl`, `wsUrl`. Xử lý lỗi:
   - **401** — pairing secret sai. Hỏi lại secret, đừng sinh token mới bằng giá trị cũ.
   - **404** — server chưa bật pairing (`CC_CHROME_PAIR_SECRET` chưa đặt) — báo người dùng liên hệ admin.
   - **429** — bị rate limit vì nhập sai secret quá nhiều (10 lần / 15 phút / IP). Response có header `Retry-After` (giây): báo người dùng chờ đúng chừng đó rồi chạy lại. **Chờ là hết**, không cần làm gì khác. Lấy header bằng `curl -sS -D - -o /dev/null ...` nếu cần.
   - **503** — server đã chạm trần `CC_CHROME_MAX_TOKENS` (số token động tối đa). **Chờ không hết** — báo người dùng nhờ admin thu hồi token cũ (`DELETE /pair`) hoặc nâng `CC_CHROME_MAX_TOKENS` rồi restart server. Đừng thử lại trong vòng lặp.

   **Không bao giờ in pairing secret ra màn hình**; token cá nhân thì in được (người dùng cần dán nó vào extension).

4. **Lưu trạng thái**: ghi `~/.ccchrome.json` chứa `serverUrl`, `token`, `name`.

5. **Đăng ký MCP server** (bỏ qua nếu đã có — kiểm tra bằng `claude mcp get chrome`):
   ```
   claude mcp add --scope user --transport http chrome <serverUrl>/mcp --header "Authorization: Bearer <token>"
   ```
   Nếu đã tồn tại với token khác: `claude mcp remove --scope user chrome` rồi add lại.

6. **Nhắc cài/cập nhật extension lên bản ≥ 2.0.0** — bước này phải nói trước bước dán URL. Từ 2.0.0 token đi qua WebSocket subprotocol chứ không còn ở query string, nên **extension 1.x không bắt tay được với server 2.0.0** (và ngược lại): badge cứ đỏ mãi dù URL và token đều đúng. In cho người dùng:
   - Tải bản mới nhất tại `<serverUrl>/extension.zip` (chính server này phục vụ file đó), giải nén ra một thư mục cố định
   - `chrome://extensions` → **Load unpacked** → chọn thư mục đó (đè lên bản cũ), hoặc bấm **Reload** nếu đã cài từ chính thư mục đó
   - Người dùng đang cài từ source repo thì chỉ cần `git pull` rồi **Reload** trong `chrome://extensions`

7. **Hướng dẫn nối extension**: in cho người dùng (dùng `wsUrl` từ bước 3, hoặc tự ghép `wss://<host>/ws?token=<token>`):
   - Mở Chrome → bấm icon **Claude Code Chrome Bridge**
   - Dán `<wsUrl>` vào ô "Địa chỉ MCP server" → bấm **Lưu & kết nối lại**
   - Badge chuyển `on` màu xanh là xong. Badge đỏ `×` thì **xem dòng lỗi ngay trong popup** — từ 2.0.0 server báo rõ lý do từ chối (token sai/bị thu hồi, URL thiếu token, extension cũ hơn server, origin không hợp lệ) chứ không còn im lặng nữa.

8. **Chờ extension kết nối**: poll tối đa ~2 phút:
   ```
   for i in $(seq 1 40); do
     curl -sS -H "Authorization: Bearer <token>" <serverUrl>/pair/status | grep -q '"extensionConnected":true' && echo CONNECTED && break
     sleep 3
   done
   ```
   - Nếu `CONNECTED`: báo thành công 🎉 và nhắc: **tool chrome chỉ xuất hiện ở phiên Claude Code mới** — thoát và chạy lại `claude` (hoặc `/mcp` để kiểm tra) nếu phiên hiện tại chưa thấy server `chrome`.
   - Nếu hết giờ: token và cấu hình phía Claude Code đã xong, vấn đề nằm ở phía extension. In lại `wsUrl` và bảo người dùng kiểm tra theo thứ tự này (đừng chỉ nói "chưa dán URL" — nguyên nhân hay gặp nhất hiện nay là extension còn ở bản 1.x, dán URL đúng cũng vẫn không kết nối được):
     1. **Bản extension** — bấm icon extension xem version, phải **≥ 2.0.0**. Cũ hơn thì tải lại `<serverUrl>/extension.zip` và Load unpacked đè lên (bước 6).
     2. **Dòng lỗi trong popup** — từ 2.0.0 popup nói rõ lý do bị từ chối; đọc nó rồi xử theo:
        - *"Token sai hoặc đã bị thu hồi"* → chạy lại `/ccchrome connect` để lấy token mới
        - *"URL thiếu token"* → URL dán vào thiếu `?token=…`, dán lại đúng `wsUrl` ở trên
        - *"extension cũ hơn server"* → quay lại mục 1
        - *"origin không hợp lệ"* → admin đặt `CC_CHROME_EXTENSION_ID` không khớp với extension đang cài; báo admin
        - Popup trống / *"MCP server chưa chạy"* → URL chưa được dán, hoặc sai host/scheme (`wss://` cho server có HTTPS)
     3. Dán xong thì chạy `/ccchrome status` để xác nhận.

## `status`

Đọc `~/.ccchrome.json`; không có thì báo "chưa kết nối, chạy `/ccchrome connect`". Có thì gọi `GET <serverUrl>/pair/status` với Bearer token và báo cáo: server sống không, `extensionConnected` true/false, tên người dùng. Kiểm tra thêm `claude mcp get chrome` để xác nhận MCP đã đăng ký. Nếu `extensionConnected` là false, in lại `wsUrl` và chạy đúng danh sách kiểm tra ở nhánh hết giờ của `connect` (bản extension ≥ 2.0.0 trước, rồi đọc dòng lỗi trong popup, rồi mới tới chuyện dán URL).

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
