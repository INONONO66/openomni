import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Sink } from "@openomni/protocol";
import { BoundarySanitizer, CredentialSource, SecretRegistry } from "../src/auth";
import { canonicalize } from "../src/model/catalog-cache";
import type { Provider } from "../src/provider";
import type { RunInput } from "../src/run";

const TEST_PROVIDER_ID = "__test_run_stream_args__";
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
    credentialId: "run-stream-args-test",
    rotationId: "rotation-1",
    sourceKind: "injected_runtime",
    auth: { type: "api", key: "test-key-run" },
  }),
);
const environmentBase = {
  version: "llm-environment-v1" as const,
  catalogSchemaVersion: 1,
  catalogSource: "bundled" as const,
  catalogSourceVersion: "run-stream-args-test-v1",
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
  __openomniAiStepCount?: number;
};

const aiCapture = globalThis as AiCaptureGlobal;

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
      aiCapture.__openomniAiStepCount = stepCount;
      return (input: { steps: unknown[] }) => input.steps.length === stepCount;
    },
  }));
}

mockAiModule();

let run: typeof import("../src/run").run;

beforeAll(async () => {
  ({ run } = await import("../src/run"));
});

describe("run() streamText arguments", () => {
  const mockSink: Sink = {
    onMessage: () => undefined,
    onToolCall: () => undefined,
    onToolResult: () => undefined,
    onSnapshot: () => undefined,
  };

  beforeEach(() => {
    mockAiModule();
    aiCapture.__openomniAiStreamArgs = undefined;
    aiCapture.__openomniAiStepCount = undefined;
  });

  test("forwards toolChoice and AI SDK stepCountIs stopWhen, and sets maxRetries to 0", async () => {
    await run(
      {
        messages: [],
        tools: [],
        toolChoice: "required",
        maxSteps: 7,
        model: testModel,
        environment,
      },
      mockSink,
    );

    expect(aiCapture.__openomniAiStreamArgs).toBeDefined();
    const streamArgs = aiCapture.__openomniAiStreamArgs as {
      toolChoice?: unknown;
      stopWhen?: unknown;
      maxRetries?: unknown;
    };

    expect(streamArgs.toolChoice).toBe("required");
    expect(streamArgs.stopWhen).toBeFunction();
    expect(streamArgs.maxRetries).toBe(0);
    expect(aiCapture.__openomniAiStepCount).toBe(7);

    const stopWhen = streamArgs.stopWhen as (input: { steps: unknown[] }) => boolean;
    expect(stopWhen({ steps: [] })).toBe(false);
    expect(stopWhen({ steps: [1, 2, 3, 4, 5, 6] })).toBe(false);
    expect(stopWhen({ steps: [1, 2, 3, 4, 5, 6, 7] })).toBe(true);
  });

  test("uses default stepCountIs threshold when maxSteps is not provided", async () => {
    await run(
      {
        messages: [],
        tools: [],
        model: testModel,
        environment,
      },
      mockSink,
    );

    expect(aiCapture.__openomniAiStreamArgs).toBeDefined();
    const streamArgs = aiCapture.__openomniAiStreamArgs as { stopWhen?: unknown };
    expect(streamArgs.stopWhen).toBeFunction();
    expect(aiCapture.__openomniAiStepCount).toBe(24);

    const stopWhen = streamArgs.stopWhen as (input: { steps: unknown[] }) => boolean;
    expect(stopWhen({ steps: Array.from({ length: 23 }) })).toBe(false);
    expect(stopWhen({ steps: Array.from({ length: 24 }) })).toBe(true);
  });

  test("nests provider options without overriding authenticated stream controls", async () => {
    const providerOptions = {
      anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
      model: "forged-model",
      messages: [{ role: "user", content: "forged transcript" }],
      maxRetries: 99,
    };
    await run(
      {
        messages: [],
        tools: [],
        model: testModel,
        environment,
        providerOptions,
      },
      mockSink,
    );

    const streamArgs = aiCapture.__openomniAiStreamArgs as Record<string, unknown>;
    expect(streamArgs.model).not.toBe("forged-model");
    expect(streamArgs.messages).toEqual([]);
    expect(streamArgs.maxRetries).toBe(0);
    expect(streamArgs.providerOptions).toEqual(providerOptions);
  });
});
