import { expect, test } from "bun:test";
import { Policy } from "@openomni/protocol";
import { Run, run } from "../src/run";

const input = {
  messages: [],
  tools: [],
  model: { id: "model", name: "model", providerID: "provider" },
  trace: { traceId: "trace", sessionId: "session", runId: "run" },
  events: { publish: () => undefined },
};
const sink = {
  onMessage: () => undefined,
  onToolCall: () => undefined,
  onToolResult: () => undefined,
};

test("the provider produces typed failure facts, never a legacy error shape", async () => {
  const cause = new Error("provider failure");
  const result = await run(input, sink, {
    createStream: async () => {
      throw cause;
    },
  });
  expect(result.type).toBe("error");
  if (result.type !== "error") throw new Error("missing failure");
  expect(result.error).toBeInstanceOf(Run.FailureError);
  expect(result.error.data).toMatchObject({
    aborted: false,
    contextOverflow: false,
    visibleOutput: false,
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  expect(result.error.cause).toBe(cause);
});

test("stop and aborted are produced by the real attempt entry", async () => {
  const stop = await run(input, sink, {
    createStream: async () => ({
      fullStream: (async function* () {
        yield { type: "finish" };
      })(),
    }),
  });
  expect(stop).toEqual({ type: "stop" });
  expect(await run({ ...input, signal: AbortSignal.abort() }, sink)).toEqual({ type: "aborted" });
});

test("policy owns persisted lifecycle validation independently of the static provider outcome", () => {
  const schema = Policy.PolicyPoint.InputSchemas["run.lifecycle.post"];
  const embed = (runOutcome: { type: string }) => ({
    sessionId: "session",
    runId: "run",
    runOutcome,
  });
  expect(schema.safeParse(embed({ type: "stop" })).success).toBe(true);
  expect(schema.safeParse(embed({ type: "max-steps" })).success).toBe(true);
  expect(schema.safeParse(embed({ type: "invalid" })).success).toBe(false);
  expect("Outcome" in Run).toBe(false);
});
