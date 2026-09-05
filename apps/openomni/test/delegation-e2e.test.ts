import { expect, test } from "bun:test";
import { SessionHandleStore } from "@openomni/ledger";
import type { RunInput, Sink } from "@openomni/llm";
import { assistantMessage } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextMessage } from "./helpers/ws";

const WS_TOKEN = "delegation-e2e-token";
const WORKER_ANSWER = "the build is green";
const suite = residentSuite();

test("a Resident turn hands work to an inline worker and reports what came back", async () => {
  const seen: string[] = [];
  let workerTools: string[] = [];

  const app = await suite.boot({
    config: suite.config("openomni-delegation-", {
      wsToken: WS_TOKEN,
      model: { provider: "fake", id: "delegation-test", apiKey: "test-key" },
    }),
    llm: {
      resolveProviderModel: fakeProviderModel,
      run: async (input: RunInput, sink: Sink) => {
        const isWorker = SessionHandleStore.row(input.trace.sessionId).role === "worker";
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
          input: {
            instruction: "check the build",
            operation: "ask",
            scope: "inline",
            timeoutMs: 5000,
          },
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
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", WS_TOKEN]);
  const reply = nextMessage(ws, 10_000);
  ws.send(JSON.stringify({ type: "message", text: "is the build ok?" }));

  const answer = JSON.parse(String((await reply).data)) as { type: string; text: string };

  expect(answer.text).toContain(WORKER_ANSWER);
  // Proof the worker was a loop of its own rather than the Resident answering
  // itself: a second provider turn ran in a delegation session.
  expect(seen).toEqual(["resident", "worker"]);
  expect(workerTools).not.toContain("work_items");
  expect(workerTools).not.toContain("complete_work");
  expect(workerTools.length).toBeGreaterThan(0);
});
