import { Cause, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "bun:test";
import { Tool } from "@openomni/protocol";
import { createDispatcher, defineTool, ToolRefused } from "../../../src/index";
import { z } from "zod";
import {
  actionCommitGate,
  accountOutputDeniedPolicy,
  compiledPolicy,
  recordingToolObservations,
} from "../../helpers/compiled-policy";
import { recordingExecutor } from "../../helpers/effect-g1";
import { isolated } from "../../helpers/isolated";

const definition = defineTool({
  name: "account",
  description: "Read an account",
  category: "query",
  input: z.object({ id: z.string() }).strict(),
  output: z.object({ id: z.string() }).strict(),
  visibility: { model: ["resident"], cell: ["resident"] },
  execute: async ({ id }) => ({ id }),
  render: (_input, output) => output.id,
});
const call = { id: "call-1", tool: "account", input: { id: "a-1" } } satisfies Tool.Call;
const context = { sessionId: "session-1", turnId: "turn-1" };

function transformingExecutor(replacement: string | null) {
  return recordingExecutor({
    policy: compiledPolicy([{
      name: "redact-account",
      kind: "tool",
      phase: "post",
      match: { encodingVersion: 1, value: { op: "account" } },
      verdict: { encodingVersion: 1, value: { type: "transform", name: "redact", paths: ["result.output.id"], replacement } },
      priority: 1,
      generation: 1,
    }]),
  }).executor;
}

describe("tool post-policy refusal", () => {
  it("publishes one completion only after the blocked-post result commits", async () => isolated(Effect.scoped(Effect.gen(function* () {
    const observations = recordingToolObservations();
    const resultCommit = actionCommitGate("account:result");
    const recording = recordingExecutor({ policy: accountOutputDeniedPolicy(), onCommit: resultCommit.onCommit, onObservation: observations.observe });
    const running = yield* Effect.forkScoped(createDispatcher([definition], { executor: recording.executor }).execute(call, context));
    yield* Effect.promise(() => resultCommit.reached).pipe(Effect.timeout("5 seconds"));
    expect(observations.names).toHaveLength(1);
    expect(observations.names[0]).toBe(Tool.Events.Started.name);
    resultCommit.release();
    const result = yield* Fiber.join(running);
    expect(result).toMatchObject({ isError: true, errorKind: "precondition_failed" });
    expect(observations.names).toEqual([Tool.Events.Started.name, Tool.Events.Completed.name]);
  }))));

  it("returns an error result through the model door", async () => isolated(Effect.scoped(Effect.gen(function* () {
    const result = yield* createDispatcher([definition], { executor: recordingExecutor({ policy: accountOutputDeniedPolicy() }).executor }).execute(call, context);
    expect(result).toMatchObject({ isError: true, errorKind: "precondition_failed" });
    expect(result.output).toContain("output_denied");
  }))));

  it("throws through the cell door", async () => isolated(Effect.scoped(Effect.gen(function* () {
    const exit = yield* Effect.exit(createDispatcher([definition], { executor: recordingExecutor({ policy: accountOutputDeniedPolicy() }).executor }).executeCell(call, context));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(ToolRefused);
  }))));

  for (const door of ["model", "cell"] as const) {
    it(`${door} door uses a valid transformed output`, async () => isolated(Effect.scoped(Effect.gen(function* () {
      const dispatcher = createDispatcher([definition], { executor: transformingExecutor("masked") });
      const result = yield* (door === "model" ? dispatcher.execute(call, context) : dispatcher.executeCell(call, context));
      expect(result.output).toEqual(door === "model" ? "masked" : { id: "masked" });
    }))));

    it(`${door} door rejects a transformed output that breaks the schema`, async () => isolated(Effect.scoped(Effect.gen(function* () {
      const dispatcher = createDispatcher([definition], { executor: transformingExecutor(null) });
      const result = yield* (door === "model" ? dispatcher.execute(call, context) : dispatcher.executeCell(call, context));
      expect(result).toMatchObject({ isError: true, errorKind: "invalid_output" });
    }))));
  }
});
