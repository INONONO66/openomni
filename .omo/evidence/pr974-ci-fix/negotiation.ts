import { connect } from "node:net";

console.log(JSON.stringify({ bun: Bun.version, revision: Bun.revision, platform: process.platform, arch: process.arch }));
for (const mode of ["title", "selected-request", "title"] as const) {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server) {
      console.log(JSON.stringify({ mode, request: req.headers.get("sec-websocket-protocol") }));
      if (mode === "selected-request") req.headers.set("sec-websocket-protocol", "auth");
      const headers = mode === "title" ? { "Sec-WebSocket-Protocol": "auth" } : undefined;
      const upgraded = server.upgrade(req, { headers });
      console.log(JSON.stringify({ mode, upgraded }));
      if (!upgraded) return new Response("failed", { status: 400 });
    },
    websocket: {
      open() { console.log(JSON.stringify({ mode, event: "server.open" })); },
      message(ws, data) { ws.send(data); },
      close() { console.log(JSON.stringify({ mode, event: "server.close" })); },
    },
  });
  const raw = connect({ host: server.url.hostname, port: Number(server.url.port) });
  const rawClosed = new Promise<void>((resolve) => raw.once("close", resolve));
  let rawTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await new Promise<string>((resolve, reject) => {
      rawTimer = setTimeout(() => reject(new Error("raw response deadline")), 2000);
      let received = "";
      raw.setEncoding("utf8");
      raw.on("error", reject);
      raw.on("data", (chunk) => { received += chunk; if (received.includes("\r\n\r\n")) resolve(received); });
      raw.once("connect", () => raw.write([
        "GET /ws HTTP/1.1", `Host: 127.0.0.1:${server.port}`, "Connection: Upgrade", "Upgrade: websocket",
        "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Protocol: other, auth, secret-token", "", "",
      ].join("\r\n")));
    });
    console.log(JSON.stringify({ mode, raw: response }));
  } finally {
    clearTimeout(rawTimer); raw.destroy(); await rawClosed;
  }
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, ["other", "auth", "secret-token"]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve(), { once: true }));
  try {
    const result = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("client response deadline")), 2000);
      ws.addEventListener("open", () => { console.log(JSON.stringify({ mode, event: "client.open", protocol: ws.protocol })); ws.send("echo"); });
      ws.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
      ws.addEventListener("error", (event) => reject(event), { once: true });
      ws.addEventListener("close", (event) => {
        console.log(JSON.stringify({ mode, event: "client.close", code: event.code, reason: event.reason }));
        resolve(`closed:${event.code}:${event.reason}`);
      }, { once: true });
    });
    console.log(JSON.stringify({ mode, result, state: ws.readyState, protocol: ws.protocol }));
  } finally {
    clearTimeout(timer);
    ws.close();
    const closeTimer = setTimeout(() => { console.error("close deadline"); process.exit(1); }, 2000);
    await closed;
    clearTimeout(closeTimer);
    await server.stop(true);
  }
}
