#!/usr/bin/env bash
# Claude Code Chrome Bridge — cài đặt trên máy của bạn.
#
# Chạy:  curl -fsSL <release-url>/install.sh | bash
#
# Script này KHÔNG cần quyền root và chỉ ghi vào thư mục home của bạn.
set -euo pipefail

# C2: the token in $STATE_FILE authorizes full browser control (and, on a
# loopback bridge, spawning `claude` under this login). umask 077 means
# every file/dir this script creates — via mkdir, cp, mv, tar, or node's
# writeFileSync — starts owner-only, with no window where it briefly exists
# group/other-readable. Token files also pass an explicit `mode: 0o600` at
# writeFileSync, and (N2) get an unconditional `chmod` on every run too,
# because writeFileSync's `mode` only applies the moment a file is *created*
# — rewriting an existing file (the upgrade path, every time) leaves
# whatever mode it already had untouched.
umask 077

PORT="${CC_CHROME_PORT:-8787}"
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "Lỗi: CC_CHROME_PORT không hợp lệ: '$PORT' (phải là số)." >&2; exit 1; }
INSTALL_DIR="$HOME/.cc-chrome-bridge"
STATE_FILE="$HOME/.ccchrome.json"
COMMAND_DEST="$HOME/.claude/commands/ccchrome.md"

# CC_CHROME_SOURCE lets the test suite install from a checkout instead of
# downloading a release. Unset in normal use.
SOURCE="${CC_CHROME_SOURCE:-}"
RELEASE_URL="${CC_CHROME_RELEASE_URL:-https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/cc-chrome-bridge.tar.gz}"

say() { echo "$@"; }
die() { echo "Lỗi: $*" >&2; exit 1; }

# I6: `node` is already a hard requirement below, so generating the token
# through it avoids adding `openssl` as a second one.
new_token() { node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))'; }

# C3: read the token out of a possibly-missing/malformed/keyless state file
# without ever letting a raw Node exception reach the user. Prints nothing
# (empty string) on any problem; the caller decides what "no token" means.
read_existing_token() {
  CC_STATE_FILE="$STATE_FILE" node -e '
    const fs = require("fs");
    try {
      const data = JSON.parse(fs.readFileSync(process.env.CC_STATE_FILE, "utf8"));
      if (typeof data.token === "string") process.stdout.write(data.token);
    } catch {
      // malformed JSON, missing file, missing key — all treated as "no usable token"
    }
  '
}

command -v node >/dev/null 2>&1 || die "chưa có 'node'. Cài Node.js 18 trở lên rồi chạy lại."
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 18 ] || die "cần Node.js 18 trở lên, máy đang có $(node -v)."

# C1: service-unit.sh must NOT be sourced here. In both documented flows this
# script is the only file the user has — `curl … | bash` and `curl … -o
# install.sh; bash install.sh` — and service-unit.sh only arrives inside the
# release tarball downloaded ~40 lines below. Sourcing it up front made every
# real install (and every upgrade, since install.sh is the documented upgrade
# path too) exit 1 having created nothing. The library is sourced right after
# staging instead, from "$stage"; $script_dir is only the fallback for running
# straight out of a checkout (what test/install.test.mjs's CC_CHROME_SOURCE
# path does).
#
# ${BASH_SOURCE[0]} is unbound when the script arrives on stdin, and `set -u`
# turns reading it into a fatal error before anything else can run — hence the
# :- default and the empty-string case.
script_dir=""
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

# Platform preflight, inlined rather than calling cc_platform(): refusing an
# unsupported OS is worth doing before a multi-megabyte download, and at this
# point the library that defines cc_platform does not exist yet. Kept in sync
# with cc_platform() in service-unit.sh by hand — two cases, no logic.
case "$(uname -s)" in
  Darwin|Linux) ;;
  *) die "chỉ hỗ trợ macOS và Linux (máy này là $(uname -s))." ;;
esac

upgrade=no
[ -f "$STATE_FILE" ] && upgrade=yes

say "Claude Code Chrome Bridge — $([ $upgrade = yes ] && echo 'nâng cấp' || echo 'cài đặt')"
say ""

# 1. Chuẩn bị mã nguồn mới trong "$INSTALL_DIR/.new" và kiểm tra đầy đủ TRƯỚC
#    khi đụng tới bản cài hiện tại (C1). Staging NẰM TRONG $INSTALL_DIR thay
#    vì thư mục tạm hệ thống, để bước hoán đổi ở mục 3 luôn là "mv" trên cùng
#    filesystem — tức đổi tên tức thời, không phải copy. Đổi tên thì Ctrl-C
#    hầu như không có cửa sổ nào để rơi vào giữa chừng; copy xuyên filesystem
#    (tmpfs /tmp trên Linux, ví dụ) có thể mất vài giây cho node_modules và
#    hết dung lượng đĩa giữa chừng thì hỏng cả hai bản.
say "→ Chuẩn bị mã nguồn mới…"
mkdir -p "$INSTALL_DIR"
chmod 700 "$INSTALL_DIR"
stage="$INSTALL_DIR/.new"
rm -rf "$stage"
mkdir -p "$stage"
tmp=""
trap 'rm -rf "$stage" "$tmp"' EXIT
if [ -n "$SOURCE" ]; then
  cp -R "$SOURCE/server" "$stage/server"
  cp -R "$SOURCE/extension" "$stage/extension"
  cp "$SOURCE/.claude/commands/ccchrome.md" "$stage/ccchrome.md"
  # I8: uninstall.sh does not exist in this checkout until Task 5 lands, so
  # this one copy stays conditional — the only branch where "missing" is
  # expected rather than a broken release.
  [ -f "$SOURCE/scripts/uninstall.sh" ] && cp "$SOURCE/scripts/uninstall.sh" "$stage/"
  cp "$SOURCE/scripts/service-unit.sh" "$stage/"
else
  tmp="$(mktemp -d)"
  curl -fsSL "$RELEASE_URL" -o "$tmp/release.tar.gz" \
    || die "không tải được gói phát hành. Bản cài hiện tại (nếu có) không bị thay đổi."
  tar -xzf "$tmp/release.tar.gz" -C "$tmp" \
    || die "gói phát hành hỏng, không giải nén được. Bản cài hiện tại không bị thay đổi."
  cp -R "$tmp/server" "$stage/server"
  cp -R "$tmp/extension" "$stage/extension"
  cp "$tmp/ccchrome.md" "$stage/ccchrome.md"
  # I8: a real release is expected to ship both files. Missing either one
  # means the release itself is broken — fail loudly instead of silently
  # shipping a bridge the user can never uninstall.
  cp "$tmp/uninstall.sh" "$stage/" || die "gói phát hành thiếu uninstall.sh."
  cp "$tmp/service-unit.sh" "$stage/" || die "gói phát hành thiếu service-unit.sh."
fi
[ -d "$stage/server/node_modules" ] \
  || die "gói phát hành thiếu node_modules. Bản cài hiện tại không bị thay đổi."

# C1: now — and only now — the shared library exists. Prefer the freshly
# staged copy (that is the version about to be installed, so the running
# script and the installed unit file can never disagree); fall back to a
# sibling file when this script runs straight out of a checkout.
if [ -f "$stage/service-unit.sh" ]; then
  # shellcheck source=/dev/null
  . "$stage/service-unit.sh"
elif [ -n "$script_dir" ] && [ -f "$script_dir/service-unit.sh" ]; then
  # shellcheck source=/dev/null
  . "$script_dir/service-unit.sh"
else
  die "thiếu service-unit.sh. Bản cài hiện tại không bị thay đổi."
fi

# 2. Dừng service cũ — an toàn để làm bây giờ, vì mã nguồn thay thế đã sẵn
#    sàng và đã qua kiểm tra ở bước 1. Nếu dừng service trước rồi mới tải
#    (thứ tự cũ), một lần tải hỏng sẽ để lại service đã tắt lẫn mã nguồn bị
#    xoá — không còn gì chạy được.
#
#    Stopped UNCONDITIONALLY, not just when $STATE_FILE exists. On Linux the
#    two can disagree: a user who deleted ~/.ccchrome.json to reset a token,
#    or an interrupted uninstall, leaves the unit loaded and running while
#    $upgrade reads "no". The tree would then be replaced under a live
#    process, `systemctl --user enable --now` is a no-op on an already-active
#    unit, and the old process keeps the port with the OLD token set — so
#    /health answers, the install reports success, and the ws URL just printed
#    gets a 4001. (macOS never had this: cc_service_start does bootout before
#    bootstrap.) Stopping a service that isn't running is free — every branch
#    of cc_service_stop ends in `|| true`.
if [ -n "${CC_CHROME_SKIP_SERVICE:-}" ]; then
  # N4: say only what actually happens — CC_CHROME_SKIP_SERVICE means this
  # step is skipped, not performed.
  say "  (bỏ qua bước dừng dịch vụ — CC_CHROME_SKIP_SERVICE)"
else
  say "→ Dừng dịch vụ đang chạy (nếu có)…"
  cc_service_stop
fi

# 3. Đưa mã nguồn đã kiểm tra vào vị trí thật. $stage nằm trên cùng
#    filesystem với $INSTALL_DIR nên mỗi "mv" dưới đây là đổi tên, không copy.
say "→ Cài mã nguồn vào $INSTALL_DIR"
mkdir -p "$INSTALL_DIR/logs"
rm -rf "$INSTALL_DIR/server" "$INSTALL_DIR/extension"
mv "$stage/server" "$INSTALL_DIR/server"
mv "$stage/extension" "$INSTALL_DIR/extension"
mv "$stage/ccchrome.md" "$INSTALL_DIR/ccchrome.md"
if [ -f "$stage/uninstall.sh" ]; then
  mv "$stage/uninstall.sh" "$INSTALL_DIR/uninstall.sh"
  chmod +x "$INSTALL_DIR/uninstall.sh"
fi
mv "$stage/service-unit.sh" "$INSTALL_DIR/service-unit.sh"
rm -rf "$stage"

# 4. Token — giữ nguyên khi nâng cấp, để khỏi phải dán lại URL vào popup.
if [ "$upgrade" = yes ]; then
  TOKEN="$(read_existing_token)"
  if [[ "$TOKEN" =~ ^[0-9a-f]{16,}$ ]]; then
    say "→ Giữ token cũ"
  else
    # C3: a missing/malformed/keyless state file must never crash here or
    # silently produce a "Bearer undefined" install — mint a fresh token
    # and say so, the same as a first install. N1: this necessarily
    # replaces whatever tokens.json had, so tell the user their old URL
    # (if they ever had one working) is now dead and must be re-pasted.
    say "→ Token cũ trong $STATE_FILE bị hỏng hoặc thiếu — sinh token mới."
    say "  Token cũ (nếu còn dùng được) sẽ bị thu hồi — dán lại URL mới vào popup extension."
    TOKEN="$(new_token)"
  fi
else
  TOKEN="$(new_token)"
  say "→ Sinh token mới"
fi

# I4: values go through process.env, never interpolated into JS source —
# an apostrophe or backslash in $HOME (e.g. /tmp/o'brien) would otherwise
# break the generated JavaScript. Explicit `mode: 0o600` backs up umask (C2).
CC_STATE_FILE="$STATE_FILE" CC_TOKEN="$TOKEN" CC_PORT="$PORT" node -e '
  const fs = require("fs");
  const port = Number(process.env.CC_PORT);
  fs.writeFileSync(
    process.env.CC_STATE_FILE,
    JSON.stringify({ token: process.env.CC_TOKEN, port }, null, 2) + "\n",
    { mode: 0o600 }
  );
'
# N1: tokens.json holds exactly one live token, this one — written wholesale,
# not merged. server/tokens.js loads this file wholesale as the set of
# credentials that authorize full browser control and (on a loopback bridge)
# spawning `claude` under this login; merging previous entries in meant nothing
# ever revoked them, so a run of bad-state recoveries left an unbounded set of
# still-valid tokens behind. Overwriting is what actually revokes the old one.
CC_TOKENS_FILE="$INSTALL_DIR/tokens.json" CC_TOKEN="$TOKEN" node -e '
  const fs = require("fs");
  fs.writeFileSync(
    process.env.CC_TOKENS_FILE,
    JSON.stringify({ [process.env.CC_TOKEN]: "local" }, null, 2) + "\n",
    { mode: 0o600 }
  );
'
# N2: repair modes on every run, not just the run that created these files —
# writeFileSync's `mode` option is a create-time-only default in Node/POSIX,
# so a file that already existed with looser bits (e.g. from a pre-fix
# install) would otherwise keep them forever across every future upgrade.
chmod 600 "$STATE_FILE" "$INSTALL_DIR/tokens.json"

# 5. Service
say "→ Cài dịch vụ nền"
cc_write_unit "$INSTALL_DIR" "$PORT"
if [ -n "${CC_CHROME_SKIP_SERVICE:-}" ]; then
  say "  (bỏ qua bước nạp dịch vụ — CC_CHROME_SKIP_SERVICE)"
elif cc_service_start; then
  say "→ Chờ bridge sẵn sàng…"
  ok=no
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ok=yes; break; fi
    sleep 0.5
  done
  # I7: a slow/failed health check must not abort before the slash command
  # and MCP registration below, and before the closing instructions print —
  # those are what let the user finish the install by hand.
  [ "$ok" = yes ] || say "→ Cảnh báo: bridge không phản hồi sau 20 giây. Xem log: $INSTALL_DIR/logs/bridge.err.log"
else
  # I7: `launchctl bootstrap`/`systemctl --user` fail in ordinary, common
  # situations (stale bootstrap state, WSL/containers, ssh without
  # lingering). Warn and keep going instead of dying with raw tool output.
  say "→ Cảnh báo: không khởi động được dịch vụ nền. Xem log: $INSTALL_DIR/logs/bridge.err.log"
  # N3: quoted so the command stays copy-pasteable when $INSTALL_DIR contains a space.
  say "   Bạn có thể tự chạy: node \"$INSTALL_DIR/server/index.js\" --http"
fi

# 6. Slash command
mkdir -p "$(dirname "$COMMAND_DEST")"
cp "$INSTALL_DIR/ccchrome.md" "$COMMAND_DEST"
say "→ Đã cài lệnh /ccchrome"

# 7. Đăng ký MCP với Claude Code
#
# Minor: the Bearer token is visible in `ps`/`/proc/<pid>/cmdline` for the
# lifetime of this `claude mcp add` child, to any other local user — same
# class of tradeoff as the panel's spawned-argv token documented in
# CLAUDE.md. Same-machine-only exposure; not fixed here.
if command -v claude >/dev/null 2>&1; then
  claude mcp remove --scope user chrome >/dev/null 2>&1 || true
  # I5: a `claude` too old to know --transport http (or any other failure)
  # must not abort the script — the user still needs the Load-unpacked and
  # ws:// instructions printed below regardless of whether this succeeded.
  if claude mcp add --scope user --transport http chrome \
      "http://127.0.0.1:$PORT/mcp" --header "Authorization: Bearer $TOKEN" >/dev/null 2>&1; then
    say "→ Đã đăng ký MCP server 'chrome' với Claude Code"
  else
    say "→ Không đăng ký được MCP server tự động (có thể 'claude' bản cũ chưa hỗ trợ --transport http)."
    say "   Đăng ký thủ công:"
    say "   claude mcp add --scope user --transport http chrome http://127.0.0.1:$PORT/mcp --header \"Authorization: Bearer $TOKEN\""
  fi
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
# I8 + minor: only promise the uninstall command if the file is actually
# there (it isn't yet, from a checkout predating Task 5), and quote the
# path so the line stays copy-pasteable when $HOME contains a space.
if [ -f "$INSTALL_DIR/uninstall.sh" ]; then
  say "  Gỡ cài đặt:  bash \"$INSTALL_DIR/uninstall.sh\""
fi
