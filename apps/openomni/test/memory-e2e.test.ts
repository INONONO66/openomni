import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunInput, Sink } from "@openomni/llm";
import { Storage } from "@openomni/ledger";
import type { Message } from "@openomni/protocol";
import { startOpenOmni } from "../src/index";

let stopApp: (() => void) | undefined;
const directories: string[] = [];

afterEach(() => {
  stopApp?.();
  stopApp = undefined;
  Storage.reset();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const WS_TOKEN = "memory-e2e-token";

function message(input: RunInput, text: string): Message.WithParts {
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
      { id: `${id}-text`, sessionID, messageID: id, type: "text", text },
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

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("open timed out")), 2_000);
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

function nextMessage(ws: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("reply timed out")), 2_000);
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

async function ask(ws: WebSocket, text: string): Promise<string> {
  const reply = nextMessage(ws);
  ws.send(JSON.stringify({ type: "message", text }));
  const event = await reply;
  return JSON.parse(String(event.data)).text as string;
}

it("memory writes render next session, never mid-session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openomni-memory-e2e-"));
  directories.push(directory);

  // The fake Resident: on a "remember" ask it writes memory through its own
  // tool executor; every turn reports whether its system prompt held memory.
  const app = await startOpenOmni({
    config: {
      dbPath: join(directory, "chat.db"),
      memoryPath: join(directory, "memory.json"),
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
        const offered = (input.tools ?? []).map((tool) => tool.name);
        const ask = input.messages.at(-1)?.parts.find((part) => part.type === "text");
        let wrote = "";
        if (ask?.type === "text" && ask.text.startsWith("remember:")) {
          const result = await input.toolExecutor?.({
            id: "memory-call",
            tool: "memory",
            input: { action: "add", store: "owner", content: ask.text.slice("remember:".length) },
          });
          wrote = ` wrote=${result?.output ?? "nothing"}`;
        }
        const held = input.system?.includes("# Memory")
          ? `memory:[${/- \[[0-9a-f-]{8}\] (.*)$/m.exec(input.system ?? "")?.[1] ?? ""}]`
          : "memory:none";
        sink.onMessage(message(input, `${held} offered=${offered.includes("memory")}${wrote}`));
        return { type: "stop" };
      },
    },
  });
  stopApp = app.stop;

  // Session A, turn 1: nothing remembered yet; the tool is offered; a write lands.
  const first = new WebSocket(`ws://127.0.0.1:${app.port}/ws?token=${WS_TOKEN}`);
  await opened(first);
  const turn1 = await ask(first, "remember: the Owner prefers worktrees");
  expect(turn1).toContain("memory:none");
  expect(turn1).toContain("offered=true");
  expect(turn1).toContain("wrote=remembered as [");

  // Session A, turn 2: the snapshot was frozen at session start — still none.
  const turn2 = await ask(first, "and now?");
  expect(turn2).toContain("memory:none");
  first.close();

  // Session B (new connection = new surface = new session): the write renders.
  const second = new WebSocket(`ws://127.0.0.1:${app.port}/ws?token=${WS_TOKEN}`);
  await opened(second);
  const turn3 = await ask(second, "what do you know?");
  expect(turn3).toContain("memory:[ the Owner prefers worktrees]");
  second.close();
}, 15_000);
