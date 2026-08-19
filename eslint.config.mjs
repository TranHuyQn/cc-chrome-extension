import js from "@eslint/js";
import globals from "globals";

export default [
  {
    // extension/vendor/** is vendored third-party code, copied byte for byte and
    // never edited here — linting it would only produce noise nobody may act on,
    // because acting on it means diverging from upstream. The version of each
    // file is recorded in CLAUDE.md; that is what an update is driven from.
    ignores: ["dist/**", "node_modules/**", "**/node_modules/**", "extension/vendor/**"],
  },
  js.configs.recommended,
  {
    // MCP server, build scripts, e2e tests — Node.js ESM
    files: ["server/**/*.js", "scripts/**/*.mjs", "test/**/*.mjs", "deploy/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      // `chrome` and `self` appear inside page.evaluate()/sw.evaluate() callbacks,
      // which run in the browser/service worker, not in this Node process.
      globals: { ...globals.node, chrome: "readonly", self: "readonly" },
    },
  },
  {
    // Extension: MV3 service worker + popup. background.js also contains
    // functions that are injected into pages, so browser globals (window,
    // document, getComputedStyle) are legitimate here.
    files: ["extension/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        chrome: "readonly",
        ccLabels: "readonly",
        ccJournal: "readonly",
        ccMarkdown: "readonly",
        // Vendored into extension/vendor/, loaded by sidepanel.html before the
        // panel's own scripts. Used for their lexers only — see panel-markdown.js.
        marked: "readonly",
        Prism: "readonly",
        // The file declares its own `status`; the deprecated window.status
        // global would otherwise be reported as a redeclaration.
        status: "off",
      },
    },
  },
  {
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // `try { ... } catch {}` is used deliberately for best-effort cleanup.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Defensive `let x = {}` before a try/catch assignment is intentional.
      "no-useless-assignment": "off",
    },
  },
];
