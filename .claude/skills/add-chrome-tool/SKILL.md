---
name: add-chrome-tool
description: Add a new browser tool to the Chrome Bridge end to end — MCP tool in server/index.js, handler in extension/background.js, e2e assertion, README row. Use when asked to add, rename, or remove a browser capability exposed to Claude Code.
---

A tool only works when all four pieces exist. Do them in this order and stop at the first mismatch.

## 1. Extension handler — `extension/background.js`

Add a key to the `handlers` object. The key is the wire method name.

```js
async my_tool(params) {
  const tab = await resolveTab(params);        // honors params.tabId, falls back to active tab
  return await execInTab(tab, pageMyTool, [params.someArg ?? default]);
}
```

- Anything touching the DOM goes through `execInTab` with a `pageXxx` function. Those are injected
  into the page: **no closures**, inline every helper, and end the body with
  `} catch (e) { return { __cc_err: e.message }; }` — thrown exceptions are swallowed by
  `chrome.scripting` and surface as a useless "no result".
- Anything needing CDP (keyboard, eval, console, network, full-page screenshot) goes through
  `ensureDebugger(tabId, [domains])` + `cdp(tabId, method, params)` instead.
- Element refs: read them from `window.__cc_refs`; a missing ref must produce a message telling
  Claude to call `read_page` again, matching the existing "stale ref" wording.
- Throw `Error` with an actionable message rather than returning error objects.

## 2. MCP tool — `server/index.js`

Inside `buildMcpServer()`, register with the same name as the handler key:

```js
tool(
  "my_tool",
  "One line telling Claude when to reach for this and what it gets back.",
  {
    someArg: z.string().describe("..."),
    tabId: tabIdSchema,
  },
  async (args) => textResult(await call("my_tool", args))
);
```

Reuse `tabIdSchema` for tab targeting and `textResult` for the response. Pass a custom
`timeoutMs` as the third arg of `call()` only for tools that can legitimately outrun the default 45s.
Descriptions are read by the model at every session — say when to use the tool, not how it works.

## 3. E2E coverage — `test/e2e.mjs`

The test serves its own fixture pages from an in-process HTTP server and drives the real MCP client.
Add an assertion next to the related tools:

```js
r = await client.callTool("my_tool", { someArg: "..." });
check("my_tool does X", toolText(r).includes("expected"));
```

If the tool needs new markup, extend the fixture HTML in the same file. Run
`node test/e2e.mjs` and confirm the new line prints `PASS` — a Chromium at the hardcoded
`executablePath` is required (see CLAUDE.md).

## 4. README

Add a row to the tool table under "Tools cung cấp cho Claude Code" (Vietnamese description, matching
the existing groups). If the tool adds an env var, add it to the config table too.

## Checklist before reporting done

- [ ] Handler key in `background.js` === tool name in `index.js`
- [ ] Injected function is self-contained and returns `__cc_err` on failure
- [ ] `node test/e2e.mjs` passes, including the new assertion
- [ ] README tool table updated
- [ ] No `console.log` added to `server/index.js` (stdout is the MCP transport)
