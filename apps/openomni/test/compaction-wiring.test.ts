import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { RunInput, Sink } from "@openomni/llm";
import { loadConfig } from "../src/config";
import { configuredCompaction } from "../src/compaction/strategy";
import { assistantMessage } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextMessage } from "./helpers/ws";

const KEYS = [
  "OPENOMNI_MODEL_PROVIDER",
  "OPENOMNI_MODEL_ID",
  "OPENOMNI_MODEL_API_KEY",
  "OPENOMNI_COMPACTION_SUMMARIZER",
] as const;
let saved: Record<string, string | undefined>;
const suite = residentSuite();

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  process.env.OPENOMNI_MODEL_PROVIDER = "fake";
  process.env.OPENOMNI_MODEL_ID = "resident-test";
  process.env.OPENOMNI_MODEL_API_KEY = "test-key";
  delete process.env.OPENOMNI_COMPACTION_SUMMARIZER;
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("compaction composition configuration", () => {
  it("wires a run-scoped summarizer by default", () => {
    expect(configuredCompaction(loadConfig()).onSummarize).toBeFunction();
  });

  it("omits the summarizer when explicitly off while preserving deterministic reduction", () => {
    process.env.OPENOMNI_COMPACTION_SUMMARIZER = "off";
    const compaction = configuredCompaction(loadConfig());
    expect(compaction.onSummarize).toBeUndefined();
    expect(compaction.elideToolOutputs).toEqual({ minOutputChars: 4000, keepHeadChars: 500 });
  });
  it("passes configured compaction through the production Resident root", async () => {
    const config = suite.config("openomni-root-compaction-", {
      wsToken: "root-compaction-token",
      compactionSummarizer: false,
    });
    const messageCounts: number[] = [];
    let constrained = false;
    let calls = 0;
    const app = await suite.boot({
      config,
      llm: {
        resolveProviderModel: async (model) => ({
          ...(await fakeProviderModel(model)),
          limit: { context: constrained ? 100 : 100_000 },
        }),
        run: async (input: RunInput, sink: Sink) => {
          calls += 1;
          if (constrained) messageCounts.push(input.messages.length);
          sink.onMessage(
            assistantMessage(input, {
              call: calls,
              reason: constrained && messageCounts.length === 1 ? "tool-calls" : "stop",
              text: `answer ${calls} ${"filler ".repeat(30)}`,
              tokens: constrained
                ? { input: 90, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
                : undefined,
            }),
          );
          return { type: "stop" };
        },
      },
    });
    const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "root-compaction-token"]);
    for (let index = 0; index < 6; index += 1) {
      const reply = nextMessage(ws);
      ws.send(JSON.stringify({ type: "message", text: `seed ${index} ${"filler ".repeat(30)}` }));
      await reply;
    }
    constrained = true;
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ type: "message", text: "compact now" }));
    await reply;

    expect(messageCounts).toHaveLength(2);
    expect(messageCounts[1]).toBeLessThan(messageCounts[0] ?? 0);
  });

});
