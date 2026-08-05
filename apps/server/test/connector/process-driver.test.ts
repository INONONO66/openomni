import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConnector, Dispatch, Execution } from "@openomni/protocol";
import { AppConnectorInstallationStore, Artifact, Storage, WorkItemStore } from "@openomni/session";
import { z } from "zod";
import { createWorkerDispatchHandlers } from "../../../../packages/openomni/src/dispatch/handlers/worker";
import { resolveConnectorLogPath } from "../../src/connector/log-path.js";
import { createConnectorEndpointProcessDriver } from "../../src/connector/process-driver.js";

const tempRoots: string[] = [];
let completionWriter: Storage.WorkItemCompletionWriter;

const ConnectorDispatchOutput = z
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
  completionWriter = Storage.initialize({ dbPath: ":memory:" });
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
  const path = join(import.meta.dir, "..", ".tmp", name, crypto.randomUUID());
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
    description: "Runs a fake connector endpoint",
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
    driver: {
      provider: "fake-cli",
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

function installation(
  definition: AppConnector.Definition,
  consentOverrides: Partial<AppConnector.Consent> = {},
): AppConnector.Installation {
  return {
    id: "install:fake-cli",
    connectorId: definition.id,
    connectorVersion: definition.version,
    endpointId: "endpoint:install:fake-cli",
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
    dispatchId: "dispatch-connector-endpoint",
    action: "worker.spawn",
    target: { kind: "worker", id: "app.fake-cli", endpointId: "endpoint:install:fake-cli" },
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
  options: Parameters<typeof createConnectorEndpointProcessDriver>[0] = {},
): Promise<Execution.Result> {
  return createConnectorEndpointProcessDriver(options).dispatch({
    command: command(),
    executionRequest: request(workspaceRoot),
    installation: installation(definition),
  });
}

describe("createConnectorEndpointProcessDriver", () => {
  test("fails before spawning when the execution request has no worktree", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-missing-worktree");
    const scriptPath = join(workspaceRoot, "must-not-run.ts");
    writeFileSync(scriptPath, "console.log('must not run');");
    const definition = fakeConnector("bun", [scriptPath]);

    // When
    const result = await createConnectorEndpointProcessDriver().dispatch({
      command: command(),
      executionRequest: {
        runId: "run_fake",
        sessionId: "ses_fake",
        mode: "direct",
        prompt: "ship it",
        model: { provider: "anthropic", id: "claude-test" },
      },
      installation: installation(definition),
    });

    // Then
    expect(result).toMatchObject({
      runId: "run_fake",
      sessionId: "ses_fake",
      status: "failed",
      finishReason: "worktree_unavailable",
      error: "connector endpoint process driver requires workspaceRoot worktree",
    });
  });

  test("runs the AppConnector spawn template with prompt and worktree placeholders", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-happy");
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
    const result = await dispatchRuntime(definition, workspaceRoot, {
      questionBridge: async () => "unused",
    });

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
    const workspaceRoot = tempDir("connector-runtime-env");
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
    const workspaceRoot = tempDir("connector-runtime-empty-env");
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

  test("materializes hook question bridge metadata into the child env", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-question-hook");
    const scriptPath = join(workspaceRoot, "fake-question-hook.ts");
    writeFileSync(
      scriptPath,
      [
        "console.log(JSON.stringify({",
        "  kind: process.env.OPENOMNI_QUESTION_BRIDGE_KIND,",
        "  command: process.env.OPENOMNI_QUESTION_BRIDGE_COMMAND,",
        "  args: JSON.parse(process.env.OPENOMNI_QUESTION_BRIDGE_ARGS_JSON ?? '[]'),",
        "  promptField: process.env.OPENOMNI_QUESTION_BRIDGE_PROMPT_FIELD,",
        "  responseMode: process.env.OPENOMNI_QUESTION_BRIDGE_RESPONSE_MODE,",
        "}));",
      ].join("\n"),
    );
    const definition = {
      ...fakeConnector("bun", [scriptPath], {
        env: { OPENOMNI_QUESTION_BRIDGE_KIND: "connector-should-not-override" },
      }),
      questionBridge: {
        kind: "hook",
        command: "openomni-question-hook",
        args: ["--run", "{{runId}}", "--session", "{{sessionId}}", "--worktree", "{{worktree}}"],
        promptField: "prompt",
        responseMode: "stdout",
      },
    } satisfies AppConnector.Definition;

    // When
    const result = await dispatchRuntime(definition, workspaceRoot, {
      questionBridge: async () => "unused",
    });

    // Then
    expect(result).toMatchObject({
      status: "succeeded",
      finishReason: "exit_code:0",
    });
    expect(result.output).toContain('"kind":"hook"');
    expect(result.output).toContain('"command":"openomni-question-hook"');
    expect(result.output).toContain(`"--run","run_fake"`);
    expect(result.output).toContain(`"--session","ses_fake"`);
    expect(result.output).toContain(`"--worktree","${workspaceRoot}"`);
    expect(result.output).toContain('"promptField":"prompt"');
    expect(result.output).toContain('"responseMode":"stdout"');
    expect(result.output).not.toContain("connector-should-not-override");
  });

  test("materializes disabled question bridge metadata for connectors without a bridge", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-question-none");
    const scriptPath = join(workspaceRoot, "fake-question-none.ts");
    writeFileSync(
      scriptPath,
      [
        "console.log(JSON.stringify({",
        "  kind: process.env.OPENOMNI_QUESTION_BRIDGE_KIND,",
        "  command: process.env.OPENOMNI_QUESTION_BRIDGE_COMMAND ?? null,",
        "  args: process.env.OPENOMNI_QUESTION_BRIDGE_ARGS_JSON ?? null,",
        "  promptField: process.env.OPENOMNI_QUESTION_BRIDGE_PROMPT_FIELD ?? null,",
        "  responseMode: process.env.OPENOMNI_QUESTION_BRIDGE_RESPONSE_MODE ?? null,",
        "  url: process.env.OPENOMNI_QUESTION_BRIDGE_URL ?? null,",
        "  token: process.env.OPENOMNI_QUESTION_BRIDGE_TOKEN ?? null,",
        "}));",
      ].join("\n"),
    );
    const definition = fakeConnector("bun", [scriptPath], {
      env: {
        OPENOMNI_QUESTION_BRIDGE_KIND: "connector-kind",
        OPENOMNI_QUESTION_BRIDGE_COMMAND: "connector-command",
        OPENOMNI_QUESTION_BRIDGE_ARGS_JSON: '["connector-arg"]',
        OPENOMNI_QUESTION_BRIDGE_PROMPT_FIELD: "connector-prompt",
        OPENOMNI_QUESTION_BRIDGE_RESPONSE_MODE: "connector-response",
      },
    });

    // When
    const result = await dispatchRuntime(definition, workspaceRoot, {
      questionBridge: async () => "unused",
    });

    // Then
    expect(result).toMatchObject({
      status: "succeeded",
      finishReason: "exit_code:0",
    });
    expect(result.output).toContain('"kind":"none"');
    expect(result.output).toContain('"command":null');
    expect(result.output).toContain('"args":null');
    expect(result.output).toContain('"promptField":null');
    expect(result.output).toContain('"responseMode":null');
    expect(result.output).toContain('"url":null');
    expect(result.output).toContain('"token":null');
    expect(result.output).not.toContain("connector-");
  });

  test("does not let connector env fill omitted hook question bridge fields", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-question-hook-reserved");
    const scriptPath = join(workspaceRoot, "fake-question-hook-reserved.ts");
    writeFileSync(
      scriptPath,
      [
        "console.log(JSON.stringify({",
        "  kind: process.env.OPENOMNI_QUESTION_BRIDGE_KIND,",
        "  command: process.env.OPENOMNI_QUESTION_BRIDGE_COMMAND,",
        "  args: JSON.parse(process.env.OPENOMNI_QUESTION_BRIDGE_ARGS_JSON ?? '[]'),",
        "  promptField: process.env.OPENOMNI_QUESTION_BRIDGE_PROMPT_FIELD ?? null,",
        "  responseMode: process.env.OPENOMNI_QUESTION_BRIDGE_RESPONSE_MODE ?? null,",
        "}));",
      ].join("\n"),
    );
    const definition = {
      ...fakeConnector("bun", [scriptPath], {
        env: {
          OPENOMNI_QUESTION_BRIDGE_PROMPT_FIELD: "connector-prompt",
          OPENOMNI_QUESTION_BRIDGE_RESPONSE_MODE: "connector-response",
        },
      }),
      questionBridge: {
        kind: "hook",
        command: "openomni-question-hook",
      },
    } satisfies AppConnector.Definition;

    // When
    const result = await dispatchRuntime(definition, workspaceRoot, {
      questionBridge: async () => "unused",
    });

    // Then
    expect(result).toMatchObject({
      status: "succeeded",
      finishReason: "exit_code:0",
    });
    expect(result.output).toContain('"kind":"hook"');
    expect(result.output).toContain('"command":"openomni-question-hook"');
    expect(result.output).toContain('"args":[]');
    expect(result.output).toContain('"promptField":null');
    expect(result.output).toContain('"responseMode":null');
    expect(result.output).not.toContain("connector-");
  });

  test("does not let consented credentials override question bridge metadata", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-question-credential");
    const scriptPath = join(workspaceRoot, "fake-question-credential.ts");
    writeFileSync(
      scriptPath,
      "console.log(JSON.stringify({kind:process.env.OPENOMNI_QUESTION_BRIDGE_KIND, allowed:process.env.FAKE_API_KEY === 'secret-value'}));",
    );
    const definition = {
      ...fakeConnector(
        "bun",
        [scriptPath],
        {},
        {
          credentials: ["OPENOMNI_QUESTION_BRIDGE_KIND", "FAKE_API_KEY"],
        },
      ),
      questionBridge: {
        kind: "hook",
        command: "openomni-question-hook",
      },
    } satisfies AppConnector.Definition;

    // When
    const result = await createConnectorEndpointProcessDriver({
      credentials: {
        OPENOMNI_QUESTION_BRIDGE_KIND: "credential-kind",
        FAKE_API_KEY: "secret-value",
      },
      questionBridge: async () => "unused",
    }).dispatch({
      command: command(),
      executionRequest: request(workspaceRoot),
      installation: installation(definition, {
        credentials: ["OPENOMNI_QUESTION_BRIDGE_KIND", "FAKE_API_KEY"],
      }),
    });

    // Then
    expect(result).toMatchObject({
      status: "succeeded",
      finishReason: "exit_code:0",
    });
    expect(result.output).toContain('"kind":"hook"');
    expect(result.output).toContain('"allowed":true');
    expect(result.output).not.toContain("credential-kind");
  });

  test("stores configured text logs as redacted artifacts and can use them as final output", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-log-artifact");
    const scriptPath = join(workspaceRoot, "fake-log-artifact.ts");
    const logPath = join(workspaceRoot, "agent.log");
    writeFileSync(
      scriptPath,
      [
        "await Bun.write(Bun.argv.at(-1) ?? 'agent.log', 'final log message with secret-value');",
        "console.log('stdout should not be final');",
      ].join("\n"),
    );
    const definition = {
      ...fakeConnector(
        "bun",
        [scriptPath, "{{worktree}}/agent.log"],
        {},
        { credentials: ["FAKE_API_KEY"] },
      ),
      logs: {
        kind: "text",
        path: "{{worktree}}/agent.log",
      },
      evidence: {
        emits: ["exit_code", "artifact", "log_event"],
        completionReport: { finalMessage: "log" },
      },
    } satisfies AppConnector.Definition;

    // When
    const result = await createConnectorEndpointProcessDriver({
      credentials: { FAKE_API_KEY: "secret-value" },
    }).dispatch({
      command: command(),
      executionRequest: request(workspaceRoot),
      installation: installation(definition, { credentials: ["FAKE_API_KEY"] }),
    });

    // Then
    expect(result).toMatchObject({
      status: "succeeded",
      finishReason: "exit_code:0",
      output: "final log message with [REDACTED]",
    });
    expect(result.output).not.toContain("secret-value");
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts?.[0]).toMatchObject({
      kind: "connector_log",
      title: "Fake CLI run_fake log",
      mimeType: "text/plain",
    });
    const artifactId = result.artifacts?.[0]?.artifactId;
    if (artifactId === undefined) throw new Error("expected log artifact id");
    const artifact = await Artifact.get(artifactId);
    expect(artifact?.meta.sessionId).toBe("ses_fake");
    expect(artifact?.content).toBe("final log message with [REDACTED]");
    expect(artifact?.content).not.toContain("secret-value");
    expect(logPath).toContain(workspaceRoot);
  });

  test("stores stdout-backed structured logs for server stream connectors", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-log-stdout");
    const scriptPath = join(workspaceRoot, "fake-stdout-log.ts");
    writeFileSync(
      scriptPath,
      [
        "console.log(JSON.stringify({time:1,message:'first event'}));",
        "console.log(JSON.stringify({time:2,message:'final stdout log with secret-value'}));",
      ].join("\n"),
    );
    const definition = {
      ...fakeConnector("bun", [scriptPath], {}, { credentials: ["FAKE_API_KEY"] }),
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
    } satisfies AppConnector.Definition;

    // When
    const result = await createConnectorEndpointProcessDriver({
      credentials: { FAKE_API_KEY: "secret-value" },
    }).dispatch({
      command: command(),
      executionRequest: request(workspaceRoot),
      installation: installation(definition, { credentials: ["FAKE_API_KEY"] }),
    });

    // Then
    expect(result.output).toBe("final stdout log with [REDACTED]");
    expect(result.artifacts).toHaveLength(1);
    const artifactId = result.artifacts?.[0]?.artifactId;
    if (artifactId === undefined) throw new Error("expected stdout log artifact id");
    const artifact = await Artifact.get(artifactId);
    expect(artifact?.meta.mimeType).toBe("application/x-ndjson");
    expect(artifact?.content).toContain("final stdout log with [REDACTED]");
    expect(artifact?.content).not.toContain("secret-value");
  });

  test("stores newest home-expanded workspace glob log for Claude-style connectors", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-log-glob-worktree");
    const homeRoot = tempDir("connector-runtime-log-glob-home");
    const previousHome = process.env.HOME;
    process.env.HOME = homeRoot;
    const projectDir = resolveConnectorLogPath("~/.claude/projects/{{workspaceHash}}", {
      prompt: "ship it",
      runId: "run_fake",
      sessionId: "ses_fake",
      worktree: workspaceRoot,
    });
    mkdirSync(projectDir, { recursive: true });
    const olderLogPath = join(projectDir, "older.jsonl");
    const newerLogPath = join(projectDir, "newer.jsonl");
    writeFileSync(olderLogPath, JSON.stringify({ timestamp: 1, message: "older log" }));
    writeFileSync(
      newerLogPath,
      JSON.stringify({ timestamp: 2, message: "newest log with secret-value" }),
    );
    utimesSync(olderLogPath, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    utimesSync(newerLogPath, new Date(1_700_000_010_000), new Date(1_700_000_010_000));
    const scriptPath = join(workspaceRoot, "fake-glob-log.ts");
    writeFileSync(scriptPath, "console.log('stdout should not be final');");
    const definition = {
      ...fakeConnector("bun", [scriptPath], {}, { credentials: ["FAKE_API_KEY"] }),
      logs: {
        kind: "jsonl",
        path: "~/.claude/projects/{{workspaceHash}}/*.jsonl",
        eventTimeField: "timestamp",
        messageField: "message",
      },
      evidence: {
        emits: ["exit_code", "artifact", "log_event"],
        completionReport: { finalMessage: "log" },
      },
    } satisfies AppConnector.Definition;

    try {
      // When
      const result = await createConnectorEndpointProcessDriver({
        credentials: { FAKE_API_KEY: "secret-value" },
      }).dispatch({
        command: command(),
        executionRequest: request(workspaceRoot),
        installation: installation(definition, { credentials: ["FAKE_API_KEY"] }),
      });

      // Then
      expect(result.output).toBe("newest log with [REDACTED]");
      expect(result.artifacts).toHaveLength(1);
      const artifactId = result.artifacts?.[0]?.artifactId;
      if (artifactId === undefined) throw new Error("expected glob log artifact id");
      const artifact = await Artifact.get(artifactId);
      expect(artifact?.content).toContain("newest log with [REDACTED]");
      expect(artifact?.content).not.toContain("older log");
      expect(artifact?.content).not.toContain("secret-value");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  test("materializes only consented connector credentials into the child env", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-credential-env");
    const scriptPath = join(workspaceRoot, "fake-credential-env.ts");
    writeFileSync(
      scriptPath,
      "console.log(JSON.stringify({allowed:process.env.FAKE_API_KEY === 'secret-value',echo:process.env.FAKE_API_KEY,ungranted:process.env.UNGRANTED_API_KEY ?? null}));",
    );
    const definition = fakeConnector("bun", [scriptPath], {}, { credentials: ["FAKE_API_KEY"] });

    // When
    const result = await createConnectorEndpointProcessDriver({
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
    const workspaceRoot = tempDir("connector-runtime-credential-redaction");
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
    const result = await createConnectorEndpointProcessDriver({
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
      error: "stderr [REDACTED]\nconnector process exited with code 7",
    });
    expect(result.output).not.toContain("secret-value");
    expect(result.error).not.toContain("secret-value");
  });

  test("fails before spawning when a required consented credential is unavailable", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-missing-credential");
    const scriptPath = join(workspaceRoot, "fake-should-not-run.ts");
    writeFileSync(scriptPath, "console.log('should not run');");
    const definition = fakeConnector("bun", [scriptPath], {}, { credentials: ["FAKE_API_KEY"] });

    // When
    const result = await createConnectorEndpointProcessDriver().dispatch({
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
      error: "connector process credential unavailable: FAKE_API_KEY",
    });
    expect(result.output).toBeUndefined();
  });

  test("fails before spawning when a required credential was not consented", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-unconsented-credential");
    const scriptPath = join(workspaceRoot, "fake-unconsented.ts");
    writeFileSync(scriptPath, "console.log('should not run');");
    const definition = fakeConnector("bun", [scriptPath], {}, { credentials: ["FAKE_API_KEY"] });

    // When
    const result = await createConnectorEndpointProcessDriver({
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
      error: "connector process credential not consented: FAKE_API_KEY",
    });
    expect(result.output).toBeUndefined();
  });

  test("returns failed when the connector process exits non-zero", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-nonzero");
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
      error: "stderr failure\nconnector process exited with code 7",
    });
  });

  test("returns interrupted when the connector process times out", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-timeout");
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

  test("returns interrupted when the connector process stalls without output", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-stall");
    const scriptPath = join(workspaceRoot, "fake-stall.ts");
    writeFileSync(
      scriptPath,
      [
        "console.log('before stall');",
        "await new Promise((resolve) => setTimeout(resolve, 1_000));",
        "console.log('after stall');",
      ].join("\n"),
    );
    const definition = fakeConnector("bun", [scriptPath], {
      timeoutMs: 1_000,
      stallTimeoutMs: 150,
    });

    // When
    const result = await dispatchRuntime(definition, workspaceRoot);

    // Then
    expect(result).toMatchObject({
      runId: "run_fake",
      sessionId: "ses_fake",
      status: "interrupted",
      finishReason: "stall_timeout",
      output: "before stall",
    });
    expect(result.error).toContain("stalled");
    expect(result.error).toContain("150ms");
  });

  test("uses file log activity to keep a silent connector process alive", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-file-log-liveness");
    const logPath = join(workspaceRoot, "agent.jsonl");
    const scriptPath = join(workspaceRoot, "fake-file-log-liveness.ts");
    writeFileSync(
      scriptPath,
      [
        "import { appendFileSync } from 'node:fs';",
        `const logPath = ${JSON.stringify(logPath)};`,
        "for (const message of ['one', 'two', 'three']) {",
        "  appendFileSync(logPath, JSON.stringify({timestamp: Date.now(), message}) + '\\n');",
        "  await new Promise((resolve) => setTimeout(resolve, 50));",
        "}",
      ].join("\n"),
    );
    const definition = {
      ...fakeConnector("bun", [scriptPath], {
        timeoutMs: 1_000,
        stallTimeoutMs: 140,
      }),
      logs: {
        kind: "jsonl",
        path: logPath,
        eventTimeField: "timestamp",
        messageField: "message",
      },
      evidence: {
        emits: ["exit_code", "artifact", "log_event"],
        completionReport: { finalMessage: "log" },
      },
    } satisfies AppConnector.Definition;

    // When
    const result = await dispatchRuntime(definition, workspaceRoot);

    // Then
    expect(result).toMatchObject({
      status: "succeeded",
      finishReason: "exit_code:0",
      output: "three",
    });
  });

  test("uses glob log activity to keep a silent connector process alive", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-glob-log-liveness-worktree");
    const homeRoot = tempDir("connector-runtime-glob-log-liveness-home");
    const previousHome = process.env.HOME;
    process.env.HOME = homeRoot;
    const projectDir = resolveConnectorLogPath("~/.claude/projects/{{workspaceHash}}", {
      prompt: "ship it",
      runId: "run_fake",
      sessionId: "ses_fake",
      worktree: workspaceRoot,
    });
    mkdirSync(projectDir, { recursive: true });
    const logPath = join(projectDir, "session.jsonl");
    const scriptPath = join(workspaceRoot, "fake-glob-log-liveness.ts");
    writeFileSync(
      scriptPath,
      [
        "import { appendFileSync } from 'node:fs';",
        `const logPath = ${JSON.stringify(logPath)};`,
        "for (const message of ['one', 'two', 'three']) {",
        "  appendFileSync(logPath, JSON.stringify({timestamp: Date.now(), message}) + '\\n');",
        "  await new Promise((resolve) => setTimeout(resolve, 50));",
        "}",
      ].join("\n"),
    );
    const definition = {
      ...fakeConnector("bun", [scriptPath], {
        timeoutMs: 1_000,
        stallTimeoutMs: 140,
      }),
      logs: {
        kind: "jsonl",
        path: "~/.claude/projects/{{workspaceHash}}/*.jsonl",
        eventTimeField: "timestamp",
        messageField: "message",
      },
      evidence: {
        emits: ["exit_code", "artifact", "log_event"],
        completionReport: { finalMessage: "log" },
      },
    } satisfies AppConnector.Definition;

    try {
      // When
      const result = await dispatchRuntime(definition, workspaceRoot);

      // Then
      expect(result).toMatchObject({
        status: "succeeded",
        finishReason: "exit_code:0",
        output: "three",
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  test("returns interrupted when file log activity stalls", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-file-log-stall");
    const logPath = join(workspaceRoot, "agent.jsonl");
    const scriptPath = join(workspaceRoot, "fake-file-log-stall.ts");
    writeFileSync(
      scriptPath,
      [
        "import { appendFileSync } from 'node:fs';",
        `const logPath = ${JSON.stringify(logPath)};`,
        "appendFileSync(logPath, JSON.stringify({timestamp: Date.now(), message: 'before stall'}) + '\\n');",
        "await new Promise((resolve) => setTimeout(resolve, 1_000));",
      ].join("\n"),
    );
    const definition = {
      ...fakeConnector("bun", [scriptPath], {
        timeoutMs: 1_000,
        stallTimeoutMs: 150,
      }),
      logs: {
        kind: "jsonl",
        path: logPath,
        eventTimeField: "timestamp",
        messageField: "message",
      },
      evidence: {
        emits: ["exit_code", "artifact", "log_event"],
        completionReport: { finalMessage: "log" },
      },
    } satisfies AppConnector.Definition;

    // When
    const result = await dispatchRuntime(definition, workspaceRoot);

    // Then
    expect(result).toMatchObject({
      status: "interrupted",
      finishReason: "stall_timeout",
      output: "before stall",
    });
    expect(result.error).toContain("stalled");
  });

  test("resets the connector process stall timer on stdout and stderr activity", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-stall-reset");
    const scriptPath = join(workspaceRoot, "fake-stall-reset.ts");
    writeFileSync(
      scriptPath,
      [
        "console.log('stdout one');",
        "await new Promise((resolve) => setTimeout(resolve, 50));",
        "console.error('stderr two');",
        "await new Promise((resolve) => setTimeout(resolve, 50));",
        "console.log('stdout three');",
      ].join("\n"),
    );
    const definition = fakeConnector("bun", [scriptPath], {
      timeoutMs: 1_000,
      stallTimeoutMs: 200,
    });

    // When
    const result = await dispatchRuntime(definition, workspaceRoot);

    // Then
    expect(result).toMatchObject({
      runId: "run_fake",
      sessionId: "ses_fake",
      status: "succeeded",
      finishReason: "exit_code:0",
      output: "stdout one\nstdout three",
      error: "stderr two",
    });
  });

  test("redacts consented credentials from timed-out process output", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-timeout-credential");
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
    const result = await createConnectorEndpointProcessDriver({
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

  test("returns failed when the connector process command cannot be spawned", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-missing");
    const definition = fakeConnector("openomni-missing-connector-command", []);

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
    const workspaceRoot = tempDir("connector-runtime-missing-credential-spawn");
    const definition = fakeConnector(
      "secret-value-openomni-missing-connector-command",
      [],
      {},
      { credentials: ["FAKE_API_KEY"] },
    );

    // When
    const result = await createConnectorEndpointProcessDriver({
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
    expect(result.error).toContain("[REDACTED]-openomni-missing-connector-command");
    expect(result.error).not.toContain("secret-value");
  });

  test("plugs into worker.spawn connector endpoint dispatch with the existing evidence gate", async () => {
    // Given
    const workspaceRoot = tempDir("connector-runtime-dispatch");
    const scriptPath = join(workspaceRoot, "fake-cli.ts");
    writeFileSync(scriptPath, "console.log(JSON.stringify({done:true,prompt:Bun.argv.at(-1)}));");
    const definition = fakeConnector("bun", [scriptPath, "{{prompt}}"]);
    const stored = AppConnectorInstallationStore.set(installation(definition));
    const handlers = createWorkerDispatchHandlers({
      completionWriter,
      connectorEndpointDriver: createConnectorEndpointProcessDriver(),
    });

    // When
    const result = ConnectorDispatchOutput.parse(
      await handlers["worker.spawn"]({
        ...command(),
        target: { kind: "worker", id: stored.connectorId, endpointId: stored.endpointId },
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
