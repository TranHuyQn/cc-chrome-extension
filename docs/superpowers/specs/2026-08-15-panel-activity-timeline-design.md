# Thiết kế: timeline hoạt động cho khung chat side panel — bản 1.1.0

Ngày: 2026-08-15
Mục tiêu: gửi prompt xong, người dùng **luôn nhìn thấy agent đang làm gì** — đang chờ API,
đang suy nghĩ, đang chạy tool nào, tool đó xong hay lỗi — thay vì ngồi trước một khung chat
im lặng không phân biệt được "đang chạy" với "đã treo".

## Bối cảnh

Hôm nay `AgentSession.translate()` trong `server/agent.js` chỉ dịch **hai** loại dòng
NDJSON của CLI thành sự kiện cho panel:

- `stream_event` → `text_delta` → `delta`
- `assistant` → block `text` → `message`, block `tool_use` → `tool {name}`

Mọi thứ còn lại bị bỏ, trong đó có hai loại mang đúng thông tin đang thiếu:

- `user` (mang `tool_result`, có `tool_use_id` và `is_error`) — **cái duy nhất** cho biết
  một tool đã kết thúc và kết thúc thế nào;
- `result` — thời lượng, token, chi phí của cả lượt.

Hệ quả: panel về mặt vật lý **không có cách nào** biết một tool đã xong. Dòng `⚙ read_page`
xuất hiện rồi nằm im vô thời hạn, giống hệt lúc tiến trình đã chết. Đo được:
`ttft_ms = 2220` cho một prompt tầm thường có một lệnh `echo` — hơn 2 giây không một pixel
nào chuyển động, và với `read_page` trên trang nặng thì khoảng im lặng đó dài hơn nhiều lần.

## Kết quả đo (2026-08-15, CLI 2.1.197)

Đo thật, không suy đoán. Hai transcript ghi bằng
`claude -p --output-format stream-json --verbose --include-partial-messages`.

**Có, và có sớm** — `content_block_start` mang `id` + `name` ngay lúc model vừa quyết định
gọi tool, trước khi tham số kịp stream xong:

```json
{"type":"stream_event","event":{"type":"content_block_start","index":1,
 "content_block":{"type":"tool_use","id":"toolu_01G8uY…","name":"Bash","input":{}}}}
```

Sau đó `input_json_delta` nhả dần tham số, `assistant` mang block `tool_use` với `input`
đầy đủ, và `user` mang `tool_result` với đúng `tool_use_id` đó **kèm `is_error`** — nên
`ok` là dữ liệu thật, không phải suy luận.

**Không có** — nội dung suy nghĩ. Đo hai lần:

| Lần đo | số `thinking_delta` | tổng ký tự |
|---|---|---|
| Prompt có gọi tool | 1 | **0** |
| Prompt `ultrathink`, ép suy nghĩ dài | 5 | **0** |

Khối `thinking` tồn tại và có `signature`, nhưng trường `thinking` **luôn rỗng**, kể cả khi
model rõ ràng đã suy nghĩ (câu trả lời sau đó dài 2462 ký tự). CLI 2.1.197 không nhả nội dung
suy nghĩ ra `stream-json`. Vậy nên "khối suy nghĩ bung ra xem được" là **không làm được** —
nó sẽ vĩnh viễn trống.

Nhưng số `thinking_delta` **khác 0**, tức là biết chắc *model đang suy nghĩ*, chỉ không biết
nghĩ gì. Cộng thêm một tín hiệu phát hiện thêm khi đo: `{"type":"system","subtype":"status",
"status":"requesting"}` — CLI đang chờ API trả lời.

**Một cái bẫy về hình dạng dữ liệu:** `tool_result.content` có hai dạng — chuỗi thuần (tool
built-in, thấy ở bản đo hôm nay) và mảng `[{type:"text",…}]` (tool MCP, thấy ở fixture
`test/fixtures/claude-stream.ndjson` đã có sẵn trong repo). Bỏ sót dạng mảng thì mọi kết quả
tool chrome sẽ hiện `[object Object]`.

## Quyết định đã chốt

| # | Quyết định | Ghi chú |
|---|---|---|
| 1 | Timeline hoạt động đầy đủ, giống Claude in Chrome | mỗi bước một dòng: ⠹ đang chạy → ✓/✗ + thời gian |
| 2 | Bung một bước ra: tham số đầy đủ + **kết quả tóm tắt do server cắt** | không đẩy nguyên nội dung trang web vào DOM panel |
| 3 | Có khôi phục lịch sử chat khi mở lại panel | trong cùng đợt này |
| 4 | Kiến trúc **C**: server sở hữu *dữ liệu*, panel sở hữu *chữ nghĩa* | xem mục kế tiếp |
| 5 | Thinking: chỉ hiện **trạng thái**, không hiện nội dung | vì đã đo là luôn rỗng |
| 6 | Ngôn ngữ chữ mô tả hoạt động bám theo ngôn ngữ prompt | chỉ chữ mô tả, không phải toàn bộ UI |

### Tại sao kiến trúc C

Ba hướng đã cân nhắc:

| Hướng | Nội dung | Lý do chọn/loại |
|---|---|---|
| A | Server dịch hết, kể cả nhãn tiếng Việt; panel chỉ append DOM | Loại: nhét chữ UI tiếng Việt vào server, trái quy ước hiện tại (server tiếng Anh trừ vài câu lỗi) |
| B | Server chuyển tiếp NDJSON thô, panel tự hiểu | Loại: vi phạm quyết định #2 (cắt ở server), và dồn toàn bộ hiểu-biết-format-CLI vào file duy nhất không có test tự động |
| **C** | Server ghép cặp / đo giờ / cắt chuỗi; panel giữ bảng nhãn và cách vẽ | **Chọn**: phần dễ sai nhất nằm ở nơi có fixture test chạy bằng node, không cần trình duyệt; thêm tool mới về sau chỉ là thêm một dòng ở bảng nhãn |

Quyết định #6 củng cố C: thêm ngôn ngữ thứ hai chỉ là thêm một cột trong bảng nhãn của
extension, server không đụng gì.

## Kiến trúc

```
claude -p  (NDJSON trên stdout)
        │
        ▼
server/agent.js  AgentSession.translate()
        │   máy trạng thái: Map<tool_use_id, {name, t0}>
        │   ghép cặp · đo giờ · cắt chuỗi
        ▼
server/index.js   onEvent: (event) => send(event)      ← KHÔNG SỬA GÌ
        │
        ▼  WS /panel
extension/sidepanel.js
        │   bảng nhãn (vi/en) · Map<id, element> · một setInterval(1s)
        ├──► DOM: timeline + dải trạng thái
        └──► journal → chrome.storage.local (panelLog.<windowId>)
```

## A. Giao thức sự kiện (server → panel)

Thêm 5 loại; `turn_start` / `delta` / `message` / `turn_end` giữ nguyên nghĩa cũ.

| Sự kiện | Sinh ra từ dòng CLI | Trường |
|---|---|---|
| `step_start` | `content_block_start` type `tool_use` | `id`, `name` |
| `step_args` | `assistant` block `tool_use` | `id`, `input` (JSON cắt ≤ 2000 ký tự) |
| `step_end` | `user` block `tool_result` | `id`, `ok`, `ms`, `summary`, `size`, `aborted?` |
| `phase` | `status:"requesting"` / `thinking_delta` / `text_delta` | `phase`: `"requesting"` \| `"thinking"` \| `"answering"` |
| `turn_stats` | `result` | `ms`, `costUsd`, `inputTokens`, `outputTokens` |

`phase` chỉ phát khi **đổi** giai đoạn, không phát trên mỗi delta.

### Thương lượng phiên bản giao thức

`tool {name}` cũ trở thành thừa, nhưng không được bỏ thẳng: người dùng có thể nâng bridge mà
quên reload extension. Bỏ thì panel cũ **không hiện gì**; phát cả hai thì panel mới vẽ trùng
mỗi tool hai dòng.

Panel khai báo năng lực ngay trong `start`:

```json
{"type":"start", "sessionId":…, "mcpSessionId":…, "model":…, "protocol": 2}
```

Server phát `tool` **chỉ khi** `protocol < 2` (thiếu trường = 1). Một trường, giải quyết cả
hai chiều, và mọi lần nâng giao thức về sau đi theo đúng lối đó.

## B. Máy trạng thái ở `server/agent.js`

`AgentSession` giữ thêm đúng một thứ: `steps = new Map()` — `tool_use_id → {name, t0}`.

```
content_block_start(tool_use)  →  steps.set(id,{name,t0})     →  phát step_start {id,name}
assistant block tool_use       →  (đã có)                     →  phát step_args  {id,input}
user block tool_result         →  steps.delete(id), tính ms   →  phát step_end   {id,ok,ms,summary,size}
result                         →                              →  phát turn_stats
```

Bốn quy tắc làm nên tính đúng đắn:

1. **Không bao giờ có `step_end` mồ côi.** `tool_result` mang `tool_use_id` không có trong
   `steps` (CLI đổi format, hoặc dòng `stream_event` không tới) → tự phát `step_start` bù
   trước rồi mới phát `step_end`. Panel không phải phòng thủ, và nếu CLI ngừng phát
   `content_block_start` thì timeline vẫn đúng, chỉ mất phần hiện sớm.
2. **`turn_end` là lúc quét dọn.** Trước khi phát `turn_end`, mọi id còn sót trong `steps`
   được phát `step_end {ok:false, aborted:true}`. Bấm Dừng giữa chừng, hoặc CLI chết, thì
   không spinner nào quay vĩnh viễn.
3. **Cắt trước khi ra khỏi socket.** `summary` = 800 ký tự đầu khi `ok`, 2000 khi lỗi (đó là
   thứ người dùng cần đọc), kèm `size` là kích thước thật để hiện "12.4KB". `input` cắt 2000.
4. **`ms` đo ở server** bằng đồng hồ đơn điệu. Panel không tự đoán; nó chỉ chạy **một**
   `setInterval(1s)` cho bước đang chạy để con số nhích trước mắt người dùng.

Chuẩn hoá `tool_result.content` về chuỗi, xử lý **cả hai** dạng đã đo (chuỗi thuần và mảng
`[{type:"text"}]`).

Toàn bộ đi qua `emit()`, nên chốt `this.disposed` sẵn có tự động che các sự kiện mới: bấm
"Phiên mới" giữa lượt thì `step_end` muộn của phiên cũ không lọt sang phiên mới.

## C. Panel: mô hình render và nhật ký

**Timeline.** `Map<id, HTMLElement>`. `step_start` tạo dòng ⠹ + nhãn tra từ bảng;
`step_args` điền phụ đề (ví dụ `new_tab` → phụ đề là `args.url`); `step_end` đổi ⠹ thành
✓/✗, ghim `ms`, gắn phần bung-ra (tham số JSON + `summary`). Tool không có trong bảng nhãn
thì rơi về tên gốc — thêm tool mới chỉ là thêm một dòng ở đây.

`step_*` **không** đụng vào biến `streaming`, đúng như `tool` hiện nay: khối `[tool_use, text]`
đến theo thứ tự nào thì `message` vẫn phải hoà giải được vào đúng phần tử mà các `delta` đã
dựng. Đây là lỗi đã từng xảy ra một lần (một câu trả lời hiện hai lần) và
`test/verify-sidepanel.mjs` F6 đang canh nó.

**Dải trạng thái** ở đáy khung chat, đọc từ cùng mô hình đó:

```
⠹ Đang gửi yêu cầu… 2s     ← phase "requesting"
⠹ Đang suy nghĩ… 5s        ← phase "thinking"
⠹ Đọc trang… 3s            ← có bước đang chạy (ưu tiên cao nhất)
⠹ Đang trả lời… 8s         ← phase "answering"
```

Nó **luôn nhích**, kể cả khi tuyệt đối im lặng — đó chính là tín hiệu "còn sống" hiện đang
thiếu. Kết thúc lượt thì thay bằng dòng `turn_stats` tĩnh.

**Nhật ký.** Một mảng **dữ liệu** (không phải HTML) chạy song song với DOM, debounce ghi vào
`chrome.storage.local` dưới khoá `panelLog.<windowId>` — cùng phạm vi cửa sổ mà
`panelSession.<windowId>` đang dùng, vì hai panel ở hai cửa sổ là hai cuộc hội thoại khác nhau.
Trần **400 mục / 512KB**, vượt thì cắt từ đầu.

Mở panel → phát lại nhật ký vào DOM **trước** khi nối socket. Bước nào lúc đóng panel còn dở
dang thì vẽ lại thành "gián đoạn", vì tiến trình đó chắc chắn đã chết. "Phiên mới" xoá nhật ký
cùng lúc xoá log.

Chọn lưu ở extension chứ không đọc transcript `.jsonl` của CLI, vì: nó sống sót qua việc bridge
khởi động lại; nó là **đúng thứ người dùng đã nhìn thấy**, không phải bản dựng lại từ format
nội bộ của CLI (thứ có thể đổi bất cứ lúc nào — chính đợt đo này đã thấy `content` đổi dạng);
và không cần quyền đọc đĩa nào mới.

## D. Nhận diện ngôn ngữ

`detectLocale(text)` trong panel, chấm điểm hai chiều:

- dấu tiếng Việt **và** từ khoá tiếng Việt không dấu (`mo`, `roi`, `giup`, `cho`, `vao`…)
- chống lại từ khoá tiếng Anh (`the`, `and`, `please`, `open`…)

Hoà → **giữ ngôn ngữ của lượt trước**. Mặc định `vi`.

Chấm điểm cả từ không dấu là bắt buộc, không phải cầu kỳ: người Việt hay gõ
"mo tab github roi tim repo" — ASCII thuần. Nhận diện chỉ dựa vào dấu sẽ đọc câu đó thành
tiếng Anh và lật giao diện sang "Thinking…" giữa chừng.

Phạm vi áp dụng: **chỉ** dải trạng thái, nhãn tool, câu tóm tắt kết quả. Nút bấm
("Phiên mới", "Dừng"), placeholder và `CLOSE_REASONS` giữ tiếng Việt theo quy ước repo —
nếu nhận diện đoán sai thì thiệt hại chỉ là mấy chữ trạng thái, không phải cả giao diện nhảy loạn.

## E. Kiểm thử

| Kiểm cái gì | Bằng gì |
|---|---|
| Ghép cặp `tool_use_id`, `step_end` mồ côi, quét dọn khi `turn_end`, cắt chuỗi, **cả hai dạng** `content` | `test/agent-session.test.mjs` phát lại fixture — node thuần, không cần trình duyệt |
| `protocol: 2` bật/tắt sự kiện `tool` cũ | `test/panel-protocol.test.mjs` |
| ⠹ → ✓ trong DOM, đồng hồ nhích, nhật ký vẽ lại đúng, F6 không hồi quy | `test/verify-sidepanel.mjs` (chạy tay, `HEADED=1`) |
| Không hồi quy chung | `npm test` xanh, `npm run lint` giữ 0 lỗi |

**Việc đầu tiên của kế hoạch thực thi**: ghi một fixture mới bằng **tool MCP chrome thật**.
Bản đo hôm nay dùng tool `Bash`, mà dạng `content` của nó khác dạng tool MCP — fixture phải
phủ đúng dạng mà sản phẩm thật chạy vào.

## F. Ngoài phạm vi (nói rõ để không hiểu nhầm)

- **Không** render markdown cho câu trả lời — vẫn là text thô. Đây là phương án 1 đã chọn,
  không phải phương án 3.
- **Không** hiện nội dung suy nghĩ — đã đo hai lần, CLI không nhả.
- Nhật ký là thứ panel *đã vẽ*, **không** đồng bộ với transcript của CLI. Xoá nhật ký không
  xoá hội thoại, và ngược lại.
- Không đổi ngôn ngữ nút bấm / thông báo lỗi kết nối.

## G. Phiên bản

Bump **1.1.0** ở cả ba nơi phải khớp (`test/build.test.mjs` canh việc này):

- `extension/manifest.json` → `version`
- `VERSION` trong `server/index.js`
- `server/package.json` → `version`, rồi `npm install --package-lock-only` trong `server/`

## H. Rủi ro đã biết

| Rủi ro | Xử lý |
|---|---|
| CLI đổi format NDJSON ở bản sau | Quy tắc "không `step_end` mồ côi" giữ timeline đúng ngay cả khi mất `content_block_start`; fixture trong test là thứ báo động khi format đổi |
| `chrome.storage.local` đầy hạn ngạch | Trần cứng 400 mục / 512KB, cắt từ đầu |
| Nhận diện ngôn ngữ đoán sai | Giữ ngôn ngữ lượt trước khi hoà; phạm vi ảnh hưởng đã giới hạn ở chữ mô tả hoạt động |
| Panel cũ + bridge mới | `protocol` trong `start`; thiếu trường = 1 = hành vi cũ |
