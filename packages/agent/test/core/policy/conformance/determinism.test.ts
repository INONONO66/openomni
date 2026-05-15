import { describe, expect, it } from "bun:test";
import type { Policy } from "@openomni/protocol";
import { PolicyEngine } from "../../../../src/core/policy";
import type { PolicyContext, PolicyRegistration } from "../../../../src/core/policy";
import { allow, inject } from "../../../helpers/policy-decision";

type PolicyDecision = Policy.PolicyDecision;

const goldenRequest = Object.freeze({
  steps: Object.freeze([]),
  usage: Object.freeze({ inputTokens: 128, outputTokens: 64, totalTokens: 192 }),
  turnCount: 2,
  isCompletion: false,
  continuationCount: 1,
  elapsedMs: 1_500,
  toolName: "shell",
  toolInput: Object.freeze({ command: "pwd", cwd: "/workspace" }),
  toolLabels: Object.freeze(["source.system", "risk.low"]),
});

const goldenDecision = Object.freeze({
  policyId: "agent.policy.composed",
  verdict: "allow",
  effects: Object.freeze([
    Object.freeze({ type: "prompt.inject_message", message: "Keep an audit trail." }),
    Object.freeze({ type: "prompt.inject_message", message: "Use read-only tools first." }),
    Object.freeze({ type: "prompt.inject_message", message: "Require approval for writes." }),
  ]),
  reasonCodes: Object.freeze(["policy.audit", "policy.readonly", "policy.approval"]),
});

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

function cloneGoldenRequest(): Omit<PolicyContext, "timing"> {
  return {
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
      name: "workspace-lock",
      timing: "model.request",
      priority: 30,
      fn: () => inject("Require approval for writes.", "policy.approval", "policy.approval"),
    },
    {
      name: "rewrite-cwd",
      timing: "model.request",
      priority: 10,
      fn: () => inject("Keep an audit trail.", "policy.audit", "policy.audit"),
    },
    {
      name: "runtime-timeout",
      timing: "model.request",
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
  return registerPolicies(registrations).dispatch("model.request", cloneGoldenRequest());
}

describe("policy determinism conformance", () => {
  it("returns the same EffectiveDecision for the same request snapshot and policy set", async () => {
    const first = await evaluate();
    const second = await evaluate();

    expectCanonicalDecision(first, goldenDecision);
    expectCanonicalDecision(second, goldenDecision);
  });

  it("is stable across randomized policy registration order", async () => {
    const decisions = await Promise.all(
      Array.from({ length: 12 }, (_, seed) => evaluate(deterministicOrder(seed))),
    );

    for (const decision of decisions) {
      expectCanonicalDecision(decision, goldenDecision);
    }
  });

  it("keeps concurrent dispatch evaluations isolated", async () => {
    const engine = registerPolicies(policySet());
    const decisions = await Promise.all(
      Array.from({ length: 16 }, () => engine.dispatch("model.request", cloneGoldenRequest())),
    );

    for (const decision of decisions) {
      expectCanonicalDecision(decision, goldenDecision);
    }
  });

  it("prevents policy functions from mutating the request snapshot", async () => {
    let mutationRejected = false;
    const request = cloneGoldenRequest();
    const engine = registerPolicies([
      {
        name: "mutating-policy",
        timing: "model.request",
        priority: 0,
        fn: (ctx) => {
          try {
            ctx.usage.totalTokens = 999;
          } catch {
            mutationRejected = true;
          }

          return allow("policy.mutating");
        },
      },
    ]);

    const decision = await engine.dispatch("model.request", request);

    expect(mutationRejected).toBe(true);
    expect(request).toEqual(cloneGoldenRequest());
    expectCanonicalDecision(decision, {
      policyId: "agent.policy.composed",
      verdict: "allow",
      effects: [],
      reasonCodes: [],
    });
  });
});
