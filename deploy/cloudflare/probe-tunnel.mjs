// Proves whether the proxy in front of the bridge forwards the WebSocket
// subprotocol that carries the token. Since 2.0.0 the token travels in
// `Sec-WebSocket-Protocol`, and a proxy that strips it makes every extension
// fail with "Token sai" while the token is perfectly valid — a failure that is
// almost impossible to diagnose from the extension side.
//
// Raw handshake on purpose: no dependencies, and the 101 response headers are
// exactly the evidence needed.
//
// Usage:
//   node deploy/cloudflare/probe-tunnel.mjs https://chrome.example.com <token>

import { request } from "node:https";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";

const [, , rawUrl, token] = process.argv;
if (!rawUrl || !token) {
  console.error("Usage: node deploy/cloudflare/probe-tunnel.mjs https://<domain> <token>");
  process.exit(2);
}

const base = new URL(rawUrl.replace(/\/+$/, ""));
const wsUrl = new URL("/ws", base);
const secure = base.protocol === "https:";
const doRequest = secure ? request : httpRequest;
const SUBPROTOCOL = `ccchrome.token.${token}`;

// The server only accepts a chrome-extension:// origin, so the probe has to
// present one. This is not a bypass — it is what the real extension sends.
const headers = {
  Connection: "Upgrade",
  Upgrade: "websocket",
  "Sec-WebSocket-Version": "13",
  "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
  "Sec-WebSocket-Protocol": SUBPROTOCOL,
  Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const CLOSE_MEANING = {
  4001: "token không hợp lệ (server ĐÃ nhận được subprotocol nhưng token sai hoặc đã thu hồi)",
  4002: "server KHÔNG nhận được subprotocol — nhiều khả năng proxy đã cắt header",
  4003: "origin bị từ chối",
};

let settled = false;
function done(code, lines) {
  if (settled) return;
  settled = true;
  for (const line of lines) console.log(line);
  process.exit(code);
}

const req = doRequest(
  { hostname: base.hostname, port: base.port || (secure ? 443 : 80), path: wsUrl.pathname, headers },
  (res) => {
    // Anything that is not a 101 never reached the bridge as an upgrade.
    const body = [];
    res.on("data", (c) => body.push(c));
    res.on("end", () =>
      done(1, [
        `✗ Proxy trả về HTTP ${res.statusCode}, không phải 101 Switching Protocols.`,
        `  server: ${res.headers.server || "(không rõ)"}`,
        `  cf-ray: ${res.headers["cf-ray"] || "(không có — request có thể chưa qua Cloudflare)"}`,
        "",
        Buffer.concat(body).toString().slice(0, 400),
        "",
        "  Nghĩa là request chưa tới được bridge. Kiểm tra ingress của cloudflared,",
        "  container còn sống không, và hostname đã trỏ đúng chưa.",
      ])
    );
  }
);

req.on("upgrade", (res, socket) => {
  const echoed = res.headers["sec-websocket-protocol"];
  const ray = res.headers["cf-ray"] || "(không có)";
  const headerSurvived = echoed === SUBPROTOCOL;

  // The echo alone only proves the header reached the server: `handleProtocols`
  // selects the subprotocol before the token is checked, so a bad token is
  // echoed too and then closed. The close frame is what separates the cases,
  // and a connection that stays open is the only real success.
  const verdict = setTimeout(() => {
    socket.destroy();
    if (headerSurvived) {
      done(0, [
        "✓ ĐẠT — proxy forward nguyên vẹn Sec-WebSocket-Protocol, và token hợp lệ.",
        `  Server echo lại: ${echoed}`,
        `  Kết nối mở và không bị đóng — cf-ray: ${ray}`,
        "",
        "  Extension sẽ kết nối được qua domain này.",
      ]);
    } else {
      done(1, [
        "✗ HỎNG — server không echo lại subprotocol và cũng không đóng kết nối.",
        `  cf-ray: ${ray}`,
        "  Bất thường. Bắt log container trong lúc chạy lại lệnh này.",
      ]);
    }
  }, 2000);

  socket.once("data", (buf) => {
    clearTimeout(verdict);
    socket.destroy();
    // Minimal close-frame read: 0x88 = FIN + opcode 8 (close), then the length,
    // then a big-endian uint16 status code.
    let code = null;
    if (buf.length >= 4 && (buf[0] & 0x0f) === 0x8) code = buf.readUInt16BE(2);

    if (code === 4002 || !headerSurvived) {
      done(1, [
        "✗ HỎNG — proxy đã CẮT header Sec-WebSocket-Protocol.",
        `  Close code: ${code ?? "(không đọc được)"} — ${CLOSE_MEANING[code] || "không rõ"}`,
        `  Echo subprotocol: ${echoed ? echoed : "KHÔNG có"}`,
        `  cf-ray: ${ray}`,
        "",
        "  → Đây là lỗi hạ tầng, không phải lỗi token. Đọc mục 'Bẫy đã biết'",
        "    trong docs/deploy-cloudflare-tunnel.md trước khi phát cho team.",
      ]);
      return;
    }

    done(1, [
      "◐ Header ĐI QUA ĐƯỢC proxy, nhưng server từ chối kết nối.",
      `  Server echo lại: ${echoed}`,
      `  Close code: ${code ?? "(không đọc được)"} — ${CLOSE_MEANING[code] || "không rõ"}`,
      `  cf-ray: ${ray}`,
      "",
      code === 4001
        ? "  → Hạ tầng ỔN. Chỉ là token bạn truyền vào lệnh này sai hoặc đã bị thu hồi."
        : "  → Kiểm tra lại tham số truyền vào lệnh.",
    ]);
  });
});

req.on("error", (err) =>
  done(1, [`✗ Không kết nối được tới ${base.host}: ${err.message}`])
);

req.end();
