import { describe, expect, test } from "bun:test";
import { Policy, Tool } from "../../src/index.js";

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


const parityCases: readonly ParityCase[] = [
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
