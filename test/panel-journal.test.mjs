// Usage: node test/panel-journal.test.mjs
//
// Same trick as test/panel-labels.test.mjs: extension/panel-journal.js is a
// classic browser script, so it runs in a Node vm against a stand-in `window`
// and a stand-in `chrome.storage.local`. What is under test is the cap — an
// unbounded journal would grow until chrome.storage.local throws QUOTA_BYTES,
// and it would do it silently, in the background, days into a session.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = {};
const sandbox = {
  window: {},
  setTimeout,
  clearTimeout,
  chrome: {
    storage: {
      local: {
        // The real chrome.storage.local serializes on the way in and hands back
        // fresh objects on the way out, so a caller can never hold a live
        // reference into the store. A double that skips that models an API
        // nobody ships, and makes the debounce assertion below unobservable
        // once the first save has run.
        get: async (defaults) => {
          const out = {};
          for (const key of Object.keys(defaults)) {
            out[key] = key in store ? structuredClone(store[key]) : defaults[key];
          }
          return out;
        },
        set: async (obj) => { Object.assign(store, structuredClone(obj)); },
      },
    },
  },
};
sandbox.globalThis = sandbox;
runInNewContext(readFileSync(join(root, "extension", "panel-journal.js"), "utf8"), sandbox);
const ccJournal = sandbox.window.ccJournal;

check(
  "the file exposes exactly one global",
  Object.keys(sandbox.window).length === 1,
  JSON.stringify(Object.keys(sandbox.window)),
);

// --- load / push / persist ---------------------------------------------------

store["panelLog.7"] = [{ type: "user", text: "câu cũ" }];
const loaded = await ccJournal.load("panelLog.7");
check("load returns what was stored", loaded.length === 1 && loaded[0].text === "câu cũ", JSON.stringify(loaded));

ccJournal.push({ type: "message", text: "câu mới" });
check("push appends in memory immediately", ccJournal.entries().length === 2, String(ccJournal.entries().length));
check("writing is debounced, not synchronous", store["panelLog.7"].length === 1, String(store["panelLog.7"].length));
await sleep(700);
check("and lands after the debounce", store["panelLog.7"].length === 2, String(store["panelLog.7"].length));

// --- load() must not drop a pending write ------------------------------------
//
// If load() clears the debounce timer without flushing it first, whatever was
// pushed since the last actual write is silently gone: the timer never fires
// and entries is immediately overwritten from storage under the new key.

await ccJournal.load("panelLog.flushA");
ccJournal.push({ type: "message", text: "not yet saved" });
// The debounce is still pending here on purpose — no sleep before the next
// load() call, so this is exercising the swap-while-pending path.
await ccJournal.load("panelLog.flushB");
check("a pending write is flushed under its OWN key before load() swaps to a new one",
  (store["panelLog.flushA"] || []).some((e) => e.text === "not yet saved"),
  JSON.stringify(store["panelLog.flushA"]));

// --- the cap -----------------------------------------------------------------

await ccJournal.load("panelLog.cap");
for (let i = 0; i < ccJournal.MAX_ENTRIES + 50; i++) ccJournal.push({ type: "message", text: `n${i}` });
check("the entry cap holds", ccJournal.entries().length === ccJournal.MAX_ENTRIES, String(ccJournal.entries().length));
check("the OLDEST entries are the ones dropped", ccJournal.entries()[0].text === "n50", ccJournal.entries()[0].text);

await ccJournal.load("panelLog.bytes");
const fat = { type: "step_end", summary: "z".repeat(50 * 1024) };
for (let i = 0; i < 40; i++) ccJournal.push({ ...fat });
const bytes = JSON.stringify(ccJournal.entries()).length;
check("the byte cap holds even when the entry count would not", bytes <= ccJournal.MAX_BYTES, String(bytes));
check("but it never empties the journal completely", ccJournal.entries().length >= 1, String(ccJournal.entries().length));

// A single entry larger than the whole budget must not spin the trim loop into
// an empty journal — the newest entry always survives.
await ccJournal.load("panelLog.huge");
ccJournal.push({ type: "message", text: "y".repeat(ccJournal.MAX_BYTES * 2) });
check("one oversized entry still leaves exactly itself", ccJournal.entries().length === 1, String(ccJournal.entries().length));

// --- resize ------------------------------------------------------------------
//
// The panel journals an assistant bubble before its final text exists (so it
// keeps its position relative to tool rows around it), then mutates it in
// place once the real text arrives. resize() must both persist that mutation
// and keep the byte accounting honest -- otherwise the cap above drifts every
// time a bubble grows.

// Let the push's own debounce fire and clear FIRST, so the only thing that can
// schedule the second write is resize() itself.
await ccJournal.load("panelLog.resize");
const entry = { type: "message", text: "ban đầu" };
ccJournal.push(entry);
await sleep(700);
entry.text = "đã sửa";
ccJournal.resize(entry);
await sleep(700);
check("resize schedules a write for an entry mutated after its first save",
  (store["panelLog.resize"][0] || {}).text === "đã sửa",
  JSON.stringify(store["panelLog.resize"]));

// The accounting half: an entry that grows past the budget must be trimmed
// against its NEW size, which only happens if resize updated the bookkeeping.
await ccJournal.load("panelLog.resizecap");
ccJournal.push({ type: "message", text: "nhỏ" });
const grown = { type: "message", text: "x" };
ccJournal.push(grown);
grown.text = "y".repeat(ccJournal.MAX_BYTES);
ccJournal.resize(grown);
check("resize re-accounts the entry's size so the byte cap still holds",
  ccJournal.entries().length === 1 && ccJournal.entries()[0] === grown,
  String(ccJournal.entries().length));

// --- clear -------------------------------------------------------------------

await ccJournal.load("panelLog.7");
ccJournal.clear();
check("clear empties memory", ccJournal.entries().length === 0, String(ccJournal.entries().length));
await sleep(50);
check("and storage", (store["panelLog.7"] || []).length === 0, JSON.stringify(store["panelLog.7"]));

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
