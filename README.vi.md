*[English](README.md)*

# Claude Code Chrome Bridge

Extension thay thế cho **Claude in Chrome** chính thức, dành cho team dùng chung tài khoản Claude **chỉ với Claude Code** (không đăng nhập được claude.ai). Extension gốc bắt buộc đăng nhập claude.ai trong browser; bản bridge này thì **không cần bất kỳ đăng nhập nào** — Claude Code điều khiển Chrome thông qua một MCP server chạy local trên máy bạn.

> **1.0.0 là bản phát hành đầu tiên.** Mọi số hiệu 2.x/3.x xuất hiện trong
> lịch sử git chỉ tồn tại nội bộ, chưa từng phát hành ra ngoài — đừng tìm
> chúng trên GitHub Releases.
>
> Cách cài: **mỗi người tự chạy bridge trên máy mình**, cài bằng một lệnh
> (`curl … | bash` trên macOS/Linux, `irm … -OutFile` + `-File` trên Windows — xem
> [Cài đặt](#cài-đặt)), chạy như một dịch vụ nền tự khởi động lại cùng máy,
> không phụ thuộc việc `claude` có đang chạy hay không. **Không còn mô hình
> server dùng chung**: không VPS, không tên miền, không pairing secret — mọi
> thứ chạy trên `127.0.0.1` của chính máy bạn. Hai điều cần biết:
> - `navigate` giờ **từ chối** đưa tab tới `chrome:`, `chrome-extension:`,
>   `devtools:`, `edge:` hay `about:` khác `about:blank` — trước đây có thể
>   đỗ một tab ở `chrome://...`, giờ thì không.
> - Dịch vụ nền ghi **đường dẫn tuyệt đối** tới `node` vào lúc cài, không phải
>   `node` trần. Đổi phiên bản Node bằng nvm/volta/fnm sau khi cài xong nghĩa
>   là đường dẫn cũ biến mất — dịch vụ crash-loop âm thầm, không có gì báo lý
>   do. Chạy lại lệnh cài ở mục [Cài đặt](#cài-đặt) (`/ccchrome install` in ra
>   đúng lệnh đó) để ghi lại đường dẫn `node` mới.

## Kiến trúc

```
Claude Code ──(MCP / Streamable HTTP + Bearer token, 127.0.0.1)──► MCP server (Node.js, dịch vụ nền)
                                                                              │
                                                        (WebSocket ws://127.0.0.1:<port>/ws?token=...)
                                                                              ▼
                                                                    Chrome Extension (MV3)
                                                                              │
                                                              chrome.tabs / chrome.scripting
                                                              chrome.debugger (CDP)
```

- **`extension/`** — Chrome extension (Manifest V3). Service worker kết nối tới MCP server qua WebSocket `ws://127.0.0.1:8787/ws`, tự động reconnect, và thực thi các lệnh điều khiển browser.
- **`server/`** — MCP server (Node.js ≥ 18), chạy như một **dịch vụ nền** (LaunchAgent trên macOS, `systemd --user` trên Linux) chứ không phải tiến trình con của `claude` — cài bởi `scripts/install.sh`, tự khởi động lại cùng máy. Claude Code nói chuyện với nó qua MCP Streamable HTTP kèm Bearer token, cùng cổng mà extension nối WebSocket vào; mỗi tool call được chuyển tiếp tới extension và trả kết quả về.

Bridge chỉ nghe trên `127.0.0.1` — không có dữ liệu nào gửi ra ngoài, không cần tài khoản Anthropic trong browser, và không có gì để lộ ra mạng. Mỗi người chạy bridge của riêng mình; không có máy chủ trung gian nào cho cả team.

## Cài đặt

Yêu cầu: Node.js ≥ 18 và Google Chrome (hoặc Chromium) đã cài sẵn. Không cần quyền root — script chỉ
ghi vào thư mục home của bạn.

### 1. Một lệnh

**macOS / Linux:**

```bash
curl -fsSL https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/install.sh | bash
```

**Windows** (PowerShell thường, **không** cần "Run as administrator"):

```powershell
irm https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/install.ps1 -OutFile "$env:TEMP\install.ps1"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\install.ps1"
```

> **Hai dòng chứ không phải `irm … | iex`, và đây là bắt buộc.** `install.ps1`
> bắt đầu bằng BOM UTF-8 vì Windows PowerShell 5.1 không có BOM thì đọc file
> theo bảng mã ANSI, làm hỏng mọi chuỗi tiếng Việt tới mức file không parse
> nổi. Nhưng `| iex` lại đưa chính BOM đó vào parser như một ký tự thường —
> `The term 'ï»¿#' is not recognized`. Thêm nữa, `irm` giải mã asset của GitHub
> (`application/octet-stream`) theo ISO-8859-1 nên chữ có dấu vỡ hết kể cả khi
> không có BOM. `-OutFile` ghi nguyên byte, `-File` đọc đúng — đó cũng là
> đường CI kiểm mỗi lần push.

> **Windows đã được nghiệm thu trọn vẹn trên máy thật** (Windows 11, PowerShell 5.1):
> cài **không cần quyền admin**, bridge tự lên và `/health` trả lời, extension nối được,
> tool trình duyệt chạy, khung chat side panel trả lời được, **khởi động lại máy thì dịch
> vụ tự lên và extension nối lại**, và **gỡ cài đặt sạch trong một lần chạy** — task
> biến mất, tiến trình về 0, cổng được trả lại. Cả ba nền tảng giờ đều đã chạy thật.

Lệnh này tải và chạy thẳng một script từ GitHub Releases — biết vậy trước khi chạy. Muốn xem
trước thì tách làm hai bước:

```bash
curl -fsSL https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/install.sh -o install.sh
less install.sh        # đọc trước khi chạy
bash install.sh
```

```powershell
irm https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/install.ps1 -OutFile install.ps1
notepad install.ps1    # đọc trước khi chạy
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Script tự làm hết: tải gói phát hành (mã nguồn `server/` + `extension/` kèm sẵn `node_modules`, không
cần bạn tự `npm install`), sinh token, cài **dịch vụ nền** tự khởi động cùng máy chạy bridge tại
`http://127.0.0.1:8787`, và đăng ký MCP server `chrome` với Claude Code
(`claude mcp add --scope user --transport http chrome ...`).

Dịch vụ nền đó là **của riêng tài khoản bạn** và lên **khi bạn đăng nhập**, trên cả ba hệ điều hành —
LaunchAgent (macOS), `systemd --user` (Linux), scheduled task trigger "At log on" (Windows). Không
có cái nào chạy trước khi đăng nhập, và cũng không cần: Chrome chỉ tồn tại sau khi bạn đăng nhập.

> **WSL không được hỗ trợ.** Chrome chạy ở Windows host còn bridge sẽ nằm trong WSL — hai bên hàng
> rào mạng khác nhau — và `systemctl --user` thường không có sẵn trong WSL. Cài bằng `install.ps1`
> trên chính Windows.

Máy đã cài rồi mà chạy lại đúng lệnh trên: script tự nhận ra là **nâng cấp**, giữ nguyên token cũ
(khỏi phải dán lại URL vào extension), chỉ thay mã nguồn dưới `~/.cc-chrome-bridge/` và khởi động lại
dịch vụ nền (phần server).

> ⚠️ **Script KHÔNG tự cập nhật extension đang chạy trong Chrome.** Nó ghi đè
> `~/.cc-chrome-bridge/extension` trên đĩa, nhưng Chrome vẫn chạy đúng bản code cũ đã Load unpacked
> cho tới khi bạn tự bấm **Reload** trên thẻ extension ở `chrome://extensions` — Chrome không tự đọc
> lại thư mục. Bỏ qua bước này nghĩa là bạn **âm thầm vẫn chạy extension của bản cũ**, kể cả khi
> server đã lên bản mới: nếu bản cũ thiếu một bản vá bảo mật (như hai chốt `navigate`/`javascript_eval`
> thêm ở bản mới, xem [Lưu ý bảo mật](#lưu-ý-bảo-mật)), bạn vẫn thiếu nó cho tới khi Reload. Luôn vào
> `chrome://extensions` bấm **Reload** trên "Claude Code Chrome Bridge" sau mỗi lần chạy lại lệnh cài.

### 1b. Script động vào đúng những chỗ nào

Không cần quyền root, không đụng gì ngoài thư mục home của bạn. Đầy đủ danh sách:

**macOS / Linux** (`install.sh`):

| Đường dẫn | Nội dung | Quyền |
|---|---|---|
| `~/.cc-chrome-bridge/` | `server/` (kèm `node_modules`), `extension/`, `logs/`, `tokens.json`, `uninstall.sh`, `service-unit.sh`, `ccchrome.md`, `update-runner.mjs`, `install.sh`, `install.ps1` | `700` |
| `~/.ccchrome.json` | `{ "token": "…", "port": 8787 }` | `600` |
| `~/Library/LaunchAgents/com.ccchrome.bridge.plist` (macOS)<br>`$XDG_CONFIG_HOME/systemd/user/ccchrome-bridge.service` (Linux) | file dịch vụ nền | |
| `~/.claude/commands/ccchrome.md` | slash command `/ccchrome` | |
| `~/.claude.json` | thêm MCP server tên `chrome` (qua `claude mcp add`) | |

**Windows** (`install.ps1`) — cùng bố cục, khác chỗ để file dịch vụ và cách đặt quyền:

| Đường dẫn | Nội dung |
|---|---|
| `%USERPROFILE%\.cc-chrome-bridge\` | `server\`, `extension\`, `logs\`, `tokens.json`, `uninstall.ps1`, `service-task.ps1`, `ccchrome.md`, `update-runner.mjs`, `install.sh`, `install.ps1`, cộng `bridge.cmd` và `bridge-launcher.vbs` |
| `%USERPROFILE%\.ccchrome.json` | `{ "token": "…", "port": 8787 }` |
| Scheduled task tên `ccchrome-bridge` | trigger **At log on**, chạy dưới chính tài khoản bạn, `RunLevel Limited` — **không cần quyền admin** |
| `%USERPROFILE%\.claude\commands\ccchrome.md` | slash command `/ccchrome` |
| `%USERPROFILE%\.claude.json` | thêm MCP server tên `chrome` |

Windows không có `chmod`, nên hai file chứa token được siết bằng
`icacls <file> /inheritance:r /grant:r "<bạn>:F"` — bỏ mọi ACE thừa kế rồi cấp lại
đúng cho tài khoản bạn. Đó là thứ tương đương `chmod 600` ở đây.

Hai file phụ chỉ Windows mới có: `bridge.cmd` giữ biến môi trường và chuyển hướng log
(Task Scheduler không làm được hai việc đó), còn `bridge-launcher.vbs` là một dòng gọi
`bridge.cmd` với cờ ẩn cửa sổ — nếu không thì `node.exe` để lại một cửa sổ console đen
suốt phiên làm việc.

Bảy bước, đúng thứ tự script chạy:

1. **Kiểm tra Node ≥ 18**, chưa có thì dừng, chưa tải gì cả.
2. **Tải gói phát hành** về thư mục tạm, giải nén vào `~/.cc-chrome-bridge/.new` và kiểm tra đủ file (đặc biệt là `node_modules`) — **trước khi** đụng vào bản đang cài. Tải hỏng thì bản cũ nguyên vẹn.
3. **Dừng dịch vụ đang chạy** (nếu có) — chỉ làm sau khi bước 2 đã có bản thay thế sẵn sàng.
4. **Đổi tên `.new` vào vị trí thật.** Cùng ổ đĩa nên là đổi tên tức thời, không phải copy.
5. **Token.** Nâng cấp thì giữ token cũ (khỏi dán lại URL); cài mới thì sinh 16 byte ngẫu nhiên bằng `crypto.randomBytes`. Ghi `~/.ccchrome.json` và `tokens.json`, cả hai `chmod 600`. **`tokens.json` bị ghi đè chứ không gộp** — đó chính là cách token cũ bị thu hồi.
6. **Dựng file dịch vụ** với **đường dẫn tuyệt đối** tới `node` và `claude` (dịch vụ nền không có `PATH` của terminal), `CC_CHROME_HOST=127.0.0.1` ghi cứng, rồi nạp và chờ `/health` tối đa 20 giây.
7. **Đăng ký MCP** với Claude Code và copy slash command.

Gỡ sạch mọi thứ trên:

```bash
bash ~/.cc-chrome-bridge/uninstall.sh                                              # macOS / Linux
```
```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.cc-chrome-bridge\uninstall.ps1"
```

Cả hai đều **giữ lại `panel/`** — đó là lịch sử hội thoại của khung chat, dữ liệu của bạn,
không phải thứ script tạo ra.

### 1c. Cài thủ công, không chạy script

Nếu bạn không muốn chạy script của người khác, đây là toàn bộ những gì nó làm, dạng lệnh tự gõ:

```bash
# 1. Lấy payload (hoặc git clone repo rồi cd server && npm install)
mkdir -p ~/.cc-chrome-bridge/logs && chmod 700 ~/.cc-chrome-bridge
curl -fsSL https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/cc-chrome-bridge.tar.gz \
  | tar -xz -C ~/.cc-chrome-bridge

# 2. Sinh token và ghi hai file cấu hình
TOKEN=$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))')
printf '{"token":"%s","port":8787}\n' "$TOKEN" > ~/.ccchrome.json
printf '{"%s":"local"}\n' "$TOKEN" > ~/.cc-chrome-bridge/tokens.json
chmod 600 ~/.ccchrome.json ~/.cc-chrome-bridge/tokens.json

# 3. Chạy thử ngay trong terminal — chưa cần dịch vụ nền
CC_CHROME_HOST=127.0.0.1 CC_CHROME_PORT=8787 \
CC_CHROME_TOKENS_FILE="$HOME/.cc-chrome-bridge/tokens.json" \
CC_CHROME_CLAUDE_BIN="$(command -v claude)" \
node ~/.cc-chrome-bridge/server/index.js --http

# 4. Đăng ký với Claude Code (terminal khác)
claude mcp add --scope user --transport http chrome \
  http://127.0.0.1:8787/mcp --header "Authorization: Bearer $TOKEN"

# 5. Muốn nó tự chạy nền khi đăng nhập thì dùng chính helper trong gói
bash -c 'source ~/.cc-chrome-bridge/service-unit.sh \
  && cc_write_unit "$HOME/.cc-chrome-bridge" 8787 && cc_service_start'

# 6. Slash command /ccchrome (tuỳ chọn)
mkdir -p ~/.claude/commands && cp ~/.cc-chrome-bridge/ccchrome.md ~/.claude/commands/
```

Bản Windows, cùng bảy bước đó trong PowerShell:

```powershell
# 1. Lấy payload
$Dir = "$env:USERPROFILE\.cc-chrome-bridge"
New-Item -ItemType Directory -Force -Path "$Dir\logs" | Out-Null
irm https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/cc-chrome-bridge.tar.gz -OutFile "$env:TEMP\cc.tgz"
tar -xzf "$env:TEMP\cc.tgz" -C $Dir

# 2. Sinh token (RNG của .NET — đừng dùng `node -e` với dấu nháy kép ở đây,
#    PowerShell 5.1 nuốt mất dấu nháy khi truyền cho lệnh native)
$bytes = New-Object byte[] 16
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$Token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
"{`"token`":`"$Token`",`"port`":8787}" | Set-Content "$env:USERPROFILE\.ccchrome.json" -Encoding ASCII
"{`"$Token`":`"local`"}"              | Set-Content "$Dir\tokens.json" -Encoding ASCII
icacls "$env:USERPROFILE\.ccchrome.json" /inheritance:r /grant:r "${env:USERNAME}:F" | Out-Null
icacls "$Dir\tokens.json"              /inheritance:r /grant:r "${env:USERNAME}:F" | Out-Null

# 3. Chạy thử ngay trong cửa sổ này
$env:CC_CHROME_HOST = "127.0.0.1"; $env:CC_CHROME_PORT = "8787"
$env:CC_CHROME_TOKENS_FILE = "$Dir\tokens.json"
$env:CC_CHROME_CLAUDE_BIN = (Get-Command claude).Source
node "$Dir\server\index.js" --http

# 4. Đăng ký với Claude Code (cửa sổ khác)
claude mcp add --scope user --transport http chrome http://127.0.0.1:8787/mcp --header "Authorization: Bearer $Token"

# 5. Muốn tự chạy nền khi đăng nhập
. "$Dir\service-task.ps1"
Write-CcLauncher -InstallDir $Dir -Port 8787
Register-CcTask -InstallDir $Dir
Start-CcTask

# 6. Slash command /ccchrome (tuỳ chọn)
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.claude\commands" | Out-Null
Copy-Item "$Dir\ccchrome.md" "$env:USERPROFILE\.claude\commands\"
```

Sau đó vẫn còn hai việc trong Chrome ở mục ngay dưới đây. URL cần dán là
`ws://127.0.0.1:8787/ws?token=<TOKEN vừa sinh>` — đọc lại bằng
`cat ~/.ccchrome.json` (macOS/Linux) hoặc
`Get-Content "$env:USERPROFILE\.ccchrome.json"` (Windows) nếu bạn quên.

### 2. Hai việc phải tự làm trong Chrome

Script không tự làm được — Chrome không cho một script cài extension thay bạn:

1. Mở `chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn thư mục
   `~/.cc-chrome-bridge/extension` (script đã in đúng đường dẫn này ở bước trước)
2. Bấm icon extension "Claude Code Chrome Bridge" → dán URL script đã in (dạng
   `ws://127.0.0.1:8787/ws?token=...`) vào ô "Địa chỉ MCP server" → **Lưu & kết nối lại**

Badge chuyển `on` màu xanh là xong. Mở khung chat (side panel) bằng nút "Mở khung chat" ngay trong
popup nếu muốn gõ thẳng không qua terminal — xem [Khung chat](#khung-chat-side-panel).

### 3. Dùng

Mở một phiên `claude` mới (MCP server đã đăng ký sẵn, không cần khởi động gì thêm — dịch vụ nền đã
chạy từ bước cài). Ra lệnh bình thường, ví dụ: *"mở github.com và chụp màn hình"*, *"đọc trang hiện
tại rồi điền form đăng ký"*.

Kiểm tra kết nối trong Claude Code: gõ `/mcp` → chọn `chrome` → xem tools, hoặc bảo Claude gọi tool
`chrome_status`. Ngoài Claude Code, gõ `/ccchrome status` (slash command script vừa cài) để xem bridge
có sống không và extension đã nối chưa.

### Gỡ cài đặt

```bash
bash ~/.cc-chrome-bridge/uninstall.sh
```

Trên Windows:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.cc-chrome-bridge\uninstall.ps1"
```

Xem trước sẽ xoá gì mà không đụng file nào: `bash ~/.cc-chrome-bridge/uninstall.sh --dry-run`
(bản `.ps1` chưa có `--dry-run`).

Script dừng dịch vụ nền, gỡ đăng ký MCP server `chrome`, xoá token và mã nguồn dưới
`~/.cc-chrome-bridge/`. Hai thứ nó **không** đụng tới, và tự in ra khi chạy xong:

- **Extension trong Chrome** — Chrome không cho một script gỡ extension. Tự vào `chrome://extensions`
  → tìm "Claude Code Chrome Bridge" → **Remove**.
- **`~/.cc-chrome-bridge/panel`** — lịch sử hội thoại của khung chat (side panel), không phải thứ
  `install.sh` tạo ra nên `uninstall.sh` cố tình giữ lại. Muốn xoá luôn: `rm -rf ~/.cc-chrome-bridge/panel`.

### Xử lý sự cố

- **Xem log**: `~/.cc-chrome-bridge/logs/bridge.err.log` (lỗi) và `bridge.log` (output thường). Hoặc
  gõ `/ccchrome logs` trong Claude Code.
- **Khởi động lại dịch vụ**: `/ccchrome restart`, hoặc tự chạy tay (cài qua `curl` thì bạn không có
  thư mục `scripts/` của repo trên máy — file đã cài nằm ở `~/.cc-chrome-bridge/service-unit.sh`):
  ```bash
  bash -c 'source "$HOME/.cc-chrome-bridge/service-unit.sh" && cc_service_stop && cc_service_start'
  ```
- **Đổi phiên bản Node (nvm/volta/fnm)**: dịch vụ nền ghi đường dẫn tuyệt đối tới `node` lúc cài, nên
  đổi phiên bản Node sau đó làm dịch vụ crash-loop âm thầm. Chạy lại lệnh cài ở mục 1 để ghi lại đường
  dẫn `node` hiện tại.
- **Trên Windows**: xem dịch vụ còn sống không bằng
  ```powershell
  Get-ScheduledTask ccchrome-bridge | Select-Object State
  ```
  `State` phải là **Running**. Nếu là `Ready` thì bridge đang không chạy — khởi động lại bằng
  `Start-ScheduledTask ccchrome-bridge`, và xem log ở
  `%USERPROFILE%\.cc-chrome-bridge\logs\bridge.err.log`.
- **Trên Linux, dịch vụ không tự lên sau khi khởi động lại máy**: `systemd --user` cần một phiên đăng
  nhập thật. Nếu bạn cài qua ssh hoặc không đăng nhập vào giao diện đồ hoạ, chạy
  `sudo loginctl enable-linger $USER` rồi cài lại. Máy dùng systemd cũ hơn 240 (ví dụ Ubuntu 18.04)
  thì log không ghi ra file mà vào journal — đọc bằng `journalctl --user -u ccchrome-bridge -e`;
  script cài in đúng chỗ xem log cho máy của bạn.

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

**Nâng cấp:** cài lại extension cho cả team — xem ghi chú ở
đầu file, extension cũ ghép server mới vẫn chạy được nhưng không có cách ly.

Mỗi phiên Claude Code (mỗi lần chạy `claude`, hoặc mỗi kết nối
MCP ở chế độ `--http`) có **một tab group riêng** trong Chrome, đặt tên
`Claude · xxxx` (4 ký tự đầu của session id) và tô màu cam để phân biệt với
tab cá nhân.

Trong lúc Claude thao tác, mép khung nhìn của tab đó ửng lên một vệt cam mờ,
đậm nhất sát mép rồi loang vào trong và tan hẳn — không có đường viền cứng.
Vệt này tự biến mất khoảng 30 giây sau khi Claude ngừng đụng vào tab, nên khi
không thấy khung nghĩa là không có lệnh nào đang chạy trên tab đó. Khung do
extension vẽ đè lên trang, không phải lỗi hiển thị của website, không nhận chuột
và không lọt vào ảnh `take_screenshot`. Một số trang extension không chèn được
(`chrome://`, trình xem PDF, tab trắng `about:blank`) sẽ không có khung.

- Tab do `navigate` (không kèm `tabId`) hoặc `new_tab` mở ra sẽ **tự động vào
  nhóm của phiên đó** — không còn chiếm tab đang mở trước mặt bạn như trước
  trước đây nữa.
- Tab đó mở **trong nền, không giành focus của bạn** — Chrome không tự nhảy
  sang tab hay cửa sổ đó, bạn cứ tiếp tục làm việc trên tab đang xem trong khi
  Claude thao tác ở tab riêng của nó. Cần xem nó thì gọi `switch_tab`.
- **Không một tool nào kéo cửa sổ Chrome lên trước ứng dụng bạn đang dùng.**
  Kể cả `switch_tab`: nó chỉ đổi tab đang hiện *bên trong* cửa sổ chứa tab đó,
  nên lúc bạn quay lại Chrome sẽ thấy đúng tab Claude muốn cho xem, còn đang
  gõ ở terminal hay editor thì không bị giật ra. `test/focus.test.mjs` chạy
  **toàn bộ** handler và bắt lỗi ngay nếu có tool nào activate tab của bạn
  hoặc gọi `chrome.windows.update({focused:true})`.
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
  ) để tạo và quản lý các nhóm này.

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

## Khung chat (side panel)

Extension có một khung chat nhúng ngay trong Chrome (side panel) —
gõ thẳng vào đó thay vì phải mở terminal chạy `claude`. Mỗi lượt chat, server
chạy một tiến trình `claude` mới (headless, `--tools ""`, chỉ có tool
`mcp__chrome`) rồi stream kết quả về khung chat qua một WebSocket riêng
(`/panel`, tách khỏi `/ws` mà extension dùng).

Khung chat hiện tiến trình theo thời gian thực: mỗi lần Claude gọi một công cụ trình duyệt
sẽ có một dòng riêng, mở ra ngay lúc nó quyết định gọi, và đóng lại bằng ✓ hoặc ✗ kèm thời
gian chạy. Bấm vào dòng đó để xem tham số và kết quả (kết quả đã được cắt bớt ở server).
Dải chữ ngay trên ô nhập luôn cho biết đang ở giai đoạn nào — đang gửi yêu cầu, đang suy
nghĩ, đang chạy công cụ nào, đang trả lời — kèm số giây trôi.

Ngôn ngữ của phần chữ mô tả hoạt động bám theo ngôn ngữ bạn gõ: nhắn tiếng Việt thì hiện
"Đang suy nghĩ", nhắn tiếng Anh thì hiện "Thinking". Nút bấm vẫn giữ tiếng Việt.

Đóng panel rồi mở lại sẽ thấy lại toàn bộ nội dung đã trao đổi. Bấm "Phiên mới" mới xoá.

### Bật khung chat

Cài bằng `install.sh` (hoặc `install.ps1`) là **có sẵn luôn** — bridge do dịch vụ nền
chạy đã bind đúng `127.0.0.1` theo mặc định (xem [Cài đặt](#cài-đặt)), và đó
là điều kiện duy nhất khung chat cần ngoài bridge đang sống. Không có bước
bật riêng: cài xong, dán URL vào popup extension như bình thường (bước 2 ở
mục Cài đặt), rồi bấm icon extension → **Mở khung chat**.

Khung chat **chỉ bật khi bridge bind đúng `127.0.0.1`** — đây là chủ đích chứ
không phải giới hạn tạm thời, xem [Lưu ý bảo mật](#lưu-ý-bảo-mật). Nếu bạn tự
đặt `CC_CHROME_HOST` khác `127.0.0.1`/`::1` khi chạy tay, khung chat tắt hẳn — không có cờ nào bật lại được, xem mục "Khung chat
không làm được gì".

### Khung chat không làm được gì

Nói thẳng để khỏi hiểu nhầm:

- **Claude không tự thấy tab bạn đang xem.** Nó chỉ thao tác được trên tab
  nằm trong tab group riêng của phiên panel (như mọi phiên khác — xem [Nhóm
  tab theo phiên](#nhóm-tab-theo-phiên)). Muốn nó làm việc trên trang đang mở,
  bấm **Đưa tab này vào phiên** ngay trong khung chat.
- **Agent trong panel không đọc/ghi được file nào trên máy** — chạy với
  `--tools ""`, chỉ có đúng các tool điều khiển trình duyệt (`mcp__chrome`).
- **Agent trong panel không thấy plugin hay ký ức chéo project nào của bạn**
  — tiến trình `claude` mà server spawn cho mỗi lượt chat chạy với cờ
  `--setting-sources project`, loại hẳn cấu hình cấp người dùng
  (`~/.claude/settings.json`) ra khỏi phiên. Đây là chủ đích: nếu không có cờ
  này, một plugin bật toàn cục (ví dụ plugin ghi nhớ chạy qua hook
  `SessionStart`) sẽ nạp ký ức từ **mọi project khác** vào phiên panel, kể cả
  khi bạn vừa bấm "Phiên mới" — log trên UI trống nhưng model vẫn nhớ việc ở
  project khác, vì ký ức đó chưa bao giờ đến từ hội thoại. Panel bị cô lập
  khỏi cấu hình người dùng để khớp với extension Claude for Chrome gốc (không
  giữ gì qua lại giữa các phiên) và với tính năng ghi nhớ của Claude (vốn
  tách riêng theo từng project).
- **Server không lưu nội dung hội thoại nào cả** — nhưng lịch sử vẫn tồn tại
  trên chính máy này, trong file phiên của CLI `claude` dưới
  `~/.cc-chrome-bridge/panel` (xem mục Vận hành bên dưới), và **sống sót qua
  việc đóng/mở lại khung chat** — mở lại panel là tiếp tục đúng hội thoại cũ,
  không phải bắt đầu mới. Bấm **Phiên mới** mới thực sự bắt đầu một hội thoại
  trắng; hội thoại cũ vẫn nằm nguyên trên đĩa, không có gì tự dọn. **Nhưng
  "Phiên mới" không đổi tab group**: nhóm tab gắn với khung chat (theo cửa sổ),
  không gắn với hội thoại — nên mọi tab bạn đã "đưa vào phiên" trước đó vẫn
  nằm trong nhóm và hội thoại mới vẫn thao tác được trên chúng. Muốn cắt hẳn
  thì tự kéo tab ra khỏi nhóm hoặc đóng chúng. Cũng vì thế, mất kết nối rồi
  nối lại (hay restart bridge) không làm mất nhóm tab: khung chat nhớ và khai
  báo lại đúng nhóm cũ.
- **Chỉ chạy được với bridge chạy trên chính máy bạn** — đúng như bridge cài
  bằng `install.sh` mặc định. Server từ chối `/panel` (đóng socket với mã 4004) trừ
  khi **cả ba** điều kiện cùng đúng: (1) bridge bind loopback
  (`127.0.0.1`/`::1`), (2) kết nối đến từ chính máy đó — địa chỉ peer của
  socket là loopback, (3) request **không** mang header `X-Forwarded-For`,
  `X-Forwarded-Proto` hay `X-Forwarded-Host` nào. Có header đó nghĩa là có
  reverse proxy đứng trước, mà proxy thì đứng ra kết nối hộ người khác — địa
  chỉ peer lúc đó là của proxy (loopback) chứ không phải của người gọi thật.
  Nói cách khác: đặt bridge sau một reverse proxy terminate TLS thì nó bind
  loopback nhưng vẫn **không** bật khung chat — và đó là chủ đích, vì sau
  `/panel` là một tiến trình `claude` chạy trên máy đó bằng tài khoản đang
  đăng nhập. Không có biến môi trường nào bật lại được: cái công tắc nào bật
  được thì sẽ có người bật.

### Nếu khung chat mở chậm

Mỗi lượt chat spawn một tiến trình `claude` mới — đó là chi phí cố hữu của
kiến trúc spawn-mỗi-lượt (khởi động CLI, nạp MCP server...), không phải lỗi
mạng hay lỗi model.

**Không còn do `SessionStart` hook nữa.** Tiến trình được spawn với
`--setting-sources project` (xem mục ngay trên), nên **plugin** cấp người dùng
— và mọi hook chạy qua plugin — không nạp vào phiên panel nữa. Đã đo lại bằng
thực nghiệm: trước khi thêm cờ, `system:init` của mỗi lượt chat báo `plugins`
khác rỗng và một hook `SessionStart` thật (ghi file side-effect ra đĩa) chạy
đúng mỗi lượt; sau khi thêm cờ, `plugins: []` và hook đó không chạy nữa, dù
vẫn cùng máy, cùng file cấu hình `~/.claude/settings.json`.

**Hook của riêng bạn thì vẫn chạy** (từ 1.0.9). Panel chuyển tiếp khối `hooks`
trong `~/.claude/settings.json` sang tiến trình con qua một file `--settings`
sinh riêng, chỉ chứa `hooks` và không bao giờ chứa `enabledPlugins` — nên công
cụ đếm usage hay bộ thông báo của bạn vẫn hoạt động. Riêng `SessionStart` và
`SessionEnd` bị bỏ có chủ đích: panel spawn **một tiến trình cho mỗi lượt
chat**, nên chuyển tiếp hai hook đó sẽ ghi nhận một phiên trọn vẹn cho mỗi tin
nhắn bạn gõ.

### Vận hành

`~/.cc-chrome-bridge/panel` là thư mục làm việc của mọi tiến trình `claude`
được spawn cho khung chat, nên nó tích lũy lịch sử phiên của CLI theo thời
gian — hiện chưa có gì tự dọn, tự xóa bằng tay nếu thấy phình to.

Biến môi trường riêng cho khung chat: `CC_CHROME_PANEL_TOOLS` — xem bảng
[Cấu hình](#cấu-hình).

### Cập nhật bridge

Mỗi lần mở khung chat, bridge tự hỏi GitHub xem có bản phát hành mới hơn bản
đang chạy không. Kết quả được **nhớ 30 phút** (không hỏi lại GitHub liên tục mỗi
lần bạn mở/đóng panel hay mất kết nối rồi nối lại) — nên một bản phát hành mới
có thể mất tới nửa tiếng mới hiện ra trên khung chat. Có bản mới thì một dòng
thông báo hiện ngay trên khung chat ("Có bản x.y.z (đang chạy a.b.c)."), kèm nút
**Cập nhật** — bridge **không tự cài** gì cả nếu bạn không bấm nút đó.

Bấm **Cập nhật**: bridge tải file `.tar.gz` của bản mới về, **đối chiếu SHA256**
với file checksum GitHub phát hành kèm bản đó trước khi đụng đến bất cứ thứ gì
trên máy — tải hỏng, tải thiếu hay bị sửa dọc đường đều bị chặn ở bước này.
Qua được thì bridge tự sao lưu bản đang chạy, cài bản mới đè lên, khởi động
lại dịch vụ nền, rồi tự kiểm tra bản mới có sống dậy được không. **Nếu bridge
mới không lên được, nó tự khôi phục lại bản cũ** — chép nguyên bản sao lưu về
chỗ cũ, và nếu lúc đó dịch vụ nền đang không chạy thì tự bật lại dịch vụ luôn,
rồi chờ `/health` trả lời để chắc chắn bridge đã sống lại.

Vẫn còn vài trường hợp phải tự tay xử lý: bước bật lại dịch vụ ở trên cũng thất
bại, hoặc không có bản sao lưu để khôi phục (`failed-no-backup`), hoặc trình cập
nhật gặp lỗi giữa chừng (`crashed`), hoặc một lần cập nhật trước đã dừng dở và
còn để lại `~/.cc-chrome-bridge.bak` (`already-running`). Cả bốn đều ghi lý do
vào `~/.ccchrome-update.json`. Với trường hợp đầu, khung chat sẽ báo thẳng
"Chưa khởi động lại được dịch vụ nền (…)",
nhưng nếu bridge không lên thì khung chat cũng không mở được để đọc dòng đó —
nên cứ thấy khung chat tắt ngóm và không tự quay lại sau vài phút thì chạy lại
lệnh cài ở mục [Cài đặt](#cài-đặt) (nó cài đè, giữ nguyên token, và dựng lại
dịch vụ nền). Muốn xem chuyện gì đã xảy ra: `~/.ccchrome-update.json` là kết
quả lần cập nhật gần nhất, `~/.ccchrome-update.log` là toàn bộ output của trình
cài đặt, và bản cũ (nếu chưa khôi phục xong) nằm ở `~/.cc-chrome-bridge.bak`.

Cài xong (thành công), khung chat báo "Đã cài x.y.z. Nạp lại extension để dùng
giao diện mới." kèm nút **Nạp lại extension** — **phải bấm nút này** thì Chrome
mới nạp lại phần giao diện (popup, khung chat...) của bản mới; bản thân bridge
đã chạy phiên bản mới ngay sau bước cài, nhưng extension trong Chrome vẫn giữ
mã cũ trong bộ nhớ cho tới khi được nạp lại.

Toàn bộ quá trình chỉ chạy khi bạn chủ động bấm nút trong khung chat trên
chính máy này — Claude (agent) không có cách nào tự kích hoạt việc cập nhật.

## Cấu hình

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `CC_CHROME_PORT` | `8787` | Port HTTP server (Streamable HTTP cho Claude Code + WebSocket cho extension đều đi qua cổng này). **Với dịch vụ nền cài bằng `install.sh`, đây KHÔNG phải biến đọc lúc chạy** — `install.sh` đọc `CC_CHROME_PORT` từ shell của bạn một lần, lúc cài, rồi ghi thẳng con số đó (literal, không phải tên biến) vào file dịch vụ (`scripts/service-unit.sh`). `export CC_CHROME_PORT=...` **sau khi** đã cài không đổi được cổng dịch vụ đang chạy — phải `export` giá trị mới rồi chạy lại lệnh cài ở mục [Cài đặt](#cài-đặt) (hoặc tự sửa file dịch vụ) để đổi cổng. |
| `CC_CHROME_HOST` | `127.0.0.1` | Địa chỉ bind. **Với dịch vụ nền cài bằng `install.sh`, biến này không có tác dụng gì cả** — không như `CC_CHROME_PORT`, `install.sh` không đọc `CC_CHROME_HOST` từ môi trường: `scripts/service-unit.sh` ghi cứng `127.0.0.1` vào file dịch vụ, không tham số hoá. Đổi được host chỉ khi chạy `node server/index.js --http` bằng tay hoặc tự sửa file dịch vụ. Quan trọng dù vậy vì `AGENT_ENABLED` (bật khung chat side panel) được tính thẳng từ giá trị host lúc chạy: bind khác `127.0.0.1`/`::1` sẽ **âm thầm tắt khung chat**, không có log cảnh báo riêng nào khác ngoài mục này. |
| `CC_CHROME_TOKENS` | — | Token tĩnh: `token1=tên1,token2=tên2`. `install.sh` dùng `CC_CHROME_TOKENS_FILE` (dưới đây) thay vì biến này. |
| `CC_CHROME_TOKENS_FILE` | — | Thay thế: file JSON `{"token": "tên"}`. `install.sh` ghi token do nó sinh vào `~/.cc-chrome-bridge/tokens.json` và trỏ dịch vụ nền vào đó. |
| `CC_CHROME_TIMEOUT_MS` | `45000` | Timeout mỗi lệnh gửi tới extension. |
| `CC_CHROME_SESSION_TTL_MS` | `28800000` (8 tiếng) | Session MCP không hoạt động quá lâu sẽ bị đóng và dọn. |
| `CC_CHROME_RECONNECT_GRACE_MS` | `25000` | Khi extension chưa kết nối, mỗi lệnh sẽ **chờ** ngần này rồi mới báo lỗi. Chrome huỷ service worker của extension khi cửa sổ Chrome nằm ở nền (đóng socket với mã 1001), alarm bật lại trong khoảng 30 giây — nhờ khoảng chờ này lệnh chỉ bị chậm thay vì hỏng. Phải nhỏ hơn `CC_CHROME_TIMEOUT_MS`. |
| `CC_CHROME_PANEL_TOOLS` | `mcp__chrome` | Danh sách MCP tool (truyền thẳng vào cờ `--allowedTools` của Claude Code) mà agent trong khung chat side panel được phép gọi. Không liên quan đến cờ `--tools` — cờ đó bị khóa cứng về `""` để tắt hết tool dựng sẵn (đọc/ghi file...), biến này chỉ chọn trong số các MCP tool còn lại (mặc định chỉ nhóm `mcp__chrome`), không mở lại quyền file. Chỉ có tác dụng khi khung chat bật (xem [Khung chat](#khung-chat-side-panel)). |
| `CC_CHROME_EXTENSION_ID` | — | Chỉ chấp nhận đúng một extension ID. **Chỉ dùng được khi mọi người cài bản `.crx` đã ký** (ID in ra khi `npm run build`, do `key.pem` quyết định): cài kiểu zip + **Load unpacked** sinh ID theo đường dẫn, khác nhau trên từng máy — đặt biến này khi đó sẽ khoá cả team ra ngoài. Không đặt thì chấp nhận mọi `chrome-extension://`. Xem thêm [Lưu ý bảo mật](#lưu-ý-bảo-mật): pin này thu hẹp chứ không đóng được lỗ origin giả. |

Đổi port ở phía extension: bấm icon extension → sửa "Địa chỉ MCP server" → **Lưu & kết nối lại**.

## Lưu ý bảo mật

- **Check origin làm được gì và không làm được gì.** Bridge **bắt buộc** handshake WebSocket phải có header `Origin: chrome-extension://…` (thiếu origin cũng bị từ chối). Việc này chặn được kết nối cross-origin phát sinh từ trong browser — một trang web bất kỳ mở `new WebSocket("ws://127.0.0.1:8787")` sẽ gửi origin `https://…` và bị từ chối — và nâng rào với client local nghiệp dư. Nhưng `Origin` là header do **client tự đặt**, không có gì bảo chứng: một process viết riêng cho việc này (script Node dùng `ws`, hay `curl`) chỉ cần gửi thêm một dòng header là qua được. Test `test/e2e-http.mjs` của chính repo này chứng minh điều đó — nó nối vào server bằng client `ws` thuần Node với origin giả và được chấp nhận như extension thật. **Đừng coi check origin là hàng rào chống được process local có chủ đích.**
- **Bridge cài bằng `install.sh` chỉ nghe trên loopback (`127.0.0.1`) theo mặc định.** Máy khác trong LAN không tới được `/ws`/`/mcp`. Hàng rào thật với ai đang đứng trên chính máy bạn là **token** (`~/.ccchrome.json`), không phải bind address hay check origin ở trên — nói thẳng, mô hình đe dọa thực tế ở mức này là *"phần mềm khác đang chạy sẵn trên máy bạn"*, và biện pháp giảm thiểu thật sự là **dùng một Chrome profile riêng cho automation**, để dù có bị lợi dụng thì cũng không có tab nào đăng nhập tài khoản cá nhân trong đó.
- **`navigate` và `javascript_eval` (cùng `press_key`, `type_text`, `upload_file`) đều từ chối trang của chính extension.** `navigate` không đưa được tab tới `chrome-extension://<id>/...` (hay `chrome:`, `devtools:`, `edge:`, `about:` khác `about:blank`); bốn tool còn lại từ chối chạy nếu tab lỡ đã nằm trên một trang như vậy. Trong các bản nội bộ trước 1.0.0, hai chốt này không tồn tại — một model có thể `navigate` một tab vào `chrome-extension://<id>/popup.html` rồi `javascript_eval` ngay trên đó, chạy trong realm đặc quyền của extension với `chrome.tabs.*` không giới hạn, phá vỡ hoàn toàn cách ly theo tab group. `take_screenshot` là ngoại lệ **có chủ đích**, không phải sót: chụp ảnh không sửa gì trên trang, còn bốn tool kia đều mutate.
- `CC_CHROME_EXTENSION_ID=<id>` thu hẹp thêm (chỉ chấp nhận đúng một extension ID) nhưng **không đóng được lỗ trên** — origin vẫn là chuỗi do client tự khai, chỉ là phải đoán đúng thêm một ID. Và pin này **chỉ dùng được khi cả team cài bản `.crx` đã ký** (kéo thả trên Linux, hoặc enterprise policy trên Windows/macOS): cài kiểu **zip + Load unpacked** như hướng dẫn ở trên sinh ID **theo đường dẫn thư mục**, khác nhau trên máy từng người — đặt pin trong trường hợp đó sẽ khoá cả team ra ngoài.
- Extension có quyền `<all_urls>` + `debugger` (giống extension gốc của Anthropic) — nhưng khác với bản gốc, mọi tool bị giới hạn trong tab group của phiên (xem [Nhóm tab theo phiên](#nhóm-tab-theo-phiên)): Claude chỉ thao tác được trên tab **đang nằm trong nhóm đó**, kể cả tab đã đăng nhập, chứ không phải mọi trang đang mở trong Chrome. Kéo một tab vào nhóm là tự tay cấp quyền đó cho nó. Khuyến nghị dùng một Chrome profile riêng cho automation nếu không muốn Claude đụng vào tài khoản cá nhân. Quyền `tabGroups` chỉ dùng để tạo/quản lý nhóm này, không mở rộng thêm gì Claude thấy được.
- Khi tool dùng debugger API (`take_screenshot` — **mọi lần chụp, không chỉ `fullPage`** —, eval, phím, console, network), Chrome hiện thanh thông báo *"... started debugging this browser"* — bình thường, đừng bấm Cancel khi đang chạy.
- **Đánh đổi thật, không phải giả thuyết:** trong các bản nội bộ trước đây `take_screenshot` (chế độ mặc định, không `fullPage`) chụp được cả khi tab đó đang mở sẵn DevTools. Giờ thì không — DevTools (hay bất kỳ debugger nào khác) đã giữ tab đó thì `chrome.debugger.attach` thất bại và `take_screenshot` báo lỗi thay vì chụp, vì cách cũ để chụp được trong trường hợp đó (`chrome.tabs.update(...,{active:true})` rồi `captureVisibleTab`) chính là thứ đã cướp tab đang active của người dùng mà bản vá này xoá đi — không có đường quay lại nó. Đóng DevTools trên tab đó rồi thử lại.
- **Token MCP của khung chat đi qua một file, không qua argv.** `AgentSession.mcpConfigPath()` ghi `--mcp-config` (kèm `Authorization: Bearer <token>`) vào `.mcp-config-<sessionId>.json` trong `~/.cc-chrome-bridge/panel`, `chmod 600`, rồi chỉ truyền đúng **đường dẫn** đó vào dòng lệnh `claude` con — bản thân token không nằm trong argv nữa. Trước 1.0.0 nó từng là JSON ghi thẳng vào tham số, đọc được bằng `ps`/`/proc/<pid>/cmdline` trong suốt vòng đời tiến trình con; đổi sang file còn giải quyết luôn việc spawn trên Windows, nơi `cmd.exe` diễn giải lại dấu `"` bên trong JSON đó. Rủi ro còn lại: quyền `600` được set lại ở **mọi lần ghi** vì `mode` của `writeFileSync` chỉ áp dụng lúc tạo file; `dispose()` xoá file khi phiên kết thúc bình thường, nhưng bridge bị kill thẳng tay thì `dispose()` không chạy — file có thể tồn lại trên đĩa, và đó là lý do `uninstall.sh` quét dọn `.mcp-config-*.json` còn sót trong `panel/`.
- **`install.sh` cũng đưa token vào argv, đúng một lần, khi đăng ký MCP server.** Bước `claude mcp add ... --header "Authorization: Bearer <token>"` truyền token thẳng vào dòng lệnh của tiến trình `claude` con, nên user local khác đọc được bằng `ps`/`/proc/<pid>/cmdline` trong suốt vòng đời lệnh đó. Cùng loại đánh đổi có chủ ý như trên, chỉ khác là vòng đời ngắn (một lệnh, không phải mỗi lượt chat) — và cũng chỉ trên chính máy vốn đã giữ token trong `~/.ccchrome.json`.

## Chạy test

Test E2E khởi động Chromium thật (nạp extension) + MCP server thật và gọi đủ các tool qua giao thức MCP Streamable HTTP (client chính thức của SDK, giống hệt cách Claude Code nói chuyện với bridge):

```bash
cd test && npm install && cd ..
node test/e2e.mjs
```

Yêu cầu: có Chromium/Chrome trên máy. Test đọc biến môi trường `CHROME_PATH` cho đường dẫn browser
(`CHROME_PATH=/path/to/chrome npm test`) — không đặt thì Playwright tự tải và dùng browser riêng của
nó (không cần sửa gì trong `test/`). **Trên macOS, để trống `CHROME_PATH`** — xem lưu ý trong
`CLAUDE.md` mục "Setup and commands" về vì sao Google Chrome bản thường không load được extension
chưa đóng gói trên macOS ≥ 137.

## Troubleshooting

| Triệu chứng | Cách xử lý |
|---|---|
| Tool báo "Chrome extension is not connected" | Mở Chrome, bấm icon extension xem trạng thái; bấm **Lưu & kết nối lại**. Kiểm tra dịch vụ nền còn sống không: `/ccchrome status` hoặc `curl http://127.0.0.1:8787/health`. |
| Badge đỏ mãi không xanh | Port lệch nhau — xem popup extension có đúng port dịch vụ nền đang chạy không (`~/.ccchrome.json` → trường `port`; đổi lại bằng cách cài lại với `CC_CHROME_PORT` mới, xem bảng Cấu hình, không phải sửa biến môi trường suông). Hoặc port bị process khác chiếm (server sẽ log `port already in use` vào stderr — xem `/ccchrome logs`). |
| "Cannot run scripts on chrome://..." | Trang nội bộ của Chrome không cho inject script — chuyển sang tab web thường. |
| Console/network trả rỗng | Việc thu thập chỉ bắt đầu từ lần gọi tool đầu tiên trên tab đó — reload trang rồi đọc lại. |
| Click/fill báo "Ref N is stale" | Trang đã thay đổi — gọi `read_page` lại để lấy ref mới. |
