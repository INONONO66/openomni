import { describe, expect, test } from "bun:test";
import { Policy, RuntimeResource } from "../../src/policy/index.js";

const expectedPointIds = [
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

describe("PolicyPoint registry", () => {
  test("accepts only canonical 3-tier point IDs", () => {
    expect(Policy.PolicyPoint.Id.parse("tool.native.pre")).toBe("tool.native.pre");
    expect(Policy.PolicyPoint.Id.parse("dispatch.action.pre")).toBe("dispatch.action.pre");
    expect(Policy.PolicyPoint.Id.safeParse("work.complete.pre").success).toBe(true);
    expect(Policy.PolicyPoint.Id.safeParse("tool.native.prepare").success).toBe(false);
    expect(Policy.PolicyPoint.Id.safeParse("tool.pre").success).toBe(false);
    expect(Policy.PolicyPoint.Id.safeParse("unknown.native.pre").success).toBe(false);
  });

  test("validates the versioned point contract shape", () => {
    const contract = Policy.PolicyPoint.Contract.parse({
      id: "tool.native.pre",
      version: 1,
      phase: "pre",
      resourceKinds: ["tool"],
      inputSchema: "policy.point.tool.native.pre.input.v1",
      requiredContext: ["sessionId", "runId", "toolId", "toolInput"],
      allowedEffects: ["tool.filter", "tool.rewrite_input", "run.abort", "audit.annotate"],
      defaultFailPolicy: "fail-closed",
      sideEffectBoundary: true,
    });

    expect(contract.id).toBe("tool.native.pre");
    expect(contract.allowedEffects.includes("tool.rewrite_input")).toBe(true);
  });

  test("retains the generic run completion contract independently of WorkItem admission", () => {
    expect(Policy.PolicyPoint.Registry["run.completion.pre"]).toEqual({
      id: "run.completion.pre",
      version: 1,
      phase: "pre",
      resourceKinds: ["run"],
      inputSchema: "policy.point.run.completion.pre.input.v1",
      requiredContext: ["sessionId", "runId", "completionCandidate"],
      allowedEffects: [
        "audit.annotate",
        "run.abort",
        "prompt.append_context",
        "run.replace_messages",
      ],
      defaultFailPolicy: "fail-closed",
      sideEffectBoundary: true,
    });
  });

  test("registers the fail-closed WorkItem completion admission contract", () => {
    expect(Reflect.get(Policy.PolicyPoint.Registry, "work.complete.pre")).toEqual({
      id: "work.complete.pre",
      version: 1,
      phase: "pre",
      resourceKinds: ["work"],
      inputSchema: "policy.point.work.complete.pre.input.v1",
      requiredContext: [
        "workItemHash",
        "requestId",
        "contractRevision",
        "basisRef",
        "expectedHead",
        "completionCandidate",
        "unresolvedBlockerIds",
      ],
      allowedEffects: ["audit.annotate", "run.abort", "work.allow_asserted"],
      defaultFailPolicy: "fail-closed",
      sideEffectBoundary: true,
    });
  });

  test("registers the criterion-scoped asserted-result allowance", () => {
    const effect = { type: "work.allow_asserted", criterionIds: ["criterion:publish"] };
    const parsed = Policy.PolicyEffect.safeParse(effect);

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(effect);
    expect(Policy.PolicyEffect.safeParse({ type: "work.allow_asserted" }).success).toBe(false);
  });

  test("accepts the canonical WorkItem resource kind", () => {
    expect(
      RuntimeResource.Descriptor.safeParse({
        id: "work:wi_admission",
        kind: "work",
        labels: [],
        capabilities: [],
        effects: [],
      }).success,
    ).toBe(true);
  });

  test("rejects effects that are not PolicyEffect types", () => {
    const parsed = Policy.PolicyPoint.Contract.safeParse({
      id: "tool.native.pre",
      version: 1,
      phase: "pre",
      resourceKinds: ["tool"],
      inputSchema: "policy.point.tool.native.pre.input.v1",
      requiredContext: [],
      allowedEffects: ["tool.delete_everything"],
      defaultFailPolicy: "fail-closed",
      sideEffectBoundary: true,
    });

    expect(parsed.success).toBe(false);
  });

  test("exports an initial contract for every required 3-tier point", () => {
    expect(Object.keys(Policy.PolicyPoint.Registry).sort()).toEqual([...expectedPointIds].sort());
    expect(Policy.PolicyPoint.RegistrySchema.parse(Policy.PolicyPoint.Registry)).toEqual(
      Policy.PolicyPoint.Registry,
    );

    for (const pointId of expectedPointIds) {
      const contract = Policy.PolicyPoint.Registry[pointId];
      expect(contract).toBeDefined();
      if (contract === undefined) continue;
      expect(contract.id).toBe(pointId);
      expect(contract.version).toBe(1);
      expect(Policy.PolicyPoint.Contract.safeParse(contract).success).toBe(true);
    }
  });

  test("preserves every v1 input schema identifier", () => {
    for (const pointId of expectedPointIds) {
      const contract = Policy.PolicyPoint.Registry[pointId];
      expect(contract).toBeDefined();
      if (contract === undefined) continue;
      expect(contract.inputSchema).toBe(`policy.point.${pointId}.input.v1`);
    }
  });

  test("maps legacy timings only to their generic registered points", () => {
    const aliases = Policy.PolicyPoint.MigrationMapping;

    expect(Object.keys(aliases).sort()).toEqual(Object.values(Policy.Timing).sort());
    expect(aliases[Policy.Timing.COMPLETION_PREPARE]).toEqual(["run.completion.pre"]);
    expect(Object.values(aliases).flat()).not.toContain("work.complete.pre");
    expect(aliases[Policy.Timing.DISPATCH_AUTHORIZE]).toEqual(["dispatch.action.pre"]);
    expect(aliases[Policy.Timing.INVOKE_PREPARE]).toEqual([
      "tool.native.pre",
      "tool.mcp.pre",
      "delegation.worker.pre",
    ]);
    expect(aliases[Policy.Timing.INVOKE_RESULT]).toEqual([
      "tool.native.post",
      "tool.mcp.post",
      "delegation.worker.post",
    ]);

    for (const pointIds of Object.values(aliases)) {
      for (const pointId of pointIds) {
        expect(Policy.PolicyPoint.Registry[pointId] !== undefined).toBe(true);
      }
    }
  });

  test("pre-boundary contracts fail closed and post-boundary contracts fail open", () => {
    expect(Policy.PolicyPoint.Registry["dispatch.action.pre"].defaultFailPolicy).toBe(
      "fail-closed",
    );
    expect(Policy.PolicyPoint.Registry["dispatch.action.pre"].sideEffectBoundary).toBe(true);
    expect(Policy.PolicyPoint.Registry["dispatch.action.pre"].allowedEffects).toEqual([
      "audit.annotate",
      "run.abort",
    ]);
    expect(Policy.PolicyPoint.Registry["tool.native.pre"].defaultFailPolicy).toBe("fail-closed");
    expect(Policy.PolicyPoint.Registry["tool.native.pre"].sideEffectBoundary).toBe(true);
    expect(Policy.PolicyPoint.Registry["tool.native.post"].defaultFailPolicy).toBe("fail-open");
    expect(Policy.PolicyPoint.Registry["tool.native.post"].sideEffectBoundary).toBe(false);
    const completionContract = Policy.PolicyPoint.Registry["work.complete.pre"];
    expect(completionContract).toBeDefined();
    if (completionContract === undefined) return;
    expect(completionContract.defaultFailPolicy).toBe("fail-closed");
    expect(completionContract.sideEffectBoundary).toBe(true);
    expect(Policy.PolicyPoint.Registry["run.error.error"].phase).toBe("error");
  });
});
