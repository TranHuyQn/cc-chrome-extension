# Claude Code Chrome Bridge

Extension thay thế cho **Claude in Chrome** chính thức, dành cho team dùng chung tài khoản Claude **chỉ với Claude Code** (không đăng nhập được claude.ai). Extension gốc bắt buộc đăng nhập claude.ai trong browser; bản bridge này thì **không cần bất kỳ đăng nhập nào** — Claude Code điều khiển Chrome thông qua một MCP server chạy local trên máy bạn.

> **1.0.0 là bản phát hành đầu tiên.** Mọi số hiệu 2.x/3.x xuất hiện trong
> lịch sử git chỉ tồn tại nội bộ, chưa từng phát hành ra ngoài — đừng tìm
> chúng trên GitHub Releases.
>
> Cách cài: **mỗi người tự chạy bridge trên máy mình**, cài bằng một lệnh
> (`curl … | bash` trên macOS/Linux, `irm … | iex` trên Windows — xem
> [Cài đặt](#cài-đặt)), chạy như một dịch vụ nền tự khởi động lại cùng máy,
> không phụ thuộc việc `claude` có đang chạy hay không. Mô hình server dùng
> chung (VPS, pairing secret, `/ccchrome connect`) vẫn còn trong code cho ai
> cố tình muốn dùng (xem [Triển khai lên VPS](#triển-khai-lên-vps-cho-cả-team)),
> nhưng không phải đường mặc định và slash command `/ccchrome` không hỗ trợ
> pairing qua đó. Hai điều cần biết:
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

Bridge chỉ nghe trên `127.0.0.1` theo mặc định — không có dữ liệu nào gửi ra ngoài, không cần tài khoản Anthropic trong browser. (Chạy kiểu VPS dùng chung thì khác: server bind `0.0.0.0` để reverse proxy tới được — đọc kỹ [Lưu ý bảo mật](#lưu-ý-bảo-mật).)

Mô hình server dùng chung (VPS, cũ, không còn là mặc định) chạy song song cho cả team trên một server duy nhất (xem [Triển khai lên VPS](#triển-khai-lên-vps-cho-cả-team)):

```
Claude Code (mỗi người) ──(MCP / Streamable HTTP + Bearer token)──► MCP server trên VPS
Chrome Extension (mỗi người) ──(wss://vps/ws?token=...)────────────────────┘
```

Server ghép cặp theo **token**: lệnh từ Claude Code của ai điều khiển đúng Chrome của người đó. Chrome vẫn chạy trên máy từng người — VPS chỉ host phần trung gian.

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
irm https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/install.ps1 | iex
```

> ⚠️ **Đường Windows chưa được nghiệm thu trên máy thật.** CI (`windows-latest`) chạy
> trọn `install.ps1` và `uninstall.ps1` mỗi lần push và đang xanh, nhưng nó chạy với
> `CC_CHROME_SKIP_SERVICE=1` — nghĩa là **ba thứ chưa ai kiểm**: đăng ký scheduled
> task có cần nâng quyền không, có hiện cửa sổ console đen không, và task có thật sự
> ở trạng thái `Running` không. Side panel chat trên Windows cũng chưa chạy thật lần
> nào. macOS và Linux thì đã dùng thật. Nếu bạn là người thử Windows đầu tiên, báo lại
> kết quả ba mục trên.

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

### Bật khung chat

Cài bằng `install.sh` (hoặc `install.ps1`) là **có sẵn luôn** — bridge do dịch vụ nền
chạy đã bind đúng `127.0.0.1` theo mặc định (xem [Cài đặt](#cài-đặt)), và đó
là điều kiện duy nhất khung chat cần ngoài bridge đang sống. Không có bước
bật riêng: cài xong, dán URL vào popup extension như bình thường (bước 2 ở
mục Cài đặt), rồi bấm icon extension → **Mở khung chat**.

Khung chat **chỉ bật khi bridge bind đúng `127.0.0.1`** — đây là chủ đích chứ
không phải giới hạn tạm thời, xem [Lưu ý bảo mật](#lưu-ý-bảo-mật). Nếu bạn tự
đặt `CC_CHROME_HOST` khác `127.0.0.1`/`::1` (ví dụ chạy tay theo mô hình VPS ở
dưới), khung chat tắt hẳn — không có cờ nào bật lại được, xem mục "Khung chat
không làm được gì".

### Khung chat không làm được gì

Nói thẳng để khỏi hiểu nhầm:

- **Claude không tự thấy tab bạn đang xem.** Nó chỉ thao tác được trên tab
  nằm trong tab group riêng của phiên panel (như mọi phiên khác — xem [Nhóm
  tab theo phiên](#nhóm-tab-theo-phiên)). Muốn nó làm việc trên trang đang mở,
  bấm **Đưa tab này vào phiên** ngay trong khung chat.
- **Agent trong panel không đọc/ghi được file nào trên máy** — chạy với
  `--tools ""`, chỉ có đúng các tool điều khiển trình duyệt (`mcp__chrome`).
- **Agent trong panel không thấy plugin, hook hay ký ức chéo project nào của
  bạn** — tiến trình `claude` mà server spawn cho mỗi lượt chat chạy với cờ
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
  bằng `install.sh` mặc định, nhưng tắt hẳn nếu bạn tự chỉnh nó chạy kiểu VPS.
  Server từ chối `/panel` (đóng socket với mã 4004) trừ
  khi **cả ba** điều kiện cùng đúng: (1) bridge bind loopback
  (`127.0.0.1`/`::1`), (2) kết nối đến từ chính máy đó — địa chỉ peer của
  socket là loopback, (3) request **không** mang header `X-Forwarded-For`,
  `X-Forwarded-Proto` hay `X-Forwarded-Host` nào. Có header đó nghĩa là có
  reverse proxy đứng trước, mà proxy thì đứng ra kết nối hộ người khác — địa
  chỉ peer lúc đó là của proxy (loopback) chứ không phải của người gọi thật.
  Đúng cấu hình VPS trong `deploy/` rơi vào trường hợp này: unit systemd đặt
  `CC_CHROME_HOST=127.0.0.1` **vì** có Caddy/nginx terminate TLS phía trước,
  nên bridge đó bind loopback nhưng vẫn **không** bật khung chat — và đó là
  chủ đích, vì sau `/panel` là một tiến trình `claude` chạy trên host bằng tài
  khoản đang đăng nhập ở đó. Không có biến môi trường nào bật lại được: cái
  công tắc nào bật được thì sẽ có người bật.

### Nếu khung chat mở chậm

Mỗi lượt chat spawn một tiến trình `claude` mới — đó là chi phí cố hữu của
kiến trúc spawn-mỗi-lượt (khởi động CLI, nạp MCP server...), không phải lỗi
mạng hay lỗi model.

**Không còn do `SessionStart` hook nữa.** Bản thân tiến trình được spawn với
`--setting-sources project` (xem mục ngay trên), nên hook cấp người dùng —
kể cả hook chạy qua plugin bật toàn cục — không nạp vào phiên panel nữa. Đã
đo lại bằng thực nghiệm: trước khi thêm cờ, `system:init` của mỗi lượt chat
báo `plugins` khác rỗng và một hook `SessionStart` thật (ghi file side-effect
ra đĩa) chạy đúng mỗi lượt; sau khi thêm cờ, `plugins: []` và hook đó không
chạy nữa, dù vẫn cùng máy, cùng file cấu hình `~/.claude/settings.json`.

### Vận hành

`~/.cc-chrome-bridge/panel` là thư mục làm việc của mọi tiến trình `claude`
được spawn cho khung chat, nên nó tích lũy lịch sử phiên của CLI theo thời
gian — hiện chưa có gì tự dọn, tự xóa bằng tay nếu thấy phình to.

Biến môi trường riêng cho khung chat: `CC_CHROME_PANEL_TOOLS` — xem bảng
[Cấu hình](#cấu-hình).

## Triển khai lên VPS cho cả team

> ⚠️ **Mô hình cũ — không còn là mặc định.** Giờ mỗi người tự
> cài bridge trên máy mình (xem [Cài đặt](#cài-đặt) ở trên) — không cần VPS,
> không cần pairing secret nào cả. Mục này giữ lại cho ai **cố tình** muốn
> chạy một server dùng chung cho cả team (ví dụ: máy cá nhân của member
> không đủ mạnh, hoặc muốn quản lý token tập trung). Hai endpoint sinh
> installer tự động (`GET /install.sh`, `GET /uninstall.sh`) đã bị xoá khỏi
> server — chúng sinh script theo URL của server, nên với model VPS
> giờ chỉ còn hợp cho việc dùng chung, những endpoint đó sẽ đưa nhầm người
> dùng vào một kiến trúc không còn tồn tại. Slash command `/ccchrome` cũng
> không còn `connect`/`disconnect`/`local` — dùng `curl` thẳng tới `/pair`
> như hướng dẫn dưới đây.

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

### Trên máy mỗi thành viên — tự lấy token qua `/pair`

Không còn slash command lo việc này tự động — gọi thẳng API của server. Cần pairing secret do admin
cấp (`CC_CHROME_PAIR_SECRET` trong `.env` ở trên):

```bash
curl -sS -X POST https://chrome.example.com/pair \
  -H "Authorization: Bearer <pairing-secret-admin-cấp>" \
  -H "content-type: application/json" \
  -d '{"name": "<tên-của-bạn>"}'
```

Kết quả JSON gồm `token`, `mcpUrl`, `wsUrl`. Lỗi hay gặp: **401** secret sai; **404** server chưa bật
pairing (`CC_CHROME_PAIR_SECRET` chưa đặt); **429** bị rate limit (đọc header `Retry-After`, chờ hết
rồi thử lại); **503** server đã chạm trần `CC_CHROME_MAX_TOKENS` (chờ không hết — nhờ admin thu hồi
token cũ hoặc nâng trần).

Có token rồi, làm tiếp hai việc dưới ("cách thủ công"): cài extension, dán `wsUrl` vào popup, và đăng
ký MCP server bằng `mcpUrl` + token. Kiểm tra đã nối chưa: `curl -sS -H "Authorization: Bearer <token>"
https://chrome.example.com/pair/status` — đọc trường `extensionConnected`.

Thu hồi token khi không dùng nữa: `curl -sS -X DELETE -H "Authorization: Bearer <token>"
https://chrome.example.com/pair`.

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

- **Tự phục vụ**: đặt `CC_CHROME_PAIR_SECRET` trên server → thành viên tự lấy token bằng `POST /pair` (xem mục ngay trên); thu hồi bằng `DELETE /pair`.
- **Thủ công**: sửa `CC_CHROME_TOKENS` trong `.env` rồi `docker compose up -d` (restart server).
- Token dài tối thiểu 8 ký tự, pairing secret tối thiểu 12 (server từ chối giá trị yếu); nên dùng `openssl rand -hex 16`.
- Có thể dùng file thay cho biến môi trường: `CC_CHROME_TOKENS_FILE=/path/tokens.json` với nội dung `{"<token>": "<tên>"}`.
- `/pair` bị giới hạn 10 lần sai secret trong 15 phút cho mỗi IP; vượt thì trả **429 kèm `Retry-After`** (chờ hết giờ là dùng lại được). Nếu server đứng sau proxy mà quên đặt `CC_CHROME_TRUST_PROXY=1`, mọi người sẽ bị tính chung một IP (IP của proxy) — server có log cảnh báo lúc khởi động.
- Chạm trần `CC_CHROME_MAX_TOKENS` là chuyện khác hẳn: `/pair` trả **503, không có `Retry-After`** — chờ bao lâu cũng không hết, phải nhờ admin thu hồi token cũ (`DELETE /pair`) hoặc nâng trần rồi restart.

## Cấu hình

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `CC_CHROME_PORT` | `8787` | Port HTTP server (Streamable HTTP cho Claude Code + WebSocket cho extension đều đi qua cổng này). **Với dịch vụ nền cài bằng `install.sh`, đây KHÔNG phải biến đọc lúc chạy** — `install.sh` đọc `CC_CHROME_PORT` từ shell của bạn một lần, lúc cài, rồi ghi thẳng con số đó (literal, không phải tên biến) vào file dịch vụ (`scripts/service-unit.sh`). `export CC_CHROME_PORT=...` **sau khi** đã cài không đổi được cổng dịch vụ đang chạy — phải `export` giá trị mới rồi chạy lại lệnh cài ở mục [Cài đặt](#cài-đặt) (hoặc tự sửa file dịch vụ) để đổi cổng. |
| `CC_CHROME_HOST` | `127.0.0.1` | Địa chỉ bind. **Với dịch vụ nền cài bằng `install.sh`, biến này không có tác dụng gì cả** — không như `CC_CHROME_PORT`, `install.sh` không đọc `CC_CHROME_HOST` từ môi trường: `scripts/service-unit.sh` ghi cứng `127.0.0.1` vào file dịch vụ, không tham số hoá. Đổi được host chỉ khi chạy `node server/index.js --http` tay (mô hình VPS ở dưới) hoặc tự sửa file dịch vụ. Quan trọng dù vậy vì `AGENT_ENABLED` (bật khung chat side panel) được tính thẳng từ giá trị host lúc chạy: bind khác `127.0.0.1`/`::1` sẽ **âm thầm tắt khung chat**, không có log cảnh báo riêng nào khác ngoài mục này. |
| `CC_CHROME_TOKENS` | — | Token tĩnh: `token1=tên1,token2=tên2`. `install.sh` dùng `CC_CHROME_TOKENS_FILE` (dưới đây) thay vì biến này. |
| `CC_CHROME_TOKENS_FILE` | — | Thay thế: file JSON `{"token": "tên"}`. `install.sh` ghi token do nó sinh vào `~/.cc-chrome-bridge/tokens.json` và trỏ dịch vụ nền vào đó. |
| `CC_CHROME_PAIR_SECRET` | — | Bật pairing tự phục vụ (`POST /pair`) cho mô hình VPS dùng chung — xem [Triển khai lên VPS](#triển-khai-lên-vps-cho-cả-team). Cần ít nhất token tĩnh hoặc pair secret để chạy. |
| `CC_CHROME_STATE_FILE` | `./ccchrome-tokens.json` | Nơi lưu bền vững token sinh động. |
| `CC_CHROME_TIMEOUT_MS` | `45000` | Timeout mỗi lệnh gửi tới extension. |
| `CC_CHROME_TRUST_PROXY` | — | Đặt `1` khi server đứng sau reverse proxy: rate-limit đọc IP thật từ `X-Forwarded-For` (**entry cuối cùng** — entry do proxy kề bên nối vào; các entry bên trái do client tự khai), và `/pair` mới tin `X-Forwarded-Proto`/`X-Forwarded-Host` khi dựng URL trả về. Không đặt thì dùng IP socket và host của chính request. Chỉ bật khi port 8787 không tới được từ đâu khác ngoài proxy đó. |
| `CC_CHROME_MAX_TOKENS` | `100` | Trần số token động, chặn việc biến secret bị lộ thành máy phát token. Chạm trần thì `/pair` trả **503** (chờ không hết — admin phải thu hồi bớt hoặc nâng trần), khác với 429 của rate limit. Giá trị không phải số dương sẽ bị bỏ qua kèm log cảnh báo. |
| `CC_CHROME_SESSION_TTL_MS` | `28800000` (8 tiếng) | Session MCP không hoạt động quá lâu sẽ bị đóng và dọn. |
| `CC_CHROME_RECONNECT_GRACE_MS` | `25000` | Khi extension chưa kết nối, mỗi lệnh sẽ **chờ** ngần này rồi mới báo lỗi. Chrome huỷ service worker của extension khi cửa sổ Chrome nằm ở nền (đóng socket với mã 1001), alarm bật lại trong khoảng 30 giây — nhờ khoảng chờ này lệnh chỉ bị chậm thay vì hỏng. Phải nhỏ hơn `CC_CHROME_TIMEOUT_MS`. |
| `CC_CHROME_PANEL_TOOLS` | `mcp__chrome` | Danh sách MCP tool (truyền thẳng vào cờ `--allowedTools` của Claude Code) mà agent trong khung chat side panel được phép gọi. Không liên quan đến cờ `--tools` — cờ đó bị khóa cứng về `""` để tắt hết tool dựng sẵn (đọc/ghi file...), biến này chỉ chọn trong số các MCP tool còn lại (mặc định chỉ nhóm `mcp__chrome`), không mở lại quyền file. Chỉ có tác dụng khi khung chat bật (xem [Khung chat](#khung-chat-side-panel)). |
| `CC_CHROME_EXTENSION_ID` | — | Chỉ chấp nhận đúng một extension ID. **Chỉ dùng được khi mọi người cài bản `.crx` đã ký** (ID in ra khi `npm run build`, do `key.pem` quyết định): cài kiểu zip + **Load unpacked** sinh ID theo đường dẫn, khác nhau trên từng máy — đặt biến này khi đó sẽ khoá cả team ra ngoài. Không đặt thì chấp nhận mọi `chrome-extension://`. Xem thêm [Lưu ý bảo mật](#lưu-ý-bảo-mật): pin này thu hẹp chứ không đóng được lỗ origin giả. |

Đổi port ở phía extension: bấm icon extension → sửa "Địa chỉ MCP server" → **Lưu & kết nối lại**.

## Lưu ý bảo mật

- **Check origin làm được gì và không làm được gì.** Bridge **bắt buộc** handshake WebSocket phải có header `Origin: chrome-extension://…` (thiếu origin cũng bị từ chối). Việc này chặn được kết nối cross-origin phát sinh từ trong browser — một trang web bất kỳ mở `new WebSocket("ws://127.0.0.1:8787")` sẽ gửi origin `https://…` và bị từ chối — và nâng rào với client local nghiệp dư. Nhưng `Origin` là header do **client tự đặt**, không có gì bảo chứng: một process viết riêng cho việc này (script Node dùng `ws`, hay `curl`) chỉ cần gửi thêm một dòng header là qua được. Test `test/e2e-http.mjs` của chính repo này chứng minh điều đó — nó nối vào server bằng client `ws` thuần Node với origin giả và được chấp nhận như extension thật. **Đừng coi check origin là hàng rào chống được process local có chủ đích.**
- **Bridge cài bằng `install.sh` chỉ nghe trên loopback (`127.0.0.1`) theo mặc định.** Máy khác trong LAN không tới được `/ws`/`/mcp`. Hàng rào thật với ai đang đứng trên chính máy bạn là **token** (`~/.ccchrome.json`), không phải bind address hay check origin ở trên — nói thẳng, mô hình đe dọa thực tế ở mức này là *"phần mềm khác đang chạy sẵn trên máy bạn"*, và biện pháp giảm thiểu thật sự là **dùng một Chrome profile riêng cho automation**, để dù có bị lợi dụng thì cũng không có tab nào đăng nhập tài khoản cá nhân trong đó.
- **Ở mô hình VPS dùng chung (xem [Triển khai lên VPS](#triển-khai-lên-vps-cho-cả-team)), hàng rào thật cũng là token**, không phải check origin. Server bind `0.0.0.0` **có chủ ý** để reverse proxy (Caddy trong `deploy/`) tới được — nghĩa là `/ws` và `/mcp` sẽ tới được từ internet qua proxy đó. Vì vậy hai điều sau là **bắt buộc, không phải khuyến nghị**: (1) TLS phải terminate ở proxy, dùng `wss://`/`https://` — token đi trong subprotocol/header, để plaintext là lộ token trên đường truyền; (2) **đừng bao giờ expose port 8787 trần ra internet** (compose dùng `expose` chứ không `ports`; bản systemd đặt `CC_CHROME_HOST=127.0.0.1`) — 8787 lộ ra ngoài thì ai cũng tự đặt được `X-Forwarded-For` và rate limit của `/pair` mất tác dụng. Token bị lộ thì thu hồi bằng `DELETE /pair`.
- **`navigate` và `javascript_eval` (cùng `press_key`, `type_text`, `upload_file`) đều từ chối trang của chính extension.** `navigate` không đưa được tab tới `chrome-extension://<id>/...` (hay `chrome:`, `devtools:`, `edge:`, `about:` khác `about:blank`); bốn tool còn lại từ chối chạy nếu tab lỡ đã nằm trên một trang như vậy. Trong các bản nội bộ trước 1.0.0, hai chốt này không tồn tại — một model có thể `navigate` một tab vào `chrome-extension://<id>/popup.html` rồi `javascript_eval` ngay trên đó, chạy trong realm đặc quyền của extension với `chrome.tabs.*` không giới hạn, phá vỡ hoàn toàn cách ly theo tab group. `take_screenshot` là ngoại lệ **có chủ đích**, không phải sót: chụp ảnh không sửa gì trên trang, còn bốn tool kia đều mutate.
- `CC_CHROME_EXTENSION_ID=<id>` thu hẹp thêm (chỉ chấp nhận đúng một extension ID) nhưng **không đóng được lỗ trên** — origin vẫn là chuỗi do client tự khai, chỉ là phải đoán đúng thêm một ID. Và pin này **chỉ dùng được khi cả team cài bản `.crx` đã ký** (kéo thả trên Linux, hoặc enterprise policy trên Windows/macOS): cài kiểu **zip + Load unpacked** như hướng dẫn ở trên sinh ID **theo đường dẫn thư mục**, khác nhau trên máy từng người — đặt pin trong trường hợp đó sẽ khoá cả team ra ngoài.
- Extension có quyền `<all_urls>` + `debugger` (giống extension gốc của Anthropic) — nhưng khác với bản gốc, mọi tool bị giới hạn trong tab group của phiên (xem [Nhóm tab theo phiên](#nhóm-tab-theo-phiên)): Claude chỉ thao tác được trên tab **đang nằm trong nhóm đó**, kể cả tab đã đăng nhập, chứ không phải mọi trang đang mở trong Chrome. Kéo một tab vào nhóm là tự tay cấp quyền đó cho nó. Khuyến nghị dùng một Chrome profile riêng cho automation nếu không muốn Claude đụng vào tài khoản cá nhân. Quyền `tabGroups` chỉ dùng để tạo/quản lý nhóm này, không mở rộng thêm gì Claude thấy được.
- Khi tool dùng debugger API (`take_screenshot` — **mọi lần chụp, không chỉ `fullPage`** —, eval, phím, console, network), Chrome hiện thanh thông báo *"... started debugging this browser"* — bình thường, đừng bấm Cancel khi đang chạy.
- **Đánh đổi thật, không phải giả thuyết:** trong các bản nội bộ trước đây `take_screenshot` (chế độ mặc định, không `fullPage`) chụp được cả khi tab đó đang mở sẵn DevTools. Giờ thì không — DevTools (hay bất kỳ debugger nào khác) đã giữ tab đó thì `chrome.debugger.attach` thất bại và `take_screenshot` báo lỗi thay vì chụp, vì cách cũ để chụp được trong trường hợp đó (`chrome.tabs.update(...,{active:true})` rồi `captureVisibleTab`) chính là thứ đã cướp tab đang active của người dùng mà bản vá này xoá đi — không có đường quay lại nó. Đóng DevTools trên tab đó rồi thử lại.
- **Token MCP của khung chat nằm trong argv của tiến trình `claude` được spawn.** Mỗi lượt chat, server dựng chuỗi `--mcp-config '{"mcpServers":{"chrome":{...,"headers":{"Authorization":"Bearer <token>"}}}}'` rồi truyền thẳng vào dòng lệnh con — nghĩa là bất kỳ user local nào khác trên máy chạy bridge cũng đọc được token đó bằng `ps` hoặc `/proc/<pid>/cmdline` trong suốt vòng đời tiến trình. Đây là đánh đổi có chủ ý, không phải sơ suất bỏ sót. Rủi ro chỉ phát sinh khi máy đó đã có user local khác — và máy đó vốn đã giữ sẵn token này trong `~/.ccchrome.json` và `chrome.storage` của extension rồi, nên không mở thêm mặt trận rủi ro mới.
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
