import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConnector, Dispatch, Execution } from "@openomni/protocol";
import { createIngressEngine, type NativeTool } from "@openomni/openomni";
import { createServerDispatchOwners } from "../../src/bootstrap/dispatch-owners";
import { assembleBootstrap } from "../../src/bootstrap/worker-bootstrap";
import type { CustomToolProvider } from "../../src/tool/custom";
import type { McpToolProvider } from "../../src/tool/mcp";
import { mcpToolMetadata } from "../../src/tool/mcp/provider-metadata";

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

function fakeMcpProvider(): Pick<McpToolProvider, "listTools"> {
  return {
    listTools: () => [],
  };
}

function fakeMcpProviderWithTool(): Pick<McpToolProvider, "listTools"> {
  const tool = makeTool({ name: "filesystem.read", category: "mcp" });
  const metadata = mcpToolMetadata("filesystem", tool.spec);
  return {
    listTools: () => [
      {
        ...tool,
        spec: { ...tool.spec, labels: metadata.labels },
        labels: metadata.labels,
        descriptor: metadata.descriptor,
      },
    ],
  };
}

function fakeCustomProvider(): Pick<CustomToolProvider, "listTools"> {
  return {
    listTools: () => [
      makeTool({
        name: "web_search",
        category: "custom",
      }),
      makeTool({
        name: "web_fetch",
        category: "custom",
      }),
    ],
  };
}

function makeTool(input: {
  readonly name: string;
  readonly category: NativeTool["category"];
}): NativeTool {
  return {
    spec: {
      name: input.name,
      description: `${input.name} tool`,
      inputSchema: { type: "object", properties: {} },
    },
    riskTier: 0,
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    category: input.category,
    execute: async (call) => ({
      id: crypto.randomUUID(),
      toolCallId: call.id,
      output: `${input.name} result`,
    }),
  };
}

function fakeConnector(command: string, args: readonly string[]): AppConnector.Definition {
  return {
    id: "app.fake-cli",
    name: "Fake CLI",
    version: "1.0.0",
    description: "Runs a fake connector endpoint from assembled server bootstrap credentials",
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
    driver: {
      provider: "fake-cli",
      install: { scopes: ["workspace"], hooks: [], plugins: [] },
      submit: { mode: "spawn", ack: "accepted" },
      observedEvents: ["accepted", "completed"],
      emits: ["exit_code"],
    },
    requires: {
      credentials: ["ANTHROPIC_API_KEY"],
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
    consent: {
      grantedBy: "act_owner",
      grantedAt: 1,
      credentials: ["ANTHROPIC_API_KEY"],
    },
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
    traceId: "trace-fixture",
    runId: "run_fake",
    sessionId: "ses_fake",
    mode: "direct",
    prompt: "ship it",
    model: { provider: "anthropic", id: "claude-test" },
    workspaceRoot,
  };
}

describe("server bootstrap connector endpoint credentials", () => {
  test("includes custom server tools in the worker runtime catalog", async () => {
    const bootstrap = await assembleBootstrap(fakeMcpProviderWithTool(), {}, fakeCustomProvider());
    const byName = Object.fromEntries(
      bootstrap.toolCatalog.map((entry) => [entry.canonicalName, entry]),
    );

    expect(byName["filesystem.read"]).toMatchObject({
      source: "mcp",
      category: "mcp",
      mcpServer: "filesystem",
    });
    expect(byName.web_search).toMatchObject({
      source: "server",
      category: "custom",
      riskTier: 0,
    });
    expect(byName.web_fetch).toMatchObject({
      source: "server",
      category: "custom",
      riskTier: 0,
    });
    expect(byName.web_search?.mcpServer).toBeUndefined();
    expect(byName.web_fetch?.mcpServer).toBeUndefined();
  });

  test("passes Auth.all credentials through bootstrap into the default connector driver with redacted output", async () => {
    const workspaceRoot = tempDir("server-bootstrap-credential-runtime");
    const scriptPath = join(workspaceRoot, "fake-bootstrap-credential.ts");
    writeFileSync(
      scriptPath,
      "console.log(JSON.stringify({allowed:process.env.ANTHROPIC_API_KEY === 'anthropic-secret',echo:process.env.ANTHROPIC_API_KEY,baseUrl:process.env.ANTHROPIC_BASE_URL ?? null}));",
    );
    const bootstrap = await assembleBootstrap(fakeMcpProvider(), {
      anthropic: {
        type: "proxy",
        baseURL: "https://anthropic.example",
        apiKey: "anthropic-secret",
      },
    });
    const owners = createServerDispatchOwners({
      coordinator: {
        async dispatch(_sessionId, executionRequest) {
          return {
            runId: executionRequest.runId,
            sessionId: executionRequest.sessionId,
            status: "succeeded",
          };
        },
      },
      residentRuntime: {
        async run() {
          return {
            output: "resident result",
            finishReason: "stop",
            runId: "run_resident",
            activationId: "activation_resident",
          };
        },
      },
      credentials: bootstrap.credentials,
      ingress: createIngressEngine(),
    });
    const runtime = owners.connectorEndpointDriver;
    if (runtime === undefined) {
      expect.unreachable("server dispatch owners must include a connector endpoint driver");
    }

    const result = await runtime.dispatch({
      command: command(),
      executionRequest: request(workspaceRoot),
      installation: installation(fakeConnector("bun", [scriptPath])),
    });

    expect(bootstrap.credentials).toMatchObject({
      ANTHROPIC_BASE_URL: "https://anthropic.example",
      ANTHROPIC_API_KEY: "anthropic-secret",
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toContain('"allowed":true');
    expect(result.output).toContain('"echo":"[REDACTED]"');
    expect(result.output).toContain('"baseUrl":null');
    expect(result.output).not.toContain("anthropic-secret");
    expect(result.output).not.toContain("https://anthropic.example");
  });
});
