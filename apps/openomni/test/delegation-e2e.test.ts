import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunInput, Sink } from "@openomni/llm";
import { Storage } from "@openomni/ledger";
import type { Message } from "@openomni/protocol";
import { startOpenOmni } from "../src/index";

const WS_TOKEN = "delegation-e2e-token";
const WORKER_ANSWER = "the build is green";

const directories: string[] = [];
let stopApp: (() => void) | undefined;

afterEach(() => {
  stopApp?.();
  stopApp = undefined;
  Storage.reset();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * The Resident's first turn calls the tool, the worker's turn answers, and the
 * Resident's second turn reports it. Which loop is speaking is read from the
 * session id, because a worker runs in a delegation session of its own — the
 * same fact the runtime uses to keep the two transcripts apart.
 */
function message(input: RunInput, parts: Message.WithParts["parts"]): Message.WithParts {
  const id = `fake-${input.trace.sessionId}-${input.messages.length}`;
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
      ...parts.map((part) => ({ ...part, id: `${id}-${part.type}`, sessionID, messageID: id })),
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

test("a Resident turn hands work to an inline worker and reports what came back", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openomni-delegation-"));
  directories.push(directory);
  const seen: string[] = [];

  const app = await startOpenOmni({
    config: {
      dbPath: join(directory, "chat.db"),
      memoryPath: join(directory, "memory.json"),
      host: "127.0.0.1",
      wsPort: 0,
      wsToken: WS_TOKEN,
      model: { provider: "fake", id: "delegation-test", apiKey: "test-key" },
    },
    llm: {
      resolveProviderModel: async (model) => ({ id: model.id, name: model.id, providerID: model.provider }),
      run: async (input: RunInput, sink: Sink) => {
        const isWorker = input.trace.sessionId.startsWith("delegation-");
        seen.push(isWorker ? "worker" : "resident");

        if (isWorker) {
          sink.onMessage(message(input, [{ type: "text", text: WORKER_ANSWER } as never]));
          return { type: "stop" };
        }

        // The provider is what actually runs a tool call, so the Resident's
        // turn calls the injected executor exactly as a real provider would
        // and then speaks the result back.
        const executed = await input.toolExecutor?.({
          id: "call-1",
          tool: "delegate",
          input: { instruction: "check the build", mode: "ask", scope: "inline", timeoutMs: 5000 },
        });
        sink.onMessage(
          message(input, [{ type: "text", text: `the worker reports: ${executed?.output ?? "nothing"}` } as never]),
        );
        return { type: "stop" };
      },
    },
  });
  stopApp = app.stop;

  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws?token=${WS_TOKEN}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("socket failed to open")), { once: true });
  });
  const reply = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no reply arrived")), 10_000);
    ws.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(String(event.data));
      },
      { once: true },
    );
  });
  ws.send(JSON.stringify({ type: "message", text: "is the build ok?" }));

  const answer = JSON.parse(await reply) as { type: string; text: string };
  ws.close();

  expect(answer.text).toContain(WORKER_ANSWER);
  // Proof the worker was a loop of its own rather than the Resident answering
  // itself: a second provider turn ran in a delegation session.
  expect(seen).toEqual(["resident", "worker"]);
});
