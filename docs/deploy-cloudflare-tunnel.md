# Deploy lên home server qua Cloudflare Tunnel

Hướng dẫn cho: **home server Linux có Docker**, **tunnel `cloudflared` đã chạy sẵn trong một container** (chỉ thêm hostname mới), team **2–5 người**.

Đích đến: mỗi thành viên gõ lệnh trong Claude Code và Chrome trên máy họ làm theo.

---

## 1. Setup này trông thế nào

```
Claude Code (máy mỗi người) ──HTTPS──┐
                                     ├─► Cloudflare ──tunnel──► container cloudflared
Chrome Extension (máy mỗi người) ─WSS─┘      (biên)                      │
                                                        http://chrome-bridge:8787
                                                            (cùng docker network)
                                                                         ▼
                                                                 container bridge
```

Bốn điều quan trọng về hình này:

- **Home server không mở port nào ra internet.** cloudflared chủ động nối ra Cloudflare, không có chiều ngược lại. Đây là lý do chính để dùng tunnel thay vì port forwarding.
- **Bridge cũng không publish cổng nào ra host.** cloudflared nằm trong container, nên cách nối gọn nhất là cho bridge vào **chung docker network** rồi gọi nhau bằng tên service. Kết quả: kể cả máy khác trong LAN cũng không chạm được vào bridge — chỉ Cloudflare vào được.
- **Không cần Caddy.** Cloudflare đã lo TLS ở biên. Vì vậy setup này dùng `deploy/cloudflare/docker-compose.yml` chứ **không** dùng `deploy/docker-compose.yml` (file kia bundle sẵn Caddy, dành cho VPS có IP công khai).
- **Chrome vẫn chạy trên máy từng người.** Server chỉ là trạm trung chuyển ghép token với browser. Không có browser nào chạy trên home server.

---

## 2. Trước khi bắt đầu

Kiểm nhanh trên home server:

```bash
docker --version && docker compose version    # cần có cả hai
docker ps --format '{{.Names}} :: {{.Image}}' | grep -i cloudflared
```

Ghi lại **tên container cloudflared** và **network** của nó — hai giá trị này sẽ dùng ở A2 và A4:

```bash
docker inspect <tên-container-cloudflared> \
  --format '{{range $k,$_ := .NetworkSettings.Networks}}{{$k}}{{end}}'
```

Server **không cần cài node/npm**: `npm ci` chạy bên trong Docker build, còn gói extension thì build ở máy dev rồi copy sang (bước A1).

Và một điều **phải quyết trước**:

> ⚠️ **Không bật Cloudflare Access cho hostname này.**
> Access chặn request bằng màn hình đăng nhập trên trình duyệt. Service worker của extension mở WebSocket ở nền, không có ai bấm nút đăng nhập được, nên extension sẽ không bao giờ kết nối nổi. Nếu bạn cần lớp xác thực nữa thì dùng token của chính bridge (mục 8), đừng chồng Access lên.

---

## 3. Giai đoạn A — dựng server

### A1. Build gói extension — làm trên **máy dev**, không phải server

Server không có node, và cũng không nên có: `key.pem` (quyết định Extension ID) nên ở lại máy bạn.

Trên máy dev, trong repo:

```bash
npm install
npm run build
```

Lệnh build in ra một dòng như:

```
Extension ID (stable while key.pem is kept): kchddgjpkpbpjgihjihcaafokmlgojpe
```

> 🔑 **Backup `key.pem` ngay bây giờ.** File này (đã gitignore, nằm ở gốc repo) quyết định Extension ID. Mất nó là mọi bản build sau có ID khác, và extension đã cài của cả team thành vô dụng. Copy ra chỗ an toàn ngoài server.

Kiểm artifact:

```bash
ls -la dist/
# cần có: extension.zip, extension.crx, claude-code-chrome-bridge-v2.0.0.zip/.crx
```

Nếu trong `dist/` còn file của phiên bản cũ (`...-v1.1.0.zip`), xoá đi cho khỏi ai lấy nhầm — build lại lúc nào cũng được.

### A2. Đưa code sang server và cấu hình

Dọn chỗ trước nếu đĩa chật (ổ eMMC của SBC thường vậy):

```bash
ssh root@<home-server> 'df -h / ; docker system df'
ssh root@<home-server> 'docker system prune -a --volumes=false'
```

Copy repo sang (bỏ những thứ không cần, giữ `dist/` vì nó bị gitignore):

```bash
rsync -av --exclude node_modules --exclude .git --exclude .superpowers \
  ./ root@<home-server>:/opt/cc-chrome-extension/
```

Rồi trên server:

```bash
cd /opt/cc-chrome-extension/deploy/cloudflare
cp .env.example .env
openssl rand -hex 16          # sinh pairing secret
```

Sửa `.env`:

- `CC_CHROME_PAIR_SECRET` — dán giá trị vừa sinh
- `CC_CHROME_TUNNEL_NETWORK` — **tên network của container cloudflared** ghi ở mục 2
- `CC_CHROME_MAX_TOKENS=20` là thoải mái cho 2–5 người

`.env` chứa secret — đã nằm trong `.gitignore`, đừng commit và đừng gửi qua chat nhóm.

### A3. Chạy container

```bash
docker compose up -d --build
docker compose ps             # trạng thái phải là healthy sau ~15 giây
```

Bridge **không publish cổng ra host**, nên kiểm sức khoẻ từ bên trong container:

```bash
docker compose exec chrome-bridge \
  node -e "fetch('http://127.0.0.1:8787/health').then(r=>r.text()).then(console.log)"
```

Kỳ vọng:

```json
{"ok":true,"version":"2.0.0","extensionsConnected":0,"mcpSessions":0}
```

`version` phải là `2.0.0`. Nếu ra số khác thì image cũ còn cache — `docker compose build --no-cache` rồi chạy lại.

Xác nhận bridge và cloudflared **thật sự nhìn thấy nhau**:

```bash
docker inspect chrome-bridge \
  --format '{{range $k,$_ := .NetworkSettings.Networks}}{{$k}} {{end}}'
# phải in ra đúng tên network của cloudflared
```

Xem log khởi động:

```bash
docker compose logs chrome-bridge | head -20
```

Phải thấy `Self-service pairing ENABLED`. **Không** được thấy dòng cảnh báo về `CC_CHROME_TRUST_PROXY` — compose đã đặt sẵn `=1`; nếu vẫn thấy cảnh báo thì `.env` hoặc compose bị sửa sai.

### A4. Thêm hostname vào tunnel đã có

Nếu tunnel của bạn chạy bằng `--token` (kiểu container `cloudflare/cloudflared` khởi động với token dài), thì ingress được quản **từ Zero Trust dashboard**, không phải file trên máy. Trong log cloudflared bạn sẽ thấy dòng `Updated to new configuration config={"ingress":[...]}` — đó là dấu hiệu.

Trên [Cloudflare Zero Trust](https://one.dash.cloudflare.com) → **Networks → Tunnels** → chọn tunnel → tab **Published application routes** → **Add a published application route**:

| Trường | Giá trị |
|---|---|
| Subdomain | `cccx` |
| Domain | `beelyai.com` |
| Type | `HTTP` |
| URL | `chrome-bridge:8787` |

Lưu xong Cloudflare tự tạo DNS record và đẩy cấu hình mới xuống cloudflared trong vài giây — **không cần restart container nào**. Xác nhận:

```bash
docker logs --tail 5 <tên-container-cloudflared> | grep 'Updated to new configuration'
```

Dòng mới phải chứa `"hostname":"cccx.beelyai.com"` và `"service":"http://chrome-bridge:8787"`.

> Nếu tunnel của bạn dùng file `config.yml` thay vì token, thì thêm ingress rule **phía trên** rule catch-all `service: http_status:404`, rồi `docker restart <container>`:
> ```yaml
>   - hostname: cccx.beelyai.com
>     service: http://chrome-bridge:8787
>   - service: http_status:404      # luôn nằm cuối
> ```

Kiểm từ **một máy khác** (không phải home server):

```bash
curl -sS https://cccx.beelyai.com/health
```

Phải ra đúng JSON như ở A3. Nếu ra lỗi 502/1033 thì cloudflared chưa nối được tới container — xem bảng ở mục 9.

---

## 4. Giai đoạn B — ba phép kiểm quyết định

**Làm hết ba phép này trước khi phát cho bất kỳ ai.** Chúng kiểm đúng những thứ chỉ hỏng khi đi qua Cloudflare, mà chạy ở máy local không phát hiện được.

### B1. Cloudflare có forward `Sec-WebSocket-Protocol` không

Đây là rủi ro lớn nhất của bản 2.0.0. Token đi trong header đó; proxy nào cắt nó thì **mọi** thành viên sẽ thấy "Token sai" dù token hoàn toàn đúng — một lỗi cực khó đoán từ phía extension.

Cấp cho mình một token để thử:

```bash
curl -sS -X POST https://cccx.beelyai.com/pair \
  -H "Authorization: Bearer <CC_CHROME_PAIR_SECRET>" \
  -H 'content-type: application/json' \
  -d '{"name":"probe"}'
```

Rồi chạy (từ máy có repo, cần Node ≥ 18, không cần cài gì thêm):

```bash
node deploy/cloudflare/probe-tunnel.mjs https://cccx.beelyai.com <token-vừa-nhận>
```

Ba kết quả có thể:

| Kết quả | Nghĩa là | Làm gì |
|---|---|---|
| `✓ ĐẠT` | Header đi qua nguyên vẹn, token hợp lệ | Đi tiếp B2 |
| `◐ Header ĐI QUA ĐƯỢC… close 4001` | Hạ tầng ổn, chỉ là token bạn dán sai | Dán lại token, chạy lại |
| `✗ HỎNG — proxy đã CẮT header` | Cloudflare không forward subprotocol | **Dừng lại.** Xem mục 8, bẫy số 1 |

### B2. Rate-limit có nhìn đúng IP không

Bridge chặn dò `/pair` theo IP. Sau Cloudflare, IP thật nằm trong `X-Forwarded-For`. Phép này chứng minh server đọc đúng đầu nào của header đó.

Từ một máy **không phải** home server:

```bash
curl -sS -X POST https://cccx.beelyai.com/pair \
  -H "Authorization: Bearer co-tinh-sai" \
  -H 'content-type: application/json' -d '{}'
```

Rồi trên home server:

```bash
docker compose logs --tail 5 chrome-bridge | grep "Failed pairing attempt"
```

| Log hiện ra | Nghĩa là |
|---|---|
| IP công khai của máy bạn vừa gọi | ✅ Đúng. Rate-limit hoạt động theo từng người |
| `127.0.0.1` hoặc một IP `172.x` của Docker | ❌ `CC_CHROME_TRUST_PROXY` chưa tới được container. Kiểm lại compose, dựng lại |
| Một IP lạ, giống nhau ở mọi lần thử từ mọi máy | ❌ Cả team bị gom một rổ — người này thử sai sẽ khoá người kia. Báo lại, cần chỉnh cách đọc header |

### B3. Tải được gói extension qua domain

```bash
curl -sSI https://cccx.beelyai.com/extension.zip | head -5
```

Kỳ vọng `HTTP/2 200` và `content-type: application/zip`. Nếu ra 404 thì `dist/` chưa được build hoặc chưa mount — quay lại A1.

---

## 5. Giai đoạn C — máy đầu tiên (bạn)

Làm một mình cho chạy thông rồi mới mở cho team.

### C1. Cài slash command

Trong repo, trên **máy cá nhân** của bạn (không phải server):

```bash
bash scripts/install-command.sh
```

### C2. Nối Claude Code với server

Mở một phiên Claude Code mới, gõ:

```
/ccchrome connect https://cccx.beelyai.com
```

Lệnh sẽ hỏi pairing secret, tự sinh token riêng cho bạn, tự chạy `claude mcp add`, rồi in ra URL dạng `wss://cccx.beelyai.com/ws?token=...`.

### C3. Cài extension và dán URL

1. Tải `https://cccx.beelyai.com/extension.zip`, **giải nén ra một thư mục cố định** (đừng xoá sau khi cài)
2. `chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn thư mục vừa giải nén
3. Bấm icon extension → dán URL `wss://...` ở bước C2 vào ô "Địa chỉ MCP server" → **Lưu & kết nối lại**
4. Badge phải chuyển **`on` màu xanh**

Badge đỏ thì bấm vào icon xem dòng chữ đỏ trong popup — bản 2.0.0 nói rõ lý do chứ không báo chung chung nữa. Đối chiếu với bảng ở mục 9.

### C4. Smoke test — để Claude Code thật sự điều khiển Chrome

**Thoát và chạy lại `claude`** (tool MCP mới chỉ xuất hiện ở phiên mới), rồi:

```
/mcp
```

Chọn `chrome`, phải thấy danh sách tool. Sau đó thử một chuỗi thật:

```
Dùng tool chrome: mở example.com, đọc tiêu đề trang, rồi chụp màn hình
```

Đạt khi: Chrome trên máy bạn tự mở tab, Claude đọc được nội dung, và ảnh chụp hiện ra trong phiên chat. Đến đây là **hệ thống chạy đúng mục tiêu**.

Kiểm chéo phía server:

```bash
curl -sS https://cccx.beelyai.com/health
# extensionsConnected phải là 1
```

---

## 6. Giai đoạn D — mở cho team

Với mỗi thành viên, gửi đúng hai thứ:

1. Domain: `https://cccx.beelyai.com`
2. Pairing secret — **gửi riêng cho từng người**, đừng đăng lên nhóm chung

Rồi họ chỉ cần chạy một lệnh (không cần clone repo):

```bash
curl -fsSL https://cccx.beelyai.com/install.sh | bash
```

Lệnh này tải và chạy một script bash trực tiếp từ server — họ nên biết vậy trước khi chạy; ai muốn đọc trước thì tách làm hai bước (`curl -fsSL .../install.sh -o install.sh`, đọc, rồi `bash install.sh`). Script tự cài slash command `/ccchrome` và tự tải + giải nén extension vào một thư mục cố định, rồi in ra đúng hai việc còn lại phải làm bằng tay: **Load unpacked** trong `chrome://extensions`, và `/ccchrome connect https://cccx.beelyai.com` trong Claude Code — lệnh đó sẽ hỏi pairing secret bạn vừa gửi riêng cho họ.

Kiểm ai đã nối được:

```bash
curl -sS https://cccx.beelyai.com/health     # đếm extensionsConnected
docker compose logs chrome-bridge | grep "extension connected"
```

---

## 7. Vận hành

**Xem ai đang có token**

```bash
docker compose exec chrome-bridge cat /data/ccchrome-tokens.json
```

**Thu hồi token của một người** — họ tự chạy `/ccchrome disconnect`, hoặc bạn làm hộ:

```bash
curl -sS -X DELETE https://cccx.beelyai.com/pair -H "Authorization: Bearer <token-của-họ>"
```

Extension của họ sẽ bị đóng ngay và popup hiện "Token sai hoặc đã bị thu hồi".

**Nâng cấp phiên bản mới**

```bash
cd cc-chrome-extension && git pull
npm run build                                   # dùng lại key.pem cũ, ID không đổi
cd deploy/cloudflare && docker compose up -d --build
```

Nếu bản mới đổi giao thức bắt tay (như 1.x → 2.0.0) thì cả team phải tải lại `extension.zip` và Load unpacked đè lên. Nếu chỉ sửa lỗi thì không cần.

**Cloudflare cache và `/extension.zip` / `/extension.crx`**
Cloudflare mặc định cache các URL có đuôi trông "tĩnh" (`.zip`, `.crx`) ở edge, kể cả khi origin không hề yêu cầu. Từ bản vá này server gửi `cache-control: no-store` trên hai endpoint tải extension và trên `/health`, nên bản build mới truyền tới ngay, không cần đợi cache hết hạn.

> ⚠️ **Một lần duy nhất, ngay sau khi nâng cấp lên bản có patch này**: nếu server từng chạy phiên bản cũ (không gửi `no-store`) và đã có ai tải `extension.zip`/`extension.crx` trước đó, Cloudflare edge có thể đang giữ một bản cache cũ — patch mới không tự xoá cache đã có sẵn từ trước, nó chỉ ngăn cache mới hình thành. Vào [Cloudflare dashboard](https://dash.cloudflare.com) → **Caching → Configuration** → **Purge Everything** (hoặc **Custom Purge** chỉ hai URL `https://<domain>/extension.zip` và `https://<domain>/extension.crx`) để xoá bản cũ. Bỏ qua bước này thì file cũ vẫn được phục vụ cho tới khi tự hết hạn (`Cache-Control: max-age=14400` mặc định của Cloudflare cho đuôi `.zip`, tức tối đa 4 tiếng).

**Backup**: `key.pem` (ID extension) và volume `bridge_data` (token đã cấp).

```bash
docker run --rm -v cc-chrome-bridge_bridge_data:/d -v "$PWD":/b alpine \
  tar czf /b/ccchrome-tokens-backup.tgz -C /d .
```

---

## 8. Bẫy đã biết

**1. Cloudflare cắt `Sec-WebSocket-Protocol`**
Nếu B1 báo hỏng: kiểm xem hostname có bật Access, WAF rule, hay Cloudflare Worker nào chen vào không — Worker là thủ phạm hay gặp nhất vì nó dựng lại request. Tắt hết rồi thử lại B1. Nếu vẫn hỏng thì đây là giới hạn hạ tầng, không phải lỗi cấu hình: phương án dự phòng (chuyển token sang bước xác thực **sau** khi kết nối) đã được cân nhắc và ghi trong `docs/superpowers/specs/2026-08-03-security-hardening-design.md`, mục "Rủi ro còn lại" — báo lại để mình làm.

**2. Xoá `CC_CHROME_PAIR_SECRET` sẽ làm MẤT toàn bộ token đã cấp**
Đây là hành vi dễ sập bẫy nhất. Trong `server/tokens.js`, token động chỉ được nạp lại từ file state **khi pairing secret còn được đặt**. Bỏ biến đó đi để "tắt pairing cho an toàn" sẽ khiến cả team mất kết nối im lặng.

Muốn tắt pairing sau khi mọi người đã nối (một cách siết bảo mật hợp lý cho team nhỏ — nó xoá hẳn cái secret có thể bị dò), phải **chuyển token thành tĩnh trước**:

```bash
# 1. Đọc token hiện có
docker compose exec chrome-bridge cat /data/ccchrome-tokens.json
# ví dụ: {"a1b2...":"huy","c3d4...":"nam"}

# 2. Viết chúng vào .env dưới dạng tĩnh
#    CC_CHROME_TOKENS=a1b2...=huy,c3d4...=nam
# 3. Xoá dòng CC_CHROME_PAIR_SECRET
# 4. docker compose up -d
```

Làm đúng thứ tự này thì không ai phải cấu hình lại gì, và `/pair` sẽ trả 404 cho mọi kẻ dò.

**3. Đổi `ports` thành `8787:8787`**
Compose cố tình bind `127.0.0.1:8787:8787`. Đổi thành `8787:8787` là mở cổng ra toàn mạng LAN, và ai trong LAN cũng đi thẳng vào bridge, bỏ qua Cloudflare.

**4. Extension bản 1.x không nối được server 2.0.0**
Giao thức bắt tay đã đổi. Người dùng bản cũ sẽ thấy popup báo thiếu token hoặc extension cũ. Cách sửa duy nhất là tải lại và Load unpacked đè lên.

**5. `CC_CHROME_EXTENSION_ID` không dùng được với Load unpacked**
Biến này siết chỉ chấp nhận đúng một extension ID. Nhưng bản Load unpacked có ID sinh theo đường dẫn, **khác nhau trên từng máy** — đặt biến này sẽ khoá luôn cả team. Chỉ dùng được nếu mọi người cài bằng file `.crx` đã ký.

**6. Kết nối rơi sau vài phút không dùng**
Extension tự ping mỗi 20 giây nên WebSocket được giữ sống, và session MCP có TTL 8 tiếng. Nếu vẫn rơi, xem `docker compose logs` có dòng `Closing MCP session` không — có thì chỉnh `CC_CHROME_SESSION_TTL_MS`.

**7. `/health` là công khai**
Ai biết domain đều xem được số người đang kết nối. Không lộ token, nhưng lộ quy mô team. Chấp nhận được với hầu hết trường hợp; muốn kín thì chặn path đó bằng Cloudflare WAF rule.

---

## 9. Troubleshooting

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| `curl https://cccx.beelyai.com/health` ra lỗi 1033 hoặc 502 | cloudflared không nối được container | Xem A3: bridge có healthy không, và có **cùng network** với cloudflared không. Ingress phải là `http://chrome-bridge:8787` (tên container, không phải `localhost`) |
| Log cloudflared: `dial tcp: lookup chrome-bridge ... no such host` | Hai container khác network | `CC_CHROME_TUNNEL_NETWORK` trong `.env` sai. Sửa rồi `docker compose up -d` |
| Badge đỏ, popup ghi **"Token sai hoặc đã bị thu hồi"** | Token sai, đã thu hồi, hoặc Cloudflare cắt subprotocol | Chạy B1. Nếu B1 đạt thì lấy token mới bằng `/ccchrome connect` |
| Badge đỏ, popup ghi **"URL thiếu token, hoặc extension cũ hơn server"** | URL dán vào popup không có `?token=`, hoặc extension còn bản 1.x | Dán lại URL đầy đủ từ `/ccchrome connect`; nếu vẫn thế thì cài lại extension từ `/extension.zip` |
| Badge đỏ, popup ghi **"origin không hợp lệ"** | Có gì đó không phải extension đang nối, hoặc `CC_CHROME_EXTENSION_ID` bị đặt sai | Bỏ `CC_CHROME_EXTENSION_ID` khỏi `.env` nếu team dùng Load unpacked |
| Badge đỏ, popup ghi **"MCP server chưa chạy"** | Không tới được server | `curl https://domain/health` từ chính máy đó |
| Claude Code không thấy tool `chrome` | Tool MCP chỉ nạp lúc mở phiên | Thoát `claude`, chạy lại, gõ `/mcp` kiểm tra |
| `/ccchrome connect` trả 429 | Đã thử sai secret quá 10 lần trong 15 phút | Chờ hết `Retry-After` (tối đa 15 phút), lấy secret đúng rồi thử lại |
| `/ccchrome connect` trả 503 | Đã chạm trần `CC_CHROME_MAX_TOKENS` | Thu hồi token không dùng, hoặc tăng trần trong `.env` |
| Tool báo "Chrome extension is not connected" | Chrome đóng, hoặc extension mất kết nối | Mở Chrome, bấm icon xem badge, bấm **Lưu & kết nối lại** |
| `docker compose up` báo `Cannot find module './tokens.js'` | Image cũ build từ Dockerfile trước 2.0.0 | `docker compose build --no-cache` |

---

## 10. Nhắc lại phần bảo mật

Bản 2.0.0 nói thẳng những gì nó bảo đảm và không bảo đảm — đọc mục "Lưu ý bảo mật" trong `README.md` trước khi mở cho team. Tóm tắt cho đúng setup này:

- **Cổng thật là token.** Mỗi người một token 128-bit; lệnh của ai chỉ tới browser của người đó.
- **Origin check chặn được trang web**, không chặn được một chương trình cố tình viết ra để giả extension. Với setup qua tunnel thì điều đó ít quan trọng hơn, vì không ai chạm được tới port 8787 ngoài Cloudflare.
- **Pairing secret là giá trị duy nhất có thể bị dò.** Sinh bằng `openssl rand -hex 16`, gửi riêng, và cân nhắc tắt pairing sau khi team đã nối xong (bẫy số 2 ở mục 8).
- **Extension có quyền `<all_urls>` và `debugger`** trên máy từng người — Claude thao tác được trên mọi tab đang mở, kể cả tab đã đăng nhập. Khuyên cả team dùng một Chrome profile riêng cho automation.
