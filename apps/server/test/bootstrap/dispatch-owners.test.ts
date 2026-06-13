import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConnector, Dispatch, Execution } from "@openomni/protocol";
import type { DispatchOwners } from "@openomni/openomni";
import { createServerDispatchOwners } from "../../src/bootstrap/dispatch-owners";

const tempRoots: string[] = [];

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
    description: "Runs a fake local CLI agent from server bootstrap owners",
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

function residentRuntime(): NonNullable<DispatchOwners["residentRuntime"]> {
  return {
    async run() {
      return {
        output: "resident result",
        finishReason: "stop",
        runId: "run_resident",
        activationId: "activation_resident",
      };
    },
  };
}

describe("createServerDispatchOwners", () => {
  test("injects a default local CLI owner that can dispatch an enabled connector", async () => {
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
      model: { providerID: "anthropic", id: "claude-test" },
    });

    expect(owners.defaultModel).toEqual({ provider: "anthropic", id: "claude-test" });
    const runtime = owners.localCliAgentRuntime;
    if (runtime === undefined) {
      expect.unreachable("server dispatch owners must include a local CLI runtime");
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

  test("passes only consented server credentials to the default local CLI owner", async () => {
    const workspaceRoot = tempDir("server-dispatch-owner-credentials");
    const scriptPath = join(workspaceRoot, "fake-credential-cli.ts");
    writeFileSync(
      scriptPath,
      "console.log(JSON.stringify({allowed:process.env.FAKE_API_KEY === 'server-secret',echo:process.env.FAKE_API_KEY,ungranted:process.env.UNGRANTED_API_KEY ?? null}));",
    );

    const owners = createServerDispatchOwners({
      coordinator: coordinator(),
      residentRuntime: residentRuntime(),
      credentials: {
        FAKE_API_KEY: "server-secret",
        UNGRANTED_API_KEY: "must-not-leak",
      },
    });
    const runtime = owners.localCliAgentRuntime;
    if (runtime === undefined) {
      expect.unreachable("server dispatch owners must include a local CLI runtime");
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
});
