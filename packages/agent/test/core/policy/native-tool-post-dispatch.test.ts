import { describe, expect, it } from "bun:test";
import { Tool } from "@openomni/protocol";
import { createDispatcher, defineTool, ToolRefused } from "../../../src/index";
import { z } from "zod";
import {
  actionCommitGate,
  compiledPolicy,
  recordingExecutor,
  recordingToolObservations,
} from "../../helpers/compiled-policy";

const blockedPost = recordingExecutor({
  policy: compiledPolicy([
    {
      name: "deny-account-output",
      kind: "tool",
      phase: "post",
      match: { encodingVersion: 1, value: { op: "account" } },
      verdict: { encodingVersion: 1, value: { type: "deny", reason: "output_denied" } },
      priority: 1,
      generation: 1,
    },
  ]),
}).executor;

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
const call = { id: "call-1", tool: "account", input: { id: "a-1" } };
const context = { sessionId: "session-1", turnId: "turn-1" };

function transformingExecutor(replacement: string | null) {
  return recordingExecutor({
    policy: compiledPolicy([
      {
        name: "redact-account",
        kind: "tool",
        phase: "post",
        match: { encodingVersion: 1, value: { op: "account" } },
        verdict: {
          encodingVersion: 1,
          value: {
            type: "transform",
            name: "redact",
            paths: ["result.output.id"],
            replacement,
          },
        },
        priority: 1,
        generation: 1,
      },
    ]),
  }).executor;
}

describe("tool post-policy refusal", () => {
  it("publishes one completion only after the blocked-post result commits", async () => {
    const observations = recordingToolObservations();
    const resultCommit = actionCommitGate("account:result");
    const recording = recordingExecutor({
      policy: compiledPolicy([
        {
          name: "deny-account-output",
          kind: "tool",
          phase: "post",
          match: { encodingVersion: 1, value: { op: "account" } },
          verdict: { encodingVersion: 1, value: { type: "deny", reason: "output_denied" } },
          priority: 1,
          generation: 1,
        },
      ]),
      onCommit: resultCommit.onCommit,
      onObservation: observations.observe,
    });
    const running = createDispatcher([definition], { executor: recording.executor }).execute(
      call,
      context,
    );

    await resultCommit.reached;
    expect(observations.names).toHaveLength(1);
    expect(observations.names[0]).toBe(Tool.Events.Started.name);
    resultCommit.release();
    const result = await running;

    expect(result).toMatchObject({ isError: true, errorKind: "precondition_failed" });
    expect(observations.names).toEqual([Tool.Events.Started.name, Tool.Events.Completed.name]);
  });

  it("returns an error result through the model door", async () => {
    const result = await createDispatcher([definition], { executor: blockedPost }).execute(
      call,
      context,
    );

    expect(result).toMatchObject({ isError: true, errorKind: "precondition_failed" });
    expect(result.output).toContain("output_denied");
  });

  it("throws through the cell door", () => {
    const running = createDispatcher([definition], { executor: blockedPost }).executeCell(
      call,
      context,
    );

    expect(running).rejects.toBeInstanceOf(ToolRefused);
  });

  for (const door of ["model", "cell"] as const) {
    it(`${door} door uses a valid transformed output`, async () => {
      const dispatcher = createDispatcher([definition], {
        executor: transformingExecutor("masked"),
      });
      const result =
        door === "model"
          ? await dispatcher.execute(call, context)
          : await dispatcher.executeCell(call, context);

      expect(result.output).toEqual(door === "model" ? "masked" : { id: "masked" });
    });

    it(`${door} door rejects a transformed output that breaks the schema`, async () => {
      const dispatcher = createDispatcher([definition], { executor: transformingExecutor(null) });
      const result =
        door === "model"
          ? await dispatcher.execute(call, context)
          : await dispatcher.executeCell(call, context);
      expect(result).toMatchObject({ isError: true, errorKind: "invalid_output" });
    });
  }
});
