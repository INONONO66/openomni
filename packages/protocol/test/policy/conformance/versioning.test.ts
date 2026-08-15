import { describe, expect, test } from "bun:test";
import { Policy, RuntimeResource, policyKernelVersion } from "../../../src/policy/index.js";

type PolicyPointContract =
  (typeof Policy.PolicyPoint.Registry)[keyof typeof Policy.PolicyPoint.Registry];

type DecisionReplayFixture = {
  readonly name: string;
  readonly policyKernelVersion: number;
  readonly policyPoint: PolicyPointContract;
  readonly resource: RuntimeResource.Descriptor;
  readonly decision: unknown;
};

type ReplayResult = {
  readonly decision: Policy.PolicyDecision;
  readonly resource: RuntimeResource.Descriptor;
};

class PolicyFixtureMigrationError extends Error {
  readonly code = "POLICY_FIXTURE_MIGRATION_REQUIRED";

  constructor(
    readonly fixtureName: string,
    readonly expectedVersion: number,
    readonly receivedVersion: number,
  ) {
    super(
      `Policy fixture ${fixtureName} requires migration from contract version ${receivedVersion} to ${expectedVersion}`,
    );
    this.name = "PolicyFixtureMigrationError";
  }
}

const toolResource = RuntimeResource.Descriptor.parse({
  id: "tool:system:bash",
  kind: "tool",
  labels: ["source:system", "tool.shell"],
  capabilities: ["shell.exec"],
  effects: ["workspace.read"],
  source: { type: "system" },
});

const runResource = RuntimeResource.Descriptor.parse({
  id: "policy:operator:workspace-safety",
  kind: "policy",
  labels: ["policy.workspace-safety"],
  capabilities: ["policy.evaluate"],
  effects: ["runtime.govern"],
  source: { type: "user", userId: "operator" },
});

const oldDecisionFixtures: DecisionReplayFixture[] = [
  {
    name: "legacy-allow-without-policy-version",
    policyKernelVersion,
    policyPoint: { ...Policy.PolicyPoint.Registry["tool.native.pre"] },
    resource: toolResource,
    decision: {
      policyId: "policy.legacy-tool-allow",
      verdict: "allow",
      effects: [],
      reasonCodes: ["legacy_fixture_allow"],
    },
  },
  {
    name: "versioned-deny-with-audit-effect",
    policyKernelVersion,
    policyPoint: { ...Policy.PolicyPoint.Registry["run.lifecycle.pre"] },
    resource: runResource,
    decision: {
      policyId: "policy.workspace-safety",
      policyVersion: "1",
      verdict: "deny",
      effects: [
        { type: "audit.annotate", annotation: "workspace write denied", severity: "warning" },
        { type: "run.abort", reason: "workspace_write_denied" },
      ],
      reasonCodes: ["workspace_write_denied"],
      factsUsed: ["resource.labels", "actor.permissions"],
      durationMs: 4,
    },
  },
];

const goldenPolicyPointFixtures = Object.values(Policy.PolicyPoint.Registry).map((contract) => ({
  policyKernelVersion,
  contract: { ...contract },
}));

function getCurrentContract(id: string): PolicyPointContract | undefined {
  return Object.values(Policy.PolicyPoint.Registry).find((contract) => contract.id === id);
}

function requireCurrentPolicyPointContract(
  fixtureName: string,
  contract: PolicyPointContract,
): PolicyPointContract {
  const current = getCurrentContract(contract.id);

  if (current === undefined) {
    throw new PolicyFixtureMigrationError(
      fixtureName,
      Policy.PolicyPoint.version,
      contract.version,
    );
  }

  if (current.version !== contract.version || current.inputSchema !== contract.inputSchema) {
    throw new PolicyFixtureMigrationError(fixtureName, current.version, contract.version);
  }

  return Policy.PolicyPoint.Contract.parse(contract);
}

function replayDecisionFixture(fixture: DecisionReplayFixture): ReplayResult {
  if (fixture.policyKernelVersion !== policyKernelVersion) {
    throw new PolicyFixtureMigrationError(
      fixture.name,
      policyKernelVersion,
      fixture.policyKernelVersion,
    );
  }

  requireCurrentPolicyPointContract(fixture.name, fixture.policyPoint);

  return {
    decision: Policy.PolicyDecision.parse(fixture.decision),
    resource: RuntimeResource.Descriptor.parse(fixture.resource),
  };
}

function safeReplay(
  fixture: DecisionReplayFixture,
): { ok: true; result: ReplayResult } | { ok: false; error: unknown } {
  try {
    return { ok: true, result: replayDecisionFixture(fixture) };
  } catch (error) {
    return { ok: false, error };
  }
}

function firstDecisionFixture(): DecisionReplayFixture {
  const [fixture] = oldDecisionFixtures;
  if (fixture === undefined) throw new Error("decision fixture missing");
  return fixture;
}

describe("PolicyPoint versioning conformance", () => {
  test("replays old PolicyDecision fixtures against current schemas", () => {
    for (const fixture of oldDecisionFixtures) {
      const replay = replayDecisionFixture(fixture);

      expect(RuntimeResource.Descriptor.parse(replay.resource)).toEqual(replay.resource);
      expect(replay.decision.policyId).toBe(Policy.PolicyDecision.parse(fixture.decision).policyId);
    }
  });

  test("validates golden fixtures for current PolicyPoint schema versions", () => {
    expect(goldenPolicyPointFixtures.length).toBe(Object.keys(Policy.PolicyPoint.Registry).length);

    for (const fixture of goldenPolicyPointFixtures) {
      const contract = Policy.PolicyPoint.Contract.parse(fixture.contract);

      expect(fixture.policyKernelVersion).toBe(policyKernelVersion);
      expect(contract.version).toBe(Policy.PolicyPoint.version);
      expect(contract.inputSchema.endsWith(`.v${contract.version}`)).toBe(true);
    }
  });

  test("locks the dispatch policy point golden fixture", () => {
    const fixture = goldenPolicyPointFixtures.find(
      (candidate) => candidate.contract.id === "dispatch.action.pre",
    );

    expect(fixture !== undefined).toBe(true);
    if (fixture === undefined) throw new Error("dispatch fixture missing");

    const contract = Policy.PolicyPoint.Contract.parse(fixture.contract);
    expect(contract.inputSchema).toBe("policy.point.dispatch.action.pre.input.v1");
    expect(contract.allowedEffects).toEqual(["audit.annotate", "run.abort"]);
    expect(contract.defaultFailPolicy).toBe("fail-closed");
    expect(contract.sideEffectBoundary).toBe(true);
  });

  test("requires explicit migration errors for breaking point schema changes", () => {
    const fixture = firstDecisionFixture();
    const replay = safeReplay({
      ...fixture,
      policyPoint: {
        ...fixture.policyPoint,
        version: fixture.policyPoint.version + 1,
        inputSchema: `${fixture.policyPoint.inputSchema}.breaking`,
      },
    });

    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error("breaking fixture replayed without migration");

    expect(replay.error instanceof PolicyFixtureMigrationError).toBe(true);
    if (replay.error instanceof PolicyFixtureMigrationError) {
      expect(replay.error.code).toBe("POLICY_FIXTURE_MIGRATION_REQUIRED");
      expect(replay.error.fixtureName).toBe(fixture.name);
      expect(replay.error.message.includes("requires migration")).toBe(true);
    }
  });

  test("exposes consistent kernel, point, and resource schema versions", () => {
    const worker = RuntimeResource.Descriptor.parse({
      id: "worker:coordinator:version-worker",
      kind: "worker",
      labels: ["source:coordinator", "worker.coordinator"],
      capabilities: [],
      effects: [],
      source: { type: "coordinator" },
    });
    const credential = RuntimeResource.Descriptor.parse({
      id: "credential:anthropic:api-key",
      kind: "credential",
      labels: ["source:file", "credential.anthropic"],
      capabilities: [],
      effects: [],
      source: { type: "file" },
    });
    const session = RuntimeResource.Descriptor.parse({
      id: "session:ses_version",
      kind: "session",
      labels: ["source:runtime", "session.self-loop"],
      capabilities: [],
      effects: [],
      source: { type: "runtime", runtimeId: "ses_version" },
    });

    expect(policyKernelVersion > 0).toBe(true);
    expect(Policy.PolicyPoint.version).toBe(policyKernelVersion);

    for (const contract of Object.values(Policy.PolicyPoint.Registry)) {
      expect(contract.version).toBe(Policy.PolicyPoint.version);
    }

    for (const descriptor of [toolResource, worker, credential, session]) {
      expect(RuntimeResource.Descriptor.safeParse(descriptor).success).toBe(true);
    }
  });
});
