import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { jsonSchema, streamText } from "ai";
import { z } from "zod";
import { Bus, newTraceId } from "./helpers/observation";
import { clientIdentity } from "../src/provider/identity";
import type { Sink } from "../src/sink";

const TEST_TRACE = {
  traceId: newTraceId(),
  sessionId: "session-transport",
  runId: "run-transport",
};

type StreamTextArgs = Parameters<typeof streamText>[0];

let capturedStreamArgs: StreamTextArgs | undefined;

function mockAiModule() {
  mock.module("ai", () => ({
    streamText: (args: StreamTextArgs) => {
      capturedStreamArgs = args;
      return {
        fullStream: (async function* (): AsyncGenerator<{ type: "finish" }, void, undefined> {
          yield { type: "finish" };
        })(),
      };
    },
    jsonSchema: (schema: Parameters<typeof jsonSchema>[0]) => ({ jsonSchema: schema }),
    stepCountIs: () => () => true,
  }));
}

mockAiModule();

type RunModule = typeof import("../src/run");
let run: RunModule["run"];

beforeAll(async () => {
  ({ run } = await import("../src/run"));
});

const sink: Sink = {
  onMessage: () => undefined,
  onToolCall: () => undefined,
  onToolResult: () => undefined,
};

/** The provider SDK keeps its resolved transport on the language model's config. */
const HeaderValue = z.union([z.string(), z.undefined()]);
const HeadersFactory = z.function({
  input: z.tuple([]),
  output: z.record(z.string(), HeaderValue),
});
const TransportConfig = z.object({
  config: z.object({
    baseURL: z.string(),
    headers: z.union([z.record(z.string(), HeaderValue), HeadersFactory]),
  }),
});

/** The SDK's own view of where it will send and what it will send with. */
function resolvedTransport(): { baseURL: string; headers: Record<string, string | undefined> } {
  const { config } = TransportConfig.parse(capturedStreamArgs?.model);
  return {
    baseURL: config.baseURL,
    headers: typeof config.headers === "function" ? config.headers() : config.headers,
  };
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
    capturedStreamArgs = undefined;
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
