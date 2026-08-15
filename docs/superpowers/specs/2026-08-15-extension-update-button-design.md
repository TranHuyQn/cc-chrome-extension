# Thiết kế: nút cập nhật trong extension — bản 1.2.0

Ngày: 2026-08-15
Mục tiêu: khi có bản phát hành mới, khung chat hiện một nút; bấm vào là máy tự cài bản
mới nhất — chạy được như nhau trên macOS, Linux và Windows.

## Bối cảnh

Hôm nay việc cập nhật là thủ công hoàn toàn: người dùng phải tự biết có bản mới, tự mở
terminal, tự dán lại lệnh cài trong README. Không có gì trong sản phẩm nói cho họ biết bản
họ đang chạy đã cũ.

Ba sự thật của hệ thống hiện tại quyết định thiết kế này, đã kiểm chứng chứ không suy đoán:

1. **Extension nạp dạng unpacked, `manifest.json` không có `key` cũng không có `update_url`.**
   Id của nó suy ra từ đường dẫn. Chrome sẽ **không bao giờ** tự cập nhật nó. Nhưng
   `chrome.runtime.reload()` thì nạp lại được từ đĩa — nên nếu có thứ khác thay file, extension
   tự làm mới được chính nó.
2. **Cả ba nền tảng đều tự hồi sinh bridge**: macOS `KeepAlive=true` (`service-unit.sh:110`),
   Linux `Restart=always` + `RestartSec=3` (`service-unit.sh:139-140`), Windows có trigger lặp
   trong Task Scheduler (`service-task.ps1:83`). Trình cập nhật **không cần** tự khởi động lại
   dịch vụ — thay file rồi để tiến trình cũ chết, supervisor lo phần còn lại.
3. **Cả hai installer đều nhận `CC_CHROME_SOURCE` và `CC_CHROME_RELEASE_URL`**
   (`install.sh:28-29`, `install.ps1:36-37`), và cả hai đều **giữ lại token cũ** trong
   `~/.ccchrome.json` — nên cập nhật không bắt người dùng ghép lại extension.

Và một sự thật khiến phương án đầu tiên bị loại: `install.ps1` tải gói bằng
`Invoke-WebRequest` (`install.ps1:121`), thứ **không nhận URI `file://`**. Nên mẹo "trỏ
installer vào gói đã tải sẵn trên đĩa qua `file://`" chỉ chạy trên macOS/Linux. Xem mục D
cho đường đi dùng chung được cho cả ba.

## Quyết định đã chốt

| # | Quyết định | Lý do |
|---|---|---|
| 1 | Chỉ **side panel** kích hoạt được, qua cổng `/panel` | `/panel` là cổng duy nhất trong repo đòi **ba** điều kiện loopback, không phải một. `/ws` cố ý chạy được qua reverse proxy, nên đặt nút ở đó là cho phép bất kỳ ai có token, từ bất kỳ đâu, chạy mã trên máy này |
| 2 | **Có** đối chiếu SHA256 trước khi cài | Cập nhật tự động chạy mà không có ai đọc gì cả, nên đáng xét kỹ hơn một lệnh người dùng tự gõ |
| 3 | Hỏng thì **tự quay về bản cũ** | Bản mới không khởi động được nghĩa là supervisor cứ dựng lại một tiến trình chết; người dùng mất bridge cho tới khi tự mở terminal |
| 4 | Nạp lại extension bằng **nút bấm**, không tự động | `chrome.runtime.reload()` huỷ luôn trang side panel — tự động là đóng khung chat ngay giữa lúc người dùng đang đọc kết quả, và mất lượt chat đang chạy |
| 5 | Kiến trúc **C**: bridge lo phần *quyết định*, installer lo phần *thi hành* | Xem mục kế tiếp |

### Tại sao kiến trúc C

| Hướng | Nội dung | Lý do chọn/loại |
|---|---|---|
| A | Bridge tự viết lại toàn bộ logic cài bằng Node | Loại: viết lại thứ `install.sh`/`install.ps1` đã làm và đã test trên ba OS (LaunchAgent/systemd/Task Scheduler, giữ token, đăng ký MCP). Hai bản cài song song sẽ trôi khỏi nhau, và bản mới ít được chạy hơn nên hỏng âm thầm |
| B | Chỉ gọi lại đúng lệnh cài đang có | Loại: không có chỗ chèn kiểm SHA256 và sao lưu/khôi phục — hai thứ đã chốt là bắt buộc |
| **C** | Bridge: hỏi phiên bản, tải, **xác minh**, sao lưu. Installer: cài | **Chọn**: không sinh ra bản cài thứ hai để trôi lệch. Phần mới toàn là thứ chưa ai làm; phần cũ vẫn là đường đã có test |

## A. Luồng tổng thể

```
1. Panel mở              → gửi update_check qua /panel
2. Bridge                → hỏi GitHub API: có tag mới hơn VERSION không?
3. Có                    → panel hiện băng "Có bản X — Cập nhật"
4. Người dùng bấm        → panel gửi update_start
5. Bridge (socket còn sống, nên báo lỗi tử tế được):
        tải tarball + tải .sha256 → ĐỐI CHIẾU → giải nén
        → dựng lại thành layout checkout → sao lưu thư mục cài
6. Bridge sinh TIẾN TRÌNH TÁCH RỜI rồi buông tay:
        con chạy installer → installer dừng dịch vụ (giết luôn bridge cha)
        → thay file → dựng lại dịch vụ → chờ /health
        → không lên thì KHÔI PHỤC bản sao lưu
7. Panel mất socket      → hỏi /health mỗi 2 giây, tối đa 90 giây
                         → thấy version mới: "Đã cài X — Nạp lại extension" + nút
                         → hết 90 giây: hiện lệnh cài thủ công để dán vào terminal
```

90 giây là trần có chủ ý, không phải chờ vô hạn: `update-runner` chỉ chờ `/health` 30 giây
rồi mới bắt đầu khôi phục, nên trần của panel phải rộng hơn cả một vòng cài **và** một vòng
khôi phục. Hết giờ mà chưa thấy gì thì thứ duy nhất trung thực để hiện là lệnh chạy tay.

Ranh giới ở giữa bước 5 và 6 là điều quan trọng nhất của thiết kế: **mọi kiểu hỏng vô hại
đều xảy ra khi socket còn sống** — mạng chập, checksum sai, đĩa đầy, tarball hỏng — và panel
báo được rõ ràng trong khi bản đang cài **chưa bị đụng tới một byte nào**. Chỉ khi mọi thứ
đã nằm sẵn và đã xác minh trên đĩa mới bước qua ranh giới không quay lại được.

## B. Thành phần

| File | Trách nhiệm | Mới? |
|---|---|---|
| `server/updater.js` | Hàm thuần: hỏi release mới nhất, so sánh phiên bản, kiểm SHA256, dựng lại layout | mới |
| `server/index.js` | Thêm hai khung panel `update_check` / `update_start`. Không thêm endpoint HTTP | sửa |
| `scripts/update-runner.mjs` | Tiến trình tách rời: chạy installer → chờ health → rollback. File **duy nhất** sống lâu hơn bridge | mới |
| `extension/sidepanel.js` + `sidepanel.html` | Băng thông báo và hai nút | sửa |
| `scripts/build-release.mjs` | Sinh thêm `cc-chrome-bridge.tar.gz.sha256` | sửa |
| `test/build.test.mjs` | Canh file checksum tồn tại và khớp tarball | sửa |

`extension/background.js` **không** đụng tới. Không thêm quyền nào vào `manifest.json` —
`host_permissions: ["<all_urls>"]` đã đủ để panel gọi `/health`.

## C. Giao thức panel

Nối tiếp cơ chế `protocol: 2` đã có, panel gửi thêm hai khung:

```
→ {type:"update_check"}
← {type:"update_status", current, latest, available, notes, lastResult}
→ {type:"update_start"}
← {type:"update_progress", step:"downloading"|"verifying"|"backing-up"|"installing"}
← {type:"update_failed", reason}      ← chỉ khi hỏng TRƯỚC lúc buông tay
```

`lastResult` đọc từ file trạng thái (mục E), nên một lần cập nhật đã tự quay về bản cũ vẫn
giải thích được cho người dùng sau khi họ kết nối lại.

**Panel không bao giờ được truyền URL.** Bridge tự dựng URL từ hằng số trong mã nguồn; một
trường `url` gửi kèm từ panel bị bỏ qua, không phải bị dùng. Đây là ranh giới quan trọng
nhất của cả tính năng — thiếu nó thì `/panel` trở thành "tải và chạy bất cứ thứ gì tôi chỉ",
và toàn bộ giá trị của quyết định #1 mất sạch.

`update_start` bị từ chối — không xếp hàng — trong hai trường hợp: đã có một bản cập nhật
đang chạy, hoặc đang có lượt chat chạy dở (`agent.busy`). Cả hai đều trả `update_failed` kèm
lý do đọc được, vì im lặng ở đây khiến nút trông như hỏng.

## D. Giao việc cho installer: `CC_CHROME_SOURCE`, không phải `file://`

Tarball phát hành có layout phẳng — `server/`, `extension/`, `ccchrome.md`, `uninstall.sh`,
`service-unit.sh`, `uninstall.ps1`, `service-task.ps1`. Nhánh `CC_CHROME_SOURCE` của cả hai
installer lại mong layout kiểu checkout (`install.sh:105-113`, `install.ps1:108-113`). Nên
sau khi xác minh, updater **dựng lại** một thư mục tạm đúng dạng đó:

```
<tmp>/server/
<tmp>/extension/
<tmp>/.claude/commands/ccchrome.md
<tmp>/scripts/{uninstall.sh, service-unit.sh, uninstall.ps1, service-task.ps1}
```

rồi chạy `CC_CHROME_SOURCE=<tmp> bash install.sh` (hoặc `install.ps1`).

Ba cái lợi, theo thứ tự quan trọng: **một đường duy nhất cho cả ba OS**; không phụ thuộc
`file://` mà `Invoke-WebRequest` không hỗ trợ; và đó đúng là nhánh mà `test/install.test.mjs`
đang chạy — tức đường đã có test, không phải đường mới đẻ ra cho riêng tính năng này.

## E. Sao lưu và khôi phục

Trước khi installer chạy, `update-runner` chép `~/.cc-chrome-bridge` sang
`~/.cc-chrome-bridge.bak`. Sau khi cài xong, nó hỏi `/health` trong tối đa 30 giây:

- **Có trả lời và `version` đúng bản mới** → xoá `.bak`, ghi trạng thái `ok`.
- **Hết giờ, hoặc `version` không đổi** → dừng dịch vụ, xoá thư mục mới, đưa `.bak` về chỗ
  cũ, dựng lại dịch vụ, ghi trạng thái `rolled-back` kèm lý do.

Giữ đúng **một** bản sao lưu. Không có lịch sử nhiều phiên bản và không có nút hạ cấp —
xem mục H.

Trạng thái ghi ra `~/.ccchrome-update.json`, **ngoài** thư mục cài. Nếu để bên trong, thao
tác khôi phục sẽ ghi đè cả thư mục đó và nuốt mất chính bản ghi giải thích tại sao phải
khôi phục.

## F. Bảo mật — ranh giới thật

- Kích hoạt **chỉ** qua `/panel`: `HOST` loopback, **và** `req.socket.remoteAddress` loopback,
  **và** không có `X-Forwarded-*`. `/ws` và MCP không có đường nào chạm tới việc này —
  nghĩa là **Claude không tự cập nhật được**, kể cả khi người dùng bảo nó làm vậy.
- SHA256 bắt được gói hỏng, tải dở, và bản sao bị sửa trên đường truyền. **Không** chống được
  người chiếm được tài khoản GitHub của chủ repo: họ sửa được cả tarball lẫn file checksum.
  README và CLAUDE.md phải ghi đúng mức đó, không mạnh hơn.
- URL cố định trong mã nguồn. Không nhận từ caller. Không có biến môi trường nào nới lỏng
  điều này — một công tắc như vậy là công tắc sẽ có người bật.
- `update-runner` chạy với **cwd nằm ngoài** thư mục cài. Trên Windows, chạy với cwd nằm
  trong chính thư mục đang bị thay là cách chắc chắn nhất để khoá file lại.
- Tính năng này nâng quyền hạn của bridge một cách thực chất: từ "điều khiển trình duyệt và
  chạy `claude` trong một thư mục cố định" thành "thay thế chính nó bằng mã tải từ internet".
  Quyết định #1 là thứ giữ cho việc đó chỉ xảy ra được từ chính máy này.

## G. Kiểm thử

| Kiểm gì | Bằng gì |
|---|---|
| So sánh phiên bản, kiểm SHA (đúng/sai), dựng lại layout | `test/updater.test.mjs` mới — node thuần, tarball giả, không cần mạng |
| Panel gửi kèm `url` thì server bỏ qua | `test/panel-protocol.test.mjs` |
| `update_start` khi đang chạy dở bị từ chối | `test/panel-protocol.test.mjs` |
| Sao lưu → cài hỏng → khôi phục nguyên trạng | test dựng thư mục giả, chạy `update-runner` với installer giả luôn thất bại |
| Checksum có mặt trong gói phát hành và khớp | `test/build.test.mjs` |
| Windows | `install-windows.test.mjs` tự bỏ qua ngoài Windows → CI chỉ canh cú pháp `.ps1`; đường thật **phải chạy tay trên máy Windows** |

### Phải đo trước khi viết code

Hai điều chưa ai biết, và đoán sai thì lật một phần thiết kế:

1. `install.ps1` có chạy được với `CC_CHROME_SOURCE` trỏ vào thư mục dựng lại từ tarball
   không — nhánh đó tồn tại trong mã nhưng chưa từng chạy với layout dựng lại kiểu này.
2. Trên Windows, tiến trình tách rời do bridge sinh ra có **sống sót** qua việc Task Scheduler
   dừng dịch vụ không. Nếu nó bị giết cùng, toàn bộ mục A bước 6 phải thiết kế lại (có thể
   phải nhờ chính Task Scheduler chạy trình cập nhật).

Việc đo này là bước đầu tiên của kế hoạch thực thi, và phải làm trên máy Windows thật.

### Kết quả đã đo được

**Q2 — Tiến trình tách rời có sống sót qua việc dừng scheduled task không? TRẢ LỜI: CÓ.**

Chạy trên máy Windows thật ngày 2026-08-16. Output:
```
task LastRunTime : 08/16/2026 00:17:51
task LastTaskResult : 267009
task state : Running
parent started marker exists : True
child script exists : True
heartbeat lines before stopping the task: 9
heartbeat lines after stopping the task: 17
Q2 ANSWER: detached child SURVIVES the task being stopped
```

Con chạy tiếp sau khi `Stop-ScheduledTask` 8 dòng nữa (từ 9 lên 17). `LastTaskResult 267009` là `0x41301` — "task is currently running", tương thích với `state: Running`, không phải lỗi. **Hệ quả**: Bridge có thể sinh trình cập nhật rồi buông tay; việc installer dừng dịch vụ không kéo nó theo. Không cần thiết kế lại.

Lần chạy đầu trả `Q2 INCONCLUSIVE` với 0 heartbeat: scheduled task của Windows và `Start-Process` bên trong nó là hai lần gọi `powershell` tách rời, không thừa kế `-ExecutionPolicy Bypass`, và máy Windows mặc định policy là `Restricted` — từ chối chạy `.ps1` từ file. Cả hai lần gọi giờ truyền flag rồi. Đó là lý do kiểm tra INCONCLUSIVE tồn tại — nếu không, "0 dòng" sẽ bị hiểu nhầm là "con chết rồi", dẫn tới thiết kế lại không cần thiết.

**Q1 — `install.ps1` có chạy được với `CC_CHROME_SOURCE` trỏ vào thư mục dựng lại từ tarball không? TRẢ LỜI: CÓ.**

Người dùng cài bridge trên Windows từ checkout có `CC_CHROME_SOURCE` trỏ vào thư mục checkout. `/health` sau đó trả `ok:true, version 1.1.0`. Kết hợp với test của `reshapeToCheckout` (chứng minh tarball được dựng lại thành cấu trúc checkout đúng), tuyên bố "một đường duy nhất cho cả ba OS" giờ được đo trên máy thật chứ không phải suy đoán.

Sự thật một cái từ máy này cần ghi vào spec: policy của máy là `Restricted`, và `npm` trong PowerShell qua shim `npm.ps1`, nên `npm install` bình thường bị từ chối. Đường sản phẩm không bị ảnh hưởng — `scripts/update-runner.mjs` đã truyền `-ExecutionPolicy Bypass` khi chạy installer `.ps1`, và `install.ps1` dot-source `service-task.ps1` vào cùng một process nên nó thừa kế bypass — nhưng điều này có nghĩa máy Restricted-policy mới là mặc định thực tế, không phải edge case.

## G2. SỬA ĐỔI 2026-08-16 — phép đo cũ trả lời sai câu hỏi

Review toàn nhánh phát hiện hai lỗi chặn phát hành. Mục này **thay thế** phần liên quan
trong mục A bước 6 và mục G ở trên; những gì ghi ở đó vẫn đúng về mặt dữ liệu, nhưng kết
luận rút ra từ chúng thì sai.

### Sai ở đâu

Phép đo Q2 gọi `Stop-ScheduledTask` và trả lời: tiến trình con tách rời **sống sót**. Đúng.
Nhưng `install.ps1` **không gọi lệnh đó**. Nó gọi `Stop-CcTask`, và hàm ấy trong
`service-task.ps1` là ba bước:

```
Disable-ScheduledTask → Stop-ScheduledTask → taskkill /pid <bridge> /T /F
```

`/T` giết cả cây tiến trình con theo PID cha. Trình cập nhật là **con của bridge**, và
`detached: true` của Node trên Windows chỉ đặt `DETACHED_PROCESS` — không cắt quan hệ cha
con. Nên nó bị giết cùng.

Linux còn chắc chắn hơn và không cần đo mới kết luận được: unit ở `service-unit.sh` không
đặt `KillMode`, nên mặc định là `control-group`; `cc_service_stop` chạy
`systemctl --user disable --now`, và systemd gửi SIGTERM cho **toàn bộ cgroup** — bridge,
trình cập nhật, và cả `install.sh` đang chạy. `detached: true` trên POSIX chỉ là `setsid()`,
đổi session chứ không thoát cgroup. Tệ hơn: unit đã bị **disable**, nên `Restart=always`
không dựng lại gì.

**Bài học:** một phép đo chỉ có giá trị nếu nó gọi **đúng đường mã mà sản phẩm chạy**. Đo một
cơ chế tương đương rồi suy ra là cách tạo ra một câu trả lời đúng cho một câu hỏi không ai
hỏi.

### Kết quả đo lại (2026-08-16)

| Nền tảng | Lệnh dừng thật | Tiến trình con tách rời | Nguồn |
|---|---|---|---|
| macOS | `launchctl bootout gui/<uid>/<label>` | **SỐNG SÓT** — heartbeat 18 → 26 sau lệnh | đo trên máy này, LaunchAgent dùng-một-lần, đã gỡ sạch |
| Windows | `Stop-CcTask` (kèm `taskkill /T /F`) | **CHẾT** | suy từ mã `service-task.ps1:133-156`; cần đo lại bằng đúng hàm đó |
| Linux | `systemctl --user disable --now` | **CHẾT** | suy từ mặc định `KillMode=control-group`; **không đo được — không có máy Linux** |

### Thiết kế thay thế cho bước 6

Trình cập nhật không được là con cháu của dịch vụ. Mỗi nền tảng một cơ chế:

| Nền tảng | Cách bàn giao | Cha mới |
|---|---|---|
| **macOS** | giữ nguyên `spawn(detached)` — đã đo là an toàn | không đổi |
| **Linux** | `systemd-run --user --collect --unit=cc-chrome-update-<id>` | systemd |
| **Windows** | đăng ký một scheduled task chạy-một-lần rồi kích hoạt, tự gỡ sau | Task Scheduler |

Linux **chưa được đo trên phần cứng thật**. Kết luận dựa trên hành vi có tài liệu của systemd
(`KillMode=control-group` là mặc định, và `systemd-run --user --unit` tạo một transient
service do systemd tự fork, nên có cgroup riêng). Ghi rõ ở đây để người sau không nhầm nó là
đã kiểm chứng.

### Lỗi thứ hai: ba file không bao giờ được cài

`spawnUpdateRunner` chạy `<INSTALL_DIR>/update-runner.mjs` và trỏ `--installer` vào
`<INSTALL_DIR>/install.sh` (hoặc `.ps1`). Ba file đó có trong tarball, nhưng **không trình
cài đặt nào chép chúng vào thư mục cài** — cả hai chỉ chuyển `server/`, `extension/`,
`ccchrome.md`, `uninstall.*`, `service-*`, phần còn lại của thư mục giải nén bị xoá. Kiểm
chứng bằng cách chạy thật `install.sh` vào một `HOME` giả: ba file vắng mặt.

Hệ quả: nút cập nhật không chạy được trên **bất kỳ máy nào**. Tiến trình con chết ngay với
`MODULE_NOT_FOUND`, `stdio` là `ignore` nên không ai thấy, và panel đợi 90 giây rồi báo một
thông điệp mô tả sai chuyện vừa xảy ra.

Sửa hai phần, thiếu phần nào cũng gãy:

1. `reshapeToCheckout` phải đặt ba file vào `<target>/scripts/`, để một bản phát hành thiếu
   chúng **hỏng ngay lúc dựng lại** — đúng mục đích hàm đó tồn tại.
2. Cả hai installer phải chép ba file từ `$SOURCE/scripts/` (và từ thư mục giải nén trên
   đường tải về) vào `$INSTALL_DIR`, ở **bước dàn dựng** — trước khi dừng dịch vụ, để thiếu
   file thì dừng lại an toàn trong khi dịch vụ vẫn đang chạy.

Điều này **sửa `install.sh` và `install.ps1`**, thứ mà kế hoạch cũ cấm. Chính lệnh cấm đó
tạo ra lỗ hổng này: nó khiến việc "đưa file tới nơi cần" bị đẩy sang tarball, mà tarball
không phải nơi bridge đọc.

## H. Ngoài phạm vi

- **Không** tự động cập nhật nền. Chỉ kiểm tra khi panel mở, và chỉ cài khi người dùng bấm.
- **Không** giữ nhiều bản cũ, **không** có nút hạ cấp. Giữ đúng một bản sao lưu, dùng cho
  đúng một việc: quay lại khi bản mới không sống dậy được.
- **Không** ký GPG/minisign. Xem mục F cho ranh giới thật của SHA256.
- **Không** sửa `install.sh`/`install.ps1` ngoài việc thêm file checksum vào quy trình phát
  hành. Đường cài thủ công giữ nguyên hành vi.
- **Không** cập nhật extension qua Chrome Web Store hay `update_url`. Extension vẫn nạp dạng
  unpacked; `chrome.runtime.reload()` là cơ chế duy nhất được dùng.

## I. Rủi ro đã biết

| Rủi ro | Xử lý |
|---|---|
| Tiến trình tách rời bị giết cùng dịch vụ trên Windows | Phải đo trước (mục G). Nếu đúng, đổi sang nhờ Task Scheduler chạy trình cập nhật |
| Giới hạn tần suất GitHub API (60 lượt/giờ, không token) | Chỉ hỏi khi panel mở; hỏng thì im lặng bỏ qua, không hiện băng, không báo lỗi |
| Bản mới cài được nhưng hỏng theo cách khác (bridge lên, tính năng vỡ) | Ngoài tầm rollback tự động — `.bak` đã bị xoá khi health đạt. Người dùng cài lại bản cũ bằng tay |
| Người dùng bấm cập nhật giữa lượt chat | `update_start` bị từ chối khi đang có lượt chạy; panel nói rõ lý do |
| Extension mới + bridge cũ (người dùng chưa bấm nạp lại) | Đã có sẵn cơ chế `protocol` từ 1.1.0 lo việc này |
