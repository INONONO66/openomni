import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConnector, Dispatch, Execution } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { createConnectorEndpointProcessDriver } from "../../src/connector/process-driver.js";

const tempRoots: string[] = [];

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  Storage.getAdapter().session.set("ses_telemetry", {
    id: "ses_telemetry",
    title: "Telemetry CLI session",
    model: { providerID: "anthropic", modelID: "claude-test" },
    time: { created: 1, updated: 1 },
    spawnDepth: 0,
  });
});

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function tempDir(name: string): string {
  const path = join(import.meta.dir, "..", ".tmp", name, crypto.randomUUID());
  mkdirSync(path, { recursive: true });
  tempRoots.push(path);
  return path;
}

function command(): Dispatch.Command {
  return {
    dispatchId: "dispatch-connector-endpoint-telemetry",
    action: "worker.spawn",
    target: {
      kind: "worker",
      id: "app.telemetry-cli",
      endpointId: "endpoint:install:telemetry-cli",
    },
    payload: { prompt: "ship it", acceptanceCriteria: ["done"] },
    actor: { kind: "user", actorId: "act_owner" },
    submittedAt: 1,
  };
}

function request(workspaceRoot: string): Execution.Request {
  return {
    runId: "run_telemetry",
    sessionId: "ses_telemetry",
    mode: "direct",
    prompt: "ship it",
    model: { provider: "anthropic", id: "claude-test" },
    workspaceRoot,
  };
}

function definition(
  scriptPath: string,
  logsOverride: Partial<Extract<AppConnector.Logs, { kind: "stream_json" }>> = {},
): AppConnector.Definition {
  return {
    id: "app.telemetry-cli",
    name: "Telemetry CLI",
    version: "1.0.0",
    description: "Runs a fake connector endpoint with telemetry logs",
    detect: { command: "bun", testedVersions: ">=1.0.0 <2.0.0" },
    spawn: { command: "bun", args: [scriptPath], cwd: "{{worktree}}", timeoutMs: 1_000 },
    logs: {
      kind: "stream_json",
      path: "stdout",
      eventTimeField: "time",
      messageField: "message",
      tokenUsageField: "usage",
      tokenUsageMode: "delta",
      toolCallField: "tool_call",
      ...logsOverride,
    },
    evidence: {
      emits: ["exit_code", "artifact", "log_event", "token_usage", "tool_call"],
      completionReport: { finalMessage: "log" },
    },
    requires: { credentials: [] },
    driver: {
      provider: "telemetry-cli",
      install: { scopes: ["workspace"], hooks: [], plugins: [] },
      submit: { mode: "spawn", ack: "accepted" },
      observedEvents: ["accepted", "completed"],
      emits: ["exit_code", "artifact", "log_event", "token_usage", "tool_call"],
    },
    profile: { kind: "connector_endpoint", taskTypes: ["code.change"] },
  };
}

function installation(connector: AppConnector.Definition): AppConnector.Installation {
  return {
    id: "install:telemetry-cli",
    connectorId: connector.id,
    connectorVersion: connector.version,
    endpointId: "endpoint:install:telemetry-cli",
    definition: connector,
    testedVersions: connector.detect.testedVersions,
    status: "enabled",
    registeredBy: "act_owner",
    consent: { grantedBy: "act_owner", grantedAt: 1 },
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("connector process structured log telemetry", () => {
  test("projects declared token usage and tool calls from structured stdout logs", async () => {
    const workspaceRoot = tempDir("connector-runtime-log-telemetry");
    const scriptPath = join(workspaceRoot, "fake-stdout-log.ts");
    writeFileSync(
      scriptPath,
      [
        "console.log(JSON.stringify({time:1,message:'tool started',usage:{input_tokens:4},tool_call:{id:'call-1',tool:'bash',status:'running',input:{cmd:'bun test'}}}));",
        "console.log(JSON.stringify({time:2,message:'tool done',usage:{output_tokens:6},tool_call:{id:'call-1',tool:'bash',status:'completed',output:'pass'}}));",
      ].join("\n"),
    );
    const connector = definition(scriptPath);

    const result = await createConnectorEndpointProcessDriver().dispatch({
      command: command(),
      executionRequest: request(workspaceRoot),
      installation: installation(connector),
    });

    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 6 });
    expect(result.logEvents?.map((event) => event.toolCall)).toEqual([
      { id: "call-1", tool: "bash", status: "running", input: { cmd: "bun test" } },
      { id: "call-1", tool: "bash", status: "completed", output: "pass" },
    ]);
    expect(result.logEvents?.map((event) => event.usage)).toEqual([
      { inputTokens: 4 },
      { outputTokens: 6 },
    ]);
  });

  test("uses the final usage event for cumulative structured token logs", async () => {
    const workspaceRoot = tempDir("connector-runtime-log-cumulative-telemetry");
    const scriptPath = join(workspaceRoot, "fake-stdout-log.ts");
    writeFileSync(
      scriptPath,
      [
        "console.log(JSON.stringify({time:1,message:'first',usage:{input_tokens:4,output_tokens:1,total_tokens:5}}));",
        "console.log(JSON.stringify({time:2,message:'final',usage:{input_tokens:10,output_tokens:6,total_tokens:16}}));",
      ].join("\n"),
    );
    const connector = definition(scriptPath, { tokenUsageMode: "cumulative" });

    const result = await createConnectorEndpointProcessDriver().dispatch({
      command: command(),
      executionRequest: request(workspaceRoot),
      installation: installation(connector),
    });

    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 6, totalTokens: 16 });
    expect(result.logEvents?.map((event) => event.usage)).toEqual([
      { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
      { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
    ]);
  });
});
