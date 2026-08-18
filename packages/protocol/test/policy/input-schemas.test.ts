import { describe, expect, test } from "bun:test";
import { Command, Policy } from "../../src/index.js";

const pointIds = [
  "dispatch.action.pre",
  "run.lifecycle.pre",
  "run.turn.pre",
  "prompt.context.pre",
  "tool.catalog.pre",
  "connection.llm.pre",
  "connection.llm.post",
  "tool.native.pre",
  "tool.mcp.pre",
  "delegation.worker.pre",
  "tool.native.post",
  "tool.mcp.post",
  "delegation.worker.post",
  "run.turn.post",
  "run.completion.pre",
  "work.complete.pre",
  "run.lifecycle.post",
  "run.error.error",
] as const;

const sessionId = "session-1";
const runId = "run-1";
const toolResult = { id: "result-1", toolCallId: "call-1", output: "ok" };
const validDispatchInput = {
  actor: { kind: "resident", actorId: "actor-1" },
  dispatchId: "dispatch-1",
  action: "worker.spawn",
  target: { kind: "worker", sessionId },
  sessionId,
  runId,
  agentType: "resident",
  context: { requestId: "request-1" },
} satisfies Policy.PolicyPointInputMap["dispatch.action.pre"];
const validInputs = {
  "dispatch.action.pre": validDispatchInput,
  "run.lifecycle.pre": { actorId: "actor-1", sessionId, runId },
  "run.turn.pre": { sessionId, runId, turnIndex: 0 },
  "prompt.context.pre": { sessionId, runId, turnIndex: 0 },
  "tool.catalog.pre": {
    sessionId,
    runId,
    availableTools: [{ name: "read", inputSchema: {} }],
  },
  "connection.llm.pre": { sessionId, runId, modelId: "model-1" },
  "connection.llm.post": { sessionId, runId, modelId: "model-1", responseTokens: 1 },
  "tool.native.pre": { sessionId, runId, toolId: "tool-1", toolInput: {} },
  "tool.mcp.pre": { sessionId, runId, toolId: "tool-1", mcpServerId: "mcp-1", toolInput: {} },
  "delegation.worker.pre": {
    sessionId,
    runId,
    workerRunId: "worker-1",
    workerProfile: { name: "worker" },
  },
  "tool.native.post": { sessionId, runId, toolId: "tool-1", toolResult },
  "tool.mcp.post": { sessionId, runId, toolId: "tool-1", mcpServerId: "mcp-1", toolResult },
  "delegation.worker.post": { sessionId, runId, workerRunId: "worker-1", workerResult: {} },
  "run.turn.post": { sessionId, runId, turnIndex: 0, turnResult: {} },
  "run.completion.pre": { sessionId, runId, completionCandidate: {} },
  "work.complete.pre": {
    workItemHash: "wi_admission",
    requestId: "request:completion",
    contractRevision: "contract:v1",
    basisRef: "basis:v1",
    expectedHead: 7,
    completionCandidate: { effectiveResultIds: ["result:publish"] },
    unresolvedBlockerIds: ["blocker:effect-pending"],
  },
  "run.lifecycle.post": { sessionId, runId, runOutcome: { type: "stop" } },
  "run.error.error": { sessionId, runId, errorCode: "error", errorPhase: "turn" },
} satisfies Policy.PolicyPointInputMap;

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

describe("PolicyPoint executable input schemas", () => {
  test("has a one-to-one schema catalog for every registered point", () => {
    expect(Object.keys(Policy.PolicyPoint.InputSchemas).sort()).toEqual([...pointIds].sort());
    expect(Object.keys(Policy.PolicyPoint.Registry).sort()).toEqual([...pointIds].sort());
  });

  test("requires every context field declared by each point contract", () => {
    for (const pointId of pointIds) {
      const contract = Policy.PolicyPoint.Registry[pointId];
      const schema = Policy.PolicyPoint.InputSchemas[pointId];
      const validInput = validInputs[pointId];

      expect(contract).toBeDefined();
      expect(schema).toBeDefined();
      if (contract === undefined || schema === undefined) continue;
      expect(schema.safeParse(validInput).success).toBe(true);

      for (const requiredKey of contract.requiredContext) {
        const missingRequired = { ...validInput };
        Reflect.deleteProperty(missingRequired, requiredKey);

        expect(schema.safeParse(missingRequired).success).toBe(false);
      }
    }
  });

  test("protects policy point authority catalogs from caller mutation", () => {
    const registry = Policy.PolicyPoint.Registry;
    const inputSchemas = Policy.PolicyPoint.InputSchemas;
    const contract = registry["run.lifecycle.post"];
    const originalLifecycleSchema = inputSchemas["run.lifecycle.post"];
    const originalEffects = [...contract.allowedEffects];
    const originalContext = [...contract.requiredContext];
    const addedPointId = "credential.test.pre";
    const expectMutationRejected = (mutate: () => boolean, restore: () => void): void => {
      const mutated = mutate();
      if (mutated) restore();
      expect(mutated).toBe(false);
    };

    expectMutationRejected(
      () => Reflect.set(registry, addedPointId, contract),
      () => Reflect.deleteProperty(registry, addedPointId),
    );
    expectMutationRejected(
      () => Reflect.set(Policy.PolicyPoint, "Registry", {}),
      () => Reflect.set(Policy.PolicyPoint, "Registry", registry),
    );
    expectMutationRejected(
      () => Reflect.set(contract.allowedEffects, contract.allowedEffects.length, "run.abort"),
      () =>
        Reflect.apply(Array.prototype.splice, contract.allowedEffects, [
          0,
          contract.allowedEffects.length,
          ...originalEffects,
        ]),
    );
    expectMutationRejected(
      () => Reflect.set(contract.requiredContext, contract.requiredContext.length, "unexpected"),
      () =>
        Reflect.apply(Array.prototype.splice, contract.requiredContext, [
          0,
          contract.requiredContext.length,
          ...originalContext,
        ]),
    );
    expectMutationRejected(
      () => Reflect.set(inputSchemas, addedPointId, inputSchemas["run.lifecycle.post"]),
      () => Reflect.deleteProperty(inputSchemas, addedPointId),
    );
    expectMutationRejected(
      () => Reflect.set(inputSchemas, "run.lifecycle.post", inputSchemas["run.error.error"]),
      () => Reflect.set(inputSchemas, "run.lifecycle.post", originalLifecycleSchema),
    );
    expectMutationRejected(
      () => Reflect.set(Policy.PolicyPoint, "InputSchemas", {}),
      () => Reflect.set(Policy.PolicyPoint, "InputSchemas", inputSchemas),
    );
  });

  test("exposes only immutable validator methods", () => {
    const validator = Policy.PolicyPoint.InputSchemas["run.lifecycle.post"];
    const originalParse = validator.parse;
    const originalSafeParse = validator.safeParse;
    const parseReplaced = Reflect.set(validator, "parse", () => ({}));
    const safeParseReplaced = Reflect.set(validator, "safeParse", () => ({ success: true }));
    if (parseReplaced) Reflect.set(validator, "parse", originalParse);
    if (safeParseReplaced) Reflect.set(validator, "safeParse", originalSafeParse);

    expect(Object.keys(validator).sort()).toEqual(["parse", "safeParse"]);
    for (const privateKey of ["shape", "_def", "_cached", "optionsMap"]) {
      expect(Reflect.has(validator, privateKey)).toBe(false);
    }
    expect(parseReplaced).toBe(false);
    expect(safeParseReplaced).toBe(false);
    const { parse, safeParse } = validator;
    expect(parse(validInputs["run.lifecycle.post"])).toEqual(validInputs["run.lifecycle.post"]);
    expect(safeParse(validInputs["run.lifecycle.post"]).success).toBe(true);
  });

  test("does not expose mutable Zod caches or native collections", () => {
    const schema = Policy.PolicyPoint.InputSchemas["run.lifecycle.post"];
    const valid = { sessionId: "session-1", runId: "run-1", runOutcome: { type: "stop" } };
    schema.parse(valid);

    const cached = Reflect.get(schema, "_cached");
    const cachedKeys = isObject(cached) ? Reflect.get(cached, "keys") : undefined;
    const runIdIndex = Array.isArray(cachedKeys) ? cachedKeys.indexOf("runId") : -1;
    const cacheMutated = runIdIndex >= 0;
    if (cacheMutated) Reflect.apply(Array.prototype.splice, cachedKeys, [runIdIndex, 1]);
    const missingRunIdAccepted = schema.safeParse({
      sessionId: "session-1",
      runOutcome: { type: "stop" },
    }).success;
    if (cacheMutated) Reflect.apply(Array.prototype.splice, cachedKeys, [runIdIndex, 0, "runId"]);

    const shape = Reflect.get(schema, "shape");
    const runOutcome = isObject(shape) ? Reflect.get(shape, "runOutcome") : undefined;
    const optionsMap = isObject(runOutcome) ? Reflect.get(runOutcome, "optionsMap") : undefined;
    const stopOption = optionsMap instanceof Map ? optionsMap.get("stop") : undefined;
    const mapMutated =
      optionsMap instanceof Map ? Reflect.apply(Map.prototype.delete, optionsMap, ["stop"]) : false;
    const validStopAccepted = schema.safeParse(valid).success;
    if (mapMutated) Reflect.apply(Map.prototype.set, optionsMap, ["stop", stopOption]);

    expect(Object.keys(schema).sort()).toEqual(["parse", "safeParse"]);
    expect(cacheMutated).toBe(false);
    expect(missingRunIdAccepted).toBe(false);
    expect(mapMutated).toBe(false);
    expect(validStopAccepted).toBe(true);
  });

  test("requires exact WorkItem completion admission identity and fold inputs", () => {
    const schema = Policy.PolicyPoint.InputSchemas["work.complete.pre"];
    const input = validInputs["work.complete.pre"];

    expect(schema).toBeDefined();
    if (schema === undefined) return;
    expect(schema.parse(input)).toEqual(input);
    for (const malformed of [
      { ...input, workItemHash: "" },
      { ...input, requestId: "" },
      { ...input, contractRevision: "" },
      { ...input, basisRef: "" },
      { ...input, expectedHead: "7" },
      { ...input, completionCandidate: undefined },
      { ...input, unresolvedBlockerIds: [""] },
      { sessionId, runId, completionCandidate: {} },
    ]) {
      expect(schema.safeParse(malformed).success).toBe(false);
    }
  });

  test("accepts canonical dispatch input and preserves generic context", () => {
    const parsed = Policy.PolicyPoint.InputSchemas["dispatch.action.pre"].parse(validDispatchInput);
    const typedInput: Policy.PolicyPointInputMap["dispatch.action.pre"] = parsed;

    expect(typedInput).toEqual(validDispatchInput);
  });

  test("accepts dispatch input without optional session and run identity", () => {
    const { sessionId: _sessionId, runId: _runId, ...input } = validDispatchInput;

    expect(Policy.PolicyPoint.InputSchemas["dispatch.action.pre"].safeParse(input).success).toBe(
      true,
    );
  });

  test("represents max-steps at the agent lifecycle policy boundary", () => {
    const input = { sessionId, runId, runOutcome: { type: "max-steps" } };

    expect(Policy.PolicyPoint.InputSchemas["run.lifecycle.post"].safeParse(input).success).toBe(
      true,
    );
    // The canonical-side divergence pin (Run.Outcome rejects "max-steps")
    // lives with Run.Outcome in packages/llm/test/run-outcome.test.ts (#500 C1).
  });

  test("rejects malformed canonical dispatch fields", () => {
    const schema = Policy.PolicyPoint.InputSchemas["dispatch.action.pre"];

    for (const input of [
      { ...validDispatchInput, actor: { actorId: "actor-1" } },
      { ...validDispatchInput, action: "" },
      { ...validDispatchInput, target: { kind: "unknown" } },
    ]) {
      expect(schema.safeParse(input).success).toBe(false);
    }
  });

  test("uses the canonical Command actor and target validation", () => {
    const schema = Policy.PolicyPoint.InputSchemas["dispatch.action.pre"];
    const parityCases = [
      [
        "actor",
        Command.ActorContext,
        [
          validDispatchInput.actor,
          { actorId: "actor-1" },
          { ...validDispatchInput.actor, extra: true },
        ],
      ],
      [
        "target",
        Command.Target,
        [
          validDispatchInput.target,
          { kind: "unknown" },
          { ...validDispatchInput.target, extra: true },
        ],
      ],
    ] as const;

    for (const [field, canonicalSchema, inputs] of parityCases) {
      for (const input of inputs) {
        expect(schema.safeParse({ ...validDispatchInput, [field]: input }).success).toBe(
          canonicalSchema.safeParse(input).success,
        );
      }
    }
  });
});
