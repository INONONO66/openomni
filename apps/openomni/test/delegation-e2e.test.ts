import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunInput, Sink } from "@openomni/llm";
import { Storage } from "@openomni/ledger";
import { startOpenOmni } from "../src/index";
import { assistantMessage } from "./helpers/assistant-message";

const WS_TOKEN = "delegation-e2e-token";
const WORKER_ANSWER = "the build is green";

const directories: string[] = [];
let stopApp: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stopApp?.();
  stopApp = undefined;
  Storage.reset();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("a Resident turn hands work to an inline worker and reports what came back", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openomni-delegation-"));
  directories.push(directory);
  const seen: string[] = [];
  let workerTools: string[] = [];

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
          // Composition-root door check: the worker door must never offer
          // the Resident-only completion surface.
          workerTools = (input.tools ?? []).map((tool) => tool.name);
          sink.onMessage(
            assistantMessage(input, { parts: [{ type: "text", text: WORKER_ANSWER } as never] }),
          );
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
          assistantMessage(input, {
            parts: [
              {
                type: "text",
                text: `the worker reports: ${executed?.output ?? "nothing"}`,
              } as never,
            ],
          }),
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
  expect(workerTools).not.toContain("work_items");
  expect(workerTools).not.toContain("complete_work");
  expect(workerTools.length).toBeGreaterThan(0);
});
