#!/usr/bin/env bash
# Measures, on real Linux systemd, the one unmeasured claim behind the
# update-handover design: server/updater.js's linux branch of
# buildRunnerSpawn() spawns the update runner via
#   systemd-run --user --collect --unit=<name>
# instead of a plain detached child, reasoned (never measured — no Linux
# dev machine exists for this project) to be a shape that survives the
# exact command scripts/service-unit.sh's cc_service_stop() runs to stop
# the real bridge:
#   systemctl --user disable --now "<unit>.service"
#
# Three arms are run inside a throwaway --user service unit that plays the
# bridge:
#
#   A — plain detached child (setsid), spawned from inside the throwaway
#       unit. What { detached: true } does in Node: setsid() changes
#       session, not cgroup, and the spawning shell IS the unit's own
#       ExecStart, so this stays a genuine, unambiguous member of the
#       unit's cgroup. Expected: DIES. This is the one hard control: it
#       fails the run (exit 1) if it does not die.
#   B — `systemd-run --user --scope --unit=<name>` from inside the
#       throwaway unit. REPORTED, NOT ASSERTED — see the comment at its
#       verdict below for why.
#   C — `systemd-run --user --collect --unit=<name>` from inside the
#       throwaway unit — the exact shape buildRunnerSpawn's linux branch
#       uses. Expected: SURVIVES. This is the property under test: it
#       fails the run (exit 1) if it does not survive.
#
# This script does NOT infer cgroup membership from survival alone —
# survival is the very thing membership is supposed to explain, and
# inferring the cause from the effect begs the question. Each writer's
# first act is to record its own real cgroup (`cat /proc/self/cgroup`),
# and every cgroup is printed next to its arm's verdict, so a human
# reading the CI log sees *why* an arm died or survived, not just that it
# did.
#
# Each writer appends one line per second to its own file. Liveness before
# the stop is confirmed by two samples ~2s apart, both required to show
# strict growth — a control that ticked once and then silently died before
# the stop would otherwise pass a "wrote >= 1 line" guard and be scored a
# vacuous, meaningless DIES. After the stop, growth is required to clear a
# margin (>= 3 lines in 6s), not just be nonzero — see the comment above
# verdict_for() for why "any growth" makes exit 1 flaky on a healthy
# machine.
#
# Exit codes:
#   0 — the asserted pattern held: A dead, C alive. (B is reported only
#       and never affects this.)
#   1 — the property is broken: A or C disagreed with its expectation.
#       The mismatching arm, its counts, and its cgroup are printed.
#   2 — the environment cannot run the experiment at all: no systemd-run,
#       no reachable --user bus, a setup command failed, an arm never
#       ticked before the stop was issued, or the stop command itself did
#       not actually stop the unit. Printed, and distinguishable from 1.
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
    # after it has already exited on its own, which arm C (by design, if
    # the property holds) never does until we stop it here.
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
# INT/TERM/HUP too, not just EXIT: `trap ... EXIT` alone does not fire on a
# signal in bash unless that signal is also trapped, and a cancelled CI job
# sends one of these — without this, a cancelled run leaves the unit file,
# its default.target.wants symlink, a live .service, a live .scope, an
# orphaned setsid writer and the tmpdir behind.
trap cleanup EXIT INT TERM HUP

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

workdir="$(mktemp -d)" || fail_env "mktemp -d failed"

runid="$$-${RANDOM}-${RANDOM}"
bridge_unit="cc-probe-bridge-${runid}"
unit_b="cc-probe-b-${runid}"
unit_c="cc-probe-c-${runid}"

# Generic heartbeat writer shared by all three arms. Its FIRST act, before
# the first heartbeat, is to record its own real cgroup — this is the
# evidence K1 exists to capture: whether an arm dies or survives the stop
# is then something the log can explain, not just report.
if ! cat > "$workdir/writer.sh" <<'EOF'
#!/usr/bin/env bash
set -u
out="$1"
cat /proc/self/cgroup > "${out}.cgroup" 2>/dev/null || true
i=0
while true; do
  i=$((i + 1))
  echo "$i" >> "$out"
  sleep 1
done
EOF
then
  fail_env "could not write $workdir/writer.sh"
fi
chmod +x "$workdir/writer.sh" || fail_env "chmod +x $workdir/writer.sh failed"

# The throwaway bridge's own ExecStart script. Runs inside the bridge
# unit's cgroup and spawns the three arms from there, then stays running
# (like the real bridge process) until the probe stops the unit. Written
# with a plain (unquoted) heredoc so the paths/names generated above are
# baked in as literal values — this file has no untrusted input in it.
if ! cat > "$workdir/bridge-start.sh" <<EOF
#!/usr/bin/env bash
set -u

# Arm A: plain detached child, no systemd-run involved. setsid() changes
# session, not cgroup, so this stays a member of the bridge unit's own
# cgroup — the same thing { detached: true } does for the darwin branch of
# buildRunnerSpawn in server/updater.js.
setsid bash "$workdir/writer.sh" "$workdir/a.count" </dev/null >"$workdir/a.err" 2>&1 &

# Arm B: systemd-run --scope. Reported, not asserted — see the probe's
# verdict section for why its expected outcome is not assumed here.
systemd-run --user --scope --unit="$unit_b" bash "$workdir/writer.sh" "$workdir/b.count" >"$workdir/systemd-run-b.err" 2>&1 &

# Arm C: the exact command shape server/updater.js's buildRunnerSpawn uses
# on linux — systemd-run --user --collect --unit=<name>. The user manager
# forks this one itself, giving it its own lifetime independent of this
# script's process.
systemd-run --user --collect --unit="$unit_c" bash "$workdir/writer.sh" "$workdir/c.count" >"$workdir/systemd-run-c.err" 2>&1 &

# Keep this unit's own main process alive, the way the real bridge process
# stays up, until the probe stops it.
sleep 300
EOF
then
  fail_env "could not write $workdir/bridge-start.sh"
fi
chmod +x "$workdir/bridge-start.sh" || fail_env "chmod +x $workdir/bridge-start.sh failed"

# Same unit directory scripts/service-unit.sh's cc_unit_path() writes the
# real bridge unit to, so this exercises the same search path.
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir" || fail_env "mkdir -p $unit_dir failed"
bridge_unit_file="${unit_dir}/${bridge_unit}.service"

if ! cat > "$bridge_unit_file" <<EOF
[Unit]
Description=cc-chrome-bridge Linux handover probe (throwaway, run ${runid})

[Service]
ExecStart=/usr/bin/env bash "${workdir}/bridge-start.sh"

[Install]
WantedBy=default.target
EOF
then
  fail_env "could not write $bridge_unit_file"
fi

# --- Start the throwaway bridge, exactly the way cc_service_start() does ----
# Every setup command below is routed through fail_env rather than left to
# `set -e`'s bare exit: systemctl's own failure exit code is 1, which is
# indistinguishable from "the property is broken" unless something catches
# it here and re-labels it ENV/exit 2.

systemctl --user daemon-reload || fail_env "daemon-reload after writing the bridge unit failed"
systemctl --user enable --now "${bridge_unit}.service" || fail_env "enable --now ${bridge_unit}.service failed"

if ! systemctl --user is-active --quiet "${bridge_unit}.service"; then
  status_out="$(systemctl --user status --no-pager "${bridge_unit}.service" 2>&1 || true)"
  fail_env "the throwaway bridge unit never became active. status:${status_out}"
fi

count_lines() {
  if [ -f "$1" ]; then
    wc -l < "$1" | tr -d ' '
  else
    echo 0
  fi
}

read_cgroup() {
  # /proc/self/cgroup is one line on a cgroup-v2-only host but can be
  # several on a hybrid/v1 one (one per controller hierarchy) — squash to
  # one line with ';' separators so each arm's report stays a single,
  # greppable log line regardless of which the runner has.
  if [ -f "$1" ]; then
    tr '\n' ';' < "$1" | sed 's/;$//'
  else
    echo "<no cgroup file — writer may never have started>"
  fi
}

dump_diagnostics() {
  echo "arm A: $(count_lines "$workdir/a.count") lines, cgroup: $(read_cgroup "$workdir/a.count.cgroup")" >&2
  echo "arm B: $(count_lines "$workdir/b.count") lines, cgroup: $(read_cgroup "$workdir/b.count.cgroup")" >&2
  echo "arm C: $(count_lines "$workdir/c.count") lines, cgroup: $(read_cgroup "$workdir/c.count.cgroup")" >&2
  echo "--- $workdir/a.err ---" >&2
  cat "$workdir/a.err" 2>/dev/null >&2 || true
  echo "--- $workdir/systemd-run-b.err ---" >&2
  cat "$workdir/systemd-run-b.err" 2>/dev/null >&2 || true
  echo "--- $workdir/systemd-run-c.err ---" >&2
  cat "$workdir/systemd-run-c.err" 2>/dev/null >&2 || true
}

# Give the three arms time to be forked (systemd-run for B and C is a
# round trip over the bus) and write their first heartbeat.
sleep 5

# Two samples ~2s apart, BOTH before the stop, with strict growth required
# on all three. A single "wrote >= 1 line" guard would pass a control that
# ticked once at t=1s and died at t=2s — that control would then be scored
# a vacuous, meaningless DIES with no trace of the fact that it never
# actually lived through the measurement window. Requiring growth across
# two pre-stop samples is what makes "this arm was genuinely alive right
# before the stop" evidence rather than assumption.
pre1_a="$(count_lines "$workdir/a.count")"
pre1_b="$(count_lines "$workdir/b.count")"
pre1_c="$(count_lines "$workdir/c.count")"
sleep 2
# This second sample is also the one used as "before" for the after-stop
# comparison below — it sits milliseconds before the stop command is
# issued next, not before any of the setup work above.
before_a="$(count_lines "$workdir/a.count")"
before_b="$(count_lines "$workdir/b.count")"
before_c="$(count_lines "$workdir/c.count")"

if [ "$before_a" -le "$pre1_a" ] || [ "$before_b" -le "$pre1_b" ] || [ "$before_c" -le "$pre1_c" ]; then
  echo "pre-stop liveness check failed — at least one arm was not ticking before the stop was even issued:" >&2
  echo "  arm A: $pre1_a -> $before_a" >&2
  echo "  arm B: $pre1_b -> $before_b" >&2
  echo "  arm C: $pre1_c -> $before_c" >&2
  dump_diagnostics
  fail_env "an arm did not show strict growth between two pre-stop samples ~2s apart — the experiment never got a live baseline, this is not a verdict about the pattern"
fi

# --- The stop: the exact command cc_service_stop() runs on the real bridge --
# (scripts/service-unit.sh). Output is captured for diagnostics but, like
# the production command, a failure here does not itself abort the
# script — is-active below is what actually confirms the stop worked.
stop_out="$(systemctl --user disable --now "${bridge_unit}.service" 2>&1)" || true

if systemctl --user is-active --quiet "${bridge_unit}.service"; then
  dump_diagnostics
  fail_env "the stop did not stop the unit: ${stop_out}"
fi

sleep 6

after_a="$(count_lines "$workdir/a.count")"
after_b="$(count_lines "$workdir/b.count")"
after_c="$(count_lines "$workdir/c.count")"

cgroup_a="$(read_cgroup "$workdir/a.count.cgroup")"
cgroup_b="$(read_cgroup "$workdir/b.count.cgroup")"
cgroup_c="$(read_cgroup "$workdir/c.count.cgroup")"

# SURVIVES requires a MARGIN, not just any growth. Between the stop being
# issued and SIGTERM actually landing on a doomed process there is an
# unbounded window — realistically 100ms to ~1s on a loaded hosted
# runner. The writers tick at 1Hz and this samples ~6s after the stop, so
# a killed writer can gain at most about one extra line inside that
# window (0 or 1), while a genuinely live one gains on the order of six.
# Treating "any growth" as SURVIVES would flip a healthy control from
# DIES to SURVIVES on roughly a 30% chance per run at a 300ms kill
# window — a flaky exit 1 ("the property is broken") on a perfectly
# healthy machine, which is exactly what the exit-code contract exists to
# prevent. >= 3 lines of growth cannot be produced by a kill-window
# heartbeat; it can only be produced by an arm that kept running.
SURVIVE_MARGIN=3

verdict_for() {
  # $1=before $2=after -> prints SURVIVES or DIES
  if [ "$(($2 - $1))" -ge "$SURVIVE_MARGIN" ]; then
    echo SURVIVES
  else
    echo DIES
  fi
}

actual_a="$(verdict_for "$before_a" "$after_a")"
actual_b="$(verdict_for "$before_b" "$after_b")"
actual_c="$(verdict_for "$before_c" "$after_c")"

fail=0

# Hard control/property arms: mismatch fails the run.
report_hard_arm() {
  # $1=label $2=expected $3=actual $4=before $5=after $6=cgroup
  local status="ok"
  if [ "$3" != "$2" ]; then
    status="MISMATCH"
    fail=1
  fi
  echo "Arm $1: expected=$2 actual=$3 before=$4 after=$5 growth=$(($5 - $4)) cgroup=[$6] [$status]"
}

# Arm B is REPORTED, NOT ASSERTED. systemd-run(1), under --slice=,
# documents that the flag places "the new .service or .scope unit" under
# a slice (app.slice by default for --user) — a scope is a unit, and
# units live under slices, never inside other units. That reading says
# --scope should be a SIBLING of the bridge service's cgroup, not a
# child, which would mean arm B SURVIVES — the opposite of what this
# probe used to assert, and of what server/updater.js's comment used to
# claim. Rather than replace one unmeasured belief with another, this
# arm's outcome is only printed. Once a real CI run reports arm B's
# actual verdict and cgroup path here, that measurement — not this
# comment — is what should decide whether arm B ever becomes an asserted
# arm.
report_soft_arm() {
  # $1=label $2=actual $3=before $4=after $5=cgroup
  echo "Arm $1: actual=$2 before=$3 after=$4 growth=$(($4 - $3)) cgroup=[$5] [reported, not asserted]"
}

echo "stop command output: ${stop_out:-<empty>}"
report_hard_arm A DIES "$actual_a" "$before_a" "$after_a" "$cgroup_a"
report_soft_arm B "$actual_b" "$before_b" "$after_b" "$cgroup_b"
report_hard_arm C SURVIVES "$actual_c" "$before_c" "$after_c" "$cgroup_c"

if [ "$fail" -eq 1 ]; then
  echo "RESULT: FAIL — the linux update-handover pattern did not hold on the ASSERTED arms (A and/or C). See the MISMATCH line(s) above for which arm, its counts, and its measured cgroup." >&2
  exit 1
fi

echo "RESULT: PASS — plain detached (A) dies under 'systemctl --user disable --now'; systemd-run --collect --unit (C, what buildRunnerSpawn actually uses) survives it with margin. Arm B's cgroup and verdict are printed above for the record, not asserted."
exit 0
