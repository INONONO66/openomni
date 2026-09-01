import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Bus, newTraceId } from "@openomni/telemetry";
import { clientIdentity } from "../src/provider/identity";
import type { Sink } from "../src/sink";

const TEST_TRACE = { traceId: newTraceId(), sessionId: "session-transport", runId: "run-transport" };

type AiCaptureGlobal = typeof globalThis & {
  __openomniTransportStreamArgs?: Record<string, unknown>;
};

const aiCapture = globalThis as AiCaptureGlobal;

function mockAiModule() {
  mock.module("ai", () => ({
    streamText: (args: Record<string, unknown>) => {
      aiCapture.__openomniTransportStreamArgs = args;
      return {
        fullStream: (async function* () {
          yield { type: "finish" };
        })(),
      };
    },
    jsonSchema: (schema: unknown) => ({ jsonSchema: schema }),
    stepCountIs: () => () => true,
  }));
}

mockAiModule();

let run: typeof import("../src/run").run;

beforeAll(async () => {
  ({ run } = await import("../src/run"));
});

const sink: Sink = {
  onMessage: () => undefined,
  onToolCall: () => undefined,
  onToolResult: () => undefined,
};

/** The SDK's own view of where it will send and what it will send with. */
function resolvedTransport(): { baseURL: string; headers: Record<string, string> } {
  const streamArgs = aiCapture.__openomniTransportStreamArgs as
    | { model?: { config?: { baseURL?: string; headers?: unknown } } }
    | undefined;
  const config = streamArgs?.model?.config;
  if (config === undefined) expect.unreachable("Expected streamText to receive a language model");
  const headers = typeof config.headers === "function" ? config.headers() : config.headers;
  return { baseURL: String(config.baseURL), headers: headers as Record<string, string> };
}

async function runWith(transport?: {
  baseUrl?: string;
  headers?: Record<string, string>;
}): Promise<void> {
  await run(
    {
      trace: TEST_TRACE,
      events: Bus,
      messages: [],
      tools: [],
      auth: { type: "api", key: "sk-run-transport" },
      model: {
        id: "claude-3-haiku",
        providerID: "__test_run_transport__",
        name: "Claude 3 Haiku Test",
        api: { npm: "@ai-sdk/anthropic", url: "https://api.anthropic.com/v1" },
      },
      ...(transport === undefined ? {} : { transport }),
    },
    sink,
  );
}

describe("run() operator transport threading", () => {
  beforeEach(() => {
    mockAiModule();
    aiCapture.__openomniTransportStreamArgs = undefined;
  });

  test("threads the caller's baseUrl and headers into the provider SDK", async () => {
    await runWith({
      baseUrl: "https://gateway.internal/v1",
      headers: { "x-tenant": "acme" },
    });

    const { baseURL, headers } = resolvedTransport();
    expect(baseURL).toBe("https://gateway.internal/v1");
    expect(headers["x-tenant"]).toBe("acme");
    // The SDK appends its own runtime segments to whatever default we set.
    expect(headers["user-agent"] ?? "").toStartWith(clientIdentity());
  });

  test("without transport config the catalog URL and default identity stand", async () => {
    await runWith();

    const { baseURL, headers } = resolvedTransport();
    expect(baseURL).toBe("https://api.anthropic.com/v1");
    expect(headers["user-agent"] ?? "").toStartWith(clientIdentity());
  });
});
