import { describe, expect, test } from "bun:test";
import { PolicyDecision, PolicyEvent } from "@openomni/protocol";
import {
  type GenericPolicyContext,
  PolicyEngine,
  type PolicyEngineCompatibilityGeneric,
} from "@openomni/policy";

interface TestContext extends GenericPolicyContext {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly turnIndex?: number;
}

const compatibility = {
  resolvePointForLegacyDispatch: (timing) =>
    timing === "context.prepare"
      ? "prompt.context.pre"
      : timing === "invoke.prepare"
        ? "tool.native.pre"
        : undefined,
} satisfies PolicyEngineCompatibilityGeneric<TestContext>;

function createAuditedEngine(id: string) {
  const events: Array<{ readonly name: string; readonly data: unknown }> = [];
  const engine = PolicyEngine.create<TestContext>(
    {
      traceContext: { traceId: `trace-${id}`, sessionId: `session-${id}` },
      auditEmit: (event, data) => events.push({ name: event.name, data }),
    },
    compatibility,
  );
  return { engine, events };
}

const promptContext = {
  sessionId: "session-legacy-canonical",
  runId: "run-legacy-canonical",
  turnIndex: 0,
} as const;

describe("PolicyEngine legacy-to-canonical compatibility", () => {
  test("denies a mapped fail-closed contract when no registrations match", async () => {
    // Given
    const { engine, events } = createAuditedEngine("legacy-canonical-fail-closed");

    // When
    const decision = await engine.dispatch("invoke.prepare", {});

    // Then
    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("policy.context_missing");
    const evaluated = PolicyEvent.Evaluated.schema.parse(
      events.find(({ name }) => name === PolicyEvent.Evaluated.name)?.data,
    );
    expect(evaluated).toMatchObject({
      policyId: "policy.point.contract",
      pointId: "tool.native.pre",
      verdict: "deny",
      reasonCodes: ["policy.context_missing"],
    });
  });

  test("enforces a mapped canonical contract when no registrations match", async () => {
    // Given
    const { engine, events } = createAuditedEngine("legacy-canonical-contract");

    // When
    const decision = await engine.dispatch("context.prepare", {});

    // Then
    expect(decision.verdict).toBe("allow");
    expect(decision.reasonCodes).toContain("policy.context_missing");
    const evaluated = PolicyEvent.Evaluated.schema.parse(
      events.find(({ name }) => name === PolicyEvent.Evaluated.name)?.data,
    );
    expect(evaluated).toMatchObject({
      policyId: "policy.point.contract",
      pointId: "prompt.context.pre",
      reasonCodes: ["policy.context_missing"],
    });
  });

  test("enforces canonical required context before invoking middleware", async () => {
    // Given
    const engine = PolicyEngine.create<TestContext>({}, compatibility);
    let invoked = false;
    engine.register({
      kind: "point",
      name: "canonical-contract",
      pointIds: ["prompt.context.pre"],
      effectCapabilities: { "prompt.context.pre": [] },
      priority: 0,
      fn: () => {
        invoked = true;
        return PolicyDecision.allow({ policyId: "canonical-contract" });
      },
    });

    // When
    const decision = await engine.dispatch("context.prepare", {});

    // Then
    expect(invoked).toBe(false);
    expect(decision.verdict).toBe("allow");
    expect(decision.reasonCodes).toContain("policy.context_missing");
  });

  test("rejects canonical effects undeclared at registration", async () => {
    // Given
    const engine = PolicyEngine.create<TestContext>({}, compatibility);
    engine.register({
      kind: "point",
      name: "canonical-undeclared-effect",
      pointIds: ["prompt.context.pre"],
      effectCapabilities: { "prompt.context.pre": [] },
      priority: 0,
      fn: () =>
        PolicyDecision.allow({
          policyId: "canonical-undeclared-effect",
          effects: [{ type: "prompt.inject_message", message: "hidden" }],
        }),
    });

    // When
    const decision = await engine.dispatch("context.prepare", promptContext);

    // Then
    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toContain("policy.effect_not_declared");
    expect(decision.effects.some((effect) => effect.type === "prompt.inject_message")).toBe(false);
  });
});
