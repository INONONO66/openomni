import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConnector, Dispatch, Execution } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { createLocalCliAgentRuntime } from "./local-cli-agent-runtime.js";

const tempRoots: string[] = [];

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  Storage.getAdapter().session.set("ses_fake", {
    id: "ses_fake",
    title: "Fake CLI session",
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
  const path = join(import.meta.dir, "..", "..", "test", ".tmp", name, crypto.randomUUID());
  mkdirSync(path, { recursive: true });
  tempRoots.push(path);
  return path;
}

function command(): Dispatch.Command {
  return {
    dispatchId: "dispatch-local-cli",
    action: "worker.spawn",
    target: { kind: "worker", id: "app.fake-cli", executorKind: "local_cli_agent" },
    payload: { prompt: "ship it", acceptanceCriteria: ["done"] },
    actor: { kind: "user", actorId: "act_owner" },
    submittedAt: 1,
  };
}

function request(workspaceRoot: string): Execution.Request {
  return {
    runId: "run_fake",
    sessionId: "ses_fake",
    mode: "direct",
    prompt: "ship it",
    model: { provider: "anthropic", id: "claude-test" },
    workspaceRoot,
  };
}

function definition(scriptPath: string): AppConnector.Definition {
  return {
    id: "app.fake-cli",
    name: "Fake CLI",
    version: "1.0.0",
    description: "Runs a fake local CLI agent",
    detect: { command: "bun", testedVersions: ">=1.0.0 <2.0.0" },
    spawn: {
      command: "bun",
      args: [scriptPath],
      cwd: "{{worktree}}",
      timeoutMs: 1_000,
    },
    logs: {
      kind: "stream_json",
      path: "stdout",
      eventTimeField: "time",
      messageField: "message",
    },
    evidence: {
      emits: ["exit_code", "artifact", "log_event"],
      completionReport: { finalMessage: "log" },
    },
    requires: { credentials: ["FAKE_API_KEY"] },
    profile: {
      executorKind: "local_cli_agent",
      taskTypes: ["code.change"],
    },
  };
}

function installation(connector: AppConnector.Definition): AppConnector.Installation {
  return {
    id: "install:fake-cli",
    connectorId: connector.id,
    connectorVersion: connector.version,
    definition: connector,
    testedVersions: connector.detect.testedVersions,
    status: "enabled",
    registeredBy: "act_owner",
    consent: { grantedBy: "act_owner", grantedAt: 1, credentials: ["FAKE_API_KEY"] },
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("local CLI structured log events", () => {
  test("projects redacted structured stdout log lines onto Execution.Result.logEvents", async () => {
    const workspaceRoot = tempDir("local-cli-runtime-log-event");
    const scriptPath = join(workspaceRoot, "fake-stdout-log.ts");
    writeFileSync(
      scriptPath,
      [
        "console.log(JSON.stringify({time:1,message:'first event'}));",
        "console.log(JSON.stringify({time:2,message:'final stdout log with secret-value'}));",
      ].join("\n"),
    );
    const connector = definition(scriptPath);

    const result = await createLocalCliAgentRuntime({
      credentials: { FAKE_API_KEY: "secret-value" },
    }).dispatch({
      command: command(),
      executionRequest: request(workspaceRoot),
      installation: installation(connector),
    });

    const artifactId = result.artifacts?.[0]?.artifactId;
    if (artifactId === undefined) throw new Error("expected stdout log artifact id");
    expect(result.output).toBe("final stdout log with [REDACTED]");
    expect(result.logEvents).toEqual([
      {
        kind: "local_cli_log_event",
        artifactId,
        message: "first event",
        timestamp: "1",
        sequence: 0,
        data: { time: 1, message: "first event" },
      },
      {
        kind: "local_cli_log_event",
        artifactId,
        message: "final stdout log with [REDACTED]",
        timestamp: "2",
        sequence: 1,
        data: { time: 2, message: "final stdout log with [REDACTED]" },
      },
    ]);
  });
});
