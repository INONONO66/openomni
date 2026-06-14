import { beforeEach, describe, expect, test } from "bun:test";
import { type AppConnector, type Execution, WorkItem } from "@openomni/protocol";
import { AppConnectorInstallationStore, Storage, WorkItemStore } from "@openomni/session";
import { z } from "zod";
import { BuiltInAppConnectors } from "../../src/app-connector";
import { createWorkerDispatchHandlers } from "../../src/dispatch/handlers/worker";
import { command, expectRejectsWithMessage, workerSpawnPayload } from "./helpers";

const ConnectorEndpointWorkerSpawnOutput = z
  .object({
    output: z
      .object({
        workItemHash: z.string(),
        connectorId: z.literal("app.codex"),
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
          title: "Codex CLI log",
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

function codexConnector(): AppConnector.Definition {
  const connector = BuiltInAppConnectors.get("app.codex");
  if (connector === undefined) {
    throw new Error("expected built-in Codex connector");
  }
  return connector;
}

function seedCodexInstallation(
  status: AppConnector.InstallationStatus,
  withConsent = status === "enabled",
): AppConnector.Installation {
  const connector = codexConnector();
  return AppConnectorInstallationStore.set({
    id: `install:codex:${status}`,
    connectorId: connector.id,
    connectorVersion: connector.version,
    definition: connector,
    detectedVersion: "0.139.1",
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
      id: "app.codex",
      endpointId: "endpoint:install:codex:enabled",
      ...options,
    },
    workerSpawnPayload("build with codex"),
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
    const installation = seedCodexInstallation("enabled");
    const requests: Execution.Request[] = [];
    const installationIds: string[] = [];
    const handlers = createConnectorEndpointHandlers(async (request) => {
      requests.push(request.executionRequest);
      installationIds.push(request.installation.id);
      return succeededResult(request.executionRequest);
    });

    const result = ConnectorEndpointWorkerSpawnOutput.parse(
      await dispatchConnectorEndpointWorkerSpawn(handlers, { name: "Codex CLI" }),
    );

    expect(result.output).toMatchObject({
      workItemHash: WorkItemStore.list()[0]?.hash,
      connectorId: "app.codex",
      connectorInstallationId: installation.id,
      result: { status: "succeeded", output: "done" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      prompt: "build with codex",
      agentName: "endpoint:install:codex:enabled",
    });
    expect(installationIds).toEqual([installation.id]);
    expect(WorkItemStore.list()[0]).toMatchObject({
      executorKind: "connector_endpoint",
      assigneeId: "endpoint:install:codex:enabled",
    });
  });

  for (const evidenceCase of connectorEvidenceCases) {
    test(evidenceCase.name, async () => {
      seedCodexInstallation("enabled");
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
    seedCodexInstallation("enabled");
    const handlers = createWorkerDispatchHandlers();

    await expectConnectorEndpointWorkerSpawnRejects(handlers, missingConnectorDriverOwnerError);

    expect(WorkItemStore.list()[0]).toMatchObject({
      executorKind: "connector_endpoint",
      failureReason: missingConnectorDriverOwnerError,
    });
  });

  test("marks the WorkItem failed when the connector driver owner throws", async () => {
    seedCodexInstallation("enabled");
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
    expect(() => seedCodexInstallation("enabled", false)).toThrow(
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
    test(`fails closed without calling runtime when Codex installation is ${status}`, async () => {
      seedCodexInstallation(status);
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
