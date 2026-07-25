#!/usr/bin/env bash
# Cài slash command /ccchrome vào Claude Code của máy này (scope user —
# dùng được trong mọi project). Chạy: bash scripts/install-command.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)/.claude/commands/ccchrome.md"
DEST="$HOME/.claude/commands"

mkdir -p "$DEST"
cp "$SRC" "$DEST/ccchrome.md"
echo "Đã cài /ccchrome vào $DEST/ccchrome.md"
echo "Mở phiên claude mới rồi gõ: /ccchrome connect https://chrome.example.com"
