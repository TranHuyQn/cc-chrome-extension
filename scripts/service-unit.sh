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
cc_write_unit() {
  local dir="$1" port="$2" unit; unit="$(cc_unit_path)"
  mkdir -p "$(dirname "$unit")"
  if [ "$(cc_platform)" = macos ]; then
    cat > "$unit" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ccchrome.bridge</string>
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
ExecStart=$(command -v node) ${dir}/server/index.js --http
Environment=CC_CHROME_HOST=127.0.0.1
Environment=CC_CHROME_PORT=${port}
Environment=CC_CHROME_TOKENS_FILE=${dir}/tokens.json
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
    launchctl bootout "gui/$(id -u)/com.ccchrome.bridge" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$(cc_unit_path)"
  else
    systemctl --user daemon-reload
    systemctl --user enable --now ccchrome-bridge.service
  fi
}

cc_service_stop() {
  if [ "$(cc_platform)" = macos ]; then
    launchctl bootout "gui/$(id -u)/com.ccchrome.bridge" >/dev/null 2>&1 || true
  else
    systemctl --user disable --now ccchrome-bridge.service >/dev/null 2>&1 || true
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
}
