#!/usr/bin/env bash
# Measures, on real Linux systemd, the one unmeasured claim behind the
# update-handover design: server/updater.js's linux branch of
# buildRunnerSpawn() spawns the update runner via
#   systemd-run --user --collect --unit=<name>
# instead of a plain detached child, reasoned (never measured — no Linux
# dev machine exists for this project) to be the only shape that survives
# the exact command scripts/service-unit.sh's cc_service_stop() runs to
# stop the real bridge:
#   systemctl --user disable --now "<unit>.service"
#
# Three arms, two of them controls that must DIE. A probe that only
# exercises the arm believed to survive cannot fail — this project has
# already shipped assertions that could not fail. If the controls do not
# die, the harness itself is broken and arm C surviving proves nothing.
#
#   A — plain detached child (setsid), spawned from inside the throwaway
#       unit. What { detached: true } does in Node: setsid() changes
#       session, not cgroup. Expected: DIES.
#   B — `systemd-run --user --scope --unit=<name>` from inside the
#       throwaway unit. A scope runs in the CALLER's cgroup. Expected: DIES.
#   C — `systemd-run --user --collect --unit=<name>` from inside the
#       throwaway unit — the exact shape buildRunnerSpawn's linux branch
#       uses. Forked directly by the systemd --user manager into its own
#       sibling cgroup. Expected: SURVIVES.
#
# A throwaway --user service unit plays the bridge. Its ExecStart script
# spawns the three heartbeat writers, then this probe runs the exact stop
# command above against that unit. Each writer appends one line per second
# to its own file; each arm's count is sampled immediately before the stop
# and again ~6s after, and SURVIVES requires strict growth *after* the
# stop — never a comparison against a baseline taken before setup, which is
# the defect that left the Windows probe unable to report anything but
# "survived".
#
# Exit codes:
#   0 — the expected pattern held: A dead, B dead, C alive.
#   1 — the property is broken: the pattern did not hold. The mismatching
#       arm(s) and their before/after counts are printed.
#   2 — the environment cannot run the experiment at all (no systemd-run,
#       no user manager, systemctl --user cannot reach the bus, or a
#       writer never started). Printed, and distinguishable from 1.
#
# There is no flag to turn this check off.

set -euo pipefail

workdir=""
bridge_unit=""
bridge_unit_file=""
unit_b=""
unit_c=""

cleanup() {
  # Best-effort, every step guarded: this runs on every exit path,
  # including ones where setup never finished, so nothing here may assume
  # a later variable was ever assigned.
  if [ -n "$bridge_unit" ]; then
    systemctl --user disable --now "${bridge_unit}.service" >/dev/null 2>&1 || true
  fi
  if [ -n "$unit_b" ]; then
    # Arm B is a *scope*, not a service — .scope, not .service.
    systemctl --user stop "${unit_b}.scope" >/dev/null 2>&1 || true
  fi
  if [ -n "$unit_c" ]; then
    # No --collect on the manual stop; --collect only auto-removes the unit
    # after it has already exited on its own, which arm C (by design) never
    # does until we stop it here.
    systemctl --user stop "${unit_c}.service" >/dev/null 2>&1 || true
  fi
  if [ -n "$bridge_unit_file" ] && [ -f "$bridge_unit_file" ]; then
    rm -f "$bridge_unit_file"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  if [ -n "$workdir" ] && [ -d "$workdir" ]; then
    rm -rf "$workdir"
  fi
}
trap cleanup EXIT

fail_env() {
  echo "ENV: $1" >&2
  exit 2
}

# --- Pre-flight: can this experiment even run here? -------------------------

command -v systemd-run >/dev/null 2>&1 || fail_env "systemd-run not found on PATH"
command -v systemctl >/dev/null 2>&1 || fail_env "systemctl not found on PATH"

: "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
export XDG_RUNTIME_DIR

# On a GitHub Actions runner, `systemctl --user` normally fails with
# "Failed to connect to bus" because there is no login session — the fix
# (`sudo loginctl enable-linger "$USER"`) belongs in the CI workflow step,
# not here, but it can take the user manager a moment to come up after
# lingering is enabled, so retry briefly before declaring the bus
# unreachable rather than failing on the first attempt.
bus_ok=0
bus_err=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if bus_err="$(systemctl --user daemon-reload 2>&1)"; then
    bus_ok=1
    break
  fi
  sleep 1
done
if [ "$bus_ok" -ne 1 ]; then
  fail_env "systemctl --user cannot reach the user bus (XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR}): ${bus_err}. On GitHub Actions this usually means 'sudo loginctl enable-linger \"\$USER\"' was not run, or XDG_RUNTIME_DIR was not exported, before this script."
fi

# --- Set up the throwaway bridge unit and its three writers ------------------

workdir="$(mktemp -d)"

runid="$$-${RANDOM}-${RANDOM}"
bridge_unit="cc-probe-bridge-${runid}"
unit_b="cc-probe-b-${runid}"
unit_c="cc-probe-c-${runid}"

cat > "$workdir/writer.sh" <<'EOF'
#!/usr/bin/env bash
# Generic heartbeat writer shared by all three arms: appends one line per
# second to the file named in $1, forever, until whatever spawned it dies.
set -u
out="$1"
i=0
while true; do
  i=$((i + 1))
  echo "$i" >> "$out"
  sleep 1
done
EOF
chmod +x "$workdir/writer.sh"

# The throwaway bridge's own ExecStart script. Runs inside the bridge
# unit's cgroup and spawns the three arms from there, then stays running
# (like the real bridge process) until the probe stops the unit. Written
# with a plain (unquoted) heredoc so the paths/names generated above are
# baked in as literal values — this file has no untrusted input in it.
cat > "$workdir/bridge-start.sh" <<EOF
#!/usr/bin/env bash
set -u

# Arm A: plain detached child, no systemd-run involved. setsid() changes
# session, not cgroup, so this stays a member of the bridge unit's own
# cgroup — the same thing { detached: true } does for the darwin branch of
# buildRunnerSpawn in server/updater.js.
setsid bash "$workdir/writer.sh" "$workdir/a.count" </dev/null >"$workdir/a.err" 2>&1 &

# Arm B (control): systemd-run --scope. A scope is executed directly by
# the invoking process rather than forked by the user manager, so it is
# expected to stay nested in the CALLER's (this unit's) cgroup and die
# with it.
systemd-run --user --scope --unit="$unit_b" bash "$workdir/writer.sh" "$workdir/b.count" >"$workdir/systemd-run-b.err" 2>&1 &

# Arm C: the exact command shape server/updater.js's buildRunnerSpawn uses
# on linux — systemd-run --user --collect --unit=<name>. The user manager
# forks this one itself, giving it its own sibling cgroup.
systemd-run --user --collect --unit="$unit_c" bash "$workdir/writer.sh" "$workdir/c.count" >"$workdir/systemd-run-c.err" 2>&1 &

# Keep this unit's own main process alive, the way the real bridge process
# stays up, until the probe calls disable --now on it.
sleep 300
EOF
chmod +x "$workdir/bridge-start.sh"

# Same unit directory scripts/service-unit.sh's cc_unit_path() writes the
# real bridge unit to, so this exercises the same search path.
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"
bridge_unit_file="${unit_dir}/${bridge_unit}.service"

cat > "$bridge_unit_file" <<EOF
[Unit]
Description=cc-chrome-bridge Linux handover probe (throwaway, run ${runid})

[Service]
ExecStart=/usr/bin/env bash "${workdir}/bridge-start.sh"

[Install]
WantedBy=default.target
EOF

# --- Start the throwaway bridge, exactly the way cc_service_start() does ----

systemctl --user daemon-reload
systemctl --user enable --now "${bridge_unit}.service"

if ! systemctl --user is-active --quiet "${bridge_unit}.service"; then
  status_out="$(systemctl --user status --no-pager "${bridge_unit}.service" 2>&1 || true)"
  fail_env "the throwaway bridge unit never became active. status:${status_out}"
fi

# Give the three arms time to be spawned and write their first heartbeats
# (each writer's first line lands within ~1s of the arm starting; this is
# generous headroom, not a tuned minimum).
sleep 5

count_lines() {
  if [ -f "$1" ]; then
    wc -l < "$1" | tr -d ' '
  else
    echo 0
  fi
}

before_a="$(count_lines "$workdir/a.count")"
before_b="$(count_lines "$workdir/b.count")"
before_c="$(count_lines "$workdir/c.count")"

if [ "$before_a" -eq 0 ] || [ "$before_b" -eq 0 ] || [ "$before_c" -eq 0 ]; then
  echo "arm A before-stop count: $before_a" >&2
  echo "arm B before-stop count: $before_b" >&2
  echo "arm C before-stop count: $before_c" >&2
  echo "--- $workdir/a.err ---" >&2
  cat "$workdir/a.err" 2>/dev/null >&2 || true
  echo "--- $workdir/systemd-run-b.err ---" >&2
  cat "$workdir/systemd-run-b.err" 2>/dev/null >&2 || true
  echo "--- $workdir/systemd-run-c.err ---" >&2
  cat "$workdir/systemd-run-c.err" 2>/dev/null >&2 || true
  fail_env "at least one arm never wrote a heartbeat before the stop was even issued — the experiment never got set up, this is not a verdict about the pattern"
fi

# --- The stop: the exact command cc_service_stop() runs on the real bridge --
# (scripts/service-unit.sh). Output is captured for diagnostics but, like
# the production command, a failure here does not abort the script — the
# after-stop sample is what actually answers the question.
stop_out="$(systemctl --user disable --now "${bridge_unit}.service" 2>&1)" || true

sleep 6

after_a="$(count_lines "$workdir/a.count")"
after_b="$(count_lines "$workdir/b.count")"
after_c="$(count_lines "$workdir/c.count")"

verdict_for() {
  # $1=before $2=after -> prints SURVIVES or DIES
  if [ "$2" -gt "$1" ]; then
    echo SURVIVES
  else
    echo DIES
  fi
}

actual_a="$(verdict_for "$before_a" "$after_a")"
actual_b="$(verdict_for "$before_b" "$after_b")"
actual_c="$(verdict_for "$before_c" "$after_c")"

fail=0

report_arm() {
  # $1=label $2=expected $3=actual $4=before $5=after
  local status="ok"
  if [ "$3" != "$2" ]; then
    status="MISMATCH"
    fail=1
  fi
  echo "Arm $1: expected=$2 actual=$3 before=$4 after=$5 [$status]"
}

echo "stop command output: ${stop_out:-<empty>}"
report_arm A DIES "$actual_a" "$before_a" "$after_a"
report_arm B DIES "$actual_b" "$before_b" "$after_b"
report_arm C SURVIVES "$actual_c" "$before_c" "$after_c"

if [ "$fail" -eq 1 ]; then
  echo "RESULT: FAIL — the linux update-handover pattern did not hold. See the MISMATCH line(s) above for which arm and its before/after counts." >&2
  exit 1
fi

echo "RESULT: PASS — plain detached (A) and systemd-run --scope (B) both die under 'systemctl --user disable --now', systemd-run --collect --unit (C, what buildRunnerSpawn actually uses) survives it."
exit 0
