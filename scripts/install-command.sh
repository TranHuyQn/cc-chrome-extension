#!/usr/bin/env bash
# Cài slash command /ccchrome vào Claude Code của máy này (scope user —
# dùng được trong mọi project). Chạy: bash scripts/install-command.sh
#
# ⚠️  MÔ HÌNH CŨ — không còn là cách cài chính thức từ 3.5.0.
# Từ 3.5.0 mỗi người tự chạy bridge trên máy mình và `scripts/install.sh` đã
# cài sẵn /ccchrome (cùng với server, extension và dịch vụ nền) — xem README,
# mục "Cài đặt". File này giữ lại cho trường hợp duy nhất còn hợp lệ: bạn đang
# ở trong repo này và chỉ muốn cập nhật riêng file lệnh /ccchrome, không cài
# lại gì khác.
#
# Hai dòng hướng dẫn cũ ở đây (`/ccchrome connect https://<domain>` và
# `curl https://<domain>/install.sh | bash`) đã bị bỏ: chúng thuộc mô hình
# server VPS dùng chung, không còn tồn tại từ 3.5.0.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)/.claude/commands/ccchrome.md"
DEST="$HOME/.claude/commands"

mkdir -p "$DEST"
cp "$SRC" "$DEST/ccchrome.md"
echo "Đã cài /ccchrome vào $DEST/ccchrome.md"
echo "Mở phiên claude mới rồi gõ: /ccchrome status"
