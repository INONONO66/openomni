import { beforeEach, describe, expect, test } from "bun:test";
import { type AppConnector, type Execution, WorkItem } from "@openomni/protocol";
import { AppConnectorInstallationStore, Storage, WorkItemStore } from "@openomni/session";
import { z } from "zod";
import { BuiltInAppConnectors } from "../../src/app-connector";
import { createWorkerDispatchHandlers } from "../../src/dispatch/handlers/worker";
import { command, expectRejectsWithMessage, workerSpawnPayload } from "./helpers";

const LocalCliWorkerSpawnOutput = z
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

const missingLocalCliRuntimeOwnerError =
  "worker.spawn executor local_cli_agent requires a local CLI runtime owner";
const missingEnabledLocalCliInstallationError =
  "worker.spawn executor local_cli_agent requires an enabled AppConnector installation";

type LocalCliEvidenceCase = {
  readonly name: string;
  readonly resultEvidence:
    | Pick<Execution.Result, "artifacts">
    | Pick<Execution.Result, "logEvents">;
  readonly expectedDescription: string;
  readonly expectedDetail: string;
};

type LocalCliCommandOptions = {
  readonly name?: string;
};

type WorkerDispatchHandlerOptions = NonNullable<Parameters<typeof createWorkerDispatchHandlers>[0]>;
type LocalCliRuntimeOwner = NonNullable<WorkerDispatchHandlerOptions["localCliAgentRuntime"]>;

const localCliEvidenceCases: readonly LocalCliEvidenceCase[] = [
  {
    name: "records local CLI log artifacts as WorkItem evidence",
    resultEvidence: {
      artifacts: [
        {
          kind: "local_cli_log",
          artifactId: "art_cli_log",
          title: "Codex CLI log",
          mimeType: "text/plain",
        },
      ],
    },
    expectedDescription: "local CLI log artifact recorded",
    expectedDetail: "art_cli_log",
  },
  {
    name: "records local CLI log events as WorkItem evidence",
    resultEvidence: {
      logEvents: [
        {
          kind: "local_cli_log_event",
          artifactId: "art_cli_log",
          message: "tool completed",
          timestamp: "1700000000000",
          sequence: 0,
          data: { type: "tool_result", message: "tool completed" },
        },
      ],
    },
    expectedDescription: "local CLI log event recorded",
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

function localCliWorkerCommand(options: LocalCliCommandOptions = {}) {
  return command(
    "worker.spawn",
    { kind: "worker", id: "app.codex", executorKind: "local_cli_agent", ...options },
    workerSpawnPayload("build with codex"),
  );
}

function dispatchLocalCliWorkerSpawn(
  handlers: ReturnType<typeof createWorkerDispatchHandlers>,
  options?: LocalCliCommandOptions,
) {
  return handlers["worker.spawn"](localCliWorkerCommand(options));
}

function createLocalCliHandlers(dispatch: LocalCliRuntimeOwner["dispatch"]) {
  return createWorkerDispatchHandlers({ localCliAgentRuntime: { dispatch } });
}

async function expectLocalCliWorkerSpawnRejects(
  handlers: ReturnType<typeof createWorkerDispatchHandlers>,
  message: string,
): Promise<void> {
  await expectRejectsWithMessage(() => dispatchLocalCliWorkerSpawn(handlers), message);
}

function succeededResult(request: Execution.Request): Execution.Result {
  return {
    runId: request.runId,
    sessionId: request.sessionId,
    status: "succeeded",
    output: "done",
  };
}

describe("worker.spawn local_cli_agent dispatch wiring", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  test("dispatches to injected local CLI runtime when an enabled matching installation exists", async () => {
    const installation = seedCodexInstallation("enabled");
    const requests: Execution.Request[] = [];
    const installationIds: string[] = [];
    const handlers = createLocalCliHandlers(async (request) => {
      requests.push(request.executionRequest);
      installationIds.push(request.installation.id);
      return succeededResult(request.executionRequest);
    });

    const result = LocalCliWorkerSpawnOutput.parse(
      await dispatchLocalCliWorkerSpawn(handlers, { name: "Codex CLI" }),
    );

    expect(result.output).toMatchObject({
      workItemHash: WorkItemStore.list()[0]?.hash,
      connectorId: "app.codex",
      connectorInstallationId: installation.id,
      result: { status: "succeeded", output: "done" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ prompt: "build with codex", agentName: "app.codex" });
    expect(installationIds).toEqual([installation.id]);
    expect(WorkItemStore.list()[0]).toMatchObject({
      executorKind: "local_cli_agent",
      assigneeId: "app.codex",
    });
  });

  for (const evidenceCase of localCliEvidenceCases) {
    test(evidenceCase.name, async () => {
      seedCodexInstallation("enabled");
      const handlers = createLocalCliHandlers(async (request) => ({
        ...succeededResult(request.executionRequest),
        ...evidenceCase.resultEvidence,
      }));

      const result = LocalCliWorkerSpawnOutput.parse(await dispatchLocalCliWorkerSpawn(handlers));

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

  test("fails closed when an enabled matching installation exists but no runtime owner is registered", async () => {
    seedCodexInstallation("enabled");
    const handlers = createWorkerDispatchHandlers();

    await expectLocalCliWorkerSpawnRejects(handlers, missingLocalCliRuntimeOwnerError);

    expect(WorkItemStore.list()[0]).toMatchObject({
      executorKind: "local_cli_agent",
      failureReason: missingLocalCliRuntimeOwnerError,
    });
  });

  test("marks the WorkItem failed when the local CLI runtime owner throws", async () => {
    seedCodexInstallation("enabled");
    const handlers = createLocalCliHandlers(async () => {
      throw new Error("runtime exploded");
    });

    await expectLocalCliWorkerSpawnRejects(handlers, "runtime exploded");

    const workItem = WorkItemStore.list()[0];
    expect(workItem).toMatchObject({
      executorKind: "local_cli_agent",
      failureReason: "runtime exploded",
    });
    expect(workItem ? WorkItem.deriveStatus(workItem) : undefined).toBe("failed");
  });

  test("fails closed when no enabled matching installation exists", async () => {
    let dispatchCalled = false;
    const handlers = createLocalCliHandlers(async (request) => {
      dispatchCalled = true;
      return succeededResult(request.executionRequest);
    });

    await expectLocalCliWorkerSpawnRejects(handlers, missingEnabledLocalCliInstallationError);

    expect(dispatchCalled).toBe(false);
    expect(WorkItemStore.list()[0]).toMatchObject({
      executorKind: "local_cli_agent",
      failureReason: missingEnabledLocalCliInstallationError,
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
      const handlers = createLocalCliHandlers(async (request) => {
        dispatchCalled = true;
        return succeededResult(request.executionRequest);
      });

      await expectLocalCliWorkerSpawnRejects(handlers, missingEnabledLocalCliInstallationError);

      expect(dispatchCalled).toBe(false);
      const workItem = WorkItemStore.list()[0];
      expect(workItem).toMatchObject({
        executorKind: "local_cli_agent",
        failureReason: missingEnabledLocalCliInstallationError,
      });
      expect(workItem?.evidence).toMatchObject([
        {
          kind: "custom",
          passed: false,
          detail: "executorKind=local_cli_agent",
        },
      ]);
      expect(workItem ? WorkItem.deriveStatus(workItem) : undefined).toBe("failed");
    });
  }
});
