import { beforeEach, describe, expect, test } from "bun:test";
import { type AppConnector, type Execution, WorkItem } from "@openomni/protocol";
import { AppConnectorInstallationStore, Storage, WorkItemStore } from "@openomni/ledger";
import { z } from "zod";
import { createWorkerDispatchHandlers } from "../../src/dispatch/handlers/worker";
import { command, expectRejectsWithMessage, workerSpawnPayload } from "./helpers";

const TEST_CONNECTOR_ID = "app.test-connector";
const TEST_INSTALLATION_ID_PREFIX = "install:test-connector";
const TEST_ENDPOINT_ID_PREFIX = "endpoint:install:test-connector";
const TEST_CONNECTOR_NAME = "Test Connector";

const ConnectorEndpointWorkerSpawnOutput = z
  .object({
    output: z
      .object({
        workItemHash: z.string(),
        connectorId: z.literal(TEST_CONNECTOR_ID),
        connectorInstallationId: z.string(),
        result: z.object({ status: z.literal("succeeded"), output: z.literal("done") }),
      })
      .passthrough(),
  })
  .passthrough();

const missingConnectorDriverOwnerError =
  "worker.spawn connector endpoint requires a connector driver owner";
const missingEnabledConnectorInstallationError =
  "worker.spawn connector endpoint requires an enabled AppConnector installation";

type ConnectorEvidenceCase = {
  readonly name: string;
  readonly resultEvidence:
    | Pick<Execution.Result, "artifacts">
    | Pick<Execution.Result, "logEvents">;
  readonly expectedDescription: string;
  readonly expectedDetail: string;
};

type ConnectorEndpointCommandOptions = {
  readonly name?: string;
};

type WorkerDispatchHandlerOptions = NonNullable<Parameters<typeof createWorkerDispatchHandlers>[0]>;
type ConnectorEndpointDriverOwner = NonNullable<
  WorkerDispatchHandlerOptions["connectorEndpointDriver"]
>;

const connectorEvidenceCases: readonly ConnectorEvidenceCase[] = [
  {
    name: "records connector log artifacts as WorkItem evidence",
    resultEvidence: {
      artifacts: [
        {
          kind: "connector_log",
          artifactId: "art_cli_log",
          title: "connector log",
          mimeType: "text/plain",
        },
      ],
    },
    expectedDescription: "connector log artifact recorded",
    expectedDetail: "art_cli_log",
  },
  {
    name: "records connector log events as WorkItem evidence",
    resultEvidence: {
      logEvents: [
        {
          kind: "connector_log_event",
          artifactId: "art_cli_log",
          message: "tool completed",
          timestamp: "1700000000000",
          sequence: 0,
          data: { type: "tool_result", message: "tool completed" },
        },
      ],
    },
    expectedDescription: "connector log event recorded",
    expectedDetail: "tool_result",
  },
];

function testConnector(): AppConnector.Definition {
  return {
    id: TEST_CONNECTOR_ID,
    name: TEST_CONNECTOR_NAME,
    version: "1.0.0",
    description: "Runs a test connector endpoint",
    detect: {
      command: "test-connector",
      testedVersions: ">=1.0.0 <2.0.0",
    },
    spawn: {
      command: "test-connector",
      promptArgument: "{{prompt}}",
      cwd: "{{worktree}}",
    },
    evidence: {
      emits: ["exit_code"],
    },
    requires: {},
    driver: {
      provider: "test-connector",
      install: { scopes: ["workspace"], hooks: [], plugins: [] },
      submit: { mode: "spawn", ack: "accepted" },
      observedEvents: ["accepted", "completed"],
      emits: ["exit_code"],
    },
    profile: {
      kind: "connector_endpoint",
      taskTypes: ["code.change"],
    },
  };
}

function seedConnectorInstallation(
  status: AppConnector.InstallationStatus,
  withConsent = status === "enabled",
): AppConnector.Installation {
  const connector = testConnector();
  return AppConnectorInstallationStore.set({
    id: `${TEST_INSTALLATION_ID_PREFIX}:${status}`,
    connectorId: connector.id,
    connectorVersion: connector.version,
    definition: connector,
    detectedVersion: "1.0.0",
    testedVersions: connector.detect.testedVersions,
    status,
    registeredBy: "act_owner",
    ...(withConsent ? { consent: { grantedBy: "act_owner", grantedAt: 1 } } : {}),
  });
}

function connectorEndpointWorkerCommand(options: ConnectorEndpointCommandOptions = {}) {
  return command(
    "worker.spawn",
    {
      kind: "worker",
      id: TEST_CONNECTOR_ID,
      endpointId: `${TEST_ENDPOINT_ID_PREFIX}:enabled`,
      ...options,
    },
    workerSpawnPayload("build with test connector"),
  );
}

function dispatchConnectorEndpointWorkerSpawn(
  handlers: ReturnType<typeof createWorkerDispatchHandlers>,
  options?: ConnectorEndpointCommandOptions,
) {
  return handlers["worker.spawn"](connectorEndpointWorkerCommand(options));
}

function createConnectorEndpointHandlers(dispatch: ConnectorEndpointDriverOwner["dispatch"]) {
  return createWorkerDispatchHandlers({ connectorEndpointDriver: { dispatch } });
}

async function expectConnectorEndpointWorkerSpawnRejects(
  handlers: ReturnType<typeof createWorkerDispatchHandlers>,
  message: string,
): Promise<void> {
  await expectRejectsWithMessage(() => dispatchConnectorEndpointWorkerSpawn(handlers), message);
}

function succeededResult(request: Execution.Request): Execution.Result {
  return {
    runId: request.runId,
    sessionId: request.sessionId,
    status: "succeeded",
    output: "done",
  };
}

describe("worker.spawn connector endpoint dispatch wiring", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  test("dispatches to injected connector endpoint driver when an enabled matching installation exists", async () => {
    const installation = seedConnectorInstallation("enabled");
    const requests: Execution.Request[] = [];
    const installationIds: string[] = [];
    const handlers = createConnectorEndpointHandlers(async (request) => {
      requests.push(request.executionRequest);
      installationIds.push(request.installation.id);
      return succeededResult(request.executionRequest);
    });

    const result = ConnectorEndpointWorkerSpawnOutput.parse(
      await dispatchConnectorEndpointWorkerSpawn(handlers, { name: TEST_CONNECTOR_NAME }),
    );

    expect(result.output).toMatchObject({
      workItemHash: WorkItemStore.list()[0]?.workItemId,
      connectorId: TEST_CONNECTOR_ID,
      connectorInstallationId: installation.id,
      result: { status: "succeeded", output: "done" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      prompt: "build with test connector",
      agentName: `${TEST_ENDPOINT_ID_PREFIX}:enabled`,
    });
    expect(installationIds).toEqual([installation.id]);
    expect(WorkItemStore.list()[0]).toMatchObject({
      executorKind: "connector_endpoint",
      assigneeId: `${TEST_ENDPOINT_ID_PREFIX}:enabled`,
    });
  });

  for (const evidenceCase of connectorEvidenceCases) {
    test(evidenceCase.name, async () => {
      seedConnectorInstallation("enabled");
      const handlers = createConnectorEndpointHandlers(async (request) => ({
        ...succeededResult(request.executionRequest),
        ...evidenceCase.resultEvidence,
      }));

      const result = ConnectorEndpointWorkerSpawnOutput.parse(
        await dispatchConnectorEndpointWorkerSpawn(handlers),
      );

      const workItem = WorkItemStore.get(result.output.workItemHash);
      expect(workItem?.evidence).toMatchObject([
        {
          kind: "custom",
          passed: true,
          description: evidenceCase.expectedDescription,
        },
      ]);
      expect(workItem?.evidence[0]?.detail).toContain(evidenceCase.expectedDetail);
    });
  }

  test("fails closed when an enabled matching installation exists but no connector driver is registered", async () => {
    seedConnectorInstallation("enabled");
    const handlers = createWorkerDispatchHandlers();

    await expectConnectorEndpointWorkerSpawnRejects(handlers, missingConnectorDriverOwnerError);

    expect(WorkItemStore.list()[0]).toMatchObject({
      executorKind: "connector_endpoint",
      failureReason: missingConnectorDriverOwnerError,
    });
  });

  test("preserves missing-driver failure when ledger reflection also fails", async () => {
    seedConnectorInstallation("enabled");
    const adapter = Storage.get().workItem;
    if (!adapter) throw new Error("missing WorkItem adapter");
    const compareAndSet = adapter.compareAndSet.bind(adapter);
    adapter.compareAndSet = (hash, expectedHead, candidate) => {
      if (candidate.evidence.some(({ passed }) => !passed)) {
        throw new Error("work item write failed");
      }
      return compareAndSet(hash, expectedHead, candidate);
    };

    let caught: unknown;
    try {
      await dispatchConnectorEndpointWorkerSpawn(createWorkerDispatchHandlers());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) return;
    expect(caught.name).toBe("WorkItemReflectionError");
    expect(caught.message).toBe(missingConnectorDriverOwnerError);
    expect(caught.cause).toEqual(new Error(missingConnectorDriverOwnerError));
    expect(Reflect.get(caught, "reflectionFailure")).toEqual(new Error("work item write failed"));
  });

  test("marks the WorkItem failed when the connector driver owner throws", async () => {
    seedConnectorInstallation("enabled");
    const handlers = createConnectorEndpointHandlers(async () => {
      throw new Error("runtime exploded");
    });

    await expectConnectorEndpointWorkerSpawnRejects(handlers, "runtime exploded");

    const workItem = WorkItemStore.list()[0];
    expect(workItem).toMatchObject({
      executorKind: "connector_endpoint",
      failureReason: "runtime exploded",
    });
    expect(workItem ? WorkItem.deriveStatus(workItem) : undefined).toBe("failed");
  });

  test("preserves connector dispatch failure when failure reflection also fails", async () => {
    seedConnectorInstallation("enabled");
    const adapter = Storage.get().workItem;
    if (!adapter) throw new Error("missing WorkItem adapter");
    const compareAndSet = adapter.compareAndSet.bind(adapter);
    adapter.compareAndSet = (hash, expectedHead, candidate) => {
      if (candidate.failureReason === "runtime exploded") {
        throw new Error("work item write failed");
      }
      return compareAndSet(hash, expectedHead, candidate);
    };
    const handlers = createConnectorEndpointHandlers(async () => {
      throw new Error("runtime exploded");
    });

    let caught: unknown;
    try {
      await dispatchConnectorEndpointWorkerSpawn(handlers);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) return;
    expect(caught.name).toBe("WorkItemReflectionError");
    expect(caught.message).toBe("runtime exploded");
    expect(caught.cause).toEqual(new Error("runtime exploded"));
    expect(Reflect.get(caught, "reflectionFailure")).toEqual(new Error("work item write failed"));
  });

  test("fails closed when no enabled matching installation exists", async () => {
    let dispatchCalled = false;
    const handlers = createConnectorEndpointHandlers(async (request) => {
      dispatchCalled = true;
      return succeededResult(request.executionRequest);
    });

    await expectConnectorEndpointWorkerSpawnRejects(
      handlers,
      missingEnabledConnectorInstallationError,
    );

    expect(dispatchCalled).toBe(false);
    expect(WorkItemStore.list()[0]).toMatchObject({
      executorKind: "connector_endpoint",
      failureReason: missingEnabledConnectorInstallationError,
    });
  });

  test("rejects an enabled matching installation without consent before dispatch", () => {
    expect(() => seedConnectorInstallation("enabled", false)).toThrow(
      "enabled installation requires owner consent",
    );
    expect(WorkItemStore.list()).toHaveLength(0);
  });

  for (const status of [
    "registered",
    "pending_consent",
    "consented",
    "disabled",
    "verification_failed",
  ] as const) {
    test(`fails closed without calling runtime when connector installation is ${status}`, async () => {
      seedConnectorInstallation(status);
      let dispatchCalled = false;
      const handlers = createConnectorEndpointHandlers(async (request) => {
        dispatchCalled = true;
        return succeededResult(request.executionRequest);
      });

      await expectConnectorEndpointWorkerSpawnRejects(
        handlers,
        missingEnabledConnectorInstallationError,
      );

      expect(dispatchCalled).toBe(false);
      const workItem = WorkItemStore.list()[0];
      expect(workItem).toMatchObject({
        executorKind: "connector_endpoint",
        failureReason: missingEnabledConnectorInstallationError,
      });
      expect(workItem?.evidence).toMatchObject([
        {
          kind: "custom",
          passed: false,
          detail: "executorKind=connector_endpoint",
        },
      ]);
      expect(workItem ? WorkItem.deriveStatus(workItem) : undefined).toBe("failed");
    });
  }
});
