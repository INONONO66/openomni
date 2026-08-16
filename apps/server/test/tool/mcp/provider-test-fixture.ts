import { afterEach, beforeEach, mock } from "bun:test";

import type { NativeTool, ToolExecutionContext } from "@openomni/openomni";
import type { Tool } from "@openomni/protocol";
import { Session, Storage } from "@openomni/session";
import { Bus } from "@openomni/telemetry";
import type { McpToolProvider } from "../../../src/tool/mcp";

/** Boot is the trace origin an MCP provider reports connect failures under. */
export const TEST_BOOT_TRACE_ID = "trace-boot-test";

export function installStorageFixture(): void {
  beforeEach(() => {
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    Storage.reset();
  });
}

/**
 * The trace an MCP call inherits from the executor that dispatched it. Every
 * suite here needs one: the provider refuses a call it cannot attribute, which
 * is the same refusal the production executor path enforces.
 */
export function executionContext(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    traceContext: {
      traceId: "trace-mcp-test",
      sessionId: "session-mcp-test",
      runId: "run-mcp-test",
    },
    ...overrides,
  };
}

export function makeTool(name: string): {
  readonly tool: NativeTool;
  readonly execute: ReturnType<typeof mock>;
} {
  const execute = mock(
    async (call: Tool.Call): Promise<Tool.Result> => ({
      id: call.id,
      toolCallId: call.id,
      output: `${call.tool} ok`,
    }),
  );

  return {
    execute,
    tool: {
      spec: { name, description: `${name} tool`, inputSchema: {} },
      riskTier: 1,
      isReadOnly: false,
      isDestructive: false,
      isConcurrencySafe: false,
      source: "mcp",
      execute,
    },
  };
}

export function makeClient() {
  const connect = mock(async (): Promise<void> => undefined);
  const disconnect = mock(async (): Promise<void> => undefined);
  const listTools = mock(async (): Promise<Tool.Spec[]> => []);
  const callTool = mock(
    async (
      toolName: string,
      _input: Record<string, unknown>,
      callId?: string,
    ): Promise<Tool.Result> => ({
      id: callId ?? crypto.randomUUID(),
      toolCallId: callId ?? "call",
      output: `${toolName} ok`,
    }),
  );

  return {
    client: { connect, disconnect, listTools, callTool },
    connect,
    disconnect,
    listTools,
    callTool,
  };
}

export function seedProvider(
  provider: McpToolProvider,
  tools: readonly NativeTool[],
  connectedServers: readonly string[] = [],
): void {
  const clients = Reflect.get(provider, "clients");
  if (!(clients instanceof Map)) throw new Error("provider clients map not found");
  clients.clear();
  for (const serverName of connectedServers) {
    clients.set(serverName, {});
  }

  const connected = Reflect.get(provider, "connected");
  if (!(connected instanceof Set)) throw new Error("provider connected set not found");
  connected.clear();
  for (const serverName of connectedServers) {
    connected.add(serverName);
  }

  Reflect.set(provider, "cachedTools", [...tools]);
}

export function createLedgerSession(): Session.Info {
  return Session.create({
    traceId: "trace-mcp-test",
    title: "mcp-ledger-test",
    model: { providerID: "test", modelID: "test-model" },
  });
}

export function collectBusEvents(): {
  readonly events: Array<{ name: string; payload: Record<string, unknown> }>;
  readonly stop: () => void;
} {
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const unsubscribe = Bus.observe((descriptor, payload) => {
    events.push({ name: descriptor.name, payload: toRecord(payload) });
  });
  return { events, stop: unsubscribe };
}

export function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected event payload record");
  }
  return Object.fromEntries(Object.entries(value));
}
