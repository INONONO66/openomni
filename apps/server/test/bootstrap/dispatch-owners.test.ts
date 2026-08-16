import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Dispatch as DispatchProtocol,
  Wait,
  type AppConnector,
  type Dispatch,
  type Execution,
} from "@openomni/protocol";
import { createIngressEngine, type DispatchOwners } from "@openomni/openomni";
import { Bus, PendingAskStore, Storage } from "@openomni/session";
import { createServerDispatchOwners } from "../../src/bootstrap/dispatch-owners";

const tempRoots: string[] = [];

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  Storage.getAdapter().session.set("ses_fake", {
    id: "ses_fake",
    title: "Fake CLI session",
    model: { providerID: "anthropic", modelID: "claude-test" },
    time: { created: 1, updated: 1 },
    spawnDepth: 1,
    parentSessionId: "ses_resident",
  });
  Storage.getAdapter().session.set("ses_resident", {
    id: "ses_resident",
    title: "Resident session",
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
  requiresOverrides: Partial<AppConnector.Requires> = {},
): AppConnector.Definition {
  return {
    id: "app.fake-cli",
    name: "Fake CLI",
    version: "1.0.0",
    description: "Runs a fake connector endpoint from server bootstrap owners",
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
    traceId: "trace_fake",
    runId: "run_fake",
    sessionId: "ses_fake",
    mode: "direct",
    prompt: "ship it",
    model: { provider: "anthropic", id: "claude-test" },
    workspaceRoot,
  };
}

function coordinator(): NonNullable<DispatchOwners["coordinator"]> {
  return {
    async dispatch(_sessionId: string, executionRequest: Execution.Request) {
      return {
        runId: executionRequest.runId,
        sessionId: executionRequest.sessionId,
        status: "succeeded",
        output: "coordinator result",
      };
    },
  };
}

interface ResidentRuntimeCall {
  readonly sessionId: string;
  readonly payload: unknown;
  readonly actorRole: unknown;
  readonly actorSessionId: unknown;
  readonly actorRunId: unknown;
}

function residentRuntime(
  calls: ResidentRuntimeCall[] = [],
): NonNullable<DispatchOwners["residentRuntime"]> {
  return {
    async run(ctx) {
      const actor = ctx.event.meta?.actor;
      if (actor === undefined) throw new Error("expected resident event actor metadata");
      calls.push({
        sessionId: ctx.sessionId,
        payload: ctx.event.payload,
        actorRole: actor.role,
        actorSessionId: actor.sessionId,
        actorRunId: actor.runId,
      });
      return {
        output: "resident result",
        finishReason: "stop",
        runId: "run_resident",
        activationId: "activation_resident",
      };
    },
  };
}

function failingResidentRuntime(): NonNullable<DispatchOwners["residentRuntime"]> {
  return {
    async run() {
      throw new Error("resident unavailable");
    },
  };
}

describe("createServerDispatchOwners", () => {
  test("injects a default connector endpoint driver that can dispatch an enabled connector", async () => {
    const workspaceRoot = tempDir("server-dispatch-owners");
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

    const owners = createServerDispatchOwners({
      coordinator: coordinator(),
      residentRuntime: residentRuntime(),
      ingress: createIngressEngine(),
      model: { providerID: "anthropic", id: "claude-test" },
    });

    expect(owners.defaultModel).toEqual({ provider: "anthropic", id: "claude-test" });
    const runtime = owners.connectorEndpointDriver;
    if (runtime === undefined) {
      expect.unreachable("server dispatch owners must include a connector endpoint driver");
    }

    const result = await runtime.dispatch({
      command: command(),
      executionRequest: request(workspaceRoot),
      installation: installation(fakeConnector("bun", [scriptPath, "{{prompt}}"])),
    });

    expect(result.status).toBe("succeeded");
    expect(result.output).toContain(`"cwd":"${workspaceRoot}"`);
    expect(result.output).toContain('"prompt":"ship it"');
  });

  test("passes only consented server credentials to the default connector endpoint driver", async () => {
    const workspaceRoot = tempDir("server-dispatch-owner-credentials");
    const scriptPath = join(workspaceRoot, "fake-credential-cli.ts");
    writeFileSync(
      scriptPath,
      "console.log(JSON.stringify({allowed:process.env.FAKE_API_KEY === 'server-secret',echo:process.env.FAKE_API_KEY,ungranted:process.env.UNGRANTED_API_KEY ?? null}));",
    );

    const owners = createServerDispatchOwners({
      coordinator: coordinator(),
      residentRuntime: residentRuntime(),
      ingress: createIngressEngine(),
      credentials: {
        FAKE_API_KEY: "server-secret",
        UNGRANTED_API_KEY: "must-not-leak",
      },
    });
    const runtime = owners.connectorEndpointDriver;
    if (runtime === undefined) {
      expect.unreachable("server dispatch owners must include a connector endpoint driver");
    }

    const definition = fakeConnector("bun", [scriptPath], { credentials: ["FAKE_API_KEY"] });
    const result = await runtime.dispatch({
      command: command(),
      executionRequest: request(workspaceRoot),
      installation: installation(definition, { credentials: ["FAKE_API_KEY"] }),
    });

    expect(result.status).toBe("succeeded");
    expect(result.output).toContain('"allowed":true');
    expect(result.output).toContain('"echo":"[REDACTED]"');
    expect(result.output).not.toContain("server-secret");
    expect(result.output).toContain('"ungranted":null');
  });

  test("routes connector question bridge requests through resident.ask", async () => {
    const eventNames: string[] = [];
    const syncAsks: Array<{ phase: string; traceId: string }> = [];
    const unsubscribe = Bus.observe((event, payload) => {
      if (event.name.startsWith("dispatch.")) eventNames.push(event.name);
      if (event.name === Wait.Events.SyncAsk.name) {
        const parsed = Wait.Events.SyncAsk.schema.parse(payload);
        syncAsks.push({ phase: parsed.phase, traceId: parsed.traceId });
      }
    });
    const residentCalls: ResidentRuntimeCall[] = [];
    const workspaceRoot = tempDir("server-dispatch-owner-question-bridge");
    const scriptPath = join(workspaceRoot, "fake-question-cli.ts");
    writeFileSync(
      scriptPath,
      [
        "const url = process.env.OPENOMNI_QUESTION_BRIDGE_URL;",
        "const token = process.env.OPENOMNI_QUESTION_BRIDGE_TOKEN;",
        "if (!url || !token) throw new Error('missing question bridge transport');",
        "const response = await fetch(url, {",
        "  method: 'POST',",
        "  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },",
        "  body: JSON.stringify({ prompt: 'May I edit the file?' }),",
        "});",
        "if (!response.ok) throw new Error(await response.text());",
        "console.log(await response.text());",
      ].join("\n"),
    );
    const definition = {
      ...fakeConnector("bun", [scriptPath]),
      questionBridge: {
        kind: "hook",
        command: "openomni-question-hook",
        responseMode: "stdout",
      },
    } satisfies AppConnector.Definition;
    const owners = createServerDispatchOwners({
      coordinator: coordinator(),
      residentRuntime: residentRuntime(residentCalls),
      ingress: createIngressEngine(),
      model: { providerID: "anthropic", id: "claude-test" },
    });
    const runtime = owners.connectorEndpointDriver;
    if (runtime === undefined) {
      expect.unreachable("server dispatch owners must include a connector endpoint driver");
    }

    try {
      const result = await runtime.dispatch({
        command: {
          ...command(),
          target: {
            kind: "worker",
            id: "app.fake-cli",
            endpointId: "endpoint:install:fake-cli",
            parentSessionId: "ses_resident",
          },
        },
        executionRequest: request(workspaceRoot),
        installation: installation(definition),
      });
      await Promise.resolve();

      expect(result).toMatchObject({
        status: "succeeded",
        output: "resident result",
      });
      expect(residentCalls).toEqual([
        {
          sessionId: "ses_resident",
          payload: "Connector worker run run_fake asks Resident:\n\nMay I edit the file?",
          actorRole: "worker",
          actorSessionId: "ses_fake",
          actorRunId: "run_fake",
        },
      ]);
      expect(eventNames).toContain(DispatchProtocol.Events.Submitted.name);
      expect(eventNames).toContain(DispatchProtocol.Events.Authorized.name);
      expect(eventNames).toContain(DispatchProtocol.Events.Routed.name);
      expect(eventNames).toContain(DispatchProtocol.Events.Completed.name);
      // The synchronous resident.ask path records wait.sync_ask audit events
      // only and writes no PendingAsk row (#215 owner decision 2).
      // Pin (D11): the nested resident.ask inherits the worker run's trace —
      // the handler passthrough is value-asserted, not just type-checked.
      expect(syncAsks).toEqual([
        { phase: "opened", traceId: "trace_fake" },
        { phase: "answered", traceId: "trace_fake" },
      ]);
      expect(PendingAskStore.list()).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  test("includes resident.ask result validation details when the question bridge response is invalid", async () => {
    const workspaceRoot = tempDir("server-dispatch-owner-question-invalid");
    const scriptPath = join(workspaceRoot, "fake-question-invalid-cli.ts");
    writeFileSync(
      scriptPath,
      [
        "const url = process.env.OPENOMNI_QUESTION_BRIDGE_URL;",
        "const token = process.env.OPENOMNI_QUESTION_BRIDGE_TOKEN;",
        "if (!url || !token) throw new Error('missing question bridge transport');",
        "const response = await fetch(url, {",
        "  method: 'POST',",
        "  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },",
        "  body: JSON.stringify({ prompt: 'Need resident?' }),",
        "});",
        "if (response.ok) throw new Error('expected invalid bridge response');",
        "throw new Error(await response.text());",
      ].join("\n"),
    );
    const definition = {
      ...fakeConnector("bun", [scriptPath]),
      questionBridge: {
        kind: "hook",
        command: "openomni-question-hook",
        responseMode: "stdout",
      },
    } satisfies AppConnector.Definition;
    const owners = createServerDispatchOwners({
      coordinator: coordinator(),
      residentRuntime: failingResidentRuntime(),
      ingress: createIngressEngine(),
      model: { providerID: "anthropic", id: "claude-test" },
    });
    const runtime = owners.connectorEndpointDriver;
    if (runtime === undefined) {
      expect.unreachable("server dispatch owners must include a connector endpoint driver");
    }

    const result = await runtime.dispatch({
      command: {
        ...command(),
        target: {
          kind: "worker",
          id: "app.fake-cli",
          endpointId: "endpoint:install:fake-cli",
          parentSessionId: "ses_resident",
        },
      },
      executionRequest: request(workspaceRoot),
      installation: installation(definition),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("resident.ask returned an invalid question response:");
    expect(result.error).toContain("invalid_literal");
    expect(result.error).toContain("completed");
    expect(result.error).toContain("Required");
  });
});
