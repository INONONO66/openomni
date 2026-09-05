export {};

const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(request, server) { if (!server.upgrade(request)) return new Response("failed", { status: 400 }); },
  websocket: { message(ws) { ws.send("x".repeat(4096)); } },
});
const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, ["auth", "secret"]);
const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve(), { once: true }));
const deadline = setTimeout(() => { throw new Error("probe deadline"); }, 2000);
try {
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("error", () => reject(new Error("socket error")), { once: true });
    ws.addEventListener("open", () => {
      console.log(JSON.stringify({ bun: Bun.version, when: "open", protocol: ws.protocol }));
      ws.send("reply");
    }, { once: true });
    ws.addEventListener("message", (event) => {
      console.log(JSON.stringify({ bun: Bun.version, when: "message", protocol: ws.protocol, length: String(event.data).length }));
      resolve();
    }, { once: true });
  });
} finally {
  ws.close(); await closed; await server.stop(true); clearTimeout(deadline);
}
