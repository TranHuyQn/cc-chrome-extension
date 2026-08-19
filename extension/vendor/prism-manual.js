// Loaded BEFORE prism-core.min.js, and the order is the whole point.
//
// Prism's core reads `_self.Prism && _self.Prism.manual` while it is building
// itself, and with no `Prism` global already present it defaults to automatic:
// it registers a DOMContentLoaded listener that walks the WHOLE document and
// rewrites every `<pre><code>` it finds, using innerHTML. In this panel that
// would mean a vendored library editing the conversation log behind the
// renderer's back — exactly the thing extension/panel-markdown.js exists to
// prevent. We only ever call Prism.tokenize() ourselves.
//
// This has to be a file rather than an inline <script> because MV3's default
// CSP (`script-src 'self'`) blocks inline script in extension pages.
window.Prism = { manual: true };
