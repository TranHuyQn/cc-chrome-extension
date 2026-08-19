// Usage: node test/panel-markdown.test.mjs
//
// extension/panel-markdown.js turns the assistant's Markdown into DOM for the
// side panel. Like panel-labels.js it is a classic browser script assigning one
// global, so it runs here against a stand-in `window` — no browser, no
// Playwright, fast enough for `npm test`.
//
// The two vendored libraries are loaded into the same sandbox because they are
// half the subject: `marked` and `Prism` are used for their LEXERS only, and the
// point of this file is to prove that what reaches the DOM is built from their
// token data rather than from any HTML string they can produce.
//
// The fake document below THROWS if anything assigns innerHTML. That assertion
// is the reason this file exists: `marked.parse()` and `Prism.highlight()` both
// return HTML strings and are one autocomplete away at all times, and a reviewer
// reading the source cannot prove they were never called. The document can.

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
  check(name, actual === expected, `\n    want: ${expected}\n    got : ${actual}`);
}

// --- the fake document -----------------------------------------------------

const VOID = new Set(["br", "hr"]);

function makeDocument() {
  const clicks = [];
  function element(tagName) {
    const el = {
      tagName,
      nodeType: 1,
      className: "",
      childNodes: [],
      attrs: {},
      appendChild(child) {
        this.childNodes.push(child);
        return child;
      },
      setAttribute(name, value) {
        this.attrs[name] = String(value);
      },
      addEventListener(type, fn) {
        if (type === "click") clicks.push({ el: this, fn });
      },
    };
    // textContent is a real property on a real element; production code is free
    // to use it. innerHTML is not, and the throw is the assertion.
    Object.defineProperty(el, "textContent", {
      get() {
        return el.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join("");
      },
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
  return {
    clicks,
    createElement: element,
    createTextNode: (data) => ({ nodeType: 3, data: String(data) }),
    createDocumentFragment: () => element("#fragment"),
  };
}

// Serialises the fake tree to an HTML-ish string. Test-side only — nothing in
// production ever turns a node back into a string.
function dump(node) {
  if (node.nodeType === 3) return node.data;
  const kids = node.childNodes.map(dump).join("");
  if (node.tagName === "#fragment") return kids;
  const cls = node.className ? ` class="${node.className}"` : "";
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");
  if (VOID.has(node.tagName)) return `<${node.tagName}${cls}${attrs}>`;
  return `<${node.tagName}${cls}${attrs}>${kids}</${node.tagName}>`;
}

// --- load the vendored lexers and the renderer into one sandbox -------------

// `window`, `globalThis` and `self` are the SAME object here, exactly as they
// are in a browser tab. panel-labels.test.mjs can get away with `{window: {}}`
// because that file only ever assigns one global; the vendored UMD bundles
// resolve their own global object and would land somewhere the renderer cannot
// see it.
const copied = [];
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  // The copy button's real target. Node has a `navigator` global of its own with
  // no clipboard, so this is a stand-in rather than a mock of our own code: what
  // is asserted below is the STRING handed to it, which is the part that has
  // been wrong in every clipboard bug worth having.
  navigator: { clipboard: { writeText: (t) => { copied.push(t); return Promise.resolve(); } } },
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
  "panel-markdown.js",
]) {
  runInNewContext(readFileSync(join(root, "extension", f), "utf8"), sandbox, { filename: f });
}
const ccMarkdown = sandbox.window.ccMarkdown;

check("panel-markdown.js exposes window.ccMarkdown.toDom", typeof ccMarkdown?.toDom === "function");
if (typeof ccMarkdown?.toDom !== "function") {
  console.log(`\n${failures} TEST(S) FAILED`);
  process.exit(1);
}

// Prism must not have armed its automatic pass — see extension/vendor/prism-manual.js.
check("Prism is in manual mode, so it never walks the panel's DOM by itself", sandbox.window.Prism.manual === true);

function render(md) {
  const doc = makeDocument();
  const frag = ccMarkdown.toDom(md, doc);
  return { html: dump(frag), doc };
}

// --- block level -----------------------------------------------------------

eq("a paragraph becomes <p>", render("Xong. Layout ngang giữ nguyên.").html,
  "<p>Xong. Layout ngang giữ nguyên.</p>");

eq("## becomes <h2>", render("## Nguyên nhân").html,
  '<h2 class="md-h2">Nguyên nhân</h2>');

eq("#### becomes <h4>", render("#### Chi tiết").html,
  '<h4 class="md-h4">Chi tiết</h4>');

eq("a bullet list becomes <ul>", render("- một\n- hai").html,
  "<ul><li>một</li><li>hai</li></ul>");

eq("an indented bullet nests inside its parent item",
  render("- ngoài\n  - trong").html,
  "<ul><li>ngoài<ul><li>trong</li></ul></li></ul>");

eq("a numbered list becomes <ol>", render("1. một\n2. hai").html,
  "<ol><li>một</li><li>hai</li></ol>");

eq("> becomes a blockquote", render("> trích").html,
  '<blockquote class="md-quote"><p>trích</p></blockquote>');

eq("--- becomes <hr>", render("a\n\n---\n\nb").html,
  '<p>a</p><hr class="md-hr"><p>b</p>');

// A table is wrapped because the side panel is ~370px wide: without its own
// scroller a wide table pushes the whole conversation sideways.
eq("a GFM table is wrapped in its own horizontal scroller",
  render("| Thuộc | Giá |\n|---|---|\n| price | €69,98 |").html,
  '<div class="md-table-wrap"><table class="md-table">'
  + "<thead><tr><th>Thuộc</th><th>Giá</th></tr></thead>"
  + "<tbody><tr><td>price</td><td>€69,98</td></tr></tbody>"
  + "</table></div>");

// --- fenced code -----------------------------------------------------------

eq("a fence with an unknown language is left unhighlighted but still framed",
  render("```brainfuck\n+[-]\n```").html,
  '<div class="md-code-block"><div class="md-code-head"><span class="md-code-lang">brainfuck</span><button class="md-code-copy" type="button">Chép</button></div><pre class="md-pre"><code class="md-code language-brainfuck">+[-]</code></pre></div>');

eq("a fence with no language still renders as a code block",
  render("```\nplain\n```").html,
  '<div class="md-code-block"><div class="md-code-head"><span class="md-code-lang"></span><button class="md-code-copy" type="button">Chép</button></div><pre class="md-pre"><code class="md-code">plain</code></pre></div>');

// The stream arrives a delta at a time, so the closing fence has not been typed
// yet for as long as the block is being written. Treating that as literal
// backticks makes the bubble flip between "text with ```" and "a code block" on
// every frame.
eq("an unterminated fence renders as a code block, not as literal backticks",
  render("```text\n.a { flex: 1 }").html,
  '<div class="md-code-block"><div class="md-code-head"><span class="md-code-lang">text</span><button class="md-code-copy" type="button">Chép</button></div><pre class="md-pre"><code class="md-code language-text">.a { flex: 1 }</code></pre></div>');

// --- inline ----------------------------------------------------------------

eq("** becomes <strong>", render("**đậm**").html, "<p><strong>đậm</strong></p>");
eq("* becomes <em>", render("*nghiêng*").html, "<p><em>nghiêng</em></p>");
eq("~~ becomes <del>", render("~~gạch~~").html, "<p><del>gạch</del></p>");
eq("backticks become inline code", render("`min-width`").html,
  '<p><code class="md-inline-code">min-width</code></p>');
eq("emphasis nests", render("**đậm có `code`**").html,
  '<p><strong>đậm có <code class="md-inline-code">code</code></strong></p>');
eq("a backslash escape yields the character, not the backslash",
  render("\\*không nghiêng\\*").html, "<p>*không nghiêng*</p>");

// marked's LEXER hands back unescaped text (`escaped: false`); only its
// renderer — which this project does not use — turns `&` into `&amp;`. Appending
// the token text to a text node is therefore correct, and this assertion is what
// catches a future marked release changing its mind: the symptom would be users
// reading `a &amp; b` on screen, which nobody would think to look for.
eq("ampersands and angle brackets survive as themselves",
  render("a & b < c").html, "<p>a & b < c</p>");

eq("code fences keep & and < verbatim too",
  render("```\na & b < c\n```").html,
  '<div class="md-code-block"><div class="md-code-head"><span class="md-code-lang"></span><button class="md-code-copy" type="button">Chép</button></div><pre class="md-pre"><code class="md-code">a & b < c</code></pre></div>');

// --- links, and the schemes that are not links ------------------------------

eq("an http link becomes an <a> that opens outside the panel",
  render("[tài liệu](https://a.dev/x)").html,
  '<p><a class="md-link" href="https://a.dev/x" target="_blank" rel="noopener noreferrer">tài liệu</a></p>');

eq("a mailto link is allowed", render("[thư](mailto:a@b.dev)").html,
  '<p><a class="md-link" href="mailto:a@b.dev" target="_blank" rel="noopener noreferrer">thư</a></p>');

// The panel is an extension page: a javascript: or data: URL clicked here runs
// with the extension's privileges, not a website's. Refused at the source rather
// than sanitised afterwards -- the link text is kept so the sentence still reads.
eq("a javascript: link is rendered as plain text, not as a link",
  render("[bấm đi](javascript:alert(1))").html, "<p>bấm đi</p>");

eq("a data: link is rendered as plain text, not as a link",
  render("[bấm đi](data:text/html,<script>alert(1)</script>)").html, "<p>bấm đi</p>");

// Raw markup in the source is content, not markup. This is the case the whole
// build-it-node-by-node approach exists for.
eq("raw HTML in the source arrives as text",
  render("trước <img src=x onerror=alert(1)> sau").html,
  "<p>trước &lt;img src=x onerror=alert(1)&gt; sau</p>".replace("&lt;", "<").replace("&gt;", ">"));

// --- syntax highlighting ----------------------------------------------------

// Prism.tokenize() returns token DATA. Prism.highlight() returns an HTML string
// and is never called: the fake document would throw the moment anyone tried to
// put that string anywhere.
function findAll(node, pred, out = []) {
  if (node.nodeType === 3) return out;
  if (pred(node)) out.push(node);
  for (const c of node.childNodes) findAll(c, pred, out);
  return out;
}

{
  const src = ".a { flex: 1 1 0 !important; }";
  const { doc } = render("```css\n" + src + "\n```");
  const frag = ccMarkdown.toDom("```css\n" + src + "\n```", doc);
  const code = findAll(frag, (n) => n.tagName === "code")[0];
  // The property that matters most, and the one a highlighter breaks first:
  // colouring must not add, drop or reorder a single character.
  eq("highlighting leaves the code text byte-identical", code.textContent, src);
  const spans = findAll(code, (n) => n.tagName === "span");
  check("css is highlighted into token spans", spans.length > 0, String(spans.length));
  check("token spans carry Prism's own class names",
    spans.some((n) => n.className === "token property" && n.textContent === "flex"),
    spans.map((n) => `${n.className}:${n.textContent}`).join(" | "));
}

{
  // A Prism token whose `content` is itself an array — the nested case, which a
  // flat loop silently flattens into one span with the right text and the wrong
  // colours, so text-only assertions cannot see it.
  const src = "@media (max-width: 767px) { .a { flex: 1 } }";
  const doc = makeDocument();
  const frag = ccMarkdown.toDom("```css\n" + src + "\n```", doc);
  const code = findAll(frag, (n) => n.tagName === "code")[0];
  eq("a nested token keeps the text intact", code.textContent, src);
  const spans = findAll(code, (n) => n.tagName === "span");
  check("nested tokens produce nested spans",
    spans.some((n) => findAll(n, (m) => m.tagName === "span" && m !== n).length > 0),
    spans.map((n) => n.className).join(" | "));
}

{
  const doc = makeDocument();
  const frag = ccMarkdown.toDom("```brainfuck\n+[-]\n```", doc);
  const code = findAll(frag, (n) => n.tagName === "code")[0];
  check("a language Prism does not know produces no spans at all",
    findAll(code, (n) => n.tagName === "span").length === 0);
  eq("and its text is untouched", code.textContent, "+[-]");
}

// --- the copy button --------------------------------------------------------

{
  // & and < are in here deliberately: they are what a naive implementation
  // round-trips through HTML and hands back as &amp; and &lt;.
  const src = "if (a & b) { x < y }\nline two";
  const doc = makeDocument();
  const frag = ccMarkdown.toDom("```js\n" + src + "\n```", doc);
  const btn = findAll(frag, (n) => n.tagName === "button")[0];
  check("a code block gets a copy button", !!btn, "no <button> in the fragment");
  const hook = doc.clicks.find((c) => c.el === btn);
  check("the copy button has a click handler", !!hook);
  copied.length = 0;
  hook.fn();
  // Copied from the token, NOT from the DOM: after highlighting the code element
  // is dozens of spans deep, and reassembling it is how a copy silently loses
  // characters.
  eq("clicking copies the source exactly, highlighting and all", copied[0], src);
  await Promise.resolve();
  await Promise.resolve();
  eq("and the button says so", btn.textContent, "Đã chép");
}

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
