// Stands in for the `claude` binary in AgentSession tests. It replays a real
// transcript captured in Task 1 instead of imitating a shape we invented, so a
// change in the CLI's output surfaces as a test failure rather than as a panel
// that silently renders nothing.
//
// Behaviour is steered by env vars so one file covers every case:
//   CC_FAKE_FIXTURE  path to the NDJSON transcript to replay (required)
//   CC_FAKE_DELAY_MS pause between lines, so a test can kill it mid-stream
//   CC_FAKE_ARGV     path to write the received argv to, for flag assertions
//   CC_FAKE_STDERR   text to write to stderr before exiting (\n for many lines)
//   CC_FAKE_EXIT     exit code, for failure paths
//   CC_FAKE_STDIN    path to write everything received on stdin to. Setting it
//                    also makes this process WAIT for the first chunk before
//                    replaying: the fixture is replayed synchronously and the
//                    process exits, so without the wait the parent's write can
//                    lose the race and the file is never written. The image
//                    path never closes stdin (that is the point of it), so
//                    waiting for 'end' would hang instead.

import { readFileSync, writeFileSync, writeSync } from "node:fs";

if (process.env.CC_FAKE_ARGV) {
  writeFileSync(process.env.CC_FAKE_ARGV, JSON.stringify(process.argv.slice(2)));
}

// Drain stdin so a parent that writes the prompt there never blocks on a full pipe.
let received = "";
let sawStdin = null;
const firstChunk = new Promise((resolve) => { sawStdin = resolve; });
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  received += chunk;
  if (process.env.CC_FAKE_STDIN) writeFileSync(process.env.CC_FAKE_STDIN, received);
  sawStdin();
});

if (process.env.CC_FAKE_STDIN) {
  // Bounded, so a test that never writes anything fails on its assertion
  // rather than hanging the whole suite.
  await Promise.race([firstChunk, new Promise((r) => setTimeout(r, 3000))]);
}

const lines = readFileSync(process.env.CC_FAKE_FIXTURE, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0);

const delay = Number(process.env.CC_FAKE_DELAY_MS || 0);

for (const line of lines) {
  process.stdout.write(line + "\n");
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
}

// writeSync, not process.stderr.write: writes to a pipe are asynchronous, and
// the process.exit() below would truncate the very line the test is asserting on.
if (process.env.CC_FAKE_STDERR) writeSync(2, process.env.CC_FAKE_STDERR + "\n");
process.exit(Number(process.env.CC_FAKE_EXIT || 0));
