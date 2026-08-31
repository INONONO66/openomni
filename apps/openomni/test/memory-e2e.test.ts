import { expect, it } from "bun:test";
import type { Sink } from "@openomni/llm";
import { assistantMessage } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { ask, opened } from "./helpers/ws";

const WS_TOKEN = "memory-e2e-token";
const suite = residentSuite();

it("memory writes render next session, never mid-session", async () => {
  // The fake Resident: on a "remember" ask it writes memory through its own
  // tool executor; every turn reports whether its system prompt held memory.
  const app = await suite.boot({
    config: suite.config("openomni-memory-e2e-", { wsToken: WS_TOKEN }),
    llm: {
      resolveProviderModel: fakeProviderModel,
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
        sink.onMessage(
          assistantMessage(input, {
            id: "fake-assistant-message",
            text: `${held} offered=${offered.includes("memory")}${wrote}`,
          }),
        );
        return { type: "stop" };
      },
    },
  });

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
