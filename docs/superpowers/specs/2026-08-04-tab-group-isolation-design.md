# Thiết kế: nhóm tab theo phiên và giới hạn thao tác trong nhóm — bản 3.0.0

Ngày: 2026-08-04
Mục tiêu: thay thế được extension Claude for Chrome gốc ở phần quản lý tab.

## Yêu cầu

Đúng ba điều, do Huy chốt:

1. **Mỗi phiên Claude Code tạo một tab group riêng** trong Chrome.
2. **Tab do extension mở tự động vào group của phiên đó.**
3. **Extension chỉ thao tác được trên tab thuộc group của phiên đó.**

Không làm gì ngoài ba điều này.

## Đối chiếu với extension gốc

Tài liệu chính thức của Claude for Chrome mô tả hai chiều:

> "This lets Claude organize tabs it opens into a separate group with a different color, so you can easily tell which tabs Claude is using versus your personal browsing."

> "Drag tabs into Claude's designated tab group to enable Claude to view and interact with all grouped tabs at once."

Yêu cầu 2 phủ chiều thứ nhất. Chiều thứ hai — kéo tab vào để Claude đọc được — **có sẵn nhờ yêu cầu 3**: tab nào nằm trong group thì extension thao tác được, nên kéo tab vào chính là cấp quyền. Không cần code riêng cho nó.

Khác biệt có chủ ý so với bản gốc: bản gốc dùng **một** group cố định, ta dùng **một group mỗi phiên** (yêu cầu 1), vì server http hỗ trợ nhiều phiên Claude Code song song trên cùng một token.

Ngoài phạm vi: side panel, phân quyền theo site, ghi GIF, hẹn lịch.

## Thiết kế

### A. Định danh phiên

Extension phải biết request đến từ phiên nào. Server gắn `session` vào mỗi message gửi xuống:

- **stdio**: `randomUUID()` sinh lúc khởi động process. Một process = một phiên Claude Code.
- **http**: MCP session id, lấy ở `onsessioninitialized`.

`ExtensionConnection.call()` nhận thêm tham số và gắn vào envelope `{type:"request", id, method, params, session}`.

### B. Nhóm tab trong extension

Tiêu đề nhóm: `Claude · <4 ký tự đầu của session id>`. Màu: `orange`, khớp màu nút trong popup và phân biệt rõ với tab cá nhân.

Tra nhóm bằng `chrome.tabGroups.query({ title, windowId })`, không thấy thì tạo. **Tiêu đề là nguồn sự thật** — service worker MV3 bị Chrome giết lúc nào cũng được, tra lại theo tiêu đề là tự lành, không cần `chrome.storage`.

Tra theo từng `windowId`: nếu không giới hạn cửa sổ, `chrome.tabs.group` sẽ kéo tab sang cửa sổ khác để nhập nhóm.

Cần thêm quyền `tabGroups` vào `extension/manifest.json`.

### C. Chốt chặn ở `resolveTab()`

Cả 22 tool đều đi qua đúng một hàm `resolveTab(params)`. Siết ở đó là đủ, không phải sửa 22 handler.

```
resolveTab(params, sessionId):
  có params.tabId → tab phải thuộc group của phiên; không thì ném lỗi
  không có tabId  → lấy tab gần nhất trong group của phiên
                    group chưa có tab nào → tạo tab mới trong group
```

Hệ quả bắt buộc, không phải tính năng thêm:

- `navigate` không kèm `tabId` **không còn chiếm tab đang active**; nó dùng tab trong group, chưa có thì tạo.
- `list_tabs` chỉ liệt kê tab trong group của phiên. Liệt kê tab mà extension không đụng được vào chỉ dẫn tới lỗi.
- `new_tab` tạo tab xong thì đưa vào group của phiên (yêu cầu 2).

### D. Thông báo lỗi khi bị chặn

Cùng tinh thần với các close code ở 2.0.0 — nói rõ cách xử lý:

```
Tab 42 nằm ngoài nhóm "Claude · 3f2a". Kéo tab đó vào nhóm nếu muốn
tôi thao tác trên nó, hoặc dùng new_tab để mở tab mới.
```

### E. Phiên bản

**3.0.0** ở cả ba chỗ (`extension/manifest.json`, `VERSION` trong `server/index.js`, `server/package.json`). Ngữ nghĩa của `navigate` và `list_tabs` đổi thật; extension cũ ghép server mới sẽ chạy không có isolation, tức mất đúng đảm bảo mà bản này hứa.

## Kiểm thử

Bước 0 bắt buộc, làm trước mọi thứ: **chứng minh Chromium của Playwright hỗ trợ `chrome.tabGroups`**. Cả thiết kế dựa vào API này; sai thì phải đổi cách kiểm chứng. Giống cách bản 2.0.0 chứng minh giả định về header `Origin` trước khi xây lên nó.

| Yêu cầu | Assertion |
|---|---|
| 1 — mỗi phiên một group | `e2e-http.mjs` đã có `clientA` và `clientA2`: cùng token, khác MCP session. Hai lần `new_tab` từ hai client phải cho hai `groupId` khác nhau |
| 1 — nhãn đúng | Tiêu đề group khớp `^Claude · [0-9a-f]{4}$` |
| 2 — tab mới vào group | `new_tab` xong, `chrome.tabs.get(id).groupId` bằng group của phiên |
| 3 — chặn tab ngoài group | Mở một tab bằng Playwright (không qua extension), gọi `get_page_text` với `tabId` đó → `isError`, thông báo chứa tên nhóm |
| 3 — kéo tab vào thì thao tác được | `chrome.tabs.group` tab đó vào group của phiên, gọi lại `get_page_text` → thành công. Đây là chứng minh chiều "kéo tab vào" hoạt động |
| Tự lành sau khi SW chết | Xoá cache trong service worker rồi gọi `new_tab` lần nữa → vẫn cùng một `groupId`, không tạo group trùng tên |

Toàn bộ test e2e hiện có phải được sửa cho khớp hành vi mới. Đây là phần việc lớn nhất của lần này, không phải bản thân tính năng nhóm tab.

## Rủi ro

- `chrome.tabGroups` chưa được kiểm chứng trên Chromium của Playwright (bước 0 xử lý).
- Người dùng kéo tab **ra khỏi** group giữa chừng → thao tác đang dở sẽ bị từ chối. Đúng theo thiết kế, và thông báo lỗi ở mục D giải thích được.
- Group chỉ xuất hiện sau khi extension mở tab đầu tiên, vì Chrome không cho tồn tại group rỗng. Người dùng muốn kéo tab vào phải đợi Claude mở tab trước.
