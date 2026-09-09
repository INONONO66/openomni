import { createTestAgent } from "../helpers/test-agent";
import { describe, expect, it } from "bun:test";
import type { Model } from "@openomni/protocol";
import { Bus } from "../../src/index";
import { createStopOutcome, type MockLlmFn } from "../helpers/mock-llm";
import { runInput } from "../helpers/run-input";

const model = { provider: "anthropic", id: "tiny-window" };

describe("model context admission", () => {
  it("compacts before the attempt and refuses admission when the window still overflows", async () => {
    let calls = 0;
    const llm = {
      run: (async () => {
        calls += 1;
        return createStopOutcome();
      }) as MockLlmFn,
      resolveModel: async (ref: Model.Ref) => ({
        id: ref.id,
        name: ref.id,
        providerID: ref.provider,
        limit: { context: 1, output: 1_000 },
      }),
    };
    await expect(
      createTestAgent({ events: Bus, model, llm }).run(
        runInput([{ role: "user", content: "a prompt wider than a one-token window" }]),
      ),
    ).rejects.toThrow("model context admission exceeded");
    expect(calls).toBe(0);
  });
});
