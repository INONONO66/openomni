import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConnector, Command, Execution } from "@openomni/protocol";
import { Storage } from "@openomni/session";
import { createConnectorEndpointProcessDriver } from "../../src/connector/process-driver.js";
import { startConnectorQuestionBridgeServer } from "../../src/connector/question-bridge.js";

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

function fakeDefinition(command: string, args: readonly string[]): AppConnector.Definition {
  return {
    id: "app.fake-cli",
    name: "Fake CLI",
    version: "1.0.0",
    description: "Runs a fake connector endpoint",
    detect: { command, testedVersions: ">=1.0.0 <2.0.0" },
    spawn: { command, args: [...args], cwd: "{{worktree}}", timeoutMs: 1_000 },
    questionBridge: { kind: "hook", command: "openomni-question-hook" },
    evidence: { emits: ["exit_code"], completionReport: { finalMessage: "stdout" } },
    requires: {},
    driver: {
      provider: "fake-cli",
      install: { scopes: ["workspace"], hooks: ["permission"], plugins: [] },
      submit: { mode: "spawn", ack: "accepted" },
      observedEvents: ["accepted", "completed"],
      emits: ["exit_code"],
    },
    profile: { kind: "connector_endpoint", taskTypes: ["code.change"] },
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
    actor: { kind: "user", actorId: "act_owner" },
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

function bridgeTransport(env: Record<string, string>): {
  readonly url: string;
  readonly token: string;
} {
  const url = env.OPENOMNI_QUESTION_BRIDGE_URL;
  const token = env.OPENOMNI_QUESTION_BRIDGE_TOKEN;
  if (url === undefined || token === undefined) throw new Error("expected bridge transport env");
  return { url, token };
}

describe("connector process question bridge edges", () => {
  test("returns 400 for malformed JSON without invoking the handler", async () => {
    let handlerCalls = 0;
    const bridge = startConnectorQuestionBridgeServer({
      traceId: "trace-fixture",
      runId: "run_fake",
      sessionId: "ses_fake",
      residentSessionId: "ses_resident",
      handler: async () => {
        handlerCalls++;
        return "unused";
      },
    });
    if (bridge === undefined) throw new Error("expected bridge server");
    const transport = bridgeTransport(bridge.env);
    try {
      const response = await fetch(transport.url, {
        method: "POST",
        headers: { authorization: `Bearer ${transport.token}` },
        body: "{",
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("question bridge request requires prompt");
      expect(handlerCalls).toBe(0);
    } finally {
      bridge.close();
    }
  });

  test("passes the HTTP request abort signal to the handler", async () => {
    let handlerSignal: AbortSignal | undefined;
    const bridge = startConnectorQuestionBridgeServer({
      traceId: "trace-fixture",
      runId: "run_fake",
      sessionId: "ses_fake",
      residentSessionId: "ses_resident",
      handler: async (request) => {
        handlerSignal = request.signal;
        return "ok";
      },
    });
    if (bridge === undefined) throw new Error("expected bridge server");
    const transport = bridgeTransport(bridge.env);
    try {
      const response = await fetch(transport.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${transport.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt: "Need signal" }),
      });
      expect(await response.text()).toBe("ok");
      expect(handlerSignal).toBeInstanceOf(AbortSignal);
    } finally {
      bridge.close();
    }
  });

  test("does not advertise hook metadata when no bridge handler is configured", async () => {
    const workspaceRoot = tempDir("connector-question-no-handler");
    const scriptPath = join(workspaceRoot, "fake-question-no-handler.ts");
    writeFileSync(
      scriptPath,
      [
        "console.log(JSON.stringify({",
        "  kind: process.env.OPENOMNI_QUESTION_BRIDGE_KIND,",
        "  command: process.env.OPENOMNI_QUESTION_BRIDGE_COMMAND ?? null,",
        "  url: process.env.OPENOMNI_QUESTION_BRIDGE_URL ?? null,",
        "  token: process.env.OPENOMNI_QUESTION_BRIDGE_TOKEN ?? null,",
        "}));",
      ].join("\n"),
    );
    const definition = fakeDefinition("bun", [scriptPath]);

    const result = await createConnectorEndpointProcessDriver().dispatch({
      command: command(),
      executionRequest: request(workspaceRoot),
      installation: installation(definition),
    });

    expect(result).toMatchObject({ status: "succeeded", finishReason: "exit_code:0" });
    expect(result.output).toContain('"kind":"none"');
    expect(result.output).toContain('"command":null');
    expect(result.output).toContain('"url":null');
    expect(result.output).toContain('"token":null');
  });
});
