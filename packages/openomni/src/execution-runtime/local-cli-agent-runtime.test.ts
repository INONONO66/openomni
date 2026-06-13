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
  requiresOverrides: Partial<AppConnector.Requires> = {},
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
    requires: {
      ...requiresOverrides,
    },
    profile: {
      executorKind: "local_cli_agent",
      taskTypes: ["code.change"],
    },
  };
}

function installation(
  definition: AppConnector.Definition,
  consentOverrides: Partial<AppConnector.Consent> = {},
): AppConnector.Installation {
  return {
    id: "install:fake-cli",
    connectorId: definition.id,
    connectorVersion: definition.version,
    definition,
    testedVersions: definition.detect.testedVersions,
    status: "enabled",
    registeredBy: "act_owner",
    consent: { grantedBy: "act_owner", grantedAt: 1, ...consentOverrides },
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
  options: Parameters<typeof createLocalCliAgentRuntime>[0] = {},
): Promise<Execution.Result> {
  return createLocalCliAgentRuntime(options).dispatch({
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

  test("renders connector env placeholders without inheriting parent secrets", async () => {
    // Given
    const workspaceRoot = tempDir("local-cli-runtime-env");
    const scriptPath = join(workspaceRoot, "fake-env.ts");
    writeFileSync(
      scriptPath,
      "console.log(JSON.stringify({prompt:process.env.OPENOMNI_PROMPT,runId:process.env.OPENOMNI_RUN_ID,sessionId:process.env.OPENOMNI_SESSION_ID,worktree:process.env.OPENOMNI_WORKTREE,secret:process.env.OPENOMNI_TEST_SECRET ?? null}));",
    );
    const definition = fakeConnector("bun", [scriptPath], {
      env: {
        OPENOMNI_PROMPT: "{{prompt}}",
        OPENOMNI_RUN_ID: "{{runId}}",
        OPENOMNI_SESSION_ID: "{{sessionId}}",
        OPENOMNI_WORKTREE: "{{worktree}}",
      },
    });
    const previousSecret = process.env.OPENOMNI_TEST_SECRET;
    process.env.OPENOMNI_TEST_SECRET = "secret-value";

    try {
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
      expect(result.output).toContain('"secret":null');
    } finally {
      if (previousSecret === undefined) {
        delete process.env.OPENOMNI_TEST_SECRET;
      } else {
        process.env.OPENOMNI_TEST_SECRET = previousSecret;
      }
    }
  });

  test("does not inherit parent env when connector env is omitted", async () => {
    // Given
    const workspaceRoot = tempDir("local-cli-runtime-empty-env");
    const scriptPath = join(workspaceRoot, "fake-empty-env.ts");
    writeFileSync(
      scriptPath,
      "console.log(JSON.stringify({secret:process.env.OPENOMNI_TEST_SECRET ?? null}));",
    );
    const definition = fakeConnector("bun", [scriptPath]);
    const previousSecret = process.env.OPENOMNI_TEST_SECRET;
    process.env.OPENOMNI_TEST_SECRET = "secret-value";

    try {
      // When
      const result = await dispatchRuntime(definition, workspaceRoot);

      // Then
      expect(result).toMatchObject({
        status: "succeeded",
        finishReason: "exit_code:0",
      });
      expect(result.output).toContain('"secret":null');
    } finally {
      if (previousSecret === undefined) {
        delete process.env.OPENOMNI_TEST_SECRET;
      } else {
        process.env.OPENOMNI_TEST_SECRET = previousSecret;
      }
    }
  });

  test("materializes only consented connector credentials into the child env", async () => {
    // Given
    const workspaceRoot = tempDir("local-cli-runtime-credential-env");
    const scriptPath = join(workspaceRoot, "fake-credential-env.ts");
    writeFileSync(
      scriptPath,
      "console.log(JSON.stringify({allowed:process.env.FAKE_API_KEY === 'secret-value',echo:process.env.FAKE_API_KEY,ungranted:process.env.UNGRANTED_API_KEY ?? null}));",
    );
    const definition = fakeConnector("bun", [scriptPath], {}, { credentials: ["FAKE_API_KEY"] });

    // When
    const result = await createLocalCliAgentRuntime({
      credentials: {
        FAKE_API_KEY: "secret-value",
        UNGRANTED_API_KEY: "must-not-leak",
      },
    }).dispatch({
      command: command(),
      executionRequest: request(workspaceRoot),
      installation: installation(definition, { credentials: ["FAKE_API_KEY"] }),
    });

    // Then
    expect(result).toMatchObject({
      status: "succeeded",
      finishReason: "exit_code:0",
    });
    expect(result.output).toContain('"allowed":true');
    expect(result.output).toContain('"echo":"[REDACTED]"');
    expect(result.output).not.toContain("secret-value");
    expect(result.output).toContain('"ungranted":null');
  });

  test("redacts consented credentials from stderr and failed results", async () => {
    // Given
    const workspaceRoot = tempDir("local-cli-runtime-credential-redaction");
    const scriptPath = join(workspaceRoot, "fake-credential-stderr.ts");
    writeFileSync(
      scriptPath,
      [
        "console.log('stdout ' + process.env.FAKE_API_KEY);",
        "console.error('stderr ' + process.env.FAKE_API_KEY);",
        "process.exit(7);",
      ].join("\n"),
    );
    const definition = fakeConnector("bun", [scriptPath], {}, { credentials: ["FAKE_API_KEY"] });

    // When
    const result = await createLocalCliAgentRuntime({
      credentials: { FAKE_API_KEY: "secret-value" },
    }).dispatch({
      command: command(),
      executionRequest: request(workspaceRoot),
      installation: installation(definition, { credentials: ["FAKE_API_KEY"] }),
    });

    // Then
    expect(result).toMatchObject({
      status: "failed",
      finishReason: "exit_code:7",
      output: "stdout [REDACTED]",
      error: "stderr [REDACTED]\nlocal CLI process exited with code 7",
    });
    expect(result.output).not.toContain("secret-value");
    expect(result.error).not.toContain("secret-value");
  });

  test("fails before spawning when a required consented credential is unavailable", async () => {
    // Given
    const workspaceRoot = tempDir("local-cli-runtime-missing-credential");
    const scriptPath = join(workspaceRoot, "fake-should-not-run.ts");
    writeFileSync(scriptPath, "console.log('should not run');");
    const definition = fakeConnector("bun", [scriptPath], {}, { credentials: ["FAKE_API_KEY"] });

    // When
    const result = await createLocalCliAgentRuntime().dispatch({
      command: command(),
      executionRequest: request(workspaceRoot),
      installation: installation(definition, { credentials: ["FAKE_API_KEY"] }),
    });

    // Then
    expect(result).toMatchObject({
      runId: "run_fake",
      sessionId: "ses_fake",
      status: "failed",
      finishReason: "credential_unavailable",
      error: "local CLI credential unavailable: FAKE_API_KEY",
    });
    expect(result.output).toBeUndefined();
  });

  test("fails before spawning when a required credential was not consented", async () => {
    // Given
    const workspaceRoot = tempDir("local-cli-runtime-unconsented-credential");
    const scriptPath = join(workspaceRoot, "fake-unconsented.ts");
    writeFileSync(scriptPath, "console.log('should not run');");
    const definition = fakeConnector("bun", [scriptPath], {}, { credentials: ["FAKE_API_KEY"] });

    // When
    const result = await createLocalCliAgentRuntime({
      credentials: { FAKE_API_KEY: "secret-value" },
    }).dispatch({
      command: command(),
      executionRequest: request(workspaceRoot),
      installation: installation(definition),
    });

    // Then
    expect(result).toMatchObject({
      runId: "run_fake",
      sessionId: "ses_fake",
      status: "failed",
      finishReason: "credential_unavailable",
      error: "local CLI credential not consented: FAKE_API_KEY",
    });
    expect(result.output).toBeUndefined();
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

  test("redacts consented credentials from timed-out process output", async () => {
    // Given
    const workspaceRoot = tempDir("local-cli-runtime-timeout-credential");
    const scriptPath = join(workspaceRoot, "fake-timeout-secret.ts");
    writeFileSync(
      scriptPath,
      [
        "console.log('stdout ' + process.env.FAKE_API_KEY);",
        "console.error('stderr ' + process.env.FAKE_API_KEY);",
        "setTimeout(() => {}, 1_000);",
      ].join("\n"),
    );
    const definition = fakeConnector(
      "bun",
      [scriptPath],
      { timeoutMs: 100 },
      { credentials: ["FAKE_API_KEY"] },
    );

    // When
    const result = await createLocalCliAgentRuntime({
      credentials: { FAKE_API_KEY: "secret-value" },
    }).dispatch({
      command: command(),
      executionRequest: request(workspaceRoot),
      installation: installation(definition, { credentials: ["FAKE_API_KEY"] }),
    });

    // Then
    expect(result).toMatchObject({
      runId: "run_fake",
      sessionId: "ses_fake",
      status: "interrupted",
      finishReason: "timeout",
      output: "stdout [REDACTED]",
      error: "stderr [REDACTED]",
    });
    expect(result.output).not.toContain("secret-value");
    expect(result.error).not.toContain("secret-value");
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

  test("redacts consented credentials from spawn errors when credentials were materialized", async () => {
    // Given
    const workspaceRoot = tempDir("local-cli-runtime-missing-credential-spawn");
    const definition = fakeConnector(
      "secret-value-openomni-missing-local-cli-command",
      [],
      {},
      { credentials: ["FAKE_API_KEY"] },
    );

    // When
    const result = await createLocalCliAgentRuntime({
      credentials: { FAKE_API_KEY: "secret-value" },
    }).dispatch({
      command: command(),
      executionRequest: request(workspaceRoot),
      installation: installation(definition, { credentials: ["FAKE_API_KEY"] }),
    });

    // Then
    expect(result).toMatchObject({
      runId: "run_fake",
      sessionId: "ses_fake",
      status: "failed",
      finishReason: "spawn_error",
    });
    expect(result.error).toContain("Executable not found");
    expect(result.error).toContain("[REDACTED]-openomni-missing-local-cli-command");
    expect(result.error).not.toContain("secret-value");
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
