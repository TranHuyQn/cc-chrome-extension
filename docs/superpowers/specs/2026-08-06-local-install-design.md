# Thiết kế: bỏ server trung gian, cài bridge trên máy từng người — bản 3.5.0

Ngày: 2026-08-06
Mục tiêu: mỗi người tự chạy bridge trên máy mình. Không còn VPS chung, không còn
pairing. Phân phối qua GitHub Releases.

## Vì sao đổi

`claude` CLI vốn đã chạy trên máy từng người — đó là điều kiện bắt buộc của khung
chat side panel (3.4.0), vì bridge phải spawn được `claude` bằng đăng nhập của
chính máy đó. Khi mọi thứ đã phải chạy cục bộ thì server trung gian không còn giải
quyết vấn đề gì: nó chỉ chuyển tiếp lời gọi tool tới đúng cái extension đang chạy
trên cùng cái máy đã có `claude`.

Bỏ nó đi cũng bỏ luôn cả một lớp hạ tầng: TLS, reverse proxy, pairing secret,
rate limit theo IP, `X-Forwarded-*`, và cái bẫy đã làm thủng cổng chặn loopback
(xem mục "Bẫy đã biết" bên dưới).

## Quyết định đã chốt (Huy, 2026-08-06)

| Câu hỏi | Chốt |
|---|---|
| Phân phối | **GitHub Releases** (không lên Chrome Web Store) |
| Code server chung (`/pair`, token động, rate limit, `deploy/`) | **Giữ nguyên**, không ai chạy |
| Bridge chạy thế nào trên máy người dùng | **Dịch vụ nền tự khởi động** (launchd / systemd user) |
| stdio mode (cổng 9876) | **Bỏ**, chỉ còn http trên loopback |
| Lỗ `javascript_eval` | **Bịt trước khi phát hành** |
| Token cho bridge local | **Vẫn cần** |
| `node_modules` trong gói phát hành | **Kèm sẵn** |
| Phạm vi `uninstall.sh` | Gỡ mọi thứ `install.sh` tạo ra; extension thì **hướng dẫn người dùng tự gỡ** |

## Kiến trúc

```
TRƯỚC                                   SAU
máy Huy ──┐                             mỗi máy tự chạy:
máy A ────┼─► VPS chung ──► extension     ~/.cc-chrome-bridge/   (launchd/systemd)
máy B ────┘   (pair, token)                      │
                                                 └─► extension trong Chrome máy đó
```

Bridge chạy `--http` bind `127.0.0.1:8787`. Cả Claude Code (qua `/mcp`) lẫn extension
(qua `/ws`) lẫn side panel (qua `/panel`) đều nối vào đúng tiến trình đó.

## Gói phát hành

Một file `cc-chrome-bridge-3.5.0.tar.gz` trên GitHub Releases:

```
server/                index.js, agent.js, tokens.js, ratelimit.js, loopback.js, package.json
server/node_modules/   3 dependency, đóng gói sẵn (đều JS thuần, không biên dịch)
extension/             thư mục để Load unpacked
install.sh
uninstall.sh
ccchrome.md            lệnh /ccchrome
```

Kèm `extension.zip` riêng cho ai chỉ cần cập nhật extension.

Cài: `curl -fsSL <release-url>/install.sh | bash`. Script tự tải tarball.

**Kèm `node_modules` là có chủ đích:** cài không cần mạng, không cần `npm`, và mọi
máy chạy đúng cùng một bộ dependency. Ba gói đó (`@modelcontextprotocol/sdk`, `ws`,
`zod`) đều là JS thuần nên không có vấn đề nhị phân theo nền tảng.

## `install.sh` tạo ra đúng 6 thứ

| # | Tạo ra | Ghi chú |
|---|---|---|
| 1 | `~/.cc-chrome-bridge/{server,extension}/` | mã nguồn + dependency |
| 2 | Token ngẫu nhiên ghi vào `~/.ccchrome.json` | `openssl rand -hex 16` |
| 3 | `~/Library/LaunchAgents/com.ccchrome.bridge.plist` (macOS)<br>`~/.config/systemd/user/ccchrome-bridge.service` (Linux) | `KeepAlive`; log ra `~/.cc-chrome-bridge/logs/` |
| 4 | Đăng ký MCP: `claude mcp add --scope user --transport http chrome http://127.0.0.1:8787/mcp --header "Authorization: Bearer <token>"` | |
| 5 | `~/.claude/commands/ccchrome.md` | |
| 6 | (không tạo file) chờ `GET /health` xanh rồi mới in hướng dẫn | thất bại thì báo lỗi, không im lặng |

Script phải **kiểm tra node ≥ 18** trước khi làm gì, và dừng ngay nếu thiếu.

Kết thúc, in đúng hai việc người dùng phải tự làm:

- `chrome://extensions` → Developer mode → **Load unpacked** → `~/.cc-chrome-bridge/extension`
- Dán `ws://127.0.0.1:8787/ws?token=<token>` vào popup của extension

### Chạy lại `install.sh` = nâng cấp

Phát hiện đã cài (có `~/.ccchrome.json`) thì: dừng service → thay mã nguồn →
**giữ nguyên token** → khởi động lại. Giữ token để người dùng không phải dán lại URL
vào popup sau mỗi lần nâng cấp.

## `uninstall.sh` gỡ đúng 6 thứ đó, ngược thứ tự

**Thứ tự là bắt buộc, không phải tuỳ ý:** gỡ service **trước tiên**. Xoá thư mục
trước khi dừng service để lại một tiến trình mồ côi vẫn giữ cổng 8787, và lần cài
sau chết vì `EADDRINUSE` — lỗi mà người dùng không có cách nào tự chẩn đoán.

1. `launchctl bootout` / `systemctl --user disable --now`, rồi xoá file unit
2. `claude mcp remove --scope user chrome`
3. Xoá `~/.claude/commands/ccchrome.md`
4. Xoá `~/.ccchrome.json`
5. Xoá `~/.cc-chrome-bridge/` **trừ thư mục `panel/`**
6. In hướng dẫn gỡ extension trong `chrome://extensions`

Giữ `--dry-run` như bản hiện có. Phải **idempotent**: chạy lần hai báo 0 mục, thoát 0.

### Vì sao `panel/` được giữ lại

`~/.cc-chrome-bridge/panel/` do **server tạo lúc chạy**, không phải `install.sh` tạo,
nên theo đúng phạm vi Huy chốt thì nó nằm ngoài. Bên trong là lịch sử hội thoại của
người dùng với khung chat. Script **in một dòng** nói rõ nó còn nằm đó và xoá bằng
lệnh nào — im lặng sẽ khiến người dùng tưởng máy đã sạch.

## Bịt lỗ `javascript_eval`

Lỗ đã có từ 3.3.0, xác nhận end-to-end bằng thực nghiệm: ba lời gọi tool thông
thường (`new_tab` → `navigate` tới `chrome-extension://<id>/popup.html` →
`javascript_eval`) chạy được code trong realm đặc quyền của extension, ở đó
`chrome.tabs.query({})` trả về **mọi** tab trong trình duyệt, vô hiệu hoá hoàn toàn
`resolveTabInGroup`.

Hai nửa đường, chặn cả hai:

```js
// javascript_eval — thiếu đúng dòng này. assertScriptableUrl ĐÃ chặn sẵn
// chrome-extension: ; vấn đề là javascript_eval không bao giờ gọi nó, vì nó đi qua
// chrome.debugger chứ không qua execInTab.
const tab = await resolveTab(params);
assertScriptableUrl(tab);

// navigate — assertScriptableUrl kiểm URL HIỆN TẠI của tab, không kiểm đích đến,
// nên cần một kiểm tra riêng trên URL đích.
if (/^(chrome-extension|devtools):/i.test(fullUrl)) throw new Error(...);
```

Chặn cả hai nửa nên không phụ thuộc vào việc Chrome có tiếp tục cho
`chrome.debugger.attach` vào trang của extension hay không.

**Test bắt buộc:** dựng lại đúng chuỗi ba lệnh đã khai thác được, khẳng định nó
thất bại ở bước `navigate` **và** ở bước `javascript_eval` (kiểm riêng từng cái, để
gỡ một trong hai chốt là có test đỏ).

## Bỏ stdio mode

- `DEFAULT_WS_URL` trong `extension/background.js` → `ws://127.0.0.1:8787/ws`
- Bỏ `mainStdio()` và nhánh cổng mặc định 9876 trong `server/index.js`
- Viết lại `local` trong `.claude/commands/ccchrome.md`

Việc này **xoá luôn một lỗ đã biết**: một URL stdio gõ tay làm panel đá văng kết nối
của extension, vì bridge stdio không phân biệt path lẫn token. Không còn bridge nào
như thế nữa.

## Hai chỗ đi chệch "giữ nguyên code server chung"

**a) Bỏ endpoint `/install.sh` và `/uninstall.sh`.** Hai endpoint này **sinh** script
theo URL của server (`installScript(base)`), nên chúng sẽ sinh ra bản cài đặt của mô
hình cũ. Phục vụ một installer sai còn tệ hơn không phục vụ gì. `/pair`, token động,
rate limit vẫn giữ nguyên như đã chốt.

**b) `deploy/chrome-bridge.service` giữ lại nhưng phải ghi cảnh báo ở đầu file.**
Đây chính là file đã làm thủng cổng chặn loopback: nó đặt `CC_CHROME_HOST=127.0.0.1`
vì đứng sau reverse proxy, khiến một kiểm tra dựa trên địa chỉ bind tưởng là máy
riêng. Cổng chặn nay kiểm cả peer và header `X-Forwarded-*` nên `/panel` sẽ từ chối,
nhưng file vẫn là một cái bẫy cho người đọc sau — phải nói rõ nó thuộc mô hình cũ.

## Kiểm thử

| Hạng mục | Cách kiểm |
|---|---|
| Lỗ `javascript_eval` | Test trình duyệt thật: chuỗi 3 lệnh phải thất bại ở cả hai chốt, kiểm riêng từng chốt |
| `install.sh` | Chạy thật trong `HOME` giả (biến `HOME` trỏ vào thư mục tạm), khẳng định đủ 6 thứ được tạo |
| `uninstall.sh` | Chạy sau install trong cùng `HOME` giả: đủ 6 thứ biến mất, `panel/` còn nguyên, chạy lần hai báo 0 mục |
| Thứ tự gỡ service | Khẳng định service bị gỡ **trước** khi thư mục bị xoá |
| Bỏ stdio | `test/e2e.mjs` **đang chạy ở stdio mode** — phải viết lại cho http-on-loopback, không được xoá: nó là bộ e2e duy nhất phủ toàn bộ 22 tool |
| Gói phát hành | `node_modules` có trong tarball; `install.sh`/`uninstall.sh` có mặt và có quyền chạy |

**Giới hạn nói thẳng:** không tự động kiểm được việc launchd/systemd thực sự tự khởi
động lại sau khi đăng xuất/khởi động máy. Phần đó Huy nghiệm thu tay.

## Version

Lên **3.5.0** — đây là thay đổi phá vỡ tương thích (bỏ stdio mode, đổi URL mặc định
của extension). Ba chỗ phải khớp như mọi lần: `extension/manifest.json`,
`const VERSION` trong `server/index.js`, `server/package.json`, rồi làm mới
`server/package-lock.json`. `test/build.test.mjs` fail nếu lệch.

## Cố tình không làm

- Không đưa lên Chrome Web Store (phải qua duyệt của Google, và extension này dùng
  `debugger` + `<all_urls>`).
- Không tự động cập nhật — nâng cấp là chạy lại `install.sh`.
- Không hỗ trợ nhiều profile Chrome trên một máy.
- Không đụng vào phần side panel vừa nghiệm thu ở 3.4.0.
- `uninstall.sh` không gỡ extension khỏi Chrome — không script nào làm được việc đó.
