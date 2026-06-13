import { beforeEach, describe, expect, test } from "bun:test";
import type { AppConnector, Execution } from "@openomni/protocol";
import { AppConnectorInstallationStore, Storage, WorkItemStore } from "@openomni/session";
import { z } from "zod";
import { BuiltInAppConnectors } from "../../src/app-connector";
import { createWorkerDispatchHandlers } from "../../src/dispatch/handlers/worker";
import { command, workerSpawnPayload } from "./helpers";

type WorkerDispatchHandlerOptions = NonNullable<Parameters<typeof createWorkerDispatchHandlers>[0]>;
type LocalCliRuntimeOwner = NonNullable<WorkerDispatchHandlerOptions["localCliAgentRuntime"]>;

const LocalCliTelemetryOutput = z
  .object({
    output: z.object({
      workItemHash: z.string(),
    }),
  })
  .passthrough();

function codexConnector(): AppConnector.Definition {
  const connector = BuiltInAppConnectors.get("app.codex");
  if (connector === undefined) throw new Error("missing built-in Codex connector");
  return connector;
}

function seedCodexInstallation(): void {
  const connector = codexConnector();
  AppConnectorInstallationStore.set({
    id: "install:codex:telemetry",
    connectorId: connector.id,
    connectorVersion: connector.version,
    definition: connector,
    detectedVersion: "0.139.0",
    testedVersions: connector.detect.testedVersions,
    status: "enabled",
    registeredBy: "act_owner",
    consent: { grantedBy: "act_owner", grantedAt: 1 },
  });
}

function localCliWorkerCommand() {
  return command(
    "worker.spawn",
    { kind: "worker", id: "app.codex", executorKind: "local_cli_agent" },
    workerSpawnPayload("build with codex"),
  );
}

function createLocalCliHandlers(dispatch: LocalCliRuntimeOwner["dispatch"]) {
  return createWorkerDispatchHandlers({ localCliAgentRuntime: { dispatch } });
}

function resultWithTelemetry(request: Execution.Request): Execution.Result {
  return {
    runId: request.runId,
    sessionId: request.sessionId,
    status: "succeeded",
    output: "done",
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    logEvents: [
      {
        kind: "local_cli_log_event",
        artifactId: "art_cli_log",
        message: "tool completed",
        sequence: 0,
        data: { type: "tool_result", message: "tool completed" },
        toolCall: {
          id: "call-1",
          tool: "bash",
          status: "completed",
          input: { command: "bun test" },
          output: "pass",
        },
      },
    ],
  };
}

describe("worker.spawn local_cli_agent telemetry evidence", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  test("records local CLI token usage and tool calls as WorkItem evidence", async () => {
    seedCodexInstallation();
    const handlers = createLocalCliHandlers(async (request) =>
      resultWithTelemetry(request.executionRequest),
    );

    const output = LocalCliTelemetryOutput.parse(
      await handlers["worker.spawn"](localCliWorkerCommand()),
    );
    const workItem = WorkItemStore.get(output.output.workItemHash);

    expect(workItem?.evidence.map((evidence) => evidence.description)).toContain(
      "local CLI token usage recorded",
    );
    expect(workItem?.evidence.map((evidence) => evidence.description)).toContain(
      "local CLI tool call recorded",
    );
    expect(workItem?.evidence.map((evidence) => evidence.detail).join("\n")).toContain("call-1");
  });
});
