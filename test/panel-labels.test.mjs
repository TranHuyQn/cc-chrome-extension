// Usage: node test/panel-labels.test.mjs
//
// extension/panel-labels.js is a classic browser script, not a module: it
// assigns one global (window.ccLabels) and has no imports. So it is testable
// from Node by evaluating it against a stand-in `window` — no browser, no
// Playwright, and therefore fast enough to sit in `npm test`.
//
// Locale detection is the reason this file exists. It is a heuristic, and a
// heuristic without a table of cases is just a guess that nobody can check.

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

const sandbox = { window: {} };
sandbox.globalThis = sandbox;
runInNewContext(readFileSync(join(root, "extension", "panel-labels.js"), "utf8"), sandbox);
const ccLabels = sandbox.window.ccLabels;

check("the file exposes exactly one global", !!ccLabels, JSON.stringify(Object.keys(sandbox.window)));

// --- tool labels -------------------------------------------------------------

check("a known tool gets a Vietnamese label", ccLabels.stepLabel("read_page", "vi") === "Đọc trang", ccLabels.stepLabel("read_page", "vi"));
check("and an English one", ccLabels.stepLabel("read_page", "en") === "Read page", ccLabels.stepLabel("read_page", "en"));
check("the mcp__chrome__ prefix is stripped", ccLabels.stepLabel("mcp__chrome__new_tab", "vi") === "Mở tab", ccLabels.stepLabel("mcp__chrome__new_tab", "vi"));
check("an unknown tool falls back to its own name rather than a blank row",
  ccLabels.stepLabel("mcp__chrome__some_future_tool", "vi") === "some_future_tool",
  ccLabels.stepLabel("mcp__chrome__some_future_tool", "vi"));
check("a missing name never renders undefined",
  typeof ccLabels.stepLabel(undefined, "vi") === "string" && !ccLabels.stepLabel(undefined, "vi").includes("undefined"),
  ccLabels.stepLabel(undefined, "vi"));

// --- subtitles ---------------------------------------------------------------

check("a url is the subtitle when there is one", ccLabels.stepSubtitle({ url: "https://example.com" }) === "https://example.com", ccLabels.stepSubtitle({ url: "https://example.com" }));
check("a query wins when there is no url", ccLabels.stepSubtitle({ query: "đăng nhập", maxResults: 5 }) === "đăng nhập", ccLabels.stepSubtitle({ query: "đăng nhập" }));
check("a ref is shown when that is all there is", ccLabels.stepSubtitle({ ref: 12 }) === "12", ccLabels.stepSubtitle({ ref: 12 }));
check("no interesting key means no subtitle", ccLabels.stepSubtitle({ maxElements: 150 }) === "", ccLabels.stepSubtitle({ maxElements: 150 }));
check("an empty input is safe", ccLabels.stepSubtitle(undefined) === "", ccLabels.stepSubtitle(undefined));
check("a long subtitle is cut", ccLabels.stepSubtitle({ text: "z".repeat(200) }).length <= 61, String(ccLabels.stepSubtitle({ text: "z".repeat(200) }).length));

// --- sizes -------------------------------------------------------------------

check("bytes under 1KB are shown as bytes", ccLabels.formatSize(512) === "512B", ccLabels.formatSize(512));
check("a big result is shown in KB", ccLabels.formatSize(12700) === "12.4KB", ccLabels.formatSize(12700));

// --- locale detection --------------------------------------------------------
//
// The trap this table exists for: Vietnamese is very often typed without
// diacritics. Detecting on diacritics alone would read "mo tab github roi tim
// repo" as English and flip the whole status bar mid-conversation.

check("diacritics settle it immediately", ccLabels.detectLocale("mở tab github", "en") === "vi");
check("Vietnamese typed WITHOUT diacritics is still Vietnamese",
  ccLabels.detectLocale("mo tab github roi tim repo", "en") === "vi",
  ccLabels.detectLocale("mo tab github roi tim repo", "en"));
check("plain English is English", ccLabels.detectLocale("open the console and check for errors", "vi") === "en",
  ccLabels.detectLocale("open the console and check for errors", "vi"));
check("an ambiguous prompt keeps the previous language", ccLabels.detectLocale("github.com", "en") === "en");
check("and keeps it the other way too", ccLabels.detectLocale("github.com", "vi") === "vi");
check("an empty prompt keeps the previous language", ccLabels.detectLocale("", "en") === "en");
check("a non-string never throws", ccLabels.detectLocale(null, "vi") === "vi");

console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
