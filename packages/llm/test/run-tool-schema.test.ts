import { createHash } from "node:crypto";
import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { Sink, Tool } from "@openomni/protocol";
import { BoundarySanitizer, CredentialSource, SecretRegistry } from "../src/auth";
import { canonicalize } from "../src/model/catalog-cache";
import type { Provider } from "../src/provider";
import type { RunInput } from "../src/run";

const TEST_PROVIDER_ID = "__test_tool_schema__";
const testModel: Provider.Model = {
  id: "claude-3-haiku",
  providerID: TEST_PROVIDER_ID,
  name: "Claude 3 Haiku Test",
  api: { id: "claude-3-haiku", npm: "@ai-sdk/anthropic" },
};
const sanitizer = BoundarySanitizer.create();
const secrets = SecretRegistry.create(sanitizer);
const { handle: credential, ref } = secrets.register(
  CredentialSource.parseOwner({
    providerId: TEST_PROVIDER_ID,
    credentialId: "run-tool-schema-test",
    rotationId: "rotation-1",
    sourceKind: "injected_runtime",
    auth: { type: "api", key: "test-key-unit" },
  }),
);
const environmentBase = {
  version: "llm-environment-v1" as const,
  catalogSchemaVersion: 1,
  catalogSource: "bundled" as const,
  catalogSourceVersion: "run-tool-schema-test-v1",
  catalogDigest: "a".repeat(64),
  modelDigest: createHash("sha256").update(canonicalize(testModel)).digest("hex"),
  endpoint: {
    version: "llm-endpoint-ref-v1" as const,
    kind: "default" as const,
    valueRef: `${TEST_PROVIDER_ID}-default`,
    endpointDigest: "b".repeat(64),
  },
  credential: ref,
  sdkPackage: "@ai-sdk/anthropic",
  adapterVersion: "test-v1",
};
const environment: RunInput["environment"] = {
  reference: {
    ...environmentBase,
    environmentDigest: createHash("sha256").update(canonicalize(environmentBase)).digest("hex"),
  },
  credential,
  secrets,
  sanitizer,
};
type AiCaptureGlobal = typeof globalThis & {
  __openomniAiStreamArgs?: Record<string, unknown>;
};

const aiCapture = globalThis as AiCaptureGlobal;

function getAiStreamArgs(): Record<string, unknown> | undefined {
  return aiCapture.__openomniAiStreamArgs;
}

function mockAiModule() {
  mock.module("ai", () => ({
    streamText: (args: Record<string, unknown>) => {
      aiCapture.__openomniAiStreamArgs = args;
      return {
        fullStream: (async function* () {
          yield { type: "finish" };
        })(),
      };
    },
    jsonSchema: (schema: unknown) => ({ jsonSchema: schema }),
    stepCountIs: (stepCount: number) => {
      return (input: { steps: unknown[] }) => input.steps.length === stepCount;
    },
  }));
}

mockAiModule();

let run: typeof import("../src/run").run;

beforeAll(async () => {
  ({ run } = await import("../src/run"));
});

describe("run() with model - tool schema conversion", () => {
  const mockSink: Sink = {
    onMessage: () => undefined,
    onToolCall: () => undefined,
    onToolResult: () => undefined,
    onSnapshot: () => undefined,
  };

  test("maps Tool.Spec inputSchema to raw function tools via jsonSchema", async () => {
    mockAiModule();
    aiCapture.__openomniAiStreamArgs = undefined;

    await run(
      {
        messages: [],
        tools: [
          {
            name: "test_tool",
            description: "A test tool",
            inputSchema: { type: "object", properties: { x: { type: "string" } } },
          },
        ] as Tool.Spec[],
        model: testModel,
        environment,
      },
      mockSink,
    );

    const streamArgs = getAiStreamArgs();
    expect(streamArgs).toBeDefined();
    if (!streamArgs) throw new Error("expected stream args");
    const tools = streamArgs.tools as Record<string, unknown> | undefined;
    expect(tools).toBeDefined();
    if (!tools) throw new Error("expected stream tools");
    expect(tools.test_tool).toBeDefined();
    expect(tools.test_tool).toEqual({
      type: "function",
      description: "A test tool",
      inputSchema: { jsonSchema: { type: "object", properties: { x: { type: "string" } } } },
    });
  });
});
