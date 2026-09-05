import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOpenOmni } from "../../../apps/openomni/src/index";
import { assistantMessage } from "../../../apps/openomni/test/helpers/assistant-message";

const directory = mkdtempSync(join(tmpdir(), "pr974-manual-"));
const token = "ci-fix-manual-token";
let providerCalls = 0;
const app = await startOpenOmni({
  config: {
    dbPath: join(directory, "chat.db"), host: "127.0.0.1", wsPort: 0, wsToken: token,
    model: { provider: "fake", id: "manual", apiKey: "test" },
  },
  llm: {
    resolveProviderModel: async (model) => ({ id: model.id, name: model.id, providerID: model.provider }),
    run: async (input, sink) => {
      providerCalls += 1;
      sink.onMessage(assistantMessage(input, { text: "canonical real-app reply" }));
      return { type: "stop" };
    },
  },
});
const db = new Database(join(directory, "chat.db"), { readonly: true });
console.log(JSON.stringify({ bun: Bun.version, revision: Bun.revision, platform: process.platform, arch: process.arch, port: app.port, directory }));

async function handshake(path: string, protocols?: string) {
  const socket = connect({ host: "127.0.0.1", port: app.port });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("handshake deadline")), 2000);
      let received = "";
      socket.setEncoding("utf8");
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        received += chunk;
        if (received.includes("\r\n\r\n")) resolve(received);
      });
      socket.once("connect", () => socket.write([
        `GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${app.port}`, "Connection: Upgrade", "Upgrade: websocket",
        "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ...(protocols === undefined ? [] : [`Sec-WebSocket-Protocol: ${protocols}`]), "", "",
      ].join("\r\n")));
    });
    console.log(JSON.stringify({ path, protocols, raw }));
    return {
      status: Number(raw.split(" ")[1]),
      selected: raw.split("\r\n").filter((line) => /^sec-websocket-protocol:/i.test(line))
        .map((line) => line.slice(line.indexOf(":") + 1).trim()),
    };
  } finally {
    clearTimeout(timer);
    socket.destroy();
    await closed;
  }
}

try {
  assert.equal((await handshake(`/ws?token=${token}`)).status, 401);
  assert.equal((await handshake(`/ws?token=${token}`, "auth, wrong-token")).status, 401);
  assert.equal(providerCalls, 0);
  assert.deepEqual(db.query("SELECT COUNT(*) AS count FROM session").get(), { count: 0 });
  for (const protocols of [["auth", token], ["other", "auth", token]]) {
    assert.deepEqual(await handshake("/ws", protocols.join(", ")), { status: 101, selected: ["auth"] });
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, protocols);
    const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve(), { once: true }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("reply deadline")), 2000);
        ws.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
        ws.addEventListener("error", () => reject(new Error("WebSocket error")), { once: true });
        ws.addEventListener("close", (event) => reject(new Error(`early close ${event.code}: ${event.reason}`)), { once: true });
        ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "message", text: "canonical input" })), { once: true });
      });
      assert.equal(ws.protocol, "auth");
      assert.deepEqual(JSON.parse(reply), { type: "response", text: "canonical real-app reply" });
      console.log(JSON.stringify({ offered: protocols, selected: ws.protocol, reply: JSON.parse(reply), providerCalls }));
    } finally {
      clearTimeout(timer);
      ws.close();
      const deadline = setTimeout(() => { throw new Error("close deadline"); }, 2000);
      try { await closed; } finally { clearTimeout(deadline); }
    }
  }
  assert.equal(providerCalls, 2);
  const sessions = db.query("SELECT role, state FROM session").all();
  assert.deepEqual(sessions, [{ role: "resident", state: "idle" }, { role: "resident", state: "idle" }]);
  console.log(JSON.stringify({ sessions, actions: db.query("SELECT COUNT(*) AS count FROM action").get() }));
} finally {
  db.close();
  await app.stop();
  rmSync(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ cleanup: true, directoryExists: existsSync(directory), port: app.port }));
}
