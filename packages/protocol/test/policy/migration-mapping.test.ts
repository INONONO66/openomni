import { describe, expect, test } from "bun:test";
import { Policy } from "../../src/policy/index.js";

describe("PolicyPoint migration mapping", () => {
  test("maps every legacy timing only to its generic 3-tier point ids", () => {
    const mapping = Policy.PolicyPoint.MigrationMapping;

    expect(Object.keys(mapping).sort()).toEqual(Object.values(Policy.Timing).sort());
    expect(mapping[Policy.Timing.DISPATCH_AUTHORIZE]).toEqual(["dispatch.action.pre"]);
    expect(mapping[Policy.Timing.RUN_START]).toEqual(["run.lifecycle.pre"]);
    expect(mapping[Policy.Timing.TURN_START]).toEqual(["run.turn.pre"]);
    expect(mapping[Policy.Timing.CONTEXT_PREPARE]).toEqual(["prompt.context.pre"]);
    expect(mapping[Policy.Timing.RESOURCES_PREPARE]).toEqual(["tool.catalog.pre"]);
    expect(mapping[Policy.Timing.MODEL_REQUEST]).toEqual(["connection.llm.pre"]);
    expect(mapping[Policy.Timing.MODEL_RESPONSE]).toEqual(["connection.llm.post"]);
    expect(mapping[Policy.Timing.INVOKE_PREPARE]).toEqual([
      "tool.native.pre",
      "tool.mcp.pre",
      "delegation.worker.pre",
    ]);
    expect(mapping[Policy.Timing.INVOKE_RESULT]).toEqual([
      "tool.native.post",
      "tool.mcp.post",
      "delegation.worker.post",
    ]);
    expect(mapping[Policy.Timing.TURN_FINISH]).toEqual(["run.turn.post"]);
    expect(mapping[Policy.Timing.COMPLETION_PREPARE]).toEqual(["run.completion.pre"]);
    expect(Object.values(mapping).flat()).not.toContain("work.complete.pre");
    expect(mapping[Policy.Timing.RUN_FINISH]).toEqual(["run.lifecycle.post"]);
    expect(mapping[Policy.Timing.ERROR]).toEqual(["run.error.error"]);
  });
});
