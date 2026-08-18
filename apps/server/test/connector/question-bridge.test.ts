import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConnector, Command, Execution } from "@openomni/protocol";
import { Storage } from "@openomni/ledger";
import { createConnectorEndpointProcessDriver } from "../../src/connector/process-driver.js";

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
  const path = join(import.meta.dir, "..", ".tmp", name, crypto.randomUUID());
  mkdirSync(path, { recursive: true });
  tempRoots.push(path);
  return path;
}

function fakeConnector(
  command: string,
  args: readonly string[],
  questionBridge: AppConnector.QuestionBridge,
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
      cwd: "{{worktree}}",
      timeoutMs: 1_000,
    },
    questionBridge,
    evidence: {
      emits: ["exit_code"],
      completionReport: { finalMessage: "stdout" },
    },
    requires: {},
    driver: {
      provider: "fake-cli",
      install: { scopes: ["workspace"], hooks: ["permission"], plugins: [] },
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

function installation(definition: AppConnector.Definition): AppConnector.Installation {
  return {
    id: "install:fake-cli",
    connectorId: definition.id,
    connectorVersion: definition.version,
    endpointId: "endpoint:install:fake-cli",
    definition,
    testedVersions: definition.detect.testedVersions,
    status: "enabled",
    registeredBy: "act_owner",
    consent: { grantedBy: "act_owner", grantedAt: 1 },
    createdAt: 1,
    updatedAt: 1,
  };
}

function command(): Command.Request {
  return {
    traceId: "trace-fixture",
    dispatchId: "dispatch-connector-endpoint",
    action: "worker.spawn",
    target: { kind: "worker", id: "app.fake-cli", endpointId: "endpoint:install:fake-cli" },
    payload: { prompt: "ship it", acceptanceCriteria: ["done"] },
    actor: { kind: "human", actorId: "act_owner" },
    submittedAt: 1,
  };
}

function request(workspaceRoot: string): Execution.Request {
  return {
    traceId: "trace-fixture",
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

describe("connector process question bridge", () => {
  test("answers hook question bridge requests through the runtime handler", async () => {
    const workspaceRoot = tempDir("connector-question-hook");
    const scriptPath = join(workspaceRoot, "fake-question-hook.ts");
    writeFileSync(
      scriptPath,
      [
        "const url = process.env.OPENOMNI_QUESTION_BRIDGE_URL;",
        "const token = process.env.OPENOMNI_QUESTION_BRIDGE_TOKEN;",
        "if (!url || !token) throw new Error('missing question bridge transport');",
        "const response = await fetch(url, {",
        "  method: 'POST',",
        "  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },",
        "  body: JSON.stringify({ prompt: 'Approve filesystem write?' }),",
        "});",
        "if (!response.ok) throw new Error(await response.text());",
        "console.log(JSON.stringify({ answer: await response.text() }));",
      ].join("\n"),
    );
    const definition = fakeConnector("bun", [scriptPath], {
      kind: "hook",
      command: "openomni-question-hook",
      responseMode: "stdout",
    });

    const result = await dispatchRuntime(definition, workspaceRoot, {
      questionBridge: async (request) => `approved: ${request.prompt}`,
    });

    expect(result).toMatchObject({ status: "succeeded", finishReason: "exit_code:0" });
    expect(result.output).toContain('"answer":"approved: Approve filesystem write?"');
  });

  test("answers stdio question bridge requests through the runtime handler", async () => {
    const workspaceRoot = tempDir("connector-question-stdio");
    const scriptPath = join(workspaceRoot, "fake-question-stdio.ts");
    writeFileSync(
      scriptPath,
      [
        "const response = await fetch(process.env.OPENOMNI_QUESTION_BRIDGE_URL ?? '', {",
        "  method: 'POST',",
        "  headers: { authorization: 'Bearer ' + process.env.OPENOMNI_QUESTION_BRIDGE_TOKEN, 'content-type': 'application/json' },",
        "  body: JSON.stringify({ prompt: 'Need clarification' }),",
        "});",
        "if (!response.ok) throw new Error(await response.text());",
        "console.log(await response.text());",
      ].join("\n"),
    );
    const definition = fakeConnector("bun", [scriptPath], {
      kind: "stdio",
      responseMode: "stdout",
    });

    const result = await dispatchRuntime(definition, workspaceRoot, {
      questionBridge: async (request) => `clarified: ${request.prompt}`,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      finishReason: "exit_code:0",
      output: "clarified: Need clarification",
    });
  });

  test("rejects unauthorized question bridge requests without invoking the handler", async () => {
    const workspaceRoot = tempDir("connector-question-unauthorized");
    const scriptPath = join(workspaceRoot, "fake-question-unauthorized.ts");
    writeFileSync(
      scriptPath,
      [
        "const response = await fetch(process.env.OPENOMNI_QUESTION_BRIDGE_URL ?? '', {",
        "  method: 'POST',",
        "  headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },",
        "  body: JSON.stringify({ prompt: 'Should be rejected' }),",
        "});",
        "console.log(JSON.stringify({ status: response.status, body: await response.text() }));",
      ].join("\n"),
    );
    const definition = fakeConnector("bun", [scriptPath], {
      kind: "hook",
      command: "openomni-question-hook",
    });
    let handlerCalls = 0;

    const result = await dispatchRuntime(definition, workspaceRoot, {
      questionBridge: async () => {
        handlerCalls++;
        return "must not be returned";
      },
    });

    expect(result).toMatchObject({ status: "succeeded", finishReason: "exit_code:0" });
    expect(result.output).toContain('"status":401');
    expect(result.output).toContain("question bridge unauthorized");
    expect(handlerCalls).toBe(0);
  });

  test("redacts question bridge bearer tokens from connector process output", async () => {
    const workspaceRoot = tempDir("connector-question-redaction");
    const scriptPath = join(workspaceRoot, "fake-question-redaction.ts");
    writeFileSync(
      scriptPath,
      [
        "console.log('token=' + process.env.OPENOMNI_QUESTION_BRIDGE_TOKEN);",
        "const response = await fetch(process.env.OPENOMNI_QUESTION_BRIDGE_URL ?? '', {",
        "  method: 'POST',",
        "  headers: { authorization: 'Bearer ' + process.env.OPENOMNI_QUESTION_BRIDGE_TOKEN, 'content-type': 'application/json' },",
        "  body: JSON.stringify({ prompt: 'Token must not leak' }),",
        "});",
        "if (!response.ok) throw new Error(await response.text());",
      ].join("\n"),
    );
    const definition = fakeConnector("bun", [scriptPath], {
      kind: "hook",
      command: "openomni-question-hook",
    });

    const result = await dispatchRuntime(definition, workspaceRoot, {
      questionBridge: async () => "approved",
    });

    expect(result).toMatchObject({ status: "succeeded", finishReason: "exit_code:0" });
    expect(result.output).toContain("token=[REDACTED]");
    expect(result.output).not.toMatch(/token=[0-9a-f-]{36}/);
  });
});
