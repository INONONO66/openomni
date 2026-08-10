import { describe, expect, test } from "bun:test";
import { type Policy, PolicyDecision, PolicyEvent } from "@openomni/protocol";
import { type GenericPolicyContext, PolicyEngine } from "@openomni/policy";

interface TestContext extends GenericPolicyContext {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly turnIndex?: number;
}

function createAuditedEngine(id: string) {
  const events: Array<{ readonly name: string; readonly data: unknown }> = [];
  const engine = PolicyEngine.create<TestContext>({
    traceContext: { traceId: `trace-${id}`, sessionId: `session-${id}` },
    auditEmit: (event, data) => events.push({ name: event.name, data }),
  });
  return { engine, events };
}

const promptContext = {
  sessionId: "session-legacy-canonical",
  runId: "run-legacy-canonical",
  turnIndex: 0,
} as const;

// The legacy timing dispatch compatibility layer was deleted in #530. These
// tests pin the canonical dispatchPoint contract semantics that replaced it.
describe("PolicyEngine canonical point contracts", () => {
  test("denies a fail-closed contract with audit evidence when context is missing", async () => {
    // Given
    const { engine, events } = createAuditedEngine("canonical-fail-closed");

    // When
    const decision = await engine.dispatchPoint(
      "tool.native.pre",
      {} as unknown as Policy.PolicyPointInputMap["tool.native.pre"],
    );

    // Then
    expect(decision.verdict).toBe("deny");
    expect(decision.policyId).toBe("agent.policy.composed");
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

  test("accepts valid canonical context without audit evidence when no registrations match", async () => {
    // Given
    const { engine, events } = createAuditedEngine("canonical-contract");

    // When
    const decision = await engine.dispatchPoint("prompt.context.pre", promptContext);

    // Then
    expect(decision.verdict).toBe("allow");
    expect(decision.reasonCodes).toEqual([]);
    expect(events.some(({ name }) => name === PolicyEvent.Evaluated.name)).toBe(false);
  });

  test("enforces required context before invoking middleware at fail-open points", async () => {
    // Given
    const engine = PolicyEngine.create<TestContext>();
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
    const decision = await engine.dispatchPoint(
      "prompt.context.pre",
      {} as unknown as Policy.PolicyPointInputMap["prompt.context.pre"],
    );

    // Then
    expect(invoked).toBe(false);
    expect(decision.verdict).toBe("allow");
    expect(decision.reasonCodes).toContain("policy.context_missing");
  });
});
