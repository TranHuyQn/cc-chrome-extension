#!/usr/bin/env bash
# Gỡ mọi thứ install.sh đã tạo trên máy này, theo đúng thứ tự ngược lại.
#
#   bash uninstall.sh --dry-run   # chỉ liệt kê, không xoá gì
#   bash uninstall.sh
set -euo pipefail

usage() { echo "Dùng: uninstall.sh [--dry-run]"; }

if [ $# -gt 1 ]; then
  echo "Lỗi: quá nhiều tham số." >&2
  usage >&2
  exit 1
fi

DRY=no
case "${1:-}" in
  "") ;;
  --dry-run) DRY=yes ;;
  -h|--help) usage; exit 0 ;;
  *)
    # A mistyped flag (--dryrun, -n, --help typo'd, anything) must not fall
    # through to a real, silent deletion — only the one exact string above
    # ever means "preview only".
    echo "Lỗi: tham số không hợp lệ: '$1'" >&2
    usage >&2
    exit 1
    ;;
esac

INSTALL_DIR="$HOME/.cc-chrome-bridge"
STATE_FILE="$HOME/.ccchrome.json"
COMMAND_DEST="$HOME/.claude/commands/ccchrome.md"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$script_dir/service-unit.sh"

removed=0
fail=0
fail_detail=""
note() { echo "  - $1"; }
gone() { removed=$((removed + 1)); }

# step_rm <path> <f|rf> — remove but survive a failure instead of aborting
# under `set -e`. A single EPERM (a chmod-locked ~/.claude/commands, a
# read-only mount, anything) must not leave the machine half-uninstalled
# with no summary and no hint of what happened — it gets counted and
# reported at the end instead, and the rest of the run still happens.
step_rm() {
  local path="$1" mode="$2" out status
  if [ "$mode" = rf ]; then
    if out="$(rm -rf -- "$path" 2>&1)"; then status=0; else status=$?; fi
  else
    if out="$(rm -f -- "$path" 2>&1)"; then status=0; else status=$?; fi
  fi
  if [ "$status" -ne 0 ]; then
    fail=$((fail + 1))
    fail_detail="${fail_detail}  ! $path: $out
"
  fi
}

echo "Claude Code Chrome Bridge — gỡ cài đặt$([ $DRY = yes ] && echo ' (dry-run)')"
echo ""

# 1. Dịch vụ TRƯỚC TIÊN. Xoá thư mục trước khi dừng dịch vụ sẽ để lại một tiến
#    trình mồ côi vẫn giữ cổng 8787, và lần cài sau chết vì EADDRINUSE — lỗi mà
#    người dùng không có cách nào tự chẩn đoán. Gọi cc_service_stop trước khi
#    kiểm tra unit file có tồn tại hay không: unit có thể đã bị xoá tay trong
#    khi dịch vụ vẫn đang chạy, và bỏ qua bước dừng chỉ vì thiếu file vẫn để
#    lại đúng cái tiến trình mồ côi này.
if [ "$DRY" = no ]; then
  if [ -n "${CC_CHROME_SKIP_SERVICE:-}" ]; then
    : # bỏ qua khi test — không được đụng dịch vụ thật của phiên đăng nhập
  else
    cc_service_stop
    # cc_service_stop nuốt mọi lỗi và luôn trả về 0 (launchctl/systemctl có
    # thể thất bại vì bootstrap hỏng, WSL, ssh không lingering — install.sh
    # đã coi đó là cảnh báo-rồi-tiếp-tục, không phải lỗi chết), nên exit code
    # của nó không chứng minh được gì. Hỏi lại bằng cc_service_loaded thay vì
    # tin rằng "đã gọi lệnh dừng" nghĩa là "đã dừng". `launchctl bootout` có
    # thể trả về trong khi tiến trình vẫn còn đang thoát hẳn — hỏi ngay lập
    # tức một lần dễ bắt trúng khoảnh khắc đó và báo lỗi oan cho một lần gỡ
    # cài hoàn toàn bình thường, nên thử lại vài lần trước khi kết luận.
    still_loaded=no
    for attempt in 1 2 3; do
      if cc_service_loaded; then
        still_loaded=yes
        [ "$attempt" -lt 3 ] && sleep 0.5
      else
        still_loaded=no
        break
      fi
    done
    if [ "$still_loaded" = yes ]; then
      echo "Lỗi: đã gọi lệnh dừng dịch vụ nhưng có vẻ nó vẫn đang chạy." >&2
      echo "Không xoá thêm gì để tránh xoá mã nguồn dưới một tiến trình còn sống." >&2
      if [ "$(cc_platform)" = macos ]; then
        echo "Tự kiểm tra:  launchctl print \"gui/\$(id -u)/$(cc_unit_label)\"" >&2
      else
        echo "Tự kiểm tra:  systemctl --user status $(cc_unit_label).service" >&2
      fi
      echo "Dừng tay xong thì chạy lại:  bash \"$INSTALL_DIR/uninstall.sh\"" >&2
      exit 1
    fi
  fi
fi
unit="$(cc_unit_path)"
if [ -f "$unit" ]; then
  note "dịch vụ nền: $unit"
  if [ "$DRY" = no ]; then
    step_rm "$unit" f
    # Systemd còn nhớ đường dẫn unit vừa xoá cho tới lần daemon-reload tiếp
    # theo — cc_service_stop đã reload một lần nhưng đó là TRƯỚC khi file bị
    # xoá ở dòng trên, nên gọi lại sau khi xoá mới thực sự dọn sạch.
    if [ "$(cc_platform)" = linux ]; then
      systemctl --user daemon-reload >/dev/null 2>&1 || true
    fi
  fi
  gone
fi

# 2. Đăng ký MCP — không dùng `claude mcp get` để quyết định có gỡ hay không:
#    lệnh đó không nhận --scope, nên một entry ở scope project/local (rất dễ
#    có sẵn ngay trong một checkout của chính repo này) khiến ta tưởng lầm là
#    "còn đăng ký" trong khi `remove --scope user` chỉ đụng scope user — kết
#    quả là báo "còn 1 mục" mãi mãi, không bao giờ về "0 mục". Gọi remove
#    thẳng, đọc exit code của chính nó.
if command -v claude >/dev/null 2>&1; then
  if [ "$DRY" = yes ]; then
    # Đếm nó vào danh sách xem trước: bản thân danh sách này đã liệt nó ra
    # (dòng note dưới), nên số đếm mà không khớp số dòng liệt kê thì cái
    # "xem trước" này còn tự mâu thuẫn với chính nó — chả ai tin được nữa.
    note "đăng ký MCP 'chrome' (scope user) trong Claude Code — nếu có"
    gone
  else
    if claude mcp remove --scope user chrome >/dev/null 2>&1; then
      note "đăng ký MCP 'chrome' trong Claude Code"
      gone
    else
      # remove thất bại không tự nó có nghĩa là "chẳng có gì để gỡ" — cấu
      # hình bị khoá, 'claude' lệch phiên bản, hay entry nằm ở scope khác
      # (remove --scope user không đụng tới) đều trả về y hệt vậy. Im lặng
      # ở đây thì hai tình huống — "sạch sẽ" và "còn sót lại đâu đó" —
      # không ai phân biệt được nữa.
      echo "  ! 'claude mcp remove --scope user chrome' không thành công (có thể do không còn gì để gỡ, hoặc lệnh thất bại)." >&2
      echo "    Kiểm tra / gỡ tay nếu cần:  claude mcp remove --scope user chrome" >&2
    fi
  fi
else
  # Không có 'claude' thì không có cách nào tự gỡ đăng ký này — im lặng bỏ
  # qua sẽ để lại một entry mang theo "Authorization: Bearer <token>" trong
  # cấu hình Claude Code mãi mãi, không ai được báo. Token khi đó đã chết
  # (bước 4 xoá tokens.json), nhưng đây vẫn là thứ install.sh để lại mà
  # không ai được nói cho biết.
  echo "  ! Không thấy lệnh 'claude' — không tự gỡ được đăng ký MCP 'chrome'." >&2
  echo "    Gỡ tay khi có lại 'claude':  claude mcp remove --scope user chrome" >&2
fi

# 3. Slash command
if [ -f "$COMMAND_DEST" ]; then
  note "lệnh /ccchrome: $COMMAND_DEST"
  [ "$DRY" = no ] && step_rm "$COMMAND_DEST" f
  gone
fi

# 4. Token
if [ -f "$STATE_FILE" ]; then
  note "token: $STATE_FILE"
  [ "$DRY" = no ] && step_rm "$STATE_FILE" f
  gone
fi

# 4b. Tàn dư của tính năng cập nhật trong panel. Một bản .bak là bản sao đầy
#     đủ của thư mục cài đặt — hàng chục MB — và không có gì khác từng dọn
#     bốn thứ này.
for artifact in "$HOME/.ccchrome-update.json" "$HOME/.ccchrome-update.log"; do
  if [ -e "$artifact" ]; then
    note "$artifact"
    [ "$DRY" = no ] && step_rm "$artifact" f
    gone
  fi
done
for artifact in "$INSTALL_DIR.bak" "$INSTALL_DIR.failed"; do
  if [ -e "$artifact" ]; then
    note "$artifact"
    [ "$DRY" = no ] && step_rm "$artifact" rf
    gone
  fi
done

# 5. Mã nguồn — nhưng KHÔNG đụng panel/, đó là lịch sử hội thoại do server tạo
#    lúc chạy, không phải thứ install.sh tạo ra. .new là chỗ install.sh dàn
#    dựng bản cài mới (kể cả node_modules) trước khi hoán đổi — bị bỏ lại
#    nguyên vẹn nếu máy mất điện hay tiến trình bị kill giữa chừng, và nếu
#    không dọn thì nó chặn luôn "rmdir" bên dưới, khiến cả thư mục cài đặt
#    không bao giờ biến mất dù script đã báo "gỡ xong".
for sub in server extension logs ccchrome.md tokens.json uninstall.sh service-unit.sh .new; do
  # [ -e ] đi theo symlink — một symlink gãy (trỏ tới đích không còn tồn tại)
  # sẽ báo "không có" và bị bỏ qua mãi mãi; [ -L ] bắt luôn trường hợp đó.
  if [ -e "$INSTALL_DIR/$sub" ] || [ -L "$INSTALL_DIR/$sub" ]; then
    note "$INSTALL_DIR/$sub"
    [ "$DRY" = no ] && step_rm "${INSTALL_DIR:?}/$sub" rf
    gone
  fi
done
# panel/ giữ lại dữ liệu người dùng, nhưng .mcp-config-*.json KHÔNG phải dữ liệu
# người dùng: mỗi file là một bản sao token Bearer của bridge, do server sinh ra
# cho từng phiên khung chat, và trước đây không có gì dọn — đo được 40 file sau
# vài ngày dùng. Token đã bị thu hồi lúc gỡ (tokens.json biến mất), nhưng để lại
# một đống file chứa credential đã chết trong thư mục mà uninstall cố ý bảo tồn
# là thói quen xấu. AgentSession.dispose() xoá file của nó khi phiên đóng; đây là
# lưới hứng cho những phiên mà bridge bị kill trước khi kịp dọn.
if [ -d "$INSTALL_DIR/panel" ]; then
  stale_configs=$(find "$INSTALL_DIR/panel" -maxdepth 1 -name '.mcp-config-*.json' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$stale_configs" -gt 0 ]; then
    note "$stale_configs file cấu hình MCP cũ trong panel/ (mỗi file chứa một token đã thu hồi)"
    if [ "$DRY" = no ]; then
      find "$INSTALL_DIR/panel" -maxdepth 1 -name '.mcp-config-*.json' -delete 2>/dev/null || true
    fi
    gone
  fi
fi

# Xoá thư mục gốc chỉ khi đã rỗng — panel/ còn thì giữ nguyên cả thư mục.
if [ "$DRY" = no ]; then
  rmdir "$INSTALL_DIR" 2>/dev/null || true
elif [ -d "$INSTALL_DIR" ]; then
  echo ""
  echo "  (Nếu $INSTALL_DIR trống sau khi gỡ, thư mục này cũng sẽ bị xoá.)"
fi

echo ""
if [ "$fail" -gt 0 ]; then
  echo "$([ $DRY = yes ] && echo 'Sẽ gỡ' || echo 'Đã gỡ') $((removed - fail))/$removed mục — $fail mục lỗi:"
  printf '%s' "$fail_detail"
elif [ "$removed" -eq 0 ]; then
  echo "Không còn gì để gỡ (0 mục)."
else
  echo "$([ $DRY = yes ] && echo 'Sẽ gỡ' || echo 'Đã gỡ') $removed mục."
fi

# Chỉ nhắc khi panel/ THỰC SỰ còn gì đó. Trước đây dòng này luôn hiện và gọi
# panel/ là "lịch sử hội thoại", trong khi trên máy thật nó chỉ chứa file cấu
# hình MCP do server sinh ra — lịch sử của khung chat nằm ở ~/.claude/projects/,
# không phải ở đây. Nói sai chỗ dữ liệu nằm thì tệ hơn là không nói.
if [ -d "$INSTALL_DIR/panel" ] && [ -n "$(ls -A "$INSTALL_DIR/panel" 2>/dev/null)" ]; then
  echo ""
  echo "Giữ lại thư mục làm việc của khung chat (KHÔNG bị xoá):"
  echo "  $INSTALL_DIR/panel"
  echo "  Đây là cwd mà mỗi tiến trình 'claude' của khung chat chạy trong đó."
  echo "  Muốn xoá luôn:  rm -rf \"$INSTALL_DIR/panel\""
fi

echo ""
echo "Script không gỡ được extension khỏi Chrome — Chrome không cho phép. Tự làm:"
echo "  Mở chrome://extensions → tìm 'Claude Code Chrome Bridge' → bấm Remove"

if [ "$fail" -gt 0 ]; then
  exit 1
fi
