import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sink } from "@openomni/llm";
import { Session, Storage, SurfaceKey } from "@openomni/ledger";
import type { Message } from "@openomni/protocol";
import { loadConfig, type OpenOmniConfig } from "../src/config";
import { startOpenOmni } from "../src/index";
import { assistantMessage } from "./helpers/assistant-message";

const REPLY = "A deterministic Resident reply.";
const directories: string[] = [];
let stopApp: (() => void) | undefined;

function nextMessage(ws: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("WebSocket reply timed out after 2000ms")),
      2_000,
    );
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        resolve(event);
      },
      { once: true },
    );
  });
}

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("WebSocket open timed out after 2000ms")),
      2_000,
    );
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket failed before opening"));
      },
      { once: true },
    );
  });
}

afterEach(() => {
  stopApp?.();
  stopApp = undefined;
  Storage.reset();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const WS_TOKEN = "e2e-upgrade-token";

async function bootWithConfig(config: OpenOmniConfig): Promise<{ port: number }> {
  const app = await startOpenOmni({
    config,
    llm: {
      resolveProviderModel: async (model) => ({
        id: model.id,
        name: model.id,
        providerID: model.provider,
      }),
      run: async (input, sink: Sink) => {
        sink.onMessage(assistantMessage(input, { id: "fake-assistant-message", text: REPLY }));
        return { type: "stop" };
      },
    },
  });
  stopApp = app.stop;
  return { port: app.port };
}

async function bootApp(
  channels?: NonNullable<OpenOmniConfig["channels"]>,
): Promise<{ port: number }> {
  const directory = mkdtempSync(join(tmpdir(), "openomni-resident-"));
  directories.push(directory);
  return bootWithConfig({
    dbPath: join(directory, "chat.db"),
    memoryPath: join(directory, "memory.json"),
    host: "127.0.0.1",
    wsPort: 0,
    wsToken: WS_TOKEN,
    model: { provider: "fake", id: "resident-test", apiKey: "test-key" },
    ...(channels === undefined ? {} : { channels }),
  });
}

// Every variable loadConfig() reads, so the env-path parity test below is
// deterministic regardless of the shell it runs in.
const CONFIG_ENV = [
  "DISCORD_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_TOKEN",
  "GITHUB_BOT_USERNAME",
  "OPENOMNI_DB_PATH",
  "OPENOMNI_MEMORY_PATH",
  "OPENOMNI_WS_HOST",
  "OPENOMNI_WS_PORT",
  "OPENOMNI_WS_TOKEN",
  "OPENOMNI_MODEL_PROVIDER",
  "OPENOMNI_MODEL_ID",
  "OPENOMNI_MODEL_API_KEY",
  "OPENOMNI_ACTORS",
  "OPENOMNI_SOCIAL_BUDGETS",
  "OPENOMNI_MACHINES_ENROLLED",
  "OPENOMNI_MACHINES_SOCKET",
] as const;

describe("OpenOmni Resident WebSocket", () => {
  it("boots WebSocket-only when no channel credentials are configured", async () => {
    const app = await bootApp();

    const webhook = await fetch(`http://127.0.0.1:${app.port}/github/webhook`, {
      method: "POST",
    });
    expect(webhook.status).toBe(404);
    expect(await webhook.text()).toBe("Not found");

    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws?token=${WS_TOKEN}`);
    await opened(ws);
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ type: "message", text: "Help me judge this." }));

    const event = await reply;
    expect(JSON.parse(String(event.data))).toEqual({ type: "response", text: REPLY });

    const sessions = Session.list();
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    if (session === undefined) throw new Error("Expected one persisted session");
    expect(session.model).toEqual({ providerID: "fake", modelID: "resident-test" });

    const messages = Session.getMessages(session.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(
      messages.map((message) => Session.getParts(message.id).map((part) => part.type)),
    ).toEqual([["text"], ["text"]]);
    expect(
      messages.map((message) =>
        Session.getParts(message.id)
          .filter((part): part is Message.TextPart => part.type === "text")
          .map((part) => part.text),
      ),
    ).toEqual([["Help me judge this."], [REPLY]]);

    const surfaceKeys = SurfaceKey.listBySession(session.id);
    expect(surfaceKeys).toHaveLength(1);
    expect(surfaceKeys[0]).toStartWith("ws:");
    ws.close();
  });

  it("boots WebSocket-only through loadConfig when channel env vars are unset", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openomni-resident-"));
    directories.push(directory);
    const saved = new Map<string, string | undefined>();
    for (const name of CONFIG_ENV) saved.set(name, process.env[name]);
    try {
      for (const name of CONFIG_ENV) delete process.env[name];
      process.env.OPENOMNI_DB_PATH = join(directory, "chat.db");
      process.env.OPENOMNI_MEMORY_PATH = join(directory, "memory.json");
      process.env.OPENOMNI_WS_PORT = "0";
      process.env.OPENOMNI_WS_TOKEN = WS_TOKEN;
      process.env.OPENOMNI_MODEL_PROVIDER = "fake";
      process.env.OPENOMNI_MODEL_ID = "resident-test";
      process.env.OPENOMNI_MODEL_API_KEY = "test-key";

      // The real env/config path: with no channel credentials present, the
      // env-presence gate must leave every driver unwired.
      const config = loadConfig();
      expect(config.channels).toBeUndefined();

      const app = await bootWithConfig(config);
      const webhook = await fetch(`http://127.0.0.1:${app.port}/github/webhook`, {
        method: "POST",
      });
      expect(webhook.status).toBe(404);
      expect(await webhook.text()).toBe("Not found");
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("wires only the credentialed driver through loadConfig when env is partially set", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openomni-resident-"));
    directories.push(directory);
    const saved = new Map<string, string | undefined>();
    for (const name of CONFIG_ENV) saved.set(name, process.env[name]);
    try {
      for (const name of CONFIG_ENV) delete process.env[name];
      process.env.OPENOMNI_DB_PATH = join(directory, "chat.db");
      process.env.OPENOMNI_MEMORY_PATH = join(directory, "memory.json");
      process.env.OPENOMNI_WS_PORT = "0";
      process.env.OPENOMNI_WS_TOKEN = WS_TOKEN;
      process.env.OPENOMNI_MODEL_PROVIDER = "fake";
      process.env.OPENOMNI_MODEL_ID = "resident-test";
      process.env.OPENOMNI_MODEL_API_KEY = "test-key";
      process.env.GITHUB_WEBHOOK_SECRET = "github-webhook-secret";

      const config = loadConfig();
      expect(config.channels).toEqual({ github: { secret: "github-webhook-secret" } });

      const app = await bootWithConfig(config);
      const webhook = await fetch(`http://127.0.0.1:${app.port}/github/webhook`, {
        method: "POST",
        body: "{}",
      });
      expect(webhook.status).toBe(401);
      expect(await webhook.text()).toBe("Missing signature");
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("mounts a configured GitHub driver on the existing HTTP server", async () => {
    const app = await bootApp({ github: { secret: "github-webhook-secret" } });

    const response = await fetch(`http://127.0.0.1:${app.port}/github/webhook`, {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Missing signature");
  });

  it("rejects an upgrade carrying the wrong token", async () => {
    const app = await bootApp();

    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws?token=wrong-token`);
    await expect(opened(ws)).rejects.toThrow("WebSocket failed before opening");
    expect(Session.list()).toHaveLength(0);
  });
});
