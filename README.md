*[Tiếng Việt](README.vi.md)*

# Claude Code Chrome Bridge

**Claude in Chrome, powered by the `claude` CLI already on your machine.**

Two ways to use it:

- **A side panel you chat with while you browse** — type into Chrome, no terminal open.
- **An MCP server that lets Claude Code drive the browser** — 22 tools, from `navigate` and
  `read_page` to `javascript_eval` and `read_network_requests`.

Both run through one local bridge on `127.0.0.1`. There is no intermediary server, and no claude.ai
login anywhere in the picture.

## Why this exists

Claude Code's own documentation says the official Chrome integration is closed to a whole class of
users — [code.claude.com/docs/en/chrome](https://code.claude.com/docs/en/chrome):

> If you authenticate with an API key or a long-lived token from `claude setup-token`, Claude Code
> keeps Chrome integration off, even when you pass `--chrome`, because the browser extension can't
> authenticate with those credentials.

This project fills that gap from the other side. The side panel does not call the Anthropic API
itself — it spawns the **local `claude` CLI**, so whatever authenticates that CLI works: an API key,
or a Pro/Max subscription. Your own hooks and project settings come along with it. **No API key is
ever stored in the browser.**

### What is different about it

- **It never takes focus.** The original Claude in Chrome extension activates the tab and raises the
  window on essentially every tool call ([#39696](https://github.com/anthropics/claude-code/issues/39696),
  [#39707](https://github.com/anthropics/claude-code/issues/39707),
  [#31119](https://github.com/anthropics/claude-code/issues/31119)). This one deliberately does not,
  and `test/focus.test.mjs` sweeps **every** handler to keep it that way — a new handler that is not
  covered by the sweep fails the suite.
- **Tab-group isolation.** Each session gets its own Chrome tab group. Tools only act on tabs inside
  that group — never the tab you are reading. Dragging one of your tabs into the group is how you
  grant access to it.
- **Everything is local.** The bridge listens on `127.0.0.1`, installs into your home directory, and
  needs no root/administrator rights on any of the three platforms.

> Versions `2.x` / `3.x` appear in the git history but were internal only and were never published —
> do not go looking for them on GitHub Releases. The current release is **1.1.0**.

Two things worth knowing up front:

- `navigate` **refuses** to send a tab to `chrome:`, `chrome-extension:`, `devtools:`, `edge:` or any
  `about:` other than `about:blank`. Earlier internal builds could park a tab on `chrome://…`; this
  one cannot.
- The background service records the **absolute path** to `node` at install time, not a bare `node`.
  Switching Node versions with nvm/volta/fnm afterwards makes that path disappear — the service then
  crash-loops silently, with nothing announcing why. Re-run the install command in
  [Installation](#installation) (`/ccchrome install` prints exactly that command) to record the new
  `node` path.

## Architecture

```
Claude Code ──(MCP / Streamable HTTP + Bearer token, 127.0.0.1)──► MCP server (Node.js, background service)
                                                                              │
                                                        (WebSocket ws://127.0.0.1:<port>/ws?token=...)
                                                                              ▼
                                                                    Chrome Extension (MV3)
                                                                              │
                                                              chrome.tabs / chrome.scripting
                                                              chrome.debugger (CDP)
```

- **`extension/`** — the Chrome extension (Manifest V3). Its service worker connects to the MCP
  server over WebSocket at `ws://127.0.0.1:8787/ws`, reconnects on its own, and executes the browser
  commands.
- **`server/`** — the MCP server (Node.js ≥ 18). It runs as a **background service** (LaunchAgent on
  macOS, `systemd --user` on Linux, a scheduled task on Windows) rather than as a child process of
  `claude` — installed by `scripts/install.sh`, and it comes back up with the machine. Claude Code
  talks to it over MCP Streamable HTTP with a Bearer token, on the same port the extension uses for
  its WebSocket; each tool call is forwarded to the extension and the result comes back.

The bridge listens only on `127.0.0.1` — nothing is sent anywhere else, no Anthropic account is
needed inside the browser, and there is nothing exposed to the network. Everyone runs their own
bridge; there is no shared machine, no VPS, no domain and no pairing secret.

## Installation

Requirements: Node.js ≥ 18 and Google Chrome (or Chromium) already installed. No root needed — the
script only writes inside your home directory.

### 1. One command

**macOS / Linux:**

```bash
curl -fsSL https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/install.sh | bash
```

**Windows** (an ordinary PowerShell window — **no** "Run as administrator"):

```powershell
irm https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/install.ps1 -OutFile "$env:TEMP\install.ps1"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\install.ps1"
```

> **Two lines, not `irm … | iex`, and this is not optional.** `install.ps1` starts with a UTF-8 BOM,
> because without one Windows PowerShell 5.1 reads the file as ANSI, which mangles every Vietnamese
> string badly enough that the file no longer parses. But `| iex` feeds that same BOM into the parser
> as an ordinary character — `The term 'ï»¿#' is not recognized`. On top of that, `irm` decodes
> GitHub's asset (`application/octet-stream`) as ISO-8859-1, so accented characters break even
> without a BOM. `-OutFile` writes the raw bytes and `-File` reads them correctly — and that is also
> the path CI exercises on every push.

> **Windows has been verified end to end on real hardware** (Windows 11, PowerShell 5.1): install
> **without admin rights**, the bridge comes up and `/health` answers, the extension connects,
> browser tools work, the side panel chat replies, **after a reboot the service starts by itself and
> the extension reconnects**, and **uninstall is clean in a single run** — the task is gone, the
> process count is zero, the port is released. All three platforms have now been run for real.

That command downloads and runs a script straight from GitHub Releases — know that before you run it.
To read it first, split it into two steps:

```bash
curl -fsSL https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/install.sh -o install.sh
less install.sh        # read before running
bash install.sh
```

```powershell
irm https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/install.ps1 -OutFile install.ps1
notepad install.ps1    # read before running
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The script does the rest: downloads the release payload (`server/` + `extension/` source with
`node_modules` already bundled, so you never run `npm install` yourself), generates a token, installs
a **background service** that starts with your machine and runs the bridge at
`http://127.0.0.1:8787`, and registers the MCP server named `chrome` with Claude Code
(`claude mcp add --scope user --transport http chrome ...`).

That background service belongs to **your account** and starts **when you log in**, on all three
operating systems — LaunchAgent (macOS), `systemd --user` (Linux), a scheduled task with an "At log
on" trigger (Windows). None of them runs before login, and none needs to: Chrome only exists after
you have logged in.

> **WSL is not supported.** Chrome runs on the Windows host while the bridge would live inside WSL —
> two different sides of a network boundary — and `systemctl --user` is often unavailable in WSL.
> Install with `install.ps1` on Windows itself.

Running the same command again on a machine that already has it installed: the script recognises this
as an **upgrade**, keeps the existing token (so you do not have to paste the URL into the extension
again), replaces only the source under `~/.cc-chrome-bridge/` and restarts the background service
(the server half).

> ⚠️ **The script does NOT update the extension already running in Chrome.** It overwrites
> `~/.cc-chrome-bridge/extension` on disk, but Chrome keeps running the old Load-unpacked code until
> you click **Reload** on the extension card at `chrome://extensions` — Chrome does not re-read the
> directory on its own. Skipping this means you are **silently still running the old extension**,
> even with a new server: if the old build is missing a security fix (such as the two `navigate` /
> `javascript_eval` guards added in a newer build, see [Security notes](#security-notes)), you are
> still missing it until you reload. Always go to `chrome://extensions` and click **Reload** on
> "Claude Code Chrome Bridge" after re-running the install command.

### 1b. Exactly what the script touches

No root, nothing outside your home directory. The complete list:

**macOS / Linux** (`install.sh`):

| Path | Contents | Mode |
|---|---|---|
| `~/.cc-chrome-bridge/` | `server/` (with `node_modules`), `extension/`, `logs/`, `tokens.json`, `uninstall.sh`, `service-unit.sh`, `ccchrome.md`, `update-runner.mjs`, `install.sh`, `install.ps1` | `700` |
| `~/.ccchrome.json` | `{ "token": "…", "port": 8787 }` | `600` |
| `~/Library/LaunchAgents/com.ccchrome.bridge.plist` (macOS)<br>`$XDG_CONFIG_HOME/systemd/user/ccchrome-bridge.service` (Linux) | the background service file | |
| `~/.claude/commands/ccchrome.md` | the `/ccchrome` slash command | |
| `~/.claude.json` | adds an MCP server named `chrome` (via `claude mcp add`) | |

**Windows** (`install.ps1`) — same layout, different home for the service file and a different way of
setting permissions:

| Path | Contents |
|---|---|
| `%USERPROFILE%\.cc-chrome-bridge\` | `server\`, `extension\`, `logs\`, `tokens.json`, `uninstall.ps1`, `service-task.ps1`, `ccchrome.md`, `update-runner.mjs`, `install.sh`, `install.ps1`, plus `bridge.cmd` and `bridge-launcher.vbs` |
| `%USERPROFILE%\.ccchrome.json` | `{ "token": "…", "port": 8787 }` |
| A scheduled task named `ccchrome-bridge` | trigger **At log on**, runs as your own account, `RunLevel Limited` — **no admin rights required** |
| `%USERPROFILE%\.claude\commands\ccchrome.md` | the `/ccchrome` slash command |
| `%USERPROFILE%\.claude.json` | adds an MCP server named `chrome` |

Windows has no `chmod`, so the two files holding the token are tightened with
`icacls <file> /inheritance:r /grant:r "<you>:F"` — drop every inherited ACE, then grant your own
account back. That is the local equivalent of `chmod 600`.

Two helper files exist only on Windows: `bridge.cmd` holds the environment variables and redirects the
logs (Task Scheduler can do neither), and `bridge-launcher.vbs` is a one-liner that calls `bridge.cmd`
with the window hidden — without it, `node.exe` leaves a black console window open for the whole
session.

Seven steps, in the order the script runs them:

1. **Check Node ≥ 18**; stop if it is missing, before downloading anything.
2. **Download the release payload** to a temp directory, extract it into `~/.cc-chrome-bridge/.new`
   and verify the files are all there (`node_modules` in particular) — **before** touching the
   installed copy. A broken download leaves the old install intact.
3. **Stop the running service** (if any) — only after step 2 has a replacement ready.
4. **Rename `.new` into place.** Same volume, so it is an instant rename, not a copy.
5. **Token.** On an upgrade, keep the existing token (no re-pasting the URL); on a fresh install,
   generate 16 random bytes with `crypto.randomBytes`. Write `~/.ccchrome.json` and `tokens.json`,
   both `chmod 600`. **`tokens.json` is overwritten, not merged** — that is exactly how old tokens
   get revoked.
6. **Write the service file** with **absolute paths** to `node` and `claude` (a background service
   does not have your terminal's `PATH`) and `CC_CHROME_HOST=127.0.0.1` hard-coded, then load it and
   wait up to 20 seconds for `/health`.
7. **Register the MCP server** with Claude Code and copy the slash command.

To remove all of the above:

```bash
bash ~/.cc-chrome-bridge/uninstall.sh                                              # macOS / Linux
```
```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.cc-chrome-bridge\uninstall.ps1"
```

Both deliberately **keep `panel/`** — that is the side panel's conversation history, your data, not
something the script created.

### 1c. Manual install, without running the script

If you would rather not run someone else's script, here is everything it does, as commands you type
yourself:

```bash
# 1. Get the payload (or git clone the repo, then cd server && npm install)
mkdir -p ~/.cc-chrome-bridge/logs && chmod 700 ~/.cc-chrome-bridge
curl -fsSL https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/cc-chrome-bridge.tar.gz \
  | tar -xz -C ~/.cc-chrome-bridge

# 2. Generate a token and write the two config files
TOKEN=$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))')
printf '{"token":"%s","port":8787}\n' "$TOKEN" > ~/.ccchrome.json
printf '{"%s":"local"}\n' "$TOKEN" > ~/.cc-chrome-bridge/tokens.json
chmod 600 ~/.ccchrome.json ~/.cc-chrome-bridge/tokens.json

# 3. Try it right here in the terminal — no service needed yet
CC_CHROME_HOST=127.0.0.1 CC_CHROME_PORT=8787 \
CC_CHROME_TOKENS_FILE="$HOME/.cc-chrome-bridge/tokens.json" \
CC_CHROME_CLAUDE_BIN="$(command -v claude)" \
node ~/.cc-chrome-bridge/server/index.js --http

# 4. Register with Claude Code (another terminal)
claude mcp add --scope user --transport http chrome \
  http://127.0.0.1:8787/mcp --header "Authorization: Bearer $TOKEN"

# 5. To have it start in the background at login, use the helper shipped in the payload
bash -c 'source ~/.cc-chrome-bridge/service-unit.sh \
  && cc_write_unit "$HOME/.cc-chrome-bridge" 8787 && cc_service_start'

# 6. The /ccchrome slash command (optional)
mkdir -p ~/.claude/commands && cp ~/.cc-chrome-bridge/ccchrome.md ~/.claude/commands/
```

The Windows version, the same steps in PowerShell:

```powershell
# 1. Get the payload
$Dir = "$env:USERPROFILE\.cc-chrome-bridge"
New-Item -ItemType Directory -Force -Path "$Dir\logs" | Out-Null
irm https://github.com/TranHuyQn/cc-chrome-extension/releases/latest/download/cc-chrome-bridge.tar.gz -OutFile "$env:TEMP\cc.tgz"
tar -xzf "$env:TEMP\cc.tgz" -C $Dir

# 2. Generate a token (.NET RNG — do not use `node -e` with double quotes here,
#    PowerShell 5.1 eats the quotes when passing them to a native command)
$bytes = New-Object byte[] 16
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$Token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
"{`"token`":`"$Token`",`"port`":8787}" | Set-Content "$env:USERPROFILE\.ccchrome.json" -Encoding ASCII
"{`"$Token`":`"local`"}"              | Set-Content "$Dir\tokens.json" -Encoding ASCII
icacls "$env:USERPROFILE\.ccchrome.json" /inheritance:r /grant:r "${env:USERNAME}:F" | Out-Null
icacls "$Dir\tokens.json"              /inheritance:r /grant:r "${env:USERNAME}:F" | Out-Null

# 3. Try it right here in this window
$env:CC_CHROME_HOST = "127.0.0.1"; $env:CC_CHROME_PORT = "8787"
$env:CC_CHROME_TOKENS_FILE = "$Dir\tokens.json"
$env:CC_CHROME_CLAUDE_BIN = (Get-Command claude).Source
node "$Dir\server\index.js" --http

# 4. Register with Claude Code (another window)
claude mcp add --scope user --transport http chrome http://127.0.0.1:8787/mcp --header "Authorization: Bearer $Token"

# 5. To have it start in the background at login
. "$Dir\service-task.ps1"
Write-CcLauncher -InstallDir $Dir -Port 8787
Register-CcTask -InstallDir $Dir
Start-CcTask

# 6. The /ccchrome slash command (optional)
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.claude\commands" | Out-Null
Copy-Item "$Dir\ccchrome.md" "$env:USERPROFILE\.claude\commands\"
```

After that there are still two things to do inside Chrome, in the section right below. The URL you
need to paste is `ws://127.0.0.1:8787/ws?token=<the token you just generated>` — read it back with
`cat ~/.ccchrome.json` (macOS/Linux) or `Get-Content "$env:USERPROFILE\.ccchrome.json"` (Windows) if
you forget it.

### 2. Two things you have to do yourself in Chrome

The script cannot do these — Chrome does not let a script install an extension on your behalf:

1. Open `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick the
   `~/.cc-chrome-bridge/extension` directory (the script printed the exact path in the previous
   step).
2. Click the "Claude Code Chrome Bridge" extension icon → paste the URL the script printed (of the
   form `ws://127.0.0.1:8787/ws?token=...`) into the "Địa chỉ MCP server" (MCP server address) field →
   **Lưu & kết nối lại** (Save & reconnect).

The badge turning green with `on` means you are done. Open the side panel with the "Mở khung chat"
(Open chat panel) button in the popup if you want to type directly without a terminal — see
[Side panel chat](#side-panel-chat).

> The extension UI (popup, side panel buttons) is currently in Vietnamese. English translations are
> given in parentheses throughout this README.

### 3. Using it

Start a new `claude` session (the MCP server is already registered, and there is nothing extra to
start — the background service has been running since install). Ask for what you want in plain
language, e.g. *"open github.com and take a screenshot"*, *"read the current page and fill in the
signup form"*.

To check the connection from inside Claude Code: type `/mcp` → pick `chrome` → look at the tools, or
ask Claude to call the `chrome_status` tool. Outside Claude Code, run `/ccchrome status` (the slash
command the script just installed) to see whether the bridge is alive and whether the extension is
connected.

### Uninstall

```bash
bash ~/.cc-chrome-bridge/uninstall.sh
```

On Windows:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.cc-chrome-bridge\uninstall.ps1"
```

To preview what would be deleted without touching a file: `bash ~/.cc-chrome-bridge/uninstall.sh --dry-run`
(the `.ps1` version has no `--dry-run` yet).

The script stops the background service, unregisters the `chrome` MCP server, and deletes the token
and the source under `~/.cc-chrome-bridge/`. Two things it does **not** touch, and says so when it
finishes:

- **The extension inside Chrome** — Chrome does not let a script remove an extension. Go to
  `chrome://extensions` yourself → find "Claude Code Chrome Bridge" → **Remove**.
- **`~/.cc-chrome-bridge/panel`** — the side panel's conversation history. It is not something
  `install.sh` created, so `uninstall.sh` keeps it on purpose. To delete it too:
  `rm -rf ~/.cc-chrome-bridge/panel`.

### When something goes wrong

- **Logs**: `~/.cc-chrome-bridge/logs/bridge.err.log` (errors) and `bridge.log` (normal output). Or
  type `/ccchrome logs` in Claude Code.
- **Restart the service**: `/ccchrome restart`, or by hand (if you installed via `curl` you do not
  have the repo's `scripts/` directory on your machine — the installed file lives at
  `~/.cc-chrome-bridge/service-unit.sh`):
  ```bash
  bash -c 'source "$HOME/.cc-chrome-bridge/service-unit.sh" && cc_service_stop && cc_service_start'
  ```
- **Switching Node versions (nvm/volta/fnm)**: the service records the absolute path to `node` at
  install time, so changing Node version afterwards makes the service crash-loop silently. Re-run the
  install command from section 1 to record the current `node` path.
- **On Windows**: check whether the service is alive with
  ```powershell
  Get-ScheduledTask ccchrome-bridge | Select-Object State
  ```
  `State` must be **Running**. If it says `Ready`, the bridge is not running. Restart it by loading
  the installed helper and calling its function — the Windows counterpart of the `service-unit.sh`
  line above:
  ```powershell
  . "$env:USERPROFILE\.cc-chrome-bridge\service-task.ps1"
  Restart-CcTask
  ```
  Read the log at `%USERPROFILE%\.cc-chrome-bridge\logs\bridge.err.log`.

  Do **not** restart with `Stop-ScheduledTask ccchrome-bridge; Start-ScheduledTask ccchrome-bridge`.
  It fails silently: `Stop-ScheduledTask` only ends the *task* (wscript), while `node.exe` — its
  grandchild — keeps running, keeps port 8787, and keeps serving from the configuration it loaded at
  startup even after the files on disk have been fixed. `Restart-CcTask` kills the real process and
  re-enables the task before starting it.
- **On Linux, the service does not come back after a reboot**: `systemd --user` needs a real login
  session. If you installed over ssh, or you do not log into a graphical session, run
  `sudo loginctl enable-linger $USER` and reinstall. On machines with systemd older than 240 (Ubuntu
  18.04, for example) the logs do not go to a file but to the journal — read them with
  `journalctl --user -u ccchrome-bridge -e`; the install script prints the right place to look for
  your machine.

## Tools available to Claude Code

| Group | Tool | What it does |
|---|---|---|
| Navigation | `navigate` | Open a URL / back / forward / reload, waiting for the page to finish loading |
| Reading | `read_page` | Page structure + interactive elements (with a numeric `ref` for click/fill) |
| | `get_page_text` | All visible text on the page |
| | `find` | Search for text on the page; returns context plus refs of clickable elements |
| Interaction | `click`, `fill`, `fill_form` | Click / fill a form by `ref` or CSS selector (fires proper events, works with React/Vue) |
| | `press_key`, `type_text` | Real keystrokes via the debugger API (Enter, Tab, shortcuts, typing text) |
| | `scroll`, `wait_for` | Scroll the page, wait for an element to appear |
| | `upload_file` | Attach a file to an `<input type=file>` |
| Observation | `take_screenshot` | Capture a PNG of the viewport or the full page |
| | `javascript_eval` | Run JavaScript in the page and return the result |
| | `read_console_messages` | Read console log/warn/error plus exceptions |
| | `read_network_requests` | Read network requests (URL, status, size, errors) |
| Tabs/windows | `list_tabs`, `new_tab`, `close_tab`, `switch_tab`, `resize_window` | Manage tabs and windows |
| Other | `chrome_status` | Check whether the extension is connected |

## Per-session tab groups

**Upgrading:** reinstall the extension — see the note in [Installation](#installation); an older
extension paired with a newer server still runs, but without isolation.

Every Claude Code session (every `claude` run, or every MCP connection in `--http` mode) gets **its
own tab group** in Chrome, named `Claude · xxxx` (the first 4 characters of the session id) and
coloured orange so it stands out from your personal tabs.

While Claude is working, the edge of that tab's viewport glows a soft orange — strongest at the edge,
fading inwards, with no hard border. It disappears roughly 30 seconds after Claude stops touching the
tab, so no glow means nothing is running on that tab. The glow is drawn by the extension on top of
the page; it is not a rendering bug of the website, it does not take mouse input, and it does not
appear in `take_screenshot` images. A few pages the extension cannot inject into (`chrome://`, the
PDF viewer, a blank `about:blank` tab) will not show it.

- A tab opened by `navigate` (without a `tabId`) or by `new_tab` **automatically joins that session's
  group** — it no longer commandeers the tab in front of you the way it used to.
- That tab opens **in the background and does not steal your focus** — Chrome does not jump to that
  tab or that window; you keep working on the tab you are looking at while Claude works in its own.
  Call `switch_tab` when you want to look at it.
- **No tool raises the Chrome window in front of the application you are using.** Not even
  `switch_tab`: it only changes the visible tab *inside* the window that already holds it, so when
  you come back to Chrome you see the tab Claude wanted to show you, while typing in a terminal or
  editor is never interrupted. `test/focus.test.mjs` runs **every** handler and fails immediately if
  any tool activates your tab or calls `chrome.windows.update({focused:true})`.
- **Every tool can only act on tabs inside its own session's group.** Calling a tool with the `tabId`
  of a tab outside the group is refused, with the group name and what to do about it (drag the tab
  into the group, or open a new one with `new_tab`).
- **Dragging one of your tabs into the group is how you grant Claude read/write access to it** —
  exactly the way the official Claude for Chrome extension works: the group is the boundary of what
  Claude can see.
- `list_tabs` only lists tabs in its own session's group, not every tab open in Chrome.
- Chrome does not allow an empty tab group to exist, so **the group only appears after Claude opens
  its first tab** in that session (via `navigate` or `new_tab`). Before that there is no group to
  drag a tab into.
- The extension needs the `tabGroups` permission (already in `extension/manifest.json`) to create and
  manage these groups.

### Two things to know before you use it

**Old groups are not cleaned up.** The session id changes every time you run `claude` again, and in
`--http` mode it also changes after an MCP session idles out. The old session's group stays in Chrome
but is now **orphaned**: no live session owns it, so Claude cannot act on the tabs inside it (they
are refused like any out-of-group tab) and `list_tabs` does not see them. The extension does not close
them — close them by hand when the orange groups pile up. This is by design, not a bug.

**`resize_window` affects the whole window, not just the tabs in the group.** It finds a tab in the
session's group and resizes **the window containing that tab** — and that window may also contain your
own personal tabs. The group boundary is **per tab**, not per window: Claude cannot read or click a
tab outside the group, but it can still resize the window those tabs are in. If you want real
separation, keep Claude's group in a window of its own.

## Side panel chat

The extension has a chat panel embedded directly in Chrome (the side panel) — type into it instead of
opening a terminal and running `claude`. For each chat turn the server spawns a fresh `claude`
process (headless, `--tools ""`, with only the `mcp__chrome` tools) and streams the result back to
the panel over a separate WebSocket (`/panel`, distinct from the `/ws` the extension uses).

The panel shows progress in real time: each browser tool Claude calls gets its own row, opened the
moment it decides to call it, and closed with a ✓ or ✗ plus how long it took. Click a row to see the
arguments and the result (the result is truncated on the server). The status line just above the
input box always says which phase you are in — sending the request, thinking, running which tool,
replying — along with a running second count.

The language of those activity descriptions follows the language you type in: message in Vietnamese
and it says "Đang suy nghĩ", message in English and it says "Thinking". The buttons stay in
Vietnamese.

Close the panel and reopen it and everything you exchanged is still there. Only "Phiên mới" (New
session) clears it.

### Turning the panel on

Installing with `install.sh` (or `install.ps1`) means it is **already on** — the bridge run by the
background service binds `127.0.0.1` by default (see [Installation](#installation)), and that is the
only condition the panel needs beyond a live bridge. There is no separate enable step: install, paste
the URL into the extension popup as usual (step 2 in Installation), then click the extension icon →
**Mở khung chat** (Open chat panel).

The panel **only turns on when the bridge binds `127.0.0.1`** — that is intentional, not a temporary
limitation; see [Security notes](#security-notes). If you run the bridge by hand with
`CC_CHROME_HOST` set to something other than `127.0.0.1`/`::1`, the panel is off entirely — there is
no flag that turns it back on, see "What the panel cannot do".

### What the panel cannot do

Stated plainly, so there is no misunderstanding:

- **Claude does not see the tab you are looking at.** It can only act on tabs inside the panel
  session's own tab group (like every other session — see
  [Per-session tab groups](#per-session-tab-groups)). To have it work on the page you have open,
  click **Đưa tab này vào phiên** (Add this tab to the session) inside the panel.
- **The panel agent cannot read or write any file on your machine** — it runs with `--tools ""`, so
  it has only the browser-control tools (`mcp__chrome`).
- **The panel agent does not see any of your plugins or cross-project memory** — the `claude`
  process the server spawns for each chat turn runs with `--setting-sources project`, which removes
  user-level configuration (`~/.claude/settings.json`) from the session entirely. This is deliberate:
  without that flag, a globally enabled plugin (say a memory plugin running through a `SessionStart`
  hook) would load memories from **every other project** into the panel session, even right after you
  pressed "Phiên mới" — the log on screen is empty but the model still remembers work from another
  project, because that memory never came from the conversation. The panel is isolated from user
  configuration to match the original Claude for Chrome extension (which keeps nothing between
  sessions) and Claude's own memory feature (which is siloed per project).
- **The server does not store any conversation content** — but the history does exist on this
  machine, in the `claude` CLI's own session files under `~/.cc-chrome-bridge/panel` (see Operations
  below), and it **survives closing and reopening the panel** — reopening continues the same
  conversation rather than starting a new one. Only **Phiên mới** (New session) really starts a blank
  conversation; the old one stays on disk, and nothing cleans it up. **But "Phiên mới" does not change
  the tab group**: the group is tied to the panel (per window), not to the conversation — so every
  tab you previously "added to the session" is still in the group and the new conversation can still
  act on them. To cut that off, drag the tabs out of the group or close them. For the same reason,
  losing the connection and reconnecting (or restarting the bridge) does not lose the tab group: the
  panel remembers and re-declares the same group.
- **It only works against a bridge running on your own machine** — which is exactly what
  `install.sh` gives you by default. The server refuses `/panel` (closing the socket with code 4004)
  unless **all three** conditions hold: (1) the bridge binds loopback (`127.0.0.1`/`::1`), (2) the
  connection comes from that same machine — the socket's peer address is loopback, (3) the request
  carries **no** `X-Forwarded-For`, `X-Forwarded-Proto` or `X-Forwarded-Host` header. Those headers
  mean a reverse proxy is in front, and a proxy connects on someone else's behalf — the peer address
  is then the proxy's (loopback), not the real caller's. In other words: put the bridge behind a
  TLS-terminating reverse proxy and it binds loopback but still does **not** enable the panel — and
  that is the intent, because behind `/panel` is a `claude` process running on that machine under the
  logged-in account. No environment variable turns it back on: a switch that can be flipped is a
  switch someone will flip.

### If the panel feels slow

Each chat turn spawns a fresh `claude` process — that is the inherent cost of the spawn-per-turn
architecture (CLI startup, loading MCP servers, and so on), not a network problem or a model problem.

**It is no longer caused by a `SessionStart` hook.** The process is spawned with
`--setting-sources project` (see the section just above), so user-level **plugins** — and any hook
that runs through one — are no longer loaded into the panel session. This was re-measured
empirically: before the flag, each turn's `system:init` reported a non-empty `plugins` field and a
real `SessionStart` hook (one that writes a side-effect file to disk) ran on every turn; after the
flag, `plugins: []` and that hook no longer ran — same machine, same `~/.claude/settings.json`.

**Your own hooks do still run** (since 1.0.9). The panel forwards the `hooks` block of your
`~/.claude/settings.json` into each spawned process through a generated `--settings` file that
contains only `hooks` and never `enabledPlugins`, so a usage tracker or a notifier of yours keeps
working. `SessionStart` and `SessionEnd` are dropped on purpose: the panel spawns **one process per
turn**, so forwarding those two would record an entire session for every message you type.

### Operations

`~/.cc-chrome-bridge/panel` is the working directory of every `claude` process spawned for the panel,
so it accumulates that CLI's session history over time — nothing prunes it today; delete it by hand
if it grows.

The panel has one environment variable of its own: `CC_CHROME_PANEL_TOOLS` — see the
[Configuration](#configuration) table.

### Updating the bridge

Every time you open the panel, the bridge asks GitHub whether there is a release newer than the one
running. The answer is **cached for 30 minutes** (so it does not re-ask GitHub every time you open or
close the panel, or lose and regain the connection) — which means a new release can take up to half an
hour to show up in the panel. When there is one, a line appears at the top of the panel ("Có bản x.y.z
(đang chạy a.b.c)." — version x.y.z is available, you are running a.b.c) with an **Cập nhật** (Update)
button. The bridge **installs nothing on its own** unless you press that button.

Press **Cập nhật** and the bridge downloads the new release's `.tar.gz` and **checks its SHA256**
against the checksum file GitHub publishes with that release, before touching anything on your
machine — a corrupt, truncated or tampered download is stopped right there. If it passes, the bridge
backs up the running version, installs the new one over it, restarts the background service, and then
checks whether the new version came back up. **If the new bridge cannot start, it restores the old
one** — copying the backup back wholesale, and if the background service happens not to be running at
that point it starts the service too, then waits for `/health` to answer to be sure the bridge is
alive again.

A few cases still need hands: the restart step above also failing, no backup to restore from
(`failed-no-backup`), the updater hitting an error mid-way (`crashed`), or an earlier update having
stopped halfway and left `~/.cc-chrome-bridge.bak` behind (`already-running`). All four write their
reason into `~/.ccchrome-update.json`. For the first case the panel says so directly ("Chưa khởi động
lại được dịch vụ nền (…)" — could not restart the background service), but if the bridge is not up the
panel cannot open to show you that line — so if the panel goes dark and does not come back after a few
minutes, re-run the install command in [Installation](#installation) (it installs over the top, keeps
the token, and rebuilds the background service). To see what happened:
`~/.ccchrome-update.json` is the result of the last update, `~/.ccchrome-update.log` is the installer's
full output, and the old version (if the restore did not finish) is at `~/.cc-chrome-bridge.bak`.

After a successful install, the panel says "Đã cài x.y.z. Nạp lại extension để dùng giao diện mới."
(x.y.z installed. Reload the extension to use the new UI.) with a **Nạp lại extension** (Reload
extension) button — **you have to press it** for Chrome to reload the new UI (popup, panel, …); the
bridge itself is on the new version immediately after the install step, but the extension in Chrome
keeps the old code in memory until it is reloaded.

The whole process only runs when you press the button in the panel, on this machine — Claude (the
agent) has no way to trigger an update itself.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CC_CHROME_PORT` | `8787` | HTTP server port (both Streamable HTTP for Claude Code and the extension's WebSocket go through it). **For a background service installed by `install.sh` this is NOT read at runtime** — `install.sh` reads `CC_CHROME_PORT` from your shell once, at install time, and writes that number (as a literal, not a variable name) into the service file (`scripts/service-unit.sh`). `export CC_CHROME_PORT=...` **after** installing does not change the port of the running service — you must `export` the new value and re-run the install command in [Installation](#installation) (or edit the service file yourself) to change the port. |
| `CC_CHROME_HOST` | `127.0.0.1` | Bind address. **For a background service installed by `install.sh` this variable does nothing at all** — unlike `CC_CHROME_PORT`, `install.sh` does not read `CC_CHROME_HOST` from the environment: `scripts/service-unit.sh` hard-codes `127.0.0.1` into the service file and does not parameterise it. You can only change the host by running `node server/index.js --http` by hand or by editing the service file yourself. It still matters, because `AGENT_ENABLED` (which turns the side panel chat on) is computed directly from the host value at runtime: binding to something other than `127.0.0.1`/`::1` **silently turns the panel off**, with no warning log other than this table entry. |
| `CC_CHROME_TOKENS` | — | Static tokens: `token1=name1,token2=name2`. `install.sh` uses `CC_CHROME_TOKENS_FILE` (below) instead of this. |
| `CC_CHROME_TOKENS_FILE` | — | Alternative: a JSON file `{"token": "name"}`. `install.sh` writes the token it generates to `~/.cc-chrome-bridge/tokens.json` and points the background service at it. |
| `CC_CHROME_TIMEOUT_MS` | `45000` | Timeout for each command sent to the extension. |
| `CC_CHROME_SESSION_TTL_MS` | `28800000` (8 hours) | An MCP session idle for longer than this is closed and cleaned up. |
| `CC_CHROME_RECONNECT_GRACE_MS` | `25000` | While the extension is not connected, each command **waits** this long before reporting an error. Chrome kills the extension's service worker when the Chrome window is in the background (closing the socket with code 1001) and an alarm brings it back within about 30 seconds — this grace window makes commands slow rather than broken. Must be smaller than `CC_CHROME_TIMEOUT_MS`. |
| `CC_CHROME_PANEL_TOOLS` | `mcp__chrome` | The list of MCP tools (passed straight into Claude Code's `--allowedTools` flag) the side panel agent may call. Unrelated to the `--tools` flag — that one is hard-locked to `""` to disable every built-in tool (file read/write, …); this variable only picks among the remaining MCP tools (by default just the `mcp__chrome` group), and does not re-open file access. Only has an effect when the panel is on (see [Side panel chat](#side-panel-chat)). |
| `CC_CHROME_EXTENSION_ID` | — | Accept exactly one extension ID. **Only usable when everyone installs the signed `.crx` build** (the ID is printed by `npm run build` and is determined by `key.pem`): a zip + **Load unpacked** install derives the ID from the directory path, which differs per machine — setting this variable in that case locks everyone out. Unset means every `chrome-extension://` origin is accepted. See also [Security notes](#security-notes): this pin narrows the forged-origin hole, it does not close it. |

To change the port on the extension side: click the extension icon → edit "Địa chỉ MCP server" (MCP
server address) → **Lưu & kết nối lại** (Save & reconnect).

## Security notes

- **What the origin check does and does not do.** The bridge **requires** the WebSocket handshake to
  carry an `Origin: chrome-extension://…` header (a missing origin is refused too). That blocks
  cross-origin connections originating inside the browser — an arbitrary web page opening
  `new WebSocket("ws://127.0.0.1:8787")` sends an `https://…` origin and is refused — and it raises
  the bar against casual local clients. But `Origin` is a header the **client sets itself**, with
  nothing vouching for it: a process purpose-built for this (a Node script using `ws`, or `curl`)
  gets through by sending one extra header line. This repo's own `test/e2e-http.mjs` demonstrates
  exactly that — it connects to the server with a plain Node `ws` client and a forged origin, and is
  accepted just like the real extension. **Do not treat the origin check as a barrier against a
  deliberate local process.**
- **A bridge installed by `install.sh` listens on loopback (`127.0.0.1`) only, by default.** Other
  machines on the LAN cannot reach `/ws` or `/mcp`. The real barrier against someone standing on your
  own machine is the **token** (`~/.ccchrome.json`), not the bind address and not the origin check
  above — put bluntly, the realistic threat model at this level is *"other software already running
  on your machine"*, and the genuine mitigation is to **use a separate Chrome profile for
  automation**, so that even if it is abused there is no tab logged into your personal accounts.
- **`navigate` and `javascript_eval` (along with `press_key`, `type_text`, `upload_file`) all refuse
  the extension's own pages.** `navigate` cannot send a tab to `chrome-extension://<id>/...` (nor to
  `chrome:`, `devtools:`, `edge:`, or any `about:` other than `about:blank`); the other four refuse
  to run if a tab somehow already sits on such a page. In the internal builds before 1.0.0 neither
  guard existed — a model could `navigate` a tab to `chrome-extension://<id>/popup.html` and then
  `javascript_eval` on it, running in the extension's privileged realm with unrestricted
  `chrome.tabs.*`, breaking tab-group isolation completely. `take_screenshot` is a **deliberate**
  exception, not an oversight: capturing pixels mutates nothing, while the other four all mutate.
- `CC_CHROME_EXTENSION_ID=<id>` narrows this further (only one extension ID is accepted) but **does
  not close the hole above** — the origin is still a string the client declares for itself; there is
  just one more ID to guess right. And this pin **only works if everyone installs the signed `.crx`
  build** (drag-and-drop on Linux, or enterprise policy on Windows/macOS): a **zip + Load unpacked**
  install as described above derives the ID **from the directory path**, which differs from machine
  to machine — setting the pin in that case locks everyone out.
- The extension holds `<all_urls>` + `debugger` permissions (like Anthropic's own extension) — but
  unlike the original, every tool is confined to the session's tab group (see
  [Per-session tab groups](#per-session-tab-groups)): Claude can only act on tabs **inside that
  group**, logged-in tabs included, not on every page open in Chrome. Dragging a tab into the group is
  you granting that access by hand. Using a separate Chrome profile for automation is recommended if
  you do not want Claude anywhere near your personal accounts. The `tabGroups` permission is used only
  to create and manage these groups; it does not widen what Claude can see.
- When a tool uses the debugger API (`take_screenshot` — **on every capture, not only `fullPage`** —,
  eval, keystrokes, console, network), Chrome shows the *"… started debugging this browser"*
  notification bar. That is normal; do not click Cancel while it is running.
- **A real trade-off, not a hypothetical one:** in earlier internal builds `take_screenshot` (default
  mode, no `fullPage`) could capture a tab that already had DevTools open. It no longer can — once
  DevTools (or any other debugger) holds that tab, `chrome.debugger.attach` fails and
  `take_screenshot` returns an error instead of an image, because the old way of capturing in that
  case (`chrome.tabs.update(...,{active:true})` followed by `captureVisibleTab`) is precisely what
  stole the user's active tab, and this fix removed it — there is no going back to it. Close DevTools
  on that tab and try again.
- **The panel's MCP token travels through a file, not through argv.** `AgentSession.mcpConfigPath()`
  writes the `--mcp-config` content (including `Authorization: Bearer <token>`) into
  `.mcp-config-<sessionId>.json` under `~/.cc-chrome-bridge/panel`, `chmod 600`, and passes only that
  **path** on the child `claude` command line — the token itself is no longer in argv. Before 1.0.0
  it was JSON written straight into an argument, readable via `ps` / `/proc/<pid>/cmdline` for the
  whole lifetime of the child process; moving to a file also fixed spawning on Windows, where
  `cmd.exe` reinterprets the `"` characters inside that JSON. What remains: the `600` mode is
  re-applied on **every write**, because `writeFileSync`'s `mode` only applies when the file is
  created; `dispose()` deletes the file when a session ends normally, but if the bridge is killed
  outright `dispose()` never runs — the file can survive on disk, which is why `uninstall.sh` sweeps
  up leftover `.mcp-config-*.json` files in `panel/`.
- **`install.sh` does put the token into argv, exactly once, when it registers the MCP server.** The
  `claude mcp add ... --header "Authorization: Bearer <token>"` step passes the token straight on the
  command line of a child `claude` process, so another local user can read it via `ps` /
  `/proc/<pid>/cmdline` for the lifetime of that command. It is the same kind of deliberate trade-off
  as above, differing only in lifetime (one command, not every chat turn) — and only on the machine
  that already holds the token in `~/.ccchrome.json`.

## Running the tests

The E2E test starts a real Chromium (with the extension loaded) plus a real MCP server and calls the
tools over the MCP Streamable HTTP protocol (using the SDK's official client, exactly the way Claude
Code talks to the bridge):

```bash
cd test && npm install && cd ..
node test/e2e.mjs
```

Requirement: Chromium/Chrome on the machine. The tests read `CHROME_PATH` for the browser path
(`CHROME_PATH=/path/to/chrome npm test`) — leave it unset and Playwright downloads and uses its own
browser (nothing under `test/` needs changing). **On macOS, leave `CHROME_PATH` empty** — see the note
in `CLAUDE.md` under "Setup and commands" for why stock Google Chrome on macOS ≥ 137 cannot load an
unpacked extension.

## Troubleshooting

| Symptom | What to do |
|---|---|
| A tool reports "Chrome extension is not connected" | Open Chrome, click the extension icon and check the status; click **Lưu & kết nối lại** (Save & reconnect). Check the background service is alive: `/ccchrome status` or `curl http://127.0.0.1:8787/health`. |
| The badge stays red and never turns green | Mismatched ports — check that the extension popup has the port the background service is actually running on (`~/.ccchrome.json` → `port` field; change it by reinstalling with a new `CC_CHROME_PORT`, see the Configuration table, not by exporting the variable alone). Or the port is taken by another process (the server logs `port already in use` to stderr — see `/ccchrome logs`). |
| "Cannot run scripts on chrome://..." | Chrome's internal pages do not allow script injection — switch to a normal web tab. |
| Console/network come back empty | Collection only starts from the first tool call on that tab — reload the page and read again. |
| Click/fill reports "Ref N is stale" | The page changed — call `read_page` again to get fresh refs. |

## Licence

MIT — see [LICENSE](LICENSE).
