import { describe, expect, test } from "bun:test";
import { AppConnector, Execution, type Dispatch } from "@openomni/protocol";
import { handleConnectorEndpointWorkerSpawn } from "../../src/dispatch/handlers/connector-endpoint-worker.js";
import {
  createConnectorArtifactServices,
  createWorkerSemanticPorts,
} from "../../src/ledger/production/worker-connector.js";

const installation = AppConnector.Installation.parse({
  id: "installation-1",
  connectorId: "connector-1",
  connectorVersion: "1",
  endpointId: "endpoint-1",
  definition: {
    id: "connector-1",
    name: "Connector One",
    version: "1",
    description: "test connector",
    detect: { command: "connector", testedVersions: "1" },
    spawn: { command: "connector" },
    driver: {
      provider: "local",
      install: { scopes: ["workspace"] },
      submit: { mode: "spawn", ack: "running" },
      observedEvents: [],
      emits: [],
    },
    evidence: { emits: ["exit_code"] },
    requires: {},
    profile: { kind: "connector_endpoint", taskTypes: ["test"] },
  },
  testedVersions: "1",
  status: "enabled",
  registeredBy: "owner",
  consent: { grantedBy: "owner", grantedAt: 1 },
  createdAt: 1,
  updatedAt: 1,
});

function command(overrides: Partial<Dispatch.Command> = {}): Dispatch.Command {
  return {
    action: "worker.spawn",
    dispatchId: "dispatch-1",
    actor: { kind: "resident", actorId: "resident-1", sessionId: "session-1" },
    sessionId: "session-1",
    target: {
      kind: "worker",
      connectorInstallationId: installation.id,
      endpointId: installation.endpointId,
    },
    submittedAt: 1,
    ...overrides,
  };
}

function fixture() {
  const allocatedRequests: Execution.Request[] = [];
  const settlements: Array<{ transitionId: string; attemptId: string; error?: string }> = [];
  const startEffects: Parameters<
    Parameters<typeof createConnectorArtifactServices>[0]["lifecycle"]["confirmAttemptStart"]
  >[0][] = [];

  let attemptRow:
    | {
        workItemId: string;
        attemptId: string;
        attemptSeq: number;
        sessionId: string;
        runId: string;
        status: string;
        prompt: string;
        model: Execution.Request["model"];
        connectorInstallationId: string;
        settlement?:
          | Readonly<{ status: "succeeded"; result: Execution.Result }>
          | Readonly<{ status: "failed"; error: string }>;
      }
    | undefined;
  const dependencies: Parameters<typeof createConnectorArtifactServices>[0] = {
    workspaceRoot: "/workspace",
    modelEnvironment: {} as Execution.LLMEnvironmentV1,
    queries: {
      connectorInstallation: async (id) => (id === installation.id ? installation : undefined),
      attemptByRunId: async (runId) => (attemptRow?.runId === runId ? attemptRow : undefined),
    },
    lifecycle: {
      createWork: async () => undefined,
      readyWork: async () => undefined,
      allocateAttempt: async (input) => {
        allocatedRequests.push(input.request);
        attemptRow = {
          workItemId: input.attempt.workItemId,
          attemptId: input.attempt.attemptId,
          attemptSeq: input.attempt.attemptSeq,
          sessionId: input.sessionId,
          runId: input.runId,
          status: "allocated",
          prompt: input.request.prompt,
          model: input.request.model,
          connectorInstallationId: input.installation.id,
        };
      },
      requestAttemptStart: async (input) => {
        if (attemptRow !== undefined) attemptRow = { ...attemptRow, status: "starting" };
        return input.effect;
      },
      confirmAttemptStart: async (input) => {
        startEffects.push(input);
        if (attemptRow !== undefined) attemptRow = { ...attemptRow, status: "running" };
      },

      settleAttempt: async (input) => {
        settlements.push({
          transitionId: input.transitionId,
          attemptId: input.attempt.attemptId,
          ...(input.error === undefined ? {} : { error: input.error }),
        });
        if (attemptRow !== undefined) {
          attemptRow = {
            ...attemptRow,
            status: input.transitionId === "AT-07" ? "succeeded" : "failed",
            settlement: input.settlement,
          };
        }
      },
    },
    artifacts: { putAndReference: async () => undefined },
  };
  const connector = createConnectorArtifactServices(dependencies);
  return { connector, dependencies, allocatedRequests, settlements, startEffects };
}

describe("production connector attempt security", () => {
  test("requires explicit installation and actor/session bindings and preserves spawn conditions", async () => {
    const { connector, allocatedRequests } = fixture();
    await expect(
      connector.queries.resolveInstallation({
        kind: "worker",
        endpointId: installation.endpointId,
      }),
    ).resolves.toBeUndefined();
    await expect(
      connector.transitions.beginAttempt({
        command: command({
          actor: { kind: "resident", actorId: "resident-1", sessionId: "other" },
        }),
        model: { provider: "anthropic", id: "claude" },
        payload: {
          prompt: "Do the work",
          acceptanceCriteria: ["Tests pass"],
          constraints: ["No network"],
        },
        installation,
      }),
    ).rejects.toThrow("connector actor/session binding does not match");

    await connector.transitions.beginAttempt({
      command: command(),
      model: { provider: "anthropic", id: "claude" },
      payload: {
        prompt: "Do the work",
        acceptanceCriteria: ["Tests pass"],
        constraints: ["No network"],
      },
      installation,
    });
    expect(allocatedRequests[0]?.prompt).toContain("Acceptance criteria:\n- Tests pass");
    expect(allocatedRequests[0]?.prompt).toContain("Constraints:\n- No network");
  });

  test("carries only the exact approved connector effect and scope into running", async () => {
    const { connector, startEffects } = fixture();
    const begin = await connector.transitions.beginAttempt({
      command: command(),
      model: { provider: "anthropic", id: "claude" },
      payload: { prompt: "Do the work", acceptanceCriteria: [] },
      installation,
    });
    const proof = startEffects[0]?.effect;
    expect(proof).toMatchObject({
      operation: "connector.submit.v1",
      attempt: begin.attempt.attempt,
      scope: {
        resolver: { id: "connector-installation-v1", version: "1" },
        containment: "connector-declared",
        mutationClass: "unknown",
        resources: [{ kind: "connector", installationId: installation.id }, { kind: "endpoint" }],
      },
    });
    expect(proof?.effectId).toBe(`connector-effect:${proof?.sourceRef}`);

    const forgedFixture = fixture();
    const originalRequest = forgedFixture.dependencies.lifecycle.requestAttemptStart;
    const forged = createConnectorArtifactServices({
      ...forgedFixture.dependencies,
      lifecycle: {
        ...forgedFixture.dependencies.lifecycle,
        requestAttemptStart: async (input) => ({
          ...(await originalRequest(input)),
          sourceRef: "forged",
        }),
      },
    });
    await expect(
      forged.transitions.beginAttempt({
        command: command({ dispatchId: "dispatch-forged-effect" }),
        model: { provider: "anthropic", id: "claude" },
        payload: { prompt: "Forged", acceptanceCriteria: [] },
        installation,
      }),
    ).rejects.toThrow("connector start effect proof denied");

    const missingFixture = fixture();
    const missing = createConnectorArtifactServices({
      ...missingFixture.dependencies,
      lifecycle: {
        ...missingFixture.dependencies.lifecycle,
        requestAttemptStart: async () => undefined as never,
      },
    });
    await expect(
      missing.transitions.beginAttempt({
        command: command({ dispatchId: "dispatch-missing-effect" }),
        model: { provider: "anthropic", id: "claude" },
        payload: { prompt: "Missing", acceptanceCriteria: [] },
        installation,
      }),
    ).rejects.toThrow("connector start effect proof denied");
  });

  test("settles only the exact durable attempt once and rejects result identity substitution", async () => {
    const { connector, settlements } = fixture();
    const { attempt } = await connector.transitions.beginAttempt({
      command: command(),
      model: { provider: "anthropic", id: "claude" },
      payload: { prompt: "Do the work", acceptanceCriteria: [] },
      installation,
    });
    const forgedProjection = {
      ...attempt,
      attemptId: "forged",
      attempt: { ...attempt.attempt, attemptId: "forged" },
    };
    await expect(
      connector.transitions.settleAttempt({
        attempt: forgedProjection,
        settlement: {
          status: "succeeded",
          result: {
            runId: attempt.request.runId,
            sessionId: attempt.request.sessionId,
            status: "succeeded",
            output: "done",
          },
        },
      }),
    ).rejects.toThrow("connector settlement denied");
    const settlement = {
      status: "succeeded",
      result: {
        runId: attempt.request.runId,
        sessionId: attempt.request.sessionId,
        status: "succeeded",
        output: "done",
      },
    } as const;
    await connector.transitions.settleAttempt({ attempt, settlement });
    expect(settlements).toEqual([{ transitionId: "AT-07", attemptId: attempt.attemptId }]);
    await expect(connector.transitions.settleAttempt({ attempt, settlement })).resolves.toEqual({
      reflection: "done",
    });
    await expect(
      connector.transitions.beginAttempt({
        command: command(),
        model: { provider: "anthropic", id: "claude" },
        payload: { prompt: "Replay", acceptanceCriteria: [] },
        installation,
      }),
    ).rejects.toThrow("connector attempt is already reserved");

    const { attempt: second } = await connector.transitions.beginAttempt({
      command: command({ dispatchId: "dispatch-2" }),
      model: { provider: "anthropic", id: "claude" },
      payload: { prompt: "Do more", acceptanceCriteria: [] },
      installation,
    });
    await expect(
      connector.transitions.settleAttempt({
        attempt: second,
        settlement: {
          status: "succeeded",
          result: {
            runId: "wrong-run",
            sessionId: second.request.sessionId,
            status: "succeeded",
          },
        },
      }),
    ).rejects.toThrow("connector settlement denied");
    expect(settlements).toHaveLength(1);
  });

  test("classifies an exact running receipt as reconciliation after connector service restart", async () => {
    const { connector, dependencies, allocatedRequests } = fixture();
    const input = {
      command: command(),
      model: { provider: "anthropic", id: "claude" },
      payload: { prompt: "Do the work", acceptanceCriteria: [] },
      installation,
    } as const;
    const first = await connector.transitions.beginAttempt(input);
    const restarted = createConnectorArtifactServices(dependencies);

    expect(first.disposition).toBe("new");
    await expect(restarted.transitions.beginAttempt(input)).resolves.toEqual({
      disposition: "in_progress_or_unknown",
      attempt: first.attempt,
    });
    expect(allocatedRequests).toHaveLength(1);
  });

  test("replays the stored terminal result after the settlement response is lost", async () => {
    const { connector, dependencies, allocatedRequests, settlements } = fixture();
    const input = {
      command: command(),
      model: { provider: "anthropic", id: "claude" },
      payload: { prompt: "Do the work", acceptanceCriteria: [] },
      installation,
    } as const;
    const begin = await connector.transitions.beginAttempt(input);
    if (begin.disposition !== "new") throw new Error("expected a new connector attempt");
    const settlement = {
      status: "succeeded",
      result: {
        runId: begin.attempt.request.runId,
        sessionId: begin.attempt.request.sessionId,
        status: "succeeded",
        output: { durable: true },
      },
    } as const;
    await connector.transitions.settleAttempt({ attempt: begin.attempt, settlement });

    const restarted = createConnectorArtifactServices(dependencies);
    await expect(restarted.transitions.beginAttempt(input)).resolves.toEqual({
      disposition: "terminal_replay",
      attempt: begin.attempt,
      settlement,
    });
    expect(allocatedRequests).toHaveLength(1);
    expect(settlements).toHaveLength(1);
  });

  test("handler routes a running durable attempt to reconciliation without dispatch", async () => {
    const { connector } = fixture();
    const payload = { prompt: "Do the work", acceptanceCriteria: [] };
    await connector.transitions.beginAttempt({
      command: command(),
      model: { provider: "anthropic", id: "claude" },
      payload,
      installation,
    });
    let dispatches = 0;
    const response = await handleConnectorEndpointWorkerSpawn(
      command(),
      { provider: "anthropic", id: "claude" },
      payload,
      {
        driver: {
          kernelQueries: connector.queries,
          kernelTransitions: connector.transitions,
          dispatch: async () => {
            dispatches += 1;
            throw new Error("must not dispatch");
          },
        },
      },
    );

    expect(dispatches).toBe(0);
    expect(response).toMatchObject({
      output: { disposition: "in_progress_or_unknown", reconciliationRequired: true },
    });
  });

  test("handler replays a terminal durable result without redispatch", async () => {
    const { connector, dependencies } = fixture();
    let dispatches = 0;
    const driver = {
      kernelQueries: connector.queries,
      kernelTransitions: connector.transitions,
      dispatch: async ({ executionRequest }: { executionRequest: Execution.Request }) => {
        dispatches += 1;
        return Execution.Result.parse({
          runId: executionRequest.runId,
          sessionId: executionRequest.sessionId,
          status: "succeeded",
          output: "durable output",
        });
      },
    };
    const payload = { prompt: "Do the work", acceptanceCriteria: [] };
    const first = await handleConnectorEndpointWorkerSpawn(
      command(),
      { provider: "anthropic", id: "claude" },
      payload,
      { driver },
    );
    expect(dispatches).toBe(1);

    const restarted = createConnectorArtifactServices(dependencies);
    const replay = await handleConnectorEndpointWorkerSpawn(
      command(),
      { provider: "anthropic", id: "claude" },
      payload,
      { driver: { ...driver, kernelTransitions: restarted.transitions } },
    );
    expect(dispatches).toBe(1);
    expect(replay).toEqual(first);
  });

  test("does not reacquire a durable claim after a lost begin response", async () => {
    const { dependencies } = fixture();
    const dependencyFailure = new Error("start confirmation unavailable");
    let confirmations = 0;
    const originalConfirm = dependencies.lifecycle.confirmAttemptStart;
    const connector = createConnectorArtifactServices({
      ...dependencies,
      lifecycle: {
        ...dependencies.lifecycle,
        confirmAttemptStart: async (input) => {
          confirmations += 1;
          if (confirmations === 1) throw dependencyFailure;
          await originalConfirm(input);
        },
      },
    });
    const input = {
      command: command(),
      model: { provider: "anthropic", id: "claude" },
      payload: { prompt: "Do the work", acceptanceCriteria: [] },
      installation,
    } as const;

    await expect(connector.transitions.beginAttempt(input)).rejects.toBe(dependencyFailure);
    await expect(connector.transitions.beginAttempt(input)).resolves.toMatchObject({
      disposition: "in_progress_or_unknown",
      attempt: { attemptId: "dispatch-1" },
    });
    expect(confirmations).toBe(1);
  });

  test("does not translate an unexpected dependency failure into a deterministic rejection", async () => {
    const dependencyFailure = new Error("storage unavailable");
    const worker = createWorkerSemanticPorts({
      queries: {
        attemptByRunId: async () => {
          throw dependencyFailure;
        },
        workSession: async () => undefined,
        waitIdsByAttempt: async () => [],
        effectsByAttempt: async () => [],
        head: async (owner) => ({
          version: "ledger-head-v1",
          owner,
          ownerSeq: 0,
          eventHash: "GENESIS_V1",
        }),
      },
      projections: { query: async () => ({}) as never },
      workerLedger: {
        resolveAttemptByRunId: async () => undefined,
        resolveWorkByRunId: async () => undefined,
        commitSemanticTransition: async () => ({}) as never,
      },
    });

    await expect(
      worker.transition({
        channelIdentity: {
          runtimeId: "runtime-1",
          workerId: "worker-1",
          generation: 1,
          principalId: "principal-1",
          processId: 42,
          attempt: {
            version: "attempt-ref-v1",
            workItemId: "work-1",
            attemptId: "attempt-1",
            attemptSeq: 1,
          },
        },
        request: {
          workerId: "worker-1",
          generation: 1,
          sessionId: "session-1",
          runId: "run-1",
          command: {} as never,
        },
      }),
    ).rejects.toBe(dependencyFailure);
  });
});
