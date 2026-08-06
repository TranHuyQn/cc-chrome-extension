#!/usr/bin/env bash
# Shared by install.sh and uninstall.sh. Sourced, never executed directly:
# both scripts need the same unit path and label, and two copies of that
# knowledge is the surest way to have them disagree.

cc_platform() {
  case "$(uname -s)" in
    Darwin) echo macos ;;
    Linux)  echo linux ;;
    *) echo "Chưa hỗ trợ hệ điều hành: $(uname -s)" >&2; return 1 ;;
  esac
}

cc_unit_label() {
  [ "$(cc_platform)" = macos ] && echo "com.ccchrome.bridge" || echo "ccchrome-bridge"
}

cc_unit_path() {
  if [ "$(cc_platform)" = macos ]; then
    echo "$HOME/Library/LaunchAgents/com.ccchrome.bridge.plist"
  else
    echo "$HOME/.config/systemd/user/ccchrome-bridge.service"
  fi
}

# cc_write_unit <install_dir> <port>
#
# Note on paths interpolated below:
# - `$(command -v node)` is resolved once, right now, and baked in as an
#   absolute path — launchd/systemd user services do not inherit an
#   interactive shell's PATH, so a bare `node` would fail at boot with an
#   error the user won't see until they wonder why the bridge is down. The
#   tradeoff: if that node is later removed (nvm version pruned, switched to
#   volta/fnm, etc.) the baked-in path stops existing and the service
#   crash-loops under KeepAlive/Restart=always with no obvious cause visible
#   from outside the unit. Re-running the installer regenerates the unit
#   against whatever `node` resolves to at that time.
# - `${dir}` and other values are not XML/shell-metacharacter-escaped. A
#   space or apostrophe in `${dir}` is handled (quoted below on the systemd
#   side; XML text nodes don't word-split), but a literal `&`, `<`, or `>`
#   in `${dir}` (e.g. an "R&D" folder) would produce an invalid plist. Known
#   and out of scope for this task.
cc_write_unit() {
  local dir="$1" port="$2" unit label; unit="$(cc_unit_path)"; label="$(cc_unit_label)"
  mkdir -p "$(dirname "$unit")" "${dir}/logs"
  if [ "$(cc_platform)" = macos ]; then
    cat > "$unit" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>${dir}/server/index.js</string>
    <string>--http</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CC_CHROME_HOST</key><string>127.0.0.1</string>
    <key>CC_CHROME_PORT</key><string>${port}</string>
    <key>CC_CHROME_TOKENS_FILE</key><string>${dir}/tokens.json</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${dir}/logs/bridge.log</string>
  <key>StandardErrorPath</key><string>${dir}/logs/bridge.err.log</string>
</dict>
</plist>
PLIST
  else
    cat > "$unit" <<UNIT
[Unit]
Description=Claude Code Chrome Bridge
After=default.target

[Service]
ExecStart="$(command -v node)" "${dir}/server/index.js" --http
Environment="CC_CHROME_HOST=127.0.0.1"
Environment="CC_CHROME_PORT=${port}"
Environment="CC_CHROME_TOKENS_FILE=${dir}/tokens.json"
Restart=always
RestartSec=3
StandardOutput=append:${dir}/logs/bridge.log
StandardError=append:${dir}/logs/bridge.err.log

[Install]
WantedBy=default.target
UNIT
  fi
}

cc_service_start() {
  if [ "$(cc_platform)" = macos ]; then
    launchctl bootout "gui/$(id -u)/$(cc_unit_label)" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$(cc_unit_path)"
  else
    systemctl --user daemon-reload
    systemctl --user enable --now "$(cc_unit_label).service"
  fi
}

cc_service_stop() {
  if [ "$(cc_platform)" = macos ]; then
    launchctl bootout "gui/$(id -u)/$(cc_unit_label)" >/dev/null 2>&1 || true
  else
    systemctl --user disable --now "$(cc_unit_label).service" >/dev/null 2>&1 || true
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
}

# cc_service_loaded — true (exit 0) if the service is still loaded/running
# right now. Read-only, mutates nothing. Every branch of cc_service_stop ends
# in `|| true`, on purpose (launchctl/systemctl fail in ordinary situations —
# stale bootstrap state, WSL, ssh without lingering — and install.sh already
# treats that as a warn-and-continue case, not a fatal one), which means its
# own exit code can never tell a caller whether the stop actually worked.
# This is how uninstall.sh confirms it before deleting anything the stopped
# process might still need.
cc_service_loaded() {
  if [ "$(cc_platform)" = macos ]; then
    launchctl print "gui/$(id -u)/$(cc_unit_label)" >/dev/null 2>&1
  else
    systemctl --user is-active --quiet "$(cc_unit_label).service" 2>/dev/null
  fi
}
