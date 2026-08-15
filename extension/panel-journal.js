// What the panel has already drawn, kept so reopening the panel does not show a
// blank log for a conversation the server is perfectly happy to --resume.
//
// Stored in the extension rather than rebuilt from the CLI's own transcript
// files: this survives a bridge restart, it is exactly what the user saw, and
// it does not depend on an internal file format that has already changed once
// (tool_result.content is a string in one CLI path and an array in another).
//
// Keyed per window by the caller, the same way panelSession.<windowId> is: two
// panels in two Chrome windows are two conversations.
window.ccJournal = (() => {
  // Two caps, because either one alone is escapable: 400 tiny entries is
  // nothing, and one step_end carrying a summary is not.
  const MAX_ENTRIES = 400;
  const MAX_BYTES = 512 * 1024;
  const SAVE_DEBOUNCE_MS = 500;

  let key = null;
  let entries = [];
  // Size of each entry, kept alongside rather than recomputed: trimming would
  // otherwise re-stringify the whole journal on every single push.
  let sizes = [];
  let bytes = 0;
  let saveTimer = null;

  function trim() {
    while (entries.length > 1 && (entries.length > MAX_ENTRIES || bytes > MAX_BYTES)) {
      bytes -= sizes.shift();
      entries.shift();
    }
  }

  function schedule() {
    if (saveTimer || !key) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (key) chrome.storage.local.set({ [key]: entries });
    }, SAVE_DEBOUNCE_MS);
  }

  async function load(storageKey) {
    // A pending debounced write belongs to the PREVIOUS key and holds entries
    // that are not on disk yet. Clearing its timer without flushing would drop
    // them silently, so it is written out now, under the key it was queued for.
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      if (key) chrome.storage.local.set({ [key]: entries });
    }
    key = storageKey;
    const got = await chrome.storage.local.get({ [key]: [] });
    entries = Array.isArray(got[key]) ? got[key] : [];
    sizes = entries.map((entry) => JSON.stringify(entry).length);
    bytes = sizes.reduce((sum, n) => sum + n, 0);
    return entries;
  }

  function push(entry) {
    let size;
    try {
      size = JSON.stringify(entry).length;
    } catch {
      return; // not storable, so not worth keeping
    }
    entries.push(entry);
    sizes.push(size);
    bytes += size;
    trim();
    schedule();
  }

  function clear() {
    entries = [];
    sizes = [];
    bytes = 0;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (key) chrome.storage.local.set({ [key]: [] });
  }

  // An entry can be journalled before its final text exists: the panel records
  // an assistant bubble the moment streaming starts, so it holds its true
  // position relative to the tool rows around it, and fills the text in later.
  // Matched by identity, not by value — the caller holds the object.
  function resize(entry) {
    const i = entries.indexOf(entry);
    if (i === -1) return;
    let size;
    try {
      size = JSON.stringify(entry).length;
    } catch {
      return;
    }
    bytes += size - sizes[i];
    sizes[i] = size;
    trim();
    schedule();
  }

  return { load, push, clear, resize, entries: () => entries, MAX_ENTRIES, MAX_BYTES };
})();
