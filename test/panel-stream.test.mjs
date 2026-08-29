// Usage: node test/panel-stream.test.mjs
//
// Drives extension/sidepanel.js itself — the streaming half — against a stand-in
// browser. Two properties are at stake and they pull in opposite directions:
//
//   1. what the user SEES is rendered Markdown, and
//   2. what the panel WRITES DOWN is the Markdown source.
//
// Before Markdown rendering, both were the same string and the panel could keep
// its only copy of a half-finished reply in the DOM: `flushStreamingEntry()`
// read `streaming.textContent` when a turn ended without a `message`. The moment
// the bubble holds rendered nodes that reading is lossy — no backticks, no `##`,
// no list markers — and the loss is invisible until the panel is reopened days
// later and the journal replays a mangled reply. CLAUDE.md calls this out as an
// invariant; this file is what actually holds it.
//
// The harness is a fake browser rather than Playwright so it can sit in
// `npm test`: sidepanel.js is a classic script, so its top-level `function`
// declarations land on the sandbox's global object and can be called directly.

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
function eq(name, actual, expected) {
  check(name, actual === expected, `\n    want: ${JSON.stringify(expected)}\n    got : ${JSON.stringify(actual)}`);
}

// --- a browser, roughly ----------------------------------------------------

function makeElement(tagName) {
  const el = {
    tagName,
    nodeType: 1,
    className: "",
    childNodes: [],
    attrs: {},
    style: {},
    hidden: false,
    disabled: false,
    value: "",
    title: "",
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    listeners: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains: () => false,
    },
    appendChild(child) {
      // A real appendChild MOVES a DocumentFragment's children and leaves the
      // fragment itself behind; the panel appends one per rendered message, so a
      // fake that nested it instead would quietly change the tree shape.
      if (child.tagName === "#fragment") {
        for (const c of child.childNodes) this.childNodes.push(c);
        child.childNodes = [];
        return child;
      }
      this.childNodes.push(child);
      return child;
    },
    removeChild(child) {
      this.childNodes = this.childNodes.filter((c) => c !== child);
      return child;
    },
    // The panel builds its step rows with append(a, b, c). Same semantics as
    // appendChild in a loop, which is what the real one does for elements.
    append(...kids) {
      for (const kid of kids) this.appendChild(kid);
    },
    remove() {},
    select() {},
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
  };
  Object.defineProperty(el, "textContent", {
    get: () => el.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(""),
    set(v) {
      el.childNodes = v === "" ? [] : [{ nodeType: 3, data: String(v) }];
    },
  });
  Object.defineProperty(el, "innerHTML", {
    get() {
      throw new Error(`read of innerHTML on <${tagName}>`);
    },
    set() {
      throw new Error(`innerHTML assigned on <${tagName}> — the panel must build DOM element by element`);
    },
  });
  return el;
}

function descendants(node, out = []) {
  if (node.nodeType === 3) return out;
  for (const c of node.childNodes) {
    out.push(c);
    descendants(c, out);
  }
  return out;
}
function plainText(node) {
  return node.nodeType === 3 ? node.data : node.childNodes.map(plainText).join("");
}

const byId = new Map();
const storage = {};
const sockets = [];
const frames = new Map();
let frameId = 0;
function flushFrames() {
  const due = [...frames.values()];
  frames.clear();
  for (const fn of due) fn();
}

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  // Queued, not immediate. The panel coalesces its stream re-renders through
  // rAF, and a synchronous stub would run the callback BEFORE the id it returns
  // is assigned — the "a frame is already pending" flag would then never clear
  // and every delta after the first would be dropped. That is a property of the
  // stub, not of the panel, and inventing production state to work around it
  // would be shaping the code to fit the test. flushFrames() below is the
  // deterministic equivalent of the browser painting.
  requestAnimationFrame: (fn) => {
    frames.set(++frameId, fn);
    return frameId;
  },
  cancelAnimationFrame: (id) => frames.delete(id),
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
  document: {
    createElement: makeElement,
    createTextNode: (data) => ({ nodeType: 3, data: String(data) }),
    createDocumentFragment: () => makeElement("#fragment"),
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, makeElement("div"));
      return byId.get(id);
    },
    addEventListener() {},
    body: makeElement("body"),
    // Prism's core sniffs for its own <script> tag at load even in manual mode.
    readyState: "complete",
    currentScript: null,
    getElementsByTagName: () => [],
    querySelectorAll: () => [],
  },
  chrome: {
    storage: {
      local: {
        get: async (keys) => (keys === null ? { ...storage } : { [keys]: storage[keys] }),
        set: async (obj) => Object.assign(storage, obj),
        remove: async () => {},
      },
    },
    windows: {
      getAll: async () => [{ id: 7 }],
      getCurrent: async () => ({ id: 7 }),
    },
    runtime: { reload() {} },
  },
  WebSocket: class {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      sockets.push(this);
    }
    send() {}
    close() {}
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

for (const f of [
  "vendor/prism-manual.js",
  "vendor/marked.umd.js",
  "vendor/prism-core.min.js",
  "vendor/prism-markup.min.js",
  "vendor/prism-css.min.js",
  "vendor/prism-clike.min.js",
  "vendor/prism-javascript.min.js",
  "vendor/prism-typescript.min.js",
  "vendor/prism-json.min.js",
  "vendor/prism-bash.min.js",
  "vendor/prism-python.min.js",
  "vendor/prism-yaml.min.js",
  "vendor/prism-diff.min.js",
  "vendor/prism-sql.min.js",
  "panel-labels.js",
  "panel-journal.js",
  "panel-markdown.js",
  "sidepanel.js",
]) {
  runInNewContext(readFileSync(join(root, "extension", f), "utf8"), sandbox, { filename: f });
}
// sidepanel.js ends in an async IIFE (journal restore, then connect()).
await new Promise((r) => setTimeout(r, 0));

const logEl = byId.get("log");
const handle = sandbox.handle;
check("sidepanel.js exposes its message handler to this harness", typeof handle === "function");
if (typeof handle !== "function") {
  console.log(`\n${failures} TEST(S) FAILED`);
  process.exit(1);
}

const MD = "Xong.\n\n## Nguyên nhân\n\n- `min-width` bị **ghi đè**\n";

handle({ type: "delta", text: MD.slice(0, 12) });
flushFrames();
handle({ type: "delta", text: MD.slice(12) });
flushFrames();

const bubble = logEl.childNodes[logEl.childNodes.length - 1];
check("a delta opens an assistant bubble", bubble && String(bubble.className).includes("assistant"),
  bubble ? String(bubble.className) : "(no bubble)");

const kids = descendants(bubble).filter((n) => n.nodeType === 1).map((n) => n.tagName);
check("the streamed text is rendered as Markdown, not dumped as source",
  kids.includes("h2") && kids.includes("ul") && kids.includes("strong") && kids.includes("code"),
  kids.join(","));
check("and the Markdown punctuation is gone from what the user reads",
  !plainText(bubble).includes("##") && !plainText(bubble).includes("**"),
  JSON.stringify(plainText(bubble)));

// The turn dies without a `message` — a dropped socket, a disposed session. This
// is the path that writes whatever reached the screen into the journal.
handle({ type: "turn_end", ok: true });

const entries = sandbox.ccJournal.entries().filter((e) => e.type === "message");
eq("the journal keeps the Markdown SOURCE, not the rendered text", entries[entries.length - 1]?.text, MD);

// A reopened panel replays that entry. If the journal held rendered text this
// would quietly render the mangled version instead, which is the whole failure.
logEl.childNodes = [];
sandbox.render({ type: "message", text: entries[entries.length - 1].text });
const replayed = descendants(logEl.childNodes[0]).filter((n) => n.nodeType === 1).map((n) => n.tagName);
check("replaying that entry reproduces the same rendered bubble",
  replayed.includes("h2") && replayed.includes("strong"), replayed.join(","));

// The user's own words are source, not a document to be reinterpreted: turning
// what they typed into something else is a different message than the one they
// sent, and it is the one the server has a copy of.
logEl.childNodes = [];
sandbox.render({ type: "user", text: "sửa **giúp** ## này" });
eq("a user message stays literal", plainText(logEl.childNodes[0]), "sửa **giúp** ## này");

// --- the log must not scroll itself while the user is reading back ---------

const jumpEl = byId.get("jumpToBottom");

// Simulate a tall log the user has scrolled up in. The panel decides by
// geometry, so the geometry is what the fake has to carry.
logEl.childNodes = [];
logEl.scrollHeight = 2000;
logEl.clientHeight = 400;
logEl.scrollTop = 2000 - 400; // pinned at the bottom
for (const fn of logEl.listeners.scroll || []) fn();

sandbox.render({ type: "delta", text: "một" });
flushFrames();
check("while pinned at the bottom, new content still scrolls into view",
  logEl.scrollTop === logEl.scrollHeight, `scrollTop=${logEl.scrollTop} scrollHeight=${logEl.scrollHeight}`);

// Now the user scrolls up to read something.
sandbox.resetStream();
logEl.scrollTop = 100;
for (const fn of logEl.listeners.scroll || []) fn();
const before = logEl.scrollTop;

sandbox.render({ type: "delta", text: "hai" });
flushFrames();
sandbox.render({ type: "step_start", id: "s1", name: "mcp__chrome__read_page" });
sandbox.render({ type: "error-line", text: "một dòng nữa" });

eq("a streaming delta does not yank the log back to the bottom", logEl.scrollTop, before);
check("neither does a new step row or a new message", logEl.scrollTop === before,
  `scrollTop=${logEl.scrollTop}, expected ${before}`);
check("the jump-to-bottom button is showing", jumpEl.hidden === false, `hidden=${jumpEl.hidden}`);

// Clicking it returns the user to the live end and re-arms following.
for (const fn of jumpEl.listeners.click || []) fn();
check("clicking the button scrolls to the bottom", logEl.scrollTop === logEl.scrollHeight,
  `scrollTop=${logEl.scrollTop} scrollHeight=${logEl.scrollHeight}`);
for (const fn of logEl.listeners.scroll || []) fn();
check("and hides itself again", jumpEl.hidden === true, `hidden=${jumpEl.hidden}`);

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
