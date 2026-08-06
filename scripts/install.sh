#!/usr/bin/env bash
# Claude Code Chrome Bridge — cài đặt trên máy của bạn.
#
# Chạy:  curl -fsSL <release-url>/install.sh | bash
#
# Script này KHÔNG cần quyền root và chỉ ghi vào thư mục home của bạn.
set -euo pipefail

PORT="${CC_CHROME_PORT:-8787}"
INSTALL_DIR="$HOME/.cc-chrome-bridge"
STATE_FILE="$HOME/.ccchrome.json"
COMMAND_DEST="$HOME/.claude/commands/ccchrome.md"

# CC_CHROME_SOURCE lets the test suite install from a checkout instead of
# downloading a release. Unset in normal use.
SOURCE="${CC_CHROME_SOURCE:-}"
RELEASE_URL="${CC_CHROME_RELEASE_URL:-https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/cc-chrome-bridge.tar.gz}"

say() { echo "$@"; }
die() { echo "Lỗi: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "chưa có 'node'. Cài Node.js 18 trở lên rồi chạy lại."
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 18 ] || die "cần Node.js 18 trở lên, máy đang có $(node -v)."

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$script_dir/service-unit.sh"
cc_platform >/dev/null || die "chỉ hỗ trợ macOS và Linux."

upgrade=no
[ -f "$STATE_FILE" ] && upgrade=yes

say "Claude Code Chrome Bridge — $([ $upgrade = yes ] && echo 'nâng cấp' || echo 'cài đặt')"
say ""

# 1. Dừng service cũ trước khi thay mã nguồn, nếu không tiến trình đang chạy
#    vẫn giữ cổng và bản mới không lên được.
if [ "$upgrade" = yes ]; then
  say "→ Dừng dịch vụ đang chạy…"
  [ -n "${CC_CHROME_SKIP_SERVICE:-}" ] || cc_service_stop
fi

# 2. Mã nguồn
say "→ Cài mã nguồn vào $INSTALL_DIR"
mkdir -p "$INSTALL_DIR/logs"
rm -rf "$INSTALL_DIR/server" "$INSTALL_DIR/extension"
if [ -n "$SOURCE" ]; then
  cp -R "$SOURCE/server" "$INSTALL_DIR/server"
  cp -R "$SOURCE/extension" "$INSTALL_DIR/extension"
  cp "$SOURCE/.claude/commands/ccchrome.md" "$INSTALL_DIR/ccchrome.md"
  # uninstall.sh does not exist until Task 5; copy it when present so the
  # closing message's "bash $INSTALL_DIR/uninstall.sh" is truthful once it
  # lands, but don't fail this install over its absence today.
  [ -f "$SOURCE/scripts/uninstall.sh" ] && cp "$SOURCE/scripts/uninstall.sh" "$INSTALL_DIR/"
  cp "$SOURCE/scripts/service-unit.sh" "$INSTALL_DIR/"
else
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$RELEASE_URL" -o "$tmp/release.tar.gz" || die "không tải được gói phát hành."
  tar -xzf "$tmp/release.tar.gz" -C "$tmp"
  cp -R "$tmp/server" "$INSTALL_DIR/server"
  cp -R "$tmp/extension" "$INSTALL_DIR/extension"
  cp "$tmp/ccchrome.md" "$INSTALL_DIR/ccchrome.md"
  [ -f "$tmp/uninstall.sh" ] && cp "$tmp/uninstall.sh" "$INSTALL_DIR/"
  [ -f "$tmp/service-unit.sh" ] && cp "$tmp/service-unit.sh" "$INSTALL_DIR/"
fi
[ -f "$INSTALL_DIR/uninstall.sh" ] && chmod +x "$INSTALL_DIR/uninstall.sh"
[ -d "$INSTALL_DIR/server/node_modules" ] || die "gói phát hành thiếu node_modules."

# 3. Token — giữ nguyên khi nâng cấp, để khỏi phải dán lại URL vào popup.
if [ "$upgrade" = yes ]; then
  TOKEN="$(node -p "require('$STATE_FILE').token")"
  say "→ Giữ token cũ"
else
  TOKEN="$(openssl rand -hex 16)"
  say "→ Sinh token mới"
fi
node -e "require('fs').writeFileSync('$STATE_FILE', JSON.stringify({ token: '$TOKEN', port: $PORT }, null, 2) + '\n')"
node -e "require('fs').writeFileSync('$INSTALL_DIR/tokens.json', JSON.stringify({ '$TOKEN': 'local' }, null, 2) + '\n')"

# 4. Service
say "→ Cài dịch vụ nền"
cc_write_unit "$INSTALL_DIR" "$PORT"
if [ -n "${CC_CHROME_SKIP_SERVICE:-}" ]; then
  say "  (bỏ qua bước nạp dịch vụ — CC_CHROME_SKIP_SERVICE)"
else
  cc_service_start
  say "→ Chờ bridge sẵn sàng…"
  ok=no
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ok=yes; break; fi
    sleep 0.5
  done
  [ "$ok" = yes ] || die "bridge không lên sau 20 giây. Xem log: $INSTALL_DIR/logs/bridge.err.log"
fi

# 5. Slash command
mkdir -p "$(dirname "$COMMAND_DEST")"
cp "$INSTALL_DIR/ccchrome.md" "$COMMAND_DEST"
say "→ Đã cài lệnh /ccchrome"

# 6. Đăng ký MCP với Claude Code
if command -v claude >/dev/null 2>&1; then
  claude mcp remove --scope user chrome >/dev/null 2>&1 || true
  claude mcp add --scope user --transport http chrome \
    "http://127.0.0.1:$PORT/mcp" --header "Authorization: Bearer $TOKEN" >/dev/null
  say "→ Đã đăng ký MCP server 'chrome' với Claude Code"
else
  say "→ Không thấy lệnh 'claude' — bỏ qua đăng ký MCP. Cài Claude Code rồi chạy lại script này."
fi

say ""
say "Xong. Còn hai việc bạn phải tự làm trong Chrome:"
say ""
say "  1. Mở chrome://extensions → bật Developer mode → Load unpacked"
say "     → chọn thư mục:  $INSTALL_DIR/extension"
say ""
say "  2. Bấm icon extension, dán URL này vào ô địa chỉ rồi bấm 'Lưu & kết nối lại':"
say "     ws://127.0.0.1:$PORT/ws?token=$TOKEN"
say ""
say "  Badge chuyển 'on' màu xanh là xong. Mở khung chat bằng nút 'Mở khung chat' trong popup."
say ""
say "  Gỡ cài đặt:  bash $INSTALL_DIR/uninstall.sh"
