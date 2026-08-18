import { describe, expect, test } from "bun:test";
import { Command, Policy, Tool } from "../../src/index.js";

interface Validator {
  readonly safeParse: (input: unknown) => { readonly success: boolean };
}

interface ParityCase {
  readonly name: string;
  readonly canonical: Validator;
  readonly policy: Validator;
  readonly embed: (candidate: unknown) => unknown;
  readonly candidates: readonly unknown[];
}

const dispatchInput = {
  actor: { kind: "resident", actorId: "actor-1" },
  dispatchId: "dispatch-1",
  action: "worker.spawn",
  target: { kind: "worker", sessionId: "session-1" },
  sessionId: "session-1",
  runId: "run-1",
};

const parityCases: readonly ParityCase[] = [
  {
    name: "Command.ActorContext",
    canonical: Command.ActorContext,
    policy: Policy.PolicyPoint.InputSchemas["dispatch.action.pre"],
    embed: (actor) => ({ ...dispatchInput, actor }),
    candidates: [
      dispatchInput.actor,
      {
        kind: "worker",
        actorId: "actor-2",
        agentName: "worker",
        sessionId: "session-2",
        runId: "run-2",
        workerRunId: "worker-1",
        workspaceRoot: "/workspace",
        labels: ["trusted"],
        trustTier: "assigned_worker",
        reason: "delegated",
      },
      { kind: "resident" },
      { kind: "invalid", actorId: "actor-1" },
      { ...dispatchInput.actor, extra: true },
      { ...dispatchInput.actor, agentName: "" },
      { ...dispatchInput.actor, trustTier: "invalid" },
    ],
  },
  {
    name: "Command.Target",
    canonical: Command.Target,
    policy: Policy.PolicyPoint.InputSchemas["dispatch.action.pre"],
    embed: (target) => ({ ...dispatchInput, target }),
    candidates: [
      dispatchInput.target,
      {
        kind: "external_actor",
        id: "actor-1",
        sessionId: "session-2",
        parentSessionId: "session-1",
        runId: "run-2",
        endpointId: "endpoint-1",
        connectorInstallationId: "install-1",
        name: "external",
        labels: ["remote"],
      },
      { sessionId: "session-1" },
      { kind: "invalid" },
      { kind: "worker", extra: true },
      { kind: "worker", id: "" },
    ],
  },
  {
    name: "Tool.Spec",
    canonical: Tool.Spec,
    policy: Policy.PolicyPoint.InputSchemas["tool.catalog.pre"],
    embed: (spec) => ({ sessionId: "session-1", runId: "run-1", availableTools: [spec] }),
    candidates: [
      { name: "read", inputSchema: {} },
      {
        name: "write",
        description: "Write a file",
        inputSchema: { path: { type: "string" } },
        safe: false,
        labels: ["filesystem"],
        prompt: "Use carefully",
      },
      { inputSchema: {} },
      { name: "read" },
      { name: "read", inputSchema: {}, safe: "yes" },
      { name: "read", inputSchema: {}, extra: true },
    ],
  },
  {
    name: "Tool.Result",
    canonical: Tool.Result,
    policy: Policy.PolicyPoint.InputSchemas["tool.native.post"],
    embed: (toolResult) => ({
      sessionId: "session-1",
      runId: "run-1",
      toolId: "tool-1",
      toolResult,
    }),
    candidates: [
      { id: "result-1", toolCallId: "call-1", output: "ok" },
      {
        id: "result-1",
        toolCallId: "call-1",
        output: "failed",
        isError: true,
        settlement: "unknown",
      },
      { id: "result-1", toolCallId: "call-1" },
      { id: "result-1", toolCallId: "call-1", output: "ok", settlement: "invalid" },
      { id: "result-1", toolCallId: "call-1", output: "ok", isError: "yes" },
      { id: "result-1", toolCallId: "call-1", output: "ok", extra: true },
      // #500 C4: additive-optional toolName must parse identically at both ends.
      { id: "result-1", toolCallId: "call-1", toolName: "read", output: "ok" },
      { id: "result-1", toolCallId: "call-1", toolName: 5, output: "ok" },
    ],
  },
];

describe("PolicyPoint private input schema parity", () => {
  for (const parityCase of parityCases) {
    test(parityCase.name, () => {
      for (const candidate of parityCase.candidates) {
        expect(parityCase.policy.safeParse(parityCase.embed(candidate)).success).toBe(
          parityCase.canonical.safeParse(candidate).success,
        );
      }
    });
  }
});
