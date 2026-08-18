import { expect, test } from "bun:test";
import { z } from "zod";
import { Command, Policy, Run, Tool } from "../../src/index.js";

function whileFieldIsOptional<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
  field: keyof Shape,
  validate: () => boolean,
): boolean {
  const shape = schema.shape;
  const original = Reflect.get(shape, field);
  expect(Reflect.set(shape, field, z.unknown().optional())).toBe(true);
  try {
    return validate();
  } finally {
    Reflect.set(shape, field, original);
  }
}

test("policy input validators isolate authority schemas from shared public mutation", () => {
  const dispatch = Policy.PolicyPoint.InputSchemas["dispatch.action.pre"];
  const dispatchInput = {
    actor: { kind: "resident", actorId: "actor-1" },
    dispatchId: "dispatch-1",
    action: "worker.spawn",
    target: { kind: "worker", sessionId: "session-1" },
    sessionId: "session-1",
    runId: "run-1",
  };
  const missingActorIdAccepted = whileFieldIsOptional(
    Command.ActorContext,
    "actorId",
    () => dispatch.safeParse({ ...dispatchInput, actor: { kind: "resident" } }).success,
  );
  const missingTargetKindAccepted = whileFieldIsOptional(
    Command.Target,
    "kind",
    () => dispatch.safeParse({ ...dispatchInput, target: { sessionId: "session-1" } }).success,
  );
  const missingToolNameAccepted = whileFieldIsOptional(
    Tool.Spec,
    "name",
    () =>
      Policy.PolicyPoint.InputSchemas["tool.catalog.pre"].safeParse({
        sessionId: "session-1",
        runId: "run-1",
        availableTools: [{ inputSchema: {} }],
      }).success,
  );
  const missingToolOutputAccepted = whileFieldIsOptional(
    Tool.Result,
    "output",
    () =>
      Policy.PolicyPoint.InputSchemas["tool.native.post"].safeParse({
        sessionId: "session-1",
        runId: "run-1",
        toolId: "tool-1",
        toolResult: { id: "result-1", toolCallId: "call-1" },
      }).success,
  );

  const optionsMap = Reflect.get(Run.Outcome, "optionsMap");
  if (!(optionsMap instanceof Map)) throw new Error("Missing run outcome options map");
  const stopOption = optionsMap.get("stop");
  expect(Reflect.apply(Map.prototype.delete, optionsMap, ["stop"])).toBe(true);
  let validStopAccepted = false;
  try {
    validStopAccepted = Policy.PolicyPoint.InputSchemas["run.lifecycle.post"].safeParse({
      sessionId: "session-1",
      runId: "run-1",
      runOutcome: { type: "stop" },
    }).success;
  } finally {
    Reflect.apply(Map.prototype.set, optionsMap, ["stop", stopOption]);
  }

  expect(missingActorIdAccepted).toBe(false);
  expect(missingTargetKindAccepted).toBe(false);
  expect(missingToolNameAccepted).toBe(false);
  expect(missingToolOutputAccepted).toBe(false);
  expect(validStopAccepted).toBe(true);
});
