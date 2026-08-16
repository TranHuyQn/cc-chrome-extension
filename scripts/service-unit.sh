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
    # XDG_CONFIG_HOME, not a hardcoded ~/.config: systemd --user reads
    # $XDG_CONFIG_HOME/systemd/user and only falls back to ~/.config when the
    # variable is unset. Writing to ~/.config regardless put the unit somewhere
    # systemd never looks for anyone who sets that variable, so `systemctl
    # --user enable` failed with "Unit not found" and install.sh's warn-and-
    # continue left them with no service at all and no obvious cause.
    echo "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/ccchrome-bridge.service"
  fi
}

# Numeric systemd version (e.g. 245), or 0 when it cannot be determined.
# `systemctl --version` prints "systemd 245 (245.4-4ubuntu3...)" on the first
# line; anything unparseable is reported as 0 so callers take the conservative
# branch rather than assuming a modern systemd.
cc_systemd_version() {
  local v
  v="$(systemctl --version 2>/dev/null | head -1 | awk '{print $2}')"
  case "$v" in
    ''|*[!0-9]*) echo 0 ;;
    *) echo "$v" ;;
  esac
}

# Where this platform's install actually writes the bridge's stderr, as a
# sentence the user can act on. Lives here because it depends on the same
# branch cc_write_unit takes, and install.sh/uninstall.sh must not guess.
cc_log_hint() {
  local dir="$1"
  if [ "$(cc_platform)" = macos ] || [ "$(cc_systemd_version)" -ge 240 ]; then
    echo "$dir/logs/bridge.err.log"
  else
    echo "journalctl --user -u ccchrome-bridge -e"
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
#
# - `claude` gets the same treatment as `node`, for the same reason and one
#   step later: the side panel spawns it once per chat turn, and a service's
#   PATH does not include a package manager's bin directory. Measured on
#   macOS: launchd gives this process PATH=/usr/bin:/bin:/usr/sbin:/sbin while
#   claude sits in /opt/homebrew/bin, so every panel turn failed with
#   "spawn claude ENOENT" until the path was baked in here. Left unset when
#   claude is not installed yet — server/agent.js then falls back to the bare
#   name, and its ENOENT message tells the user to install the CLI and re-run
#   this installer.
#
#   An inherited CC_CHROME_CLAUDE_BIN wins over the `command -v` lookup, and
#   the in-panel update path is why. That update runs this script from a child
#   of the bridge, which launchd/systemd started with the OS default PATH —
#   measured on the owner's machine: PATH=/usr/bin:/bin:/usr/sbin:/sbin, where
#   `command -v claude` finds nothing. Regenerating the unit from that lookup
#   would silently DROP the value the original install found, the update would
#   still be declared a success (the new /health answers) and the backup
#   deleted, and every panel turn from the next start on would fail with
#   "spawn claude ENOENT". The bridge's own environment carries
#   CC_CHROME_CLAUDE_BIN — this unit is what put it there — so preferring it
#   keeps an update from losing what an install already got right. A user with
#   the variable exported in their shell likewise gets the binary they named.
cc_write_unit() {
  local dir="$1" port="$2" unit label claude_bin
  unit="$(cc_unit_path)"; label="$(cc_unit_label)"
  claude_bin="${CC_CHROME_CLAUDE_BIN:-$(command -v claude || true)}"
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
$([ -n "$claude_bin" ] && printf '    <key>CC_CHROME_CLAUDE_BIN</key><string>%s</string>' "$claude_bin")
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${dir}/logs/bridge.log</string>
  <key>StandardErrorPath</key><string>${dir}/logs/bridge.err.log</string>
</dict>
</plist>
PLIST
  else
    # `append:` is systemd 240+ (Dec 2018). An older systemd does not fail
    # softly on it: it refuses to load the whole unit, so the bridge silently
    # never starts on e.g. Ubuntu 18.04 (237). Below that, drop the two lines
    # and let output go to the journal, which every version has — cc_log_hint
    # tells the user which of the two applies to their machine so the
    # "where are the logs" answer is never wrong.
    local logging=""
    if [ "$(cc_systemd_version)" -ge 240 ]; then
      logging="StandardOutput=append:${dir}/logs/bridge.log
StandardError=append:${dir}/logs/bridge.err.log"
    fi
    cat > "$unit" <<UNIT
[Unit]
Description=Claude Code Chrome Bridge
After=default.target

[Service]
ExecStart="$(command -v node)" "${dir}/server/index.js" --http
Environment="CC_CHROME_HOST=127.0.0.1"
Environment="CC_CHROME_PORT=${port}"
Environment="CC_CHROME_TOKENS_FILE=${dir}/tokens.json"
$([ -n "$claude_bin" ] && printf 'Environment="CC_CHROME_CLAUDE_BIN=%s"' "$claude_bin")
Restart=always
RestartSec=3
${logging}

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
