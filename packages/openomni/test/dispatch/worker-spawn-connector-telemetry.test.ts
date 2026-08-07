import { beforeEach, describe, expect, test } from "bun:test";
import type { AppConnector, Execution } from "@openomni/protocol";
import { AppConnectorInstallationStore, Storage, WorkItemStore } from "@openomni/session";
import { z } from "zod";
import { PolicyEngine } from "@openomni/policy";
import { createWorkerDispatchHandlers } from "../../src/dispatch/handlers/worker";
import { createCompletionAdmissionService } from "../../src/work-item/completion-admission.js";
import { command, workerSpawnPayload } from "./helpers";

const TEST_CONNECTOR_ID = "app.test-telemetry";
const TEST_INSTALLATION_ID = "install:test-telemetry";
const TEST_ENDPOINT_ID = `endpoint:${TEST_INSTALLATION_ID}`;
let completionWriter: Storage.WorkItemCompletionWriter;

type WorkerDispatchHandlerOptions = NonNullable<Parameters<typeof createWorkerDispatchHandlers>[0]>;
type ConnectorEndpointDriverOwner = NonNullable<
  WorkerDispatchHandlerOptions["connectorEndpointDriver"]
>;

const ConnectorTelemetryOutput = z
  .object({
    output: z.object({
      workItemHash: z.string(),
    }),
  })
  .passthrough();

function testConnector(): AppConnector.Definition {
  return {
    id: TEST_CONNECTOR_ID,
    name: "Test Telemetry Connector",
    version: "1.0.0",
    description: "Runs a connector endpoint telemetry fixture",
    detect: {
      command: "test-telemetry-connector",
      testedVersions: ">=1.0.0 <2.0.0",
    },
    spawn: {
      command: "test-telemetry-connector",
      promptArgument: "{{prompt}}",
      cwd: "{{worktree}}",
    },
    evidence: {
      emits: ["exit_code", "token_usage", "tool_call", "log_event"],
    },
    requires: {},
    driver: {
      provider: "test-telemetry",
      install: { scopes: ["workspace"], hooks: [], plugins: [] },
      submit: { mode: "spawn", ack: "accepted" },
      observedEvents: ["accepted", "completed"],
      emits: ["exit_code", "token_usage", "tool_call", "log_event"],
    },
    profile: {
      kind: "connector_endpoint",
      taskTypes: ["code.change"],
    },
  };
}

function seedConnectorInstallation(): void {
  const connector = testConnector();
  AppConnectorInstallationStore.set({
    id: TEST_INSTALLATION_ID,
    connectorId: connector.id,
    connectorVersion: connector.version,
    definition: connector,
    detectedVersion: "1.0.0",
    testedVersions: connector.detect.testedVersions,
    status: "enabled",
    registeredBy: "act_owner",
    consent: { grantedBy: "act_owner", grantedAt: 1 },
  });
}

function connectorEndpointWorkerCommand() {
  return command(
    "worker.spawn",
    {
      kind: "worker",
      id: TEST_CONNECTOR_ID,
      endpointId: TEST_ENDPOINT_ID,
    },
    workerSpawnPayload("build with test connector"),
  );
}

function createConnectorEndpointHandlers(dispatch: ConnectorEndpointDriverOwner["dispatch"]) {
  return createWorkerDispatchHandlers({
    completionService: createCompletionAdmissionService({
      completionWriter,
      policyEngine: PolicyEngine.create(),
      now: Date.now,
    }),
    connectorEndpointDriver: { dispatch },
  });
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
        kind: "connector_log_event",
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

describe("worker.spawn connector endpoint telemetry evidence", () => {
  beforeEach(() => {
    Storage.reset();
    completionWriter = Storage.initialize({ dbPath: ":memory:" });
  });

  test("records connector token usage and tool calls as WorkItem evidence", async () => {
    seedConnectorInstallation();
    const handlers = createConnectorEndpointHandlers(async (request) =>
      resultWithTelemetry(request.executionRequest),
    );

    const output = ConnectorTelemetryOutput.parse(
      await handlers["worker.spawn"](connectorEndpointWorkerCommand()),
    );
    const workItem = WorkItemStore.get(output.output.workItemHash);

    expect(workItem?.evidence.map((evidence) => evidence.description)).toContain(
      "connector token usage recorded",
    );
    expect(workItem?.evidence.map((evidence) => evidence.description)).toContain(
      "connector tool call recorded",
    );
    expect(workItem?.evidence.map((evidence) => evidence.detail).join("\n")).toContain("call-1");
  });

  test("rejects a foreign connector session before projecting telemetry", async () => {
    seedConnectorInstallation();
    const handlers = createConnectorEndpointHandlers(async (request) => ({
      ...resultWithTelemetry(request.executionRequest),
      sessionId: "session:foreign",
    }));

    await expect(handlers["worker.spawn"](connectorEndpointWorkerCommand())).rejects.toThrow(
      "Worker completion identity mismatch",
    );

    const workItem = WorkItemStore.list()[0];
    expect(workItem?.evidence).toEqual([]);
    expect(workItem?.completionFacts.admissions).toEqual([]);
  });
});
