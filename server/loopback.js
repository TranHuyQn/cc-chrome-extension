// Two different questions about "is this reachable only from this machine?",
// kept together because the /panel gate has to answer both and getting either
// one wrong re-opens a process spawn to the network.
//
//   isLoopbackHost    — the address the server was told to bind to. A config
//                       value, so the name "localhost" counts.
//   isLoopbackAddress — the peer address of a connection that actually
//                       arrived. Kernel-supplied, so it is never a name, but on
//                       a dual-stack socket a v4 peer arrives IPv4-mapped
//                       (::ffff:127.0.0.1) and any 127.0.0.0/8 address is
//                       loopback, not just 127.0.0.1.
//
// Split into its own module so both can be unit-tested directly: a non-loopback
// peer cannot be arranged against a loopback-bound listener (the kernel will
// not route it), so a table test is the only way to cover that branch at all.

export function isLoopbackHost(host) {
  const bare = String(host || "").replace(/^\[|\]$/g, "");
  return bare === "127.0.0.1" || bare === "localhost" || bare === "::1";
}

export function isLoopbackAddress(address) {
  let bare = String(address || "").replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(bare);
  if (mapped) bare = mapped[1];
  // Link-local addresses carry a zone id (fe80::1%lo0); it is not part of the
  // address and must not be compared as if it were.
  const zone = bare.indexOf("%");
  if (zone !== -1) bare = bare.slice(0, zone);
  if (bare === "::1") return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (!octets) return false;
  return octets[1] === "127" && octets.slice(1).every((part) => Number(part) <= 255);
}

// Presence, not value: a request carrying any of these proves something is
// forwarding on behalf of somebody else, whatever the peer address says. The
// values themselves are client-supplied and are deliberately not consulted.
export const FORWARDED_HEADERS = ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host"];

export function forwardedHeadersIn(headers = {}) {
  return FORWARDED_HEADERS.filter((name) => headers[name] !== undefined);
}
