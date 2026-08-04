import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "**/node_modules/**"],
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
