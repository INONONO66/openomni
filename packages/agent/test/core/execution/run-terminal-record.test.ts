import { describe, expect, it } from "bun:test";
import { Operational, PolicyDecision } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { runAgent } from "../../../src/core/execution/runner";
import type { PolicyEngineRegistration } from "../../../src/core/policy";
import {
  createMockLlmConfig,
  createStopOutcome,
  mockProviderData,
  mockProviderModel,
} from "../../helpers/mock-llm";
import { runInput } from "../../helpers/run-input";

/**
 * Every run that started has to end on the record too.
 *
 * `agent.run.started` fires unconditionally, but the terminal used to be
 * emitted by whichever branch happened to end the run — and only three of them
 * did. A run a policy blocked emitted a start and nothing after it, so anything
 * folding the stream saw it as permanently in flight.
 */
async function runWith(middleware: PolicyEngineRegistration[]): Promise<string[]> {
  const seen: string[] = [];
  const stop = Bus.observe((event, payload) => {
    if (event.name !== Operational.Info.name) return;
    const msg = (payload as { msg?: string }).msg;
    if (msg === "agent.run.started" || msg === "agent.run.completed") seen.push(msg);
  });
  try {
    await runAgent(runInput([{ role: "user", content: "hi" }]), {
      events: Bus,
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      middleware,
      llm: createMockLlmConfig({
        getModels: async () => mockProviderData,
        fromModelsDevModel: () => mockProviderModel,
        run: async () => createStopOutcome(),
      }),
    });
  } finally {
    stop();
  }
  return seen;
}

function blockAt(point: "run.lifecycle.pre" | "run.turn.pre"): PolicyEngineRegistration {
  return {
    kind: "point",
    name: `test:block-${point}`,
    pointIds: [point],
    effectCapabilities: { [point]: ["run.abort"] },
    priority: 100,
    fn: () =>
      PolicyDecision.deny({
        policyId: "test.block",
        reasonCodes: ["blocked"],
        effects: [{ type: "run.abort", reason: "blocked" }],
      }),
  } as PolicyEngineRegistration;
}

describe("a started run always records a terminal", () => {
  it("on the ordinary path", async () => {
    expect(await runWith([])).toEqual(["agent.run.started", "agent.run.completed"]);
  });

  it("when a policy blocks the run before its first turn", async () => {
    expect(await runWith([blockAt("run.lifecycle.pre")])).toEqual([
      "agent.run.started",
      "agent.run.completed",
    ]);
  });

  it("when a policy blocks the turn", async () => {
    expect(await runWith([blockAt("run.turn.pre")])).toEqual([
      "agent.run.started",
      "agent.run.completed",
    ]);
  });
});
