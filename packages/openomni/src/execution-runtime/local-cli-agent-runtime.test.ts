import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConnector, Dispatch, Execution } from "@openomni/protocol";
import { AppConnectorInstallationStore, Storage, WorkItemStore } from "@openomni/session";
import { z } from "zod";
import { createWorkerDispatchHandlers } from "../dispatch/handlers/worker";
import { createLocalCliAgentRuntime } from "./local-cli-agent-runtime.js";

const tempRoots: string[] = [];

const LocalCliDispatchOutput = z
  .object({
    output: z
      .object({
        workItemHash: z.string(),
        result: z.object({
          status: z.literal("succeeded"),
          output: z.string(),
        }),
        reflection: z.object({
          workItemStatus: z.literal("blocked"),
          completionBlocked: z.literal(true),
        }),
      })
      .passthrough(),
  })
  .passthrough();

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
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

function fakeConnector(
  command: string,
  args: readonly string[],
  spawnOverrides: Partial<AppConnector.Spawn> = {},
): AppConnector.Definition {
  return {
    id: "app.fake-cli",
    name: "Fake CLI",
    version: "1.0.0",
    description: "Runs a fake local CLI agent",
    detect: {
      command,
      testedVersions: ">=1.0.0 <2.0.0",
    },
    spawn: {
      command,
      args: [...args],
      promptArgument: "{{prompt}}",
      cwd: "{{worktree}}",
      timeoutMs: 1_000,
      ...spawnOverrides,
    },
    evidence: {
      emits: ["exit_code"],
      completionReport: { finalMessage: "stdout" },
    },
    requires: {},
    profile: {
      executorKind: "local_cli_agent",
      taskTypes: ["code.change"],
    },
  };
}

function installation(definition: AppConnector.Definition): AppConnector.Installation {
  return {
    id: "install:fake-cli",
    connectorId: definition.id,
    connectorVersion: definition.version,
    definition,
    testedVersions: definition.detect.testedVersions,
    status: "enabled",
    registeredBy: "act_owner",
    createdAt: 1,
    updatedAt: 1,
  };
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

function dispatchRuntime(
  definition: AppConnector.Definition,
  workspaceRoot: string,
): Promise<Execution.Result> {
  return createLocalCliAgentRuntime().dispatch({
    command: command(),
    executionRequest: request(workspaceRoot),
    installation: installation(definition),
  });
}

describe("createLocalCliAgentRuntime", () => {
  test("runs the AppConnector spawn template with prompt and worktree placeholders", async () => {
    // Given
    const workspaceRoot = tempDir("local-cli-runtime-happy");
    const scriptPath = join(workspaceRoot, "fake-cli.ts");
    writeFileSync(
      scriptPath,
      [
        "const payload = {",
        "  cwd: process.cwd(),",
        "  prompt: Bun.argv.at(-1),",
        "};",
        "console.log(JSON.stringify(payload));",
      ].join("\n"),
    );
    const definition = fakeConnector("bun", [scriptPath, "{{prompt}}"]);

    // When
    const result = await dispatchRuntime(definition, workspaceRoot);

    // Then
    expect(result).toMatchObject({
      runId: "run_fake",
      sessionId: "ses_fake",
      status: "succeeded",
      finishReason: "exit_code:0",
    });
    expect(result.output).toContain('"prompt":"ship it"');
    expect(result.output).toContain(`"cwd":"${workspaceRoot}"`);
  });

  test("preserves parent env while rendering connector env placeholders", async () => {
    // Given
    const workspaceRoot = tempDir("local-cli-runtime-env");
    const scriptPath = join(workspaceRoot, "fake-env.ts");
    writeFileSync(
      scriptPath,
      "console.log(JSON.stringify({prompt:process.env.OPENOMNI_PROMPT,runId:process.env.OPENOMNI_RUN_ID,sessionId:process.env.OPENOMNI_SESSION_ID,worktree:process.env.OPENOMNI_WORKTREE}));",
    );
    const definition = fakeConnector("bun", [scriptPath], {
      env: {
        OPENOMNI_PROMPT: "{{prompt}}",
        OPENOMNI_RUN_ID: "{{runId}}",
        OPENOMNI_SESSION_ID: "{{sessionId}}",
        OPENOMNI_WORKTREE: "{{worktree}}",
      },
    });

    // When
    const result = await dispatchRuntime(definition, workspaceRoot);

    // Then
    expect(result).toMatchObject({
      status: "succeeded",
      finishReason: "exit_code:0",
    });
    expect(result.output).toContain('"prompt":"ship it"');
    expect(result.output).toContain('"runId":"run_fake"');
    expect(result.output).toContain('"sessionId":"ses_fake"');
    expect(result.output).toContain(`"worktree":"${workspaceRoot}"`);
  });

  test("returns failed when the local CLI exits non-zero", async () => {
    // Given
    const workspaceRoot = tempDir("local-cli-runtime-nonzero");
    const scriptPath = join(workspaceRoot, "fake-fail.ts");
    writeFileSync(
      scriptPath,
      [
        "console.log('stdout before failure');",
        "console.error('stderr failure');",
        "process.exit(7);",
      ].join("\n"),
    );
    const definition = fakeConnector("bun", [scriptPath]);

    // When
    const result = await dispatchRuntime(definition, workspaceRoot);

    // Then
    expect(result).toMatchObject({
      runId: "run_fake",
      sessionId: "ses_fake",
      status: "failed",
      finishReason: "exit_code:7",
      output: "stdout before failure",
      error: "stderr failure\nlocal CLI process exited with code 7",
    });
  });

  test("returns interrupted when the local CLI times out", async () => {
    // Given
    const workspaceRoot = tempDir("local-cli-runtime-timeout");
    const scriptPath = join(workspaceRoot, "fake-hang.ts");
    writeFileSync(scriptPath, "setTimeout(() => {}, 1_000);");
    const definition = fakeConnector("bun", [scriptPath], { timeoutMs: 10 });

    // When
    const result = await dispatchRuntime(definition, workspaceRoot);

    // Then
    expect(result).toMatchObject({
      runId: "run_fake",
      sessionId: "ses_fake",
      status: "interrupted",
      finishReason: "timeout",
    });
    expect(result.error).toContain("timed out");
  });

  test("returns failed when the local CLI command cannot be spawned", async () => {
    // Given
    const workspaceRoot = tempDir("local-cli-runtime-missing");
    const definition = fakeConnector("openomni-missing-local-cli-command", []);

    // When
    const result = await dispatchRuntime(definition, workspaceRoot);

    // Then
    expect(result).toMatchObject({
      runId: "run_fake",
      sessionId: "ses_fake",
      status: "failed",
      finishReason: "spawn_error",
    });
    expect(result.error).toContain("Executable not found");
  });

  test("plugs into worker.spawn local_cli_agent dispatch with the existing evidence gate", async () => {
    // Given
    const workspaceRoot = tempDir("local-cli-runtime-dispatch");
    const scriptPath = join(workspaceRoot, "fake-cli.ts");
    writeFileSync(scriptPath, "console.log(JSON.stringify({done:true,prompt:Bun.argv.at(-1)}));");
    const definition = fakeConnector("bun", [scriptPath, "{{prompt}}"]);
    const stored = AppConnectorInstallationStore.set(installation(definition));
    const handlers = createWorkerDispatchHandlers({
      localCliAgentRuntime: createLocalCliAgentRuntime(),
    });

    // When
    const result = LocalCliDispatchOutput.parse(
      await handlers["worker.spawn"]({
        ...command(),
        target: { kind: "worker", id: stored.connectorId, executorKind: "local_cli_agent" },
        workspaceRoot,
      }),
    );

    // Then
    expect(result.output.result.output).toContain('"done":true');
    expect(result.output.result.output).toContain('"prompt":"ship it"');
    expect(result.output.reflection).toMatchObject({
      workItemStatus: "blocked",
      completionBlocked: true,
    });
    expect(WorkItemStore.list()[0]?.blockers[0]?.description).toContain(
      "completion report is invalid",
    );
  });
});
