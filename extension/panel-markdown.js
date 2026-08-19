// Renders the assistant's Markdown into DOM for the side panel.
//
// The one rule this file exists to enforce: **no HTML string ever becomes DOM
// here.** Both vendored libraries can hand out HTML — `marked.parse()` returns a
// document fragment's worth of it, `Prism.highlight()` returns a highlighted
// `<span>` soup — and neither is used. Only their LEXERS are: `marked.lexer()`
// and `Prism.tokenize()` return plain token data, and everything below is built
// with createElement/createTextNode from that data.
//
// That is not fussiness. The panel is an extension page with the extension's
// privileges, and the text it renders routinely contains whatever a website put
// on screen — `get_page_text`, `read_console_messages` and every other browser
// tool feed their results back through the conversation. `innerHTML` on that
// path is a cross-site scripting hole into a privileged context. Building the
// tree node by node makes hostile input structurally incapable of becoming
// markup: a `<img onerror=…>` in the source arrives as an `html` token and is
// appended as text, because that is the only thing this code knows how to do
// with it.
//
// test/panel-markdown.test.mjs runs this against a document whose elements
// throw if anything assigns innerHTML, so the rule is enforced by a test rather
// than by a reviewer noticing.
(function () {
  // Only these three can be a link. `javascript:` is the obvious one; `data:`
  // is the one people forget, and a data: URL in an extension page is just as
  // good as a script tag.
  const SAFE_LINK = /^(https?:|mailto:)/i;

  const COPY_LABEL = "Chép";
  const COPIED_LABEL = "Đã chép";

  function el(doc, tag, className) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function text(doc, parent, value) {
    if (value) parent.appendChild(doc.createTextNode(value));
  }

  // --- inline ---------------------------------------------------------------

  function wrap(tag, className, token, parent, doc) {
    const node = el(doc, tag, className);
    appendInline(token.tokens || [{ type: "text", text: token.text }], node, doc);
    parent.appendChild(node);
  }

  function appendLink(token, parent, doc) {
    const href = String(token.href || "").trim();
    if (!SAFE_LINK.test(href)) {
      // Refused at the source rather than sanitised afterwards, and the link
      // TEXT is kept so the sentence still reads. A whitelist is the only shape
      // that is safe by construction here: this document runs with the
      // extension's privileges, so a javascript: or data: URL clicked in the
      // panel is not a website's problem, it is the bridge's.
      appendInline(token.tokens || [{ type: "text", text: token.text }], parent, doc);
      return;
    }
    const a = el(doc, "a", "md-link");
    a.setAttribute("href", href);
    // The panel is a 370px column with no browser chrome — a navigation inside
    // it would replace the conversation with a website and there is no back
    // button to return with.
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
    appendInline(token.tokens || [{ type: "text", text: token.text }], a, doc);
    parent.appendChild(a);
  }

  function appendInline(tokens, parent, doc) {
    for (const t of tokens || []) {
      switch (t.type) {
        case "escape":
        case "text":
          if (t.tokens) appendInline(t.tokens, parent, doc);
          else text(doc, parent, t.text);
          break;
        case "strong":
          wrap("strong", "", t, parent, doc);
          break;
        case "em":
          wrap("em", "", t, parent, doc);
          break;
        case "del":
          wrap("del", "", t, parent, doc);
          break;
        case "codespan": {
          const code = el(doc, "code", "md-inline-code");
          text(doc, code, t.text);
          parent.appendChild(code);
          break;
        }
        case "link":
          appendLink(t, parent, doc);
          break;
        case "br":
          parent.appendChild(el(doc, "br"));
          break;
        case "image":
          // Deliberately NOT an <img>. Rendering one would make the panel fetch
          // an arbitrary URL chosen by whatever text came back from a webpage —
          // a request the user never asked for, from an extension page. The alt
          // text carries the meaning; the URL is shown so nothing is hidden.
          text(doc, parent, t.text ? `[${t.text}]` : "[hình]");
          break;
        default:
          // Anything not understood — `html` above all — contributes its source
          // text rather than disappearing. Losing a sentence is worse than
          // losing its formatting, and text is the safe thing to lose it as.
          text(doc, parent, t.raw != null ? t.raw : t.text || "");
      }
    }
  }

  // --- blocks ---------------------------------------------------------------

  // Prism's tokens are plain data: a string, or {type, alias?, content} whose
  // content is a string, a token, or an array of them. Turning that into spans
  // is the whole of "syntax highlighting" here — Prism.highlight(), which
  // returns the same thing as an HTML string, is never called.
  function appendPrismTokens(tokens, parent, doc) {
    for (const t of tokens) {
      if (typeof t === "string") {
        text(doc, parent, t);
        continue;
      }
      const alias = Array.isArray(t.alias) ? t.alias.join(" ") : t.alias;
      const span = el(doc, "span", `token ${t.type}${alias ? ` ${alias}` : ""}`);
      if (typeof t.content === "string") text(doc, span, t.content);
      else if (Array.isArray(t.content)) appendPrismTokens(t.content, span, doc);
      else if (t.content) appendPrismTokens([t.content], span, doc);
      parent.appendChild(span);
    }
  }

  function appendHighlighted(source, lang, parent, doc) {
    const grammar = lang && window.Prism ? window.Prism.languages[lang] : null;
    if (!grammar) {
      // No grammar vendored for this language — the block still renders, just
      // without colour. Silently degrading beats refusing to show the code.
      text(doc, parent, source);
      return;
    }
    try {
      appendPrismTokens(window.Prism.tokenize(source, grammar), parent, doc);
    } catch {
      // A grammar that throws must not cost the user the code itself.
      parent.textContent = "";
      text(doc, parent, source);
    }
  }

  function legacyCopy(source, doc) {
    if (!doc.body || typeof doc.execCommand !== "function") return false;
    const ta = doc.createElement("textarea");
    ta.value = source;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    doc.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = doc.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }

  function copyToClipboard(source, btn, doc) {
    const flash = () => {
      btn.textContent = COPIED_LABEL;
      if (btn.ccResetTimer) clearTimeout(btn.ccResetTimer);
      btn.ccResetTimer = setTimeout(() => {
        btn.textContent = COPY_LABEL;
      }, 1500);
    };
    const clip = window.navigator && window.navigator.clipboard;
    // No `clipboardWrite` permission is requested for this: writeText() works in
    // an extension page from inside a click handler, and widening the manifest
    // for a convenience button would be the wrong trade.
    if (clip && clip.writeText) {
      clip.writeText(source).then(flash, () => {
        if (legacyCopy(source, doc)) flash();
      });
      return;
    }
    if (legacyCopy(source, doc)) flash();
  }

  function appendCode(token, parent, doc) {
    // Lowercased and stripped because it becomes part of a class name and comes
    // from the model's output. className is a property rather than parsed
    // markup so this is hygiene, not the defence — the defence is that no string
    // here is ever interpreted as HTML.
    const lang = (token.lang || "").trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9+#_-]/g, "");
    const source = token.text;

    const block = el(doc, "div", "md-code-block");
    const head = el(doc, "div", "md-code-head");
    const langEl = el(doc, "span", "md-code-lang");
    text(doc, langEl, lang);
    head.appendChild(langEl);

    const btn = el(doc, "button", "md-code-copy");
    btn.setAttribute("type", "button");
    btn.textContent = COPY_LABEL;
    // `source` is the token's own text, captured here. Reading the code element
    // back at click time would mean reassembling it from however many spans the
    // highlighter split it into — which is how a copy quietly loses characters.
    btn.addEventListener("click", () => copyToClipboard(source, btn, doc));
    head.appendChild(btn);
    block.appendChild(head);

    const pre = el(doc, "pre", "md-pre");
    const code = el(doc, "code", lang ? `md-code language-${lang}` : "md-code");
    appendHighlighted(source, lang, code, doc);
    pre.appendChild(code);
    block.appendChild(pre);
    parent.appendChild(block);
  }

  function appendTable(token, parent, doc) {
    // Its own scroller: the side panel is around 370px wide, and a table without
    // one drags the whole conversation sideways.
    const wrap = el(doc, "div", "md-table-wrap");
    const table = el(doc, "table", "md-table");
    const thead = el(doc, "thead");
    const headRow = el(doc, "tr");
    for (const cell of token.header || []) {
      const th = el(doc, "th");
      appendInline(cell.tokens, th, doc);
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = el(doc, "tbody");
    for (const row of token.rows || []) {
      const tr = el(doc, "tr");
      for (const cell of row) {
        const td = el(doc, "td");
        appendInline(cell.tokens, td, doc);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    parent.appendChild(wrap);
  }

  function appendList(token, parent, doc) {
    const list = el(doc, token.ordered ? "ol" : "ul");
    if (token.ordered && token.start && token.start !== 1) list.setAttribute("start", token.start);
    for (const item of token.items || []) {
      const li = el(doc, "li");
      appendBlocks(item.tokens, li, doc, { bare: true });
      list.appendChild(li);
    }
    parent.appendChild(list);
  }

  // `bare` is what keeps a tight list item from growing a <p> around its text:
  // inside a list item marked emits the item's own words as a `text` token
  // carrying inline tokens, and wrapping that in a paragraph would put a blank
  // line inside every bullet.
  function appendBlocks(tokens, parent, doc, opts) {
    for (const t of tokens || []) {
      switch (t.type) {
        case "space":
          break;
        case "heading": {
          const depth = Math.min(6, Math.max(1, t.depth || 1));
          const h = el(doc, `h${depth}`, `md-h${depth}`);
          appendInline(t.tokens, h, doc);
          parent.appendChild(h);
          break;
        }
        case "paragraph": {
          const p = el(doc, "p");
          appendInline(t.tokens, p, doc);
          parent.appendChild(p);
          break;
        }
        case "text": {
          if (opts && opts.bare) {
            appendInline(t.tokens || [{ type: "text", text: t.text }], parent, doc);
          } else {
            const p = el(doc, "p");
            appendInline(t.tokens || [{ type: "text", text: t.text }], p, doc);
            parent.appendChild(p);
          }
          break;
        }
        case "code":
          appendCode(t, parent, doc);
          break;
        case "blockquote": {
          const quote = el(doc, "blockquote", "md-quote");
          appendBlocks(t.tokens, quote, doc);
          parent.appendChild(quote);
          break;
        }
        case "list":
          appendList(t, parent, doc);
          break;
        case "table":
          appendTable(t, parent, doc);
          break;
        case "hr":
          parent.appendChild(el(doc, "hr", "md-hr"));
          break;
        default:
          // `html` lands here on purpose: raw markup in the source is content,
          // not markup, and appending it as text is the whole defence.
          text(doc, parent, t.raw || t.text || "");
      }
    }
  }

  function toDom(source, doc) {
    const frag = doc.createDocumentFragment();
    appendBlocks(window.marked.lexer(String(source == null ? "" : source)), frag, doc);
    return frag;
  }

  window.ccMarkdown = { toDom, SAFE_LINK };
})();
