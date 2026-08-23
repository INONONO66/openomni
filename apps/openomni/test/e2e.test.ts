import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunInput, Sink } from "@openomni/llm";
import { Session, Storage, SurfaceKey } from "@openomni/ledger";
import type { Message } from "@openomni/protocol";
import { startOpenOmni } from "../src/index";

const REPLY = "A deterministic Resident reply.";
const directories: string[] = [];
let stopApp: (() => void) | undefined;

function assistantMessage(input: RunInput): Message.WithParts {
  const id = "fake-assistant-message";
  const sessionID = input.trace.sessionId;
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "",
      modelID: input.model.id,
      providerID: input.model.providerID,
      agent: "resident",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 4, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      { id: `${id}-text`, sessionID, messageID: id, type: "text", text: REPLY },
      {
        id: `${id}-finish`,
        sessionID,
        messageID: id,
        type: "step-finish",
        reason: "stop",
        cost: 0,
        tokens: { input: 4, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ],
  };
}

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

function bootApp(): { port: number } {
  const directory = mkdtempSync(join(tmpdir(), "openomni-resident-"));
  directories.push(directory);
  const app = startOpenOmni({
    config: {
      dbPath: join(directory, "chat.db"),
      host: "127.0.0.1",
      wsPort: 0,
      wsToken: WS_TOKEN,
      model: { provider: "fake", id: "resident-test", apiKey: "test-key" },
    },
    llm: {
      resolveProviderModel: async (model) => ({
        id: model.id,
        name: model.id,
        providerID: model.provider,
      }),
      run: async (input, sink: Sink) => {
        sink.onMessage(assistantMessage(input));
        return { type: "stop" };
      },
    },
  });
  stopApp = app.stop;
  return { port: app.port };
}

describe("OpenOmni Resident WebSocket", () => {
  it("routes one turn, writes the reply, and persists both messages", async () => {
    const app = bootApp();

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

  it("rejects an upgrade carrying the wrong token", async () => {
    const app = bootApp();

    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws?token=wrong-token`);
    await expect(opened(ws)).rejects.toThrow("WebSocket failed before opening");
    expect(Session.list()).toHaveLength(0);
  });
});
