# Claude Code Chrome Bridge

Extension thay thế cho **Claude in Chrome** chính thức, dành cho team dùng chung tài khoản Claude **chỉ với Claude Code** (không đăng nhập được claude.ai). Extension gốc bắt buộc đăng nhập claude.ai trong browser; bản bridge này thì **không cần bất kỳ đăng nhập nào** — Claude Code điều khiển Chrome thông qua một MCP server chạy local trên máy bạn.

> **Nâng lên 3.0.0 — bắt buộc cài lại extension, cả team.** Bản này thêm cách
> ly theo tab group cho từng phiên Claude Code (chi tiết ở [Nhóm tab theo
> phiên](#nhóm-tab-theo-phiên) bên dưới). Khác với lần nâng 1.x → 2.0.0 —
> handshake WebSocket khi đó bị từ chối thẳng nếu lệch bản — lần này extension
> 2.x vẫn **kết nối được** bình thường với server 3.0.0, không có lỗi nào báo
> ra: `navigate` không kèm `tabId` lại chiếm tab đang mở trước mặt bạn,
> `list_tabs` lại liệt kê mọi tab, và không tab nào bị chặn — tức là chạy mà
> **không có** cách ly, âm thầm mất đúng đảm bảo mà bản 3.0.0 hứa. Phải tải
> lại `extension.zip` và Load unpacked đè lên bản cũ ở **mọi máy** để có được
> cách ly thật.

## Kiến trúc

```
Claude Code ──(MCP / stdio)──► MCP server (Node.js) ──(WebSocket, chỉ localhost)──► Chrome Extension (MV3)
                                                                                        │
                                                                          chrome.tabs / chrome.scripting
                                                                          chrome.debugger (CDP)
```

- **`extension/`** — Chrome extension (Manifest V3). Service worker kết nối tới MCP server qua WebSocket `ws://127.0.0.1:9876`, tự động reconnect, và thực thi các lệnh điều khiển browser.
- **`server/`** — MCP server (Node.js ≥ 18). Claude Code nói chuyện với nó qua stdio; mỗi tool call được chuyển tiếp tới extension và trả kết quả về.

Ở chế độ local (stdio) mặc định, mọi kết nối chỉ nằm trong `127.0.0.1` — không có dữ liệu nào gửi ra ngoài, không cần tài khoản Anthropic trong browser. (Chế độ `--http` bên dưới thì khác: server bind `0.0.0.0` để reverse proxy tới được — đọc kỹ [Lưu ý bảo mật](#lưu-ý-bảo-mật).)

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

## Nhóm tab theo phiên

**Nâng cấp:** 3.0.0 bắt buộc cài lại extension cho cả team — xem ghi chú ở
đầu file, extension cũ ghép server mới vẫn chạy được nhưng không có cách ly.

Kể từ 3.0.0, mỗi phiên Claude Code (mỗi lần chạy `claude`, hoặc mỗi kết nối
MCP ở chế độ `--http`) có **một tab group riêng** trong Chrome, đặt tên
`Claude · xxxx` (4 ký tự đầu của session id) và tô màu cam để phân biệt với
tab cá nhân.

- Tab do `navigate` (không kèm `tabId`) hoặc `new_tab` mở ra sẽ **tự động vào
  nhóm của phiên đó** — không còn chiếm tab đang mở trước mặt bạn như trước
  2.x nữa.
- Tab đó mở **trong nền, không giành focus của bạn** — Chrome không tự nhảy
  sang tab hay cửa sổ đó, bạn cứ tiếp tục làm việc trên tab đang xem trong khi
  Claude thao tác ở tab riêng của nó. Cần xem nó thì gọi `switch_tab`.
- **Mọi tool chỉ thao tác được trên tab đang nằm trong nhóm của phiên mình.**
  Gọi tool với `tabId` của một tab ngoài nhóm sẽ bị từ chối kèm tên nhóm và
  cách xử lý (kéo tab vào nhóm, hoặc mở tab mới bằng `new_tab`).
- **Kéo tab của bạn vào nhóm chính là cách cấp quyền cho Claude đọc/thao tác
  trên tab đó** — giống hệt cách extension Claude for Chrome chính thức hoạt
  động, nhóm là ranh giới những gì Claude nhìn thấy được.
- `list_tabs` chỉ liệt kê tab trong nhóm của phiên mình, không phải toàn bộ
  tab đang mở trong Chrome.
- Chrome không cho tồn tại một tab group rỗng, nên **nhóm chỉ xuất hiện sau
  khi Claude mở tab đầu tiên** trong phiên đó (qua `navigate` hoặc `new_tab`).
  Trước đó bạn chưa có nhóm nào để kéo tab vào.
- Extension cần thêm quyền `tabGroups` (đã có trong `extension/manifest.json`
  từ 3.0.0) để tạo và quản lý các nhóm này.

### Hai điều cần biết trước khi dùng

**Nhóm cũ không tự dọn.** Session id đổi mỗi lần bạn chạy lại `claude`, và ở
chế độ `--http` cũng đổi sau khi phiên MCP hết hạn nhàn rỗi. Nhóm của phiên cũ
vẫn nằm nguyên trong Chrome nhưng đã **mồ côi**: không phiên nào đang sống sở
hữu nó nữa, nên Claude không thao tác được lên tab trong đó (bị từ chối như mọi
tab ngoài nhóm) và `list_tabs` cũng không thấy. Extension không tự đóng chúng —
bạn tự đóng bằng tay khi thấy nhiều nhóm cam xếp đống. Đây là hành vi đúng như
thiết kế, không phải lỗi.

**`resize_window` tác động lên cả cửa sổ, không chỉ tab trong nhóm.** Nó tìm
tab trong nhóm của phiên rồi đổi kích thước **cửa sổ chứa tab đó** — mà cửa sổ
đó có thể đang chứa cả tab cá nhân của bạn. Ranh giới nhóm là **theo tab**, chứ
không phải theo cửa sổ: Claude không đọc/không bấm được tab ngoài nhóm, nhưng
vẫn có thể làm cửa sổ chứa chúng đổi kích thước. Muốn tách hẳn thì để nhóm của
Claude ở một cửa sổ riêng.

## Triển khai lên VPS cho cả team

Chế độ `--http` cho phép cả team dùng chung **một** server: mỗi thành viên được cấp một token, Claude Code và extension của họ cùng dùng token đó để server ghép cặp đúng người — không ai điều khiển được browser của người khác.

> **Deploy lên home server sau Cloudflare Tunnel?** Dùng hướng dẫn riêng:
> [`docs/deploy-cloudflare-tunnel.md`](docs/deploy-cloudflare-tunnel.md). Setup đó
> không cần Caddy (Cloudflare lo TLS) và không mở port nào ra internet, nên nó
> dùng `deploy/cloudflare/docker-compose.yml` chứ không phải file compose dưới đây.

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

### Trên máy mỗi thành viên — cách nhanh nhất: một lệnh

```bash
curl -fsSL https://chrome.example.com/install.sh | bash
```

Lệnh này tải và chạy trực tiếp một script bash từ server — biết vậy trước khi chạy. Muốn xem trước script làm gì thì tách làm hai bước:

```bash
curl -fsSL https://chrome.example.com/install.sh -o install.sh
less install.sh        # đọc trước khi chạy
bash install.sh
```

Script chỉ cài slash command `/ccchrome` vào `~/.claude/commands/`, rồi in ra một bước tiếp theo duy nhất — trong Claude Code, chạy:

```
/ccchrome connect https://chrome.example.com
```

Lệnh đó mới là nơi dẫn cài extension Chrome từng bước (tải, giải nén vào một thư mục cố định để giữ nguyên extension ID mà Chrome sinh theo đường dẫn, **Load unpacked**/**Reload** trong `chrome://extensions`) và hỏi pairing secret, admin cấp.

Script không tự chạy `claude mcp add`, không tự hỏi pairing secret thay bạn, và không tự động điều khiển Chrome — những việc đó cần Developer mode hoặc secret của admin, không tự động hoá được.

### Trên máy mỗi thành viên — từng bước bằng tay, hoặc muốn hiểu `/ccchrome connect` làm gì

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
- `/pair` bị giới hạn 10 lần sai secret trong 15 phút cho mỗi IP; vượt thì trả **429 kèm `Retry-After`** (chờ hết giờ là dùng lại được). Nếu server đứng sau proxy mà quên đặt `CC_CHROME_TRUST_PROXY=1`, mọi người sẽ bị tính chung một IP (IP của proxy) — server có log cảnh báo lúc khởi động.
- Chạm trần `CC_CHROME_MAX_TOKENS` là chuyện khác hẳn: `/pair` trả **503, không có `Retry-After`** — chờ bao lâu cũng không hết, phải nhờ admin thu hồi token cũ (`DELETE /pair`) hoặc nâng trần rồi restart.

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
| `CC_CHROME_TRUST_PROXY` | — | Đặt `1` khi server đứng sau reverse proxy: rate-limit đọc IP thật từ `X-Forwarded-For` (**entry cuối cùng** — entry do proxy kề bên nối vào; các entry bên trái do client tự khai), và `/pair` mới tin `X-Forwarded-Proto`/`X-Forwarded-Host` khi dựng URL trả về. Không đặt thì dùng IP socket và host của chính request. Chỉ bật khi port 8787 không tới được từ đâu khác ngoài proxy đó. |
| `CC_CHROME_MAX_TOKENS` | `100` | Trần số token động, chặn việc biến secret bị lộ thành máy phát token. Chạm trần thì `/pair` trả **503** (chờ không hết — admin phải thu hồi bớt hoặc nâng trần), khác với 429 của rate limit. Giá trị không phải số dương sẽ bị bỏ qua kèm log cảnh báo. |
| `CC_CHROME_SESSION_TTL_MS` | `28800000` (8 tiếng) | Session MCP không hoạt động quá lâu sẽ bị đóng và dọn. |
| `CC_CHROME_RECONNECT_GRACE_MS` | `25000` | Khi extension chưa kết nối, mỗi lệnh sẽ **chờ** ngần này rồi mới báo lỗi. Chrome huỷ service worker của extension khi cửa sổ Chrome nằm ở nền (đóng socket với mã 1001), alarm bật lại trong khoảng 30 giây — nhờ khoảng chờ này lệnh chỉ bị chậm thay vì hỏng. Phải nhỏ hơn `CC_CHROME_TIMEOUT_MS`. |
| `CC_CHROME_EXTENSION_ID` | — | Chỉ chấp nhận đúng một extension ID. **Chỉ dùng được khi mọi người cài bản `.crx` đã ký** (ID in ra khi `npm run build`, do `key.pem` quyết định): cài kiểu zip + **Load unpacked** sinh ID theo đường dẫn, khác nhau trên từng máy — đặt biến này khi đó sẽ khoá cả team ra ngoài. Không đặt thì chấp nhận mọi `chrome-extension://`. Xem thêm [Lưu ý bảo mật](#lưu-ý-bảo-mật): pin này thu hẹp chứ không đóng được lỗ origin giả. |

Đổi port ở phía extension: bấm icon extension → sửa "Địa chỉ MCP server" → **Lưu & kết nối lại**.

## Lưu ý bảo mật

- **Check origin làm được gì và không làm được gì.** Cả hai chế độ đều **bắt buộc** handshake WebSocket phải có header `Origin: chrome-extension://…` (thiếu origin cũng bị từ chối). Việc này chặn được kết nối cross-origin phát sinh từ trong browser — một trang web bất kỳ mở `new WebSocket("ws://127.0.0.1:9876")` sẽ gửi origin `https://…` và bị từ chối — và nâng rào với client local nghiệp dư. Nhưng `Origin` là header do **client tự đặt**, không có gì bảo chứng: một process viết riêng cho việc này (script Node dùng `ws`, hay `curl`) chỉ cần gửi thêm một dòng header là qua được. Test `test/e2e-http.mjs` của chính repo này chứng minh điều đó — nó nối vào server bằng client `ws` thuần Node với origin giả và được chấp nhận như extension thật. **Đừng coi check origin là hàng rào chống được process local có chủ đích.**
- **Ở http mode, hàng rào thật là token.** Server bind `0.0.0.0` **có chủ ý** để reverse proxy (Caddy trong `deploy/`) tới được — nghĩa là `/ws` và `/mcp` sẽ tới được từ internet qua proxy đó. Vì vậy hai điều sau là **bắt buộc, không phải khuyến nghị**: (1) TLS phải terminate ở proxy, dùng `wss://`/`https://` — token đi trong subprotocol/header, để plaintext là lộ token trên đường truyền; (2) **đừng bao giờ expose port 8787 trần ra internet** (compose dùng `expose` chứ không `ports`; bản systemd đặt `CC_CHROME_HOST=127.0.0.1`) — 8787 lộ ra ngoài thì ai cũng tự đặt được `X-Forwarded-For` và rate limit của `/pair` mất tác dụng. Token bị lộ thì thu hồi bằng `/ccchrome disconnect` hoặc `DELETE /pair`.
- **Ở stdio mode không có token nào cả** — hai thứ duy nhất chặn đường là bind `127.0.0.1` (máy khác trong LAN không vào được) và một header có thể giả. Nói thẳng: mô hình đe dọa thực tế ở đây là *"phần mềm khác đang chạy sẵn trên máy bạn"*, và check origin không giải quyết được nó. Biện pháp giảm thiểu thật sự là **dùng một Chrome profile riêng cho automation**, để dù có bị lợi dụng thì cũng không có tab nào đăng nhập tài khoản cá nhân trong đó.
- `CC_CHROME_EXTENSION_ID=<id>` thu hẹp thêm (chỉ chấp nhận đúng một extension ID) nhưng **không đóng được lỗ trên** — origin vẫn là chuỗi do client tự khai, chỉ là phải đoán đúng thêm một ID. Và pin này **chỉ dùng được khi cả team cài bản `.crx` đã ký** (kéo thả trên Linux, hoặc enterprise policy trên Windows/macOS): cài kiểu **zip + Load unpacked** như hướng dẫn ở trên sinh ID **theo đường dẫn thư mục**, khác nhau trên máy từng người — đặt pin trong trường hợp đó sẽ khoá cả team ra ngoài.
- Extension có quyền `<all_urls>` + `debugger` (giống extension gốc của Anthropic) — nhưng khác với bản gốc, mọi tool bị giới hạn trong tab group của phiên (xem [Nhóm tab theo phiên](#nhóm-tab-theo-phiên)): Claude chỉ thao tác được trên tab **đang nằm trong nhóm đó**, kể cả tab đã đăng nhập, chứ không phải mọi trang đang mở trong Chrome. Kéo một tab vào nhóm là tự tay cấp quyền đó cho nó. Khuyến nghị dùng một Chrome profile riêng cho automation nếu không muốn Claude đụng vào tài khoản cá nhân. Quyền `tabGroups` (thêm từ 3.0.0) chỉ dùng để tạo/quản lý nhóm này, không mở rộng thêm gì Claude thấy được.
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
