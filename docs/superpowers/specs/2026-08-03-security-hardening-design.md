# Thiết kế: gia cố bảo mật và độ bền — bản 2.0.0

Ngày: 2026-08-03
Trạng thái: đã chốt, chờ lập kế hoạch thực thi
Mục tiêu cuối: sẵn sàng deploy lên staging

## Bối cảnh

Rà soát toàn bộ source phát hiện 5 vấn đề. Vấn đề 1 nghiêm trọng nhất vì README
đang khẳng định một điều mà code không bảo đảm.

| # | Vấn đề | Vị trí |
|---|---|---|
| 1 | Origin rỗng lọt qua check → process bất kỳ trên máy nối được vào bridge | `server/index.js:554` (stdio), `:748` (http) |
| 2 | `/pair` không giới hạn số lần thử pairing secret | `server/index.js:653` |
| 3 | Token nằm trong query string → bị ghi vào access log của reverse proxy | `server/index.js:753`, `extension/background.js:53` |
| 4 | `sessions` Map ở http mode không có TTL → rò rỉ bộ nhớ | `server/index.js:584` |
| 5 | Ba con số version lệch nhau (1.1.0 / 1.2.0 / 1.0.0) | manifest, `VERSION`, `server/package.json` |

Ngoài ra có một **điều kiện tiên quyết**: cả ba file test hardcode
`executablePath: "/opt/pw-browsers/chromium"` (đường dẫn CI), nên trên máy dev
không chạy được — không có test thì không bước nào có output verify được.

## Nguyên tắc

Không đổi kiến trúc. Không đụng 23 tool, cơ chế `ref`, hay tầng CDP. Mọi thay
đổi nằm ở tầng bắt tay kết nối và vòng đời session.

## Quyết định đã chốt

| Chủ đề | Quyết định | Vì sao |
|---|---|---|
| Token qua WebSocket | Subprotocol `ccchrome.token.<token>`, extension tự tách khỏi URL người dùng dán | Browser không cho set custom header. Người dùng không phải đổi thói quen, URL cũ vẫn dán được |
| Rate-limit | Chỉ `/pair`, theo IP, `X-Forwarded-For` chỉ đọc khi `CC_CHROME_TRUST_PROXY=1` | Token 128-bit brute-force vô nghĩa; pairing secret do admin đặt mới là chỗ yếu. Không tin XFF mặc định để expose trực tiếp cũng không né được |
| Origin | Bắt buộc đúng scheme; env `CC_CHROME_EXTENSION_ID` tùy chọn để khóa đích danh | Không hardcode ID vì Load-unpacked sinh ID ngẫu nhiên theo đường dẫn, sẽ làm hỏng luồng dev |
| Tương thích | Cắt dứt điểm, không có giai đoạn ân hạn | Giữ đường query nghĩa là giữ nguyên lỗ hổng. Đang ở staging, team nhỏ — rẻ nhất để cắt lúc này |
| Version | 2.0.0 đồng loạt 3 chỗ | Wire protocol breaking |
| Chạy test | Đọc `CHROME_PATH` từ env, dùng Chrome 150 có sẵn trên máy | Không tải thêm browser |
| Cấu trúc file | Tách `TokenStore` và `RateLimiter` ra file riêng | `index.js` 784 dòng, thêm nữa sẽ quá tải |

## Thiết kế chi tiết

### A. Xác thực WebSocket qua subprotocol

**Phía extension** (`extension/background.js`, hàm `connect`):

```js
const u = new URL(wsUrl);
const token = u.searchParams.get("token");
u.searchParams.delete("token");
socket = new WebSocket(u.toString(), token ? [`ccchrome.token.${token}`] : undefined);
```

URL đi trên dây không còn token. Người dùng vẫn dán nguyên URL cũ có `?token=`.

**Phía server** (`server/index.js`, handler `upgrade`): đọc token từ header
`sec-websocket-protocol`, bỏ hoàn toàn `url.searchParams.get("token")`.

**Điểm dễ sai nhất của cả bản này:** thư viện `ws` mặc định KHÔNG echo lại
subprotocol trong response 101. Phải khai báo `handleProtocols` để server trả
đúng giá trị client gửi. Nếu quên, handshake fail im lặng — badge extension đỏ
vĩnh viễn, không có thông báo lỗi nào chỉ ra nguyên nhân. Test phải bắt được
trường hợp này.

**Dọn nốt đường query ở `/mcp`:** `authToken()` hiện là
`bearerOf(req) || url.searchParams.get("token")`. Bỏ vế sau. Slash command
`/ccchrome` và cả ba test đều đã dùng `Authorization: Bearer` nên không ảnh hưởng
ai.

### B. Origin bắt buộc

Áp cho cả stdio mode và http mode:

```js
// mặc định
if (!origin.startsWith("chrome-extension://")) reject();
// khi CC_CHROME_EXTENSION_ID được đặt
if (origin !== `chrome-extension://${EXT_ID}`) reject();
```

**Bước 0 bắt buộc, làm trước mọi thứ khác:** viết một test chứng minh Chrome
thật sự gửi `Origin: chrome-extension://<id>` khi service worker mở WebSocket.
Toàn bộ hướng đi dựa trên giả định này. Nếu sai, phải quay lại thiết kế lại —
và cần biết điều đó trong vài phút, không phải sau khi staging đã dựng xong.

### C. Rate-limit `/pair`

File mới `server/ratelimit.js`. Key theo IP, cửa sổ trượt:

- 10 lần sai / 15 phút / IP → HTTP 429 kèm `Retry-After`
- Lần thử thành công xoá bộ đếm của IP đó
- Timer dọn entry hết hạn, `.unref()`

`clientIp(req)`: đọc `X-Forwarded-For` (phần tử trái nhất) chỉ khi
`CC_CHROME_TRUST_PROXY=1`, còn lại dùng `req.socket.remoteAddress`.
`deploy/docker-compose.yml` và `deploy/chrome-bridge.service` đặt sẵn biến này
vì cả hai đều đứng sau reverse proxy.

Thêm `CC_CHROME_MAX_TOKENS` (mặc định 100): chặn trường hợp ai đó có secret đúng
rồi spam tạo token. Vượt trần → 429 với thông báo liên hệ admin.

### D. Dọn session hết hạn

Mỗi entry trong `sessions` lưu thêm `lastSeen`, cập nhật ở mỗi request. Timer
quét mỗi 5 phút, xoá entry idle quá `CC_CHROME_SESSION_TTL_MS` (mặc định 30
phút) và gọi `transport.close()`. Timer `.unref()`.

### E. Thông báo lỗi ở extension

Sau bản này có nhiều nguyên nhân từ chối khác nhau, extension cần phân biệt được
để người dùng tự xử lý.

**Ràng buộc kỹ thuật quyết định cách làm:** WebSocket API của browser không cho
đọc HTTP status của handshake thất bại. Cách từ chối hiện tại — `socket.destroy()`
cho origin sai, ghi `HTTP/1.1 401` rồi destroy cho token sai — đều chỉ đến được
extension dưới dạng close code `1006`, không phân biệt nổi với "server chết".

Vì vậy đường từ chối ở `/ws` phải đổi: **hoàn tất upgrade rồi đóng ngay với close
code riêng**, thay vì destroy socket. Kết nối bị từ chối không bao giờ được đăng
ký vào `registry` nên không làm được gì trong khoảnh khắc đó.

| Close code | Nguyên nhân | Hiện trong popup |
|---|---|---|
| 4003 | Origin không phải `chrome-extension://` | "Server từ chối: origin không hợp lệ" |
| 4001 | Token sai hoặc đã bị thu hồi | "Token sai hoặc đã bị thu hồi — chạy lại `/ccchrome connect`" |
| 4002 | Thiếu subprotocol (extension quá cũ) | "Extension đã cũ — tải lại bản mới từ `<domain>/extension.zip`" |
| còn lại | mạng, server chưa chạy | thông báo hiện tại |

Extension lưu lý do vào `status.lastError` và popup hiện nguyên văn. Không có
phần này, người dùng gặp lỗi trên staging không có manh mối nào để tự xử lý.

### F. Cấu trúc file

| File | Nội dung | Ước lượng |
|---|---|---|
| `server/tokens.js` | `TokenStore` (mới, cắt từ index.js) | ~90 dòng |
| `server/ratelimit.js` | `RateLimiter` + `clientIp` (mới) | ~50 dòng |
| `server/index.js` | phần còn lại | ~700 dòng |

**Hệ quả bắt buộc:** `deploy/Dockerfile` đang `COPY server/index.js ./`, phải
đổi thành `COPY server/*.js ./`. Sai chỗ này e2e test KHÔNG bắt được (test chạy
trực tiếp bằng node, không qua Docker) — chỉ vỡ khi lên staging. Vì vậy quy trình
verify phải có bước `docker build` chạy thật.

### G. Version

`2.0.0` ở `extension/manifest.json`, `VERSION` trong `server/index.js`, và
`server/package.json`. Thêm assertion trong `test/build.test.mjs` bắt ba số phải
khớp — để vấn đề 5 không tái diễn.

## Kiểm thử

Điều kiện tiên quyết: cả ba file `test/*.mjs` đọc `CHROME_PATH` từ env, không có
thì để Playwright tự lo. CI cũ chạy được bằng
`CHROME_PATH=/opt/pw-browsers/chromium`.

Thêm `ws` vào `test/package.json`: các ca kiểm origin cần một WebSocket client
thuần Node, và `ws` không gửi header `Origin` — đúng thứ cần để chứng minh kết
nối không phải extension bị chặn.

| Vấn đề | Assertion | File |
|---|---|---|
| Origin (stdio) | Client `ws` thuần Node, không Origin → bị từ chối | `e2e.mjs` |
| Origin (http) | Như trên, và extension thật vẫn nối được | `e2e-http.mjs` |
| Subprotocol | Nối bằng subprotocol OK; nối bằng `?token=` bị từ chối | `e2e-http.mjs` |
| Echo subprotocol | Extension thật (Chrome) nối được — chính là ca bắt lỗi quên `handleProtocols` | `e2e-http.mjs` |
| Rate-limit | Sai secret 10 lần → lần 11 trả 429 | `e2e-http.mjs` |
| Trần token | Vượt `CC_CHROME_MAX_TOKENS` → 429 | `e2e-http.mjs` |
| Session TTL | Set TTL 2s qua env, chờ, kiểm session đã bị xoá | `e2e-http.mjs` |
| Close code | Client `ws` nối sai origin nhận đúng code 4003, sai token nhận 4001 | `e2e-http.mjs` |
| Version | Ba số khớp nhau | `build.test.mjs` |
| Docker | `docker build -f deploy/Dockerfile .` thành công và image chạy được `/health` | thủ công trong quy trình verify |

Toàn bộ test hiện có phải tiếp tục pass — đó là lưới an toàn cho việc tách file.

## Tài liệu phải cập nhật

- `README.md`: sửa câu khẳng định sai về bảo mật ở mục "Lưu ý bảo mật"; bổ sung
  `CC_CHROME_TRUST_PROXY`, `CC_CHROME_EXTENSION_ID`, `CC_CHROME_MAX_TOKENS`,
  `CC_CHROME_SESSION_TTL_MS` vào bảng cấu hình; ghi rõ nâng lên 2.0.0 bắt buộc
  cập nhật cả server lẫn extension
- `CLAUDE.md`: cập nhật mục "Security invariants" cho khớp hành vi mới
- `deploy/docker-compose.yml`, `deploy/chrome-bridge.service`: thêm
  `CC_CHROME_TRUST_PROXY=1`

## Rủi ro còn lại sau khi hoàn thành

**Caddy có forward `Sec-WebSocket-Protocol` khi proxy upgrade không.** Nhiều khả
năng là có (Caddy pass-through header ở request upgrade), nhưng chỉ chứng minh
được trên staging thật. Đây chính là giá trị của bước deploy staging: nó kiểm
chứng đúng cái mà máy local không kiểm chứng nổi. Nếu Caddy strip header, phương
án dự phòng là chuyển sang auth-after-connect (đã cân nhắc và loại ở vòng thiết
kế, có thể lấy lại).

## Quy trình lên staging

1. `npm run lint` sạch, `npm test` pass toàn bộ
2. `docker build` thành công, container trả `/health`
3. `npm run build` sinh `dist/` mới (2.0.0)
4. Deploy server 2.0.0 lên staging
5. Mọi thành viên tải lại `extension.zip` và Load unpacked đè bản cũ —
   **bước này không bỏ được**, extension 1.x không nối được server 2.0.0
