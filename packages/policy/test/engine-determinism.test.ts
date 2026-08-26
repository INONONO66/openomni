import { describe, expect, it } from "bun:test";
import { PolicyDecision as ProtocolPolicyDecision, type Policy } from "@openomni/protocol";
import {
  PolicyEngine,
  type CanonicalPolicyRegistrationGeneric,
  type GenericPolicyContext,
} from "@openomni/policy";

const inject = (message: string, policyId: string, reason: string) =>
  ProtocolPolicyDecision.allow({
    policyId,
    reasonCodes: [reason],
    effects: [{ type: "prompt.inject_message", message }],
  });

type PolicyContext = GenericPolicyContext & Record<string, unknown>;
type PolicyRegistration = CanonicalPolicyRegistrationGeneric<PolicyContext>;

type PolicyDecision = Policy.PolicyDecision;

const goldenRequest = Object.freeze({
  sessionId: "session",
  runId: "run",
  modelId: "model",
  steps: Object.freeze([]),
  usage: Object.freeze({ inputTokens: 128, outputTokens: 64, totalTokens: 192 }),
  turnCount: 2,
  isCompletion: false,
  continuationCount: 1,
  elapsedMs: 1_500,
  toolName: "shell",
  toolInput: Object.freeze({ command: "pwd", cwd: "/workspace" }),
  toolLabels: Object.freeze(["source:system", "risk.low"]),
});

/**
 * Built fresh per use, like {@link cloneGoldenRequest}: a shared frozen
 * literal would type its arrays `readonly` and force the comparison helper to
 * widen for a hazard cloning already removes.
 */
function goldenDecision(): Omit<PolicyDecision, "durationMs"> {
  return {
    policyId: "agent.policy.composed",
    verdict: "allow",
    effects: [
      { type: "prompt.inject_message", message: "Keep an audit trail." },
      { type: "prompt.inject_message", message: "Use read-only tools first." },
      { type: "prompt.inject_message", message: "Require approval for writes." },
    ],
    reasonCodes: ["policy.audit", "policy.readonly", "policy.approval"],
  };
}

function stableDecision(decision: PolicyDecision): Omit<PolicyDecision, "durationMs"> {
  const { durationMs: _durationMs, ...stable } = decision;
  return stable;
}

function expectCanonicalDecision(
  decision: PolicyDecision,
  expected: Omit<PolicyDecision, "durationMs">,
): void {
  expect(stableDecision(decision)).toEqual(expected);
  expect(typeof decision.durationMs).toBe("number");
}

type GoldenRequest = Omit<PolicyContext, "timing"> & {
  sessionId: string;
  runId: string;
  modelId: string;
};

function cloneGoldenRequest(): GoldenRequest {
  return {
    sessionId: goldenRequest.sessionId,
    runId: goldenRequest.runId,
    modelId: goldenRequest.modelId,
    steps: [],
    usage: { ...goldenRequest.usage },
    turnCount: goldenRequest.turnCount,
    isCompletion: goldenRequest.isCompletion,
    continuationCount: goldenRequest.continuationCount,
    elapsedMs: goldenRequest.elapsedMs,
    toolName: goldenRequest.toolName,
    toolInput: { ...goldenRequest.toolInput },
    toolLabels: [...goldenRequest.toolLabels],
  };
}

function policySet(): PolicyRegistration[] {
  return [
    {
      kind: "point",
      name: "workspace-lock",
      pointIds: ["connection.llm.pre"],
      effectCapabilities: { "connection.llm.pre": ["prompt.inject_message"] },
      priority: 30,
      fn: () => inject("Require approval for writes.", "policy.approval", "policy.approval"),
    },
    {
      kind: "point",
      name: "rewrite-cwd",
      pointIds: ["connection.llm.pre"],
      effectCapabilities: { "connection.llm.pre": ["prompt.inject_message"] },
      priority: 10,
      fn: () => inject("Keep an audit trail.", "policy.audit", "policy.audit"),
    },
    {
      kind: "point",
      name: "runtime-timeout",
      pointIds: ["connection.llm.pre"],
      effectCapabilities: { "connection.llm.pre": ["prompt.inject_message"] },
      priority: 20,
      fn: () => inject("Use read-only tools first.", "policy.readonly", "policy.readonly"),
    },
  ];
}

function registerPolicies(registrations: PolicyRegistration[]) {
  const engine = PolicyEngine.create();
  for (const registration of registrations) engine.register(registration);
  return engine;
}

function deterministicOrder(seed: number): PolicyRegistration[] {
  return policySet()
    .map((registration, index) => ({ registration, rank: (seed * 17 + index * 13) % 7 }))
    .sort((left, right) => left.rank - right.rank)
    .map(({ registration }) => registration);
}

async function evaluate(registrations = policySet()): Promise<PolicyDecision> {
  return registerPolicies(registrations).dispatchPoint("connection.llm.pre", cloneGoldenRequest());
}

describe("policy determinism conformance", () => {
  it("returns the same EffectiveDecision for the same request snapshot and policy set", async () => {
    const first = await evaluate();
    const second = await evaluate();

    expectCanonicalDecision(first, goldenDecision());
    expectCanonicalDecision(second, goldenDecision());
  });

  it("is stable across randomized policy registration order", async () => {
    const decisions = await Promise.all(
      Array.from({ length: 12 }, (_, seed) => evaluate(deterministicOrder(seed))),
    );

    for (const decision of decisions) {
      expectCanonicalDecision(decision, goldenDecision());
    }
  });

  it("keeps concurrent dispatch evaluations isolated", async () => {
    const engine = registerPolicies(policySet());
    const decisions = await Promise.all(
      Array.from({ length: 16 }, () =>
        engine.dispatchPoint("connection.llm.pre", cloneGoldenRequest()),
      ),
    );

    for (const decision of decisions) {
      expectCanonicalDecision(decision, goldenDecision());
    }
  });

});
