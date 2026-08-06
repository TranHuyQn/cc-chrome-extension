---
description: Kiểm tra / cài đặt / khởi động lại / xem log Claude Code Chrome Bridge chạy local trên máy này
argument-hint: status | install | restart | logs
allowed-tools: Bash(curl:*), Bash(claude mcp:*), Bash(cat:*), Bash(node:*), Bash(bash:*), Bash(tail:*), Bash(uname:*), Read, Write
---

Bạn đang quản lý **Claude Code Chrome Bridge** chạy như một dịch vụ nền trên chính máy này (cài bằng
`scripts/install.sh`, xem README mục Cài đặt). Không còn server dùng chung/VPS, không còn pairing
secret — mỗi máy tự chạy bridge riêng, mỗi bridge một token riêng.

File trạng thái: `~/.ccchrome.json` — nội dung `{"token": "...", "port": 8787}`, do `install.sh` tạo.
Thư mục cài đặt: `~/.cc-chrome-bridge/` (mã nguồn, `logs/`, `service-unit.sh`, `tokens.json`).

Subcommand người dùng gõ: `$ARGUMENTS` (không có thì coi là `status`).

## `status`

Mục tiêu: báo bridge có đang chạy không và extension đã nối vào chưa.

1. Đọc `~/.ccchrome.json` bằng `cat`. Không có file này → báo "chưa cài — chạy `/ccchrome install`"
   rồi dừng lại, không làm các bước dưới.
2. Lấy `port` từ file đó (mặc định `8787` nếu thiếu trường này). Gọi:
   ```
   curl -sS --max-time 5 http://127.0.0.1:<port>/health
   ```
   - Không có phản hồi / connection refused → bridge **không chạy**. Báo vậy và gợi ý
     `/ccchrome restart` (dịch vụ nền có thể đã bị dừng hoặc crash).
   - Có phản hồi JSON `{"ok":true,"version":"...","extensionsConnected":N,"mcpSessions":M}` →
     bridge đang sống. Đọc `extensionsConnected`:
     - `0` → extension **chưa nối**. Nhắc người dùng: bấm icon extension trong Chrome, kiểm tra "Địa
       chỉ MCP server" đã đúng `ws://127.0.0.1:<port>/ws?token=<token trong ~/.ccchrome.json>` chưa,
       bấm "Lưu & kết nối lại" nếu cần.
     - `> 0` → extension đã nối, báo thành công.
3. Kiểm tra thêm `claude mcp get chrome` để xác nhận MCP server `chrome` đã đăng ký cho Claude Code
   (registered bởi `install.sh`). Chưa có → gợi ý chạy lại `/ccchrome install`.
4. Tóm tắt ngắn gọn: bridge sống/chết, extension nối/chưa, MCP đã đăng ký/chưa.

## `install`

Mục tiêu: **chỉ đường**, không tự chạy gì cả — cài đặt ghi vào `$HOME` và cài một dịch vụ nền, việc đó
người dùng phải tự quyết định chạy khi nào.

In ra đúng lệnh sau và dừng, không thực thi:

```
curl -fsSL https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/install.sh | bash
```

Giải thích ngắn: lệnh tải và cài dịch vụ nền (không cần root, chỉ ghi vào thư mục home), tự sinh token,
tự đăng ký MCP server `chrome` với Claude Code. Sau khi script chạy xong, nó tự in ra hai việc còn lại
phải làm **bằng tay trong Chrome**: mở `chrome://extensions` → bật Developer mode → Load unpacked
(script in sẵn đường dẫn thư mục), rồi dán URL `ws://127.0.0.1:<port>/ws?token=<token>` (script in sẵn)
vào popup extension và bấm "Lưu & kết nối lại". Không có việc nào Claude Code tự làm được thay — cả hai
đều cần Developer mode, chỉ người dùng bấm được.

Nếu người dùng muốn xem trước script làm gì thay vì chạy thẳng, gợi ý:
```
curl -fsSL https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/install.sh -o install.sh
less install.sh
bash install.sh
```

Đã cài rồi mà muốn nâng cấp: chạy lại đúng lệnh trên — `install.sh` tự phát hiện bản cũ, giữ nguyên
token (khỏi phải dán lại URL), chỉ thay mã nguồn và khởi động lại dịch vụ **phía server**. Luôn nhắc
thêm bước KHÔNG tự động: script không cập nhật extension đang chạy trong Chrome — người dùng phải tự
vào `chrome://extensions` bấm **Reload** trên "Claude Code Chrome Bridge" sau mỗi lần nâng cấp, nếu
không sẽ âm thầm chạy extension của bản cũ (có thể thiếu bản vá bảo mật) dù server đã mới.

## `restart`

Mục tiêu: dừng rồi khởi động lại dịch vụ nền, dùng đúng cơ chế `scripts/service-unit.sh` mà
`install.sh`/`uninstall.sh` cũng dùng — không tự bịa lệnh `launchctl`/`systemctl` riêng.

1. Kiểm tra `~/.cc-chrome-bridge/service-unit.sh` có tồn tại không (`cat` hoặc thử đọc). Không có →
   báo "chưa cài — chạy `/ccchrome install`" rồi dừng.
2. Chạy:
   ```bash
   bash -c 'source "$HOME/.cc-chrome-bridge/service-unit.sh" && cc_service_stop && cc_service_start'
   ```
   (macOS dùng `launchctl bootout`/`bootstrap` trên `com.ccchrome.bridge`; Linux dùng
   `systemctl --user` trên `ccchrome-bridge.service` — cả hai đều nằm trong hàm này, không cần biết
   nền tảng nào trước.)
3. Đợi khoảng 1-2 giây rồi gọi `/ccchrome status` để xác nhận bridge sống lại và cổng đúng như cũ.
4. Không khởi động được (script báo lỗi) → in nguyên lỗi cho người dùng, gợi ý xem log bằng
   `/ccchrome logs`, và câu lệnh chạy tay (đọc `port` từ `~/.ccchrome.json`, mặc định `8787` nếu file
   không có trường đó — **thiếu `CC_CHROME_TOKENS_FILE` thì lệnh dưới chết ngay với `FATAL: http mode
   requires auth`**, đây không phải lỗi vặt, thiếu nó là lệnh không chạy được gì cả):
   ```bash
   CC_CHROME_TOKENS_FILE="$HOME/.cc-chrome-bridge/tokens.json" CC_CHROME_PORT="<port>" \
     node "$HOME/.cc-chrome-bridge/server/index.js" --http
   ```

## `logs`

In khoảng 50 dòng cuối của log lỗi:

```
tail -n 50 "$HOME/.cc-chrome-bridge/logs/bridge.err.log"
```

File không tồn tại → báo "chưa cài, hoặc dịch vụ nền chưa từng chạy lần nào — chạy `/ccchrome install`
hoặc `/ccchrome restart`". Có thể nhắc thêm: log output thường (không phải lỗi) nằm ở
`~/.cc-chrome-bridge/logs/bridge.log`, cùng thư mục.

## Lưu ý chung

- Không có "server-url" hay "pairing secret" nào cần hỏi nữa — bridge luôn là `127.0.0.1`, cổng đọc từ
  `~/.ccchrome.json`. Đừng bịa ra bước hỏi những thứ đó.
- Mọi lệnh `curl` thêm `--max-time 10` (trừ lệnh `install` in ra cho người dùng tự chạy — đó không phải
  lệnh do bạn thực thi).
- Kết thúc mỗi subcommand bằng một tóm tắt ngắn: trạng thái hiện tại + bước tiếp theo (nếu còn).
