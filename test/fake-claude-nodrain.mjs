// Stands in for a `claude` that fails before it ever reads its prompt — the
// documented common case being `--resume <id>` for a conversation the CLI no
// longer has on disk, which exits 1 immediately.
//
// It deliberately does NOT touch stdin. test/fake-claude.mjs drains it (so a
// parent writing a prompt never blocks), which is right for what that fake is
// for and is exactly why it cannot see this bug: with the reader gone, a prompt
// larger than the OS pipe buffer leaves a queued write hitting a closed pipe,
// and an EPIPE with no `error` listener on child.stdin takes the whole bridge
// process down.

import { writeSync } from "node:fs";

// writeSync, not process.stderr.write: a pipe write is asynchronous and the
// exit below would truncate the line the test asserts on.
writeSync(2, "No conversation found with session ID: 11111111-2222-3333-4444-555555555555\n");
process.exit(1);
