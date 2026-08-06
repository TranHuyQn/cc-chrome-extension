#!/usr/bin/env bash
# Gỡ mọi thứ install.sh đã tạo trên máy này, theo đúng thứ tự ngược lại.
#
#   bash uninstall.sh --dry-run   # chỉ liệt kê, không xoá gì
#   bash uninstall.sh
set -euo pipefail

DRY=no
[ "${1:-}" = "--dry-run" ] && DRY=yes

INSTALL_DIR="$HOME/.cc-chrome-bridge"
STATE_FILE="$HOME/.ccchrome.json"
COMMAND_DEST="$HOME/.claude/commands/ccchrome.md"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$script_dir/service-unit.sh"

removed=0
note() { echo "  - $1"; }
gone() { removed=$((removed + 1)); }

echo "Claude Code Chrome Bridge — gỡ cài đặt$([ $DRY = yes ] && echo ' (dry-run)')"
echo ""

# 1. Dịch vụ TRƯỚC TIÊN. Xoá thư mục trước khi dừng dịch vụ sẽ để lại một tiến
#    trình mồ côi vẫn giữ cổng 8787, và lần cài sau chết vì EADDRINUSE — lỗi mà
#    người dùng không có cách nào tự chẩn đoán.
unit="$(cc_unit_path)"
if [ -f "$unit" ]; then
  note "dịch vụ nền: $unit"
  if [ "$DRY" = no ]; then
    [ -n "${CC_CHROME_SKIP_SERVICE:-}" ] || cc_service_stop
    rm -f "$unit"
  fi
  gone
fi

# 2. Đăng ký MCP
if command -v claude >/dev/null 2>&1 && claude mcp get chrome >/dev/null 2>&1; then
  note "đăng ký MCP 'chrome' trong Claude Code"
  [ "$DRY" = no ] && { claude mcp remove --scope user chrome >/dev/null 2>&1 || true; }
  gone
fi

# 3. Slash command
if [ -f "$COMMAND_DEST" ]; then
  note "lệnh /ccchrome: $COMMAND_DEST"
  [ "$DRY" = no ] && rm -f "$COMMAND_DEST"
  gone
fi

# 4. Token
if [ -f "$STATE_FILE" ]; then
  note "token: $STATE_FILE"
  [ "$DRY" = no ] && rm -f "$STATE_FILE"
  gone
fi

# 5. Mã nguồn — nhưng KHÔNG đụng panel/, đó là lịch sử hội thoại do server tạo
#    lúc chạy, không phải thứ install.sh tạo ra.
for sub in server extension logs ccchrome.md tokens.json uninstall.sh service-unit.sh; do
  if [ -e "$INSTALL_DIR/$sub" ]; then
    note "$INSTALL_DIR/$sub"
    [ "$DRY" = no ] && rm -rf "${INSTALL_DIR:?}/$sub"
    gone
  fi
done
# Xoá thư mục gốc chỉ khi đã rỗng — panel/ còn thì giữ nguyên cả thư mục.
[ "$DRY" = no ] && rmdir "$INSTALL_DIR" 2>/dev/null || true

echo ""
if [ "$removed" -eq 0 ]; then
  echo "Không còn gì để gỡ (0 mục)."
else
  echo "$([ $DRY = yes ] && echo 'Sẽ gỡ' || echo 'Đã gỡ') $removed mục."
fi

if [ -d "$INSTALL_DIR/panel" ]; then
  echo ""
  echo "Còn lại lịch sử hội thoại của khung chat (KHÔNG bị xoá):"
  echo "  $INSTALL_DIR/panel"
  echo "  Muốn xoá luôn:  rm -rf $INSTALL_DIR/panel"
fi

echo ""
echo "Script không gỡ được extension khỏi Chrome — Chrome không cho phép. Tự làm:"
echo "  Mở chrome://extensions → tìm 'Claude Code Chrome Bridge' → bấm Remove"
