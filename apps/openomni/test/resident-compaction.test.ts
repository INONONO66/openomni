import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sink } from "@openomni/llm";
import { initialize, Storage } from "@openomni/ledger";
import type { Gateway } from "@openomni/protocol";
import { createResident } from "../src/resident";
import { assistantMessage } from "./helpers/assistant-message";

const directories: string[] = [];

afterEach(() => {
  Storage.reset();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function delivery(sessionId: string, payload: string, id: string): Gateway.Deliver {
  const traceId = "0af7651916cd43dd8448eb211c80319c";
  return {
    sessionId,
    event: {
      id,
      traceId,
      surface: "internal",
      userId: "owner",
      payload,
      target: { kind: "resident" },
      mode: "direct",
    },
    decision: {
      traceId,
      time: Date.now(),
      inboundId: id,
      surface: "internal",
      mode: "direct",
      stage: "surface_default",
      outcome: "route",
      reason: "test",
      factsUsed: [],
      target: "resident",
      sessionId,
    },
  };
}

describe("Resident compaction", () => {
  it("replaces oversized hydrated history before continuing the Resident run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openomni-resident-compaction-"));
    directories.push(directory);
    initialize({ dbPath: join(directory, "chat.db") });
    const sessionId = "resident-compaction";

    const seed = createResident({
      model: { provider: "fake", id: "resident-test" },
      apiKey: "test-key",
      tools: {},
      targets: () => [],
      llm: {
        resolveProviderModel: async (model) => ({
          id: model.id,
          name: model.id,
          providerID: model.provider,
          limit: { context: 100_000 },
        }),
        run: async (input, sink: Sink) => {
          sink.onMessage(assistantMessage(input, { text: `seed answer ${"filler ".repeat(30)}` }));
          return { type: "stop" };
        },
      },
    });
    for (let index = 0; index < 6; index += 1) {
      await seed(
        delivery(
          sessionId,
          `seed question ${index} ${"filler ".repeat(30)}`,
          `inbound-seed-${index}`,
        ),
      );
    }

    const messageCounts: number[] = [];
    let calls = 0;
    const resident = createResident({
      model: { provider: "fake", id: "resident-test" },
      apiKey: "test-key",
      compaction: {
        contextWindowTokens: 100,
        elideToolOutputs: { minOutputChars: 4000, keepHeadChars: 500 },
      },
      tools: {},
      targets: () => [],
      llm: {
        resolveProviderModel: async (model) => ({
          id: model.id,
          name: model.id,
          providerID: model.provider,
          limit: { context: 100 },
        }),
        run: async (input, sink: Sink) => {
          calls += 1;
          messageCounts.push(input.messages?.length ?? 0);
          sink.onMessage(
            assistantMessage(input, {
              call: calls,
              reason: calls === 1 ? "tool-calls" : "stop",
              tokens: { input: 90, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            }),
          );
          return { type: "stop" };
        },
      },
    });

    await resident(delivery(sessionId, "new resident question", "inbound-compaction"));

    expect(calls).toBe(2);
    expect(messageCounts[1]).toBeLessThan(messageCounts[0] ?? 0);
  });
});
