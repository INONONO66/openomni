import { describe, expect, test } from "bun:test";
import { Policy } from "../../src/policy/index.js";

describe("PolicyPoint migration mapping", () => {
  test("maps every legacy timing to 3-tier point ids", () => {
    const mapping = Policy.PolicyPoint.MigrationMapping;

    expect(Object.keys(mapping).sort()).toEqual(Object.values(Policy.Timing).sort());
    expect(mapping[Policy.Timing.INBOUND_RECEIVE]).toEqual(["session.inbound.pre"]);
    expect(mapping[Policy.Timing.RUN_START]).toEqual(["run.lifecycle.pre"]);
    expect(mapping[Policy.Timing.TURN_START]).toEqual(["run.turn.pre"]);
    expect(mapping[Policy.Timing.CONTEXT_PREPARE]).toEqual(["prompt.context.pre"]);
    expect(mapping[Policy.Timing.RESOURCES_PREPARE]).toEqual(["tool.catalog.pre"]);
    expect(mapping[Policy.Timing.MODEL_REQUEST]).toEqual(["connection.llm.pre"]);
    expect(mapping[Policy.Timing.MODEL_RESPONSE]).toEqual(["connection.llm.post"]);
    expect(mapping[Policy.Timing.INVOKE_PREPARE]).toEqual([
      "tool.native.pre",
      "tool.mcp.pre",
      "delegation.subagent.pre",
      "delegation.background.pre",
    ]);
    expect(mapping[Policy.Timing.INVOKE_RESULT]).toEqual([
      "tool.native.post",
      "tool.mcp.post",
      "delegation.subagent.post",
      "delegation.background.post",
    ]);
    expect(mapping[Policy.Timing.TURN_FINISH]).toEqual(["run.turn.post"]);
    expect(mapping[Policy.Timing.COMPLETION_PREPARE]).toEqual(["run.completion.pre"]);
    expect(mapping[Policy.Timing.WRITEBACK_COMMIT]).toEqual(["session.writeback.pre"]);
    expect(mapping[Policy.Timing.RUN_FINISH]).toEqual(["run.lifecycle.post"]);
    expect(mapping[Policy.Timing.ERROR]).toEqual(["run.error.error"]);
  });

  test("exposes a legacy resolver type signature", () => {
    const resolveFromLegacy: Policy.PolicyPointResolveFromLegacy = (timing, context) => {
      void context?.resourceKind;
      return Policy.PolicyPoint.MigrationMapping[timing];
    };

    expect(resolveFromLegacy(Policy.Timing.INVOKE_PREPARE, { resourceKind: "tool" })).toEqual(
      Policy.PolicyPoint.MigrationMapping[Policy.Timing.INVOKE_PREPARE],
    );
  });
});
