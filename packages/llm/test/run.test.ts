import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Message, Run, Sink, Tool } from "@openomni/protocol";
import { BoundarySanitizer, CredentialSource, SecretRegistry } from "../src/auth";
import { canonicalize } from "../src/model/catalog-cache";
import type { Provider } from "../src/provider";

let run: typeof import("../src/run").run;

type AiCaptureGlobal = typeof globalThis & {
  __openomniAiStreamArgs?: Record<string, unknown>;
};

const aiCapture = globalThis as AiCaptureGlobal;

type StreamChunk = { type: string; [key: string]: unknown };

let mockStreamChunks: StreamChunk[] = [{ type: "finish" }];

function mockAiModule() {
  mock.module("ai", () => ({
    streamText: (args: Record<string, unknown>) => {
      aiCapture.__openomniAiStreamArgs = args;
      const chunks = mockStreamChunks;
      return {
        fullStream: (async function* () {
          yield* chunks;
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

const testModel: Provider.Model = {
  id: "claude-3-haiku",
  providerID: "__test_run__",
  name: "Claude 3 Haiku Test",
  api: { id: "claude-3-haiku", npm: "@ai-sdk/anthropic" },
};
const sanitizer = BoundarySanitizer.create();
const secrets = SecretRegistry.create(sanitizer);
const { handle: credential, ref } = secrets.register(
  CredentialSource.parseOwner({
    providerId: testModel.providerID,
    credentialId: "run-test",
    rotationId: "rotation-1",
    sourceKind: "injected_runtime",
    auth: { type: "api", key: "test-key-run" },
  }),
);
const environmentBase = {
  version: "llm-environment-v1" as const,
  catalogSchemaVersion: 1,
  catalogSource: "bundled" as const,
  catalogSourceVersion: "run-test-v1",
  catalogDigest: "a".repeat(64),
  modelDigest: createHash("sha256").update(canonicalize(testModel)).digest("hex"),
  endpoint: {
    version: "llm-endpoint-ref-v1" as const,
    kind: "default" as const,
    valueRef: `${testModel.providerID}-default`,
    endpointDigest: "b".repeat(64),
  },
  credential: ref,
  sdkPackage: "@ai-sdk/anthropic",
  adapterVersion: "test-v1",
};
const environment: import("../src/run").RunInput["environment"] = {
  reference: {
    ...environmentBase,
    environmentDigest: createHash("sha256").update(canonicalize(environmentBase)).digest("hex"),
  },
  credential,
  secrets,
  sanitizer,
};

describe("run", () => {
  let mockSink: Sink;
  let capturedMessages: Message.WithParts[];
  let capturedToolCalls: Tool.Call[];
  let capturedToolResults: Tool.Result[];
  let capturedSnapshots: Run.Snapshot[];

  beforeAll(async () => {
    ({ run } = await import("../src/run"));
  });

  beforeEach(() => {
    mockStreamChunks = [{ type: "finish" }];
    mockAiModule();
    capturedMessages = [];
    capturedToolCalls = [];
    capturedToolResults = [];
    capturedSnapshots = [];
    aiCapture.__openomniAiStreamArgs = undefined;

    mockSink = {
      onMessage: (message: Message.WithParts) => {
        capturedMessages.push(message);
      },
      onToolCall: (call: Tool.Call) => {
        capturedToolCalls.push(call);
      },
      onToolResult: (result: Tool.Result) => {
        capturedToolResults.push(result);
      },
      onSnapshot: (snapshot: Run.Snapshot) => {
        capturedSnapshots.push(snapshot);
      },
    };
  });

  afterEach(() => {
    aiCapture.__openomniAiStreamArgs = undefined;
  });

  test("accepts RunInput with required fields", () => {
    const input: import("../src/run").RunInput = {
      messages: [],
      tools: [],
      model: testModel,
      environment,
    };

    expect(input.messages).toEqual([]);
    expect(input.tools).toEqual([]);
    expect(input.system).toBeUndefined();
    expect(input.signal).toBeUndefined();
  });

  test("accepts RunInput with optional fields", () => {
    const abortController = new AbortController();
    const input: import("../src/run").RunInput = {
      messages: [],
      tools: [],
      model: testModel,
      environment,
      system: "test system prompt",
      signal: abortController.signal,
      toolChoice: "required",
      maxSteps: 12,
      toolExecutor: async () => ({
        id: "result-1",
        toolCallId: "call-1",
        output: "ok",
      }),
    };

    expect(input.system).toBe("test system prompt");
    expect(input.signal).toBe(abortController.signal);
    expect(input.toolChoice).toBe("required");
    expect(input.maxSteps).toBe(12);
    expect(input.toolExecutor).toBeFunction();
  });

  test("rejects a proxy credential bound to a non-proxy environment endpoint", async () => {
    const proxySanitizer = BoundarySanitizer.create();
    const proxySecrets = SecretRegistry.create(proxySanitizer);
    const proxyModel: Provider.Model = {
      id: "gpt-4o",
      providerID: "openai",
      name: "GPT-4o",
      api: { id: "gpt-4o", npm: "@ai-sdk/openai" },
    };
    const registered = proxySecrets.register(
      CredentialSource.parseOwner({
        providerId: proxyModel.providerID,
        credentialId: "run-proxy-test",
        rotationId: "rotation-1",
        sourceKind: "injected_runtime",
        auth: { type: "proxy", baseURL: "https://proxy.invalid/v1" },
      }),
    );
    const proxyEnvironmentBase = {
      version: "llm-environment-v1" as const,
      catalogSchemaVersion: 1,
      catalogSource: "bundled" as const,
      catalogSourceVersion: "run-test-v1",
      catalogDigest: "a".repeat(64),
      modelDigest: createHash("sha256").update(canonicalize(proxyModel)).digest("hex"),
      endpoint: {
        version: "llm-endpoint-ref-v1" as const,
        kind: "default" as const,
        valueRef: "openai:default",
        endpointDigest: "b".repeat(64),
      },
      credential: registered.ref,
      sdkPackage: "@ai-sdk/openai",
      adapterVersion: "test-v1",
    };
    const proxyEnvironment: import("../src/run").RunInput["environment"] = {
      reference: {
        ...proxyEnvironmentBase,
        environmentDigest: createHash("sha256")
          .update(canonicalize(proxyEnvironmentBase))
          .digest("hex"),
      },
      credential: registered.handle,
      secrets: proxySecrets,
      sanitizer: proxySanitizer,
    };

    try {
      await expect(
        run(
          {
            messages: [],
            tools: [],
            model: proxyModel,
            environment: proxyEnvironment,
          },
          mockSink,
        ),
      ).rejects.toThrow("LLM environment endpoint does not match the proxy credential");
    } finally {
      proxySecrets.dispose();
    }
  });
  test("returns RunOutcome with stop type", async () => {
    const input: import("../src/run").RunInput = {
      messages: [],
      tools: [],
      model: testModel,
      environment,
    };

    const outcome = await run(input, mockSink);

    expect(outcome.type).toBe("stop");
    expect(capturedToolCalls.length).toBe(0);
  });

  test("handles abort signal", async () => {
    const abortController = new AbortController();
    const input: import("../src/run").RunInput = {
      messages: [],
      tools: [],
      model: testModel,
      environment,
      signal: abortController.signal,
    };

    abortController.abort();

    const outcome = await run(input, mockSink);

    expect(outcome.type).toBe("aborted");
    expect(capturedToolCalls.length).toBe(0);
  });

  test("returns aborted outcome when signal is aborted before run", async () => {
    const controller = new AbortController();
    controller.abort();

    const input: import("../src/run").RunInput = {
      messages: [],
      tools: [],
      model: testModel,
      environment,
      signal: controller.signal,
    };

    const outcome = await run(input, mockSink);

    expect(outcome.type).toBe("aborted");
    expect(capturedToolCalls.length).toBe(0);
    expect(aiCapture.__openomniAiStreamArgs).toBeUndefined();
  });

  test("calls sink methods during execution", async () => {
    const input: import("../src/run").RunInput = {
      messages: [],
      tools: [],
      model: testModel,
      environment,
    };

    await run(input, mockSink);

    expect(capturedSnapshots.length).toBeGreaterThan(0);
    expect(capturedToolCalls.length).toBe(0);
  });

  test("v6 text block yields exactly one non-empty text part (no v4 shim duplicates)", async () => {
    // Real ai-sdk v6 fullStream shape: explicit text-start/text-end frame the deltas.
    // The removed v4 shim synthesized a second text-start on the first delta,
    // leaving an orphan empty text part per block — this asserts that never returns.
    mockStreamChunks = [
      { type: "start-step" },
      { type: "text-start", id: "txt_1" },
      { type: "text-delta", id: "txt_1", text: "hello " },
      { type: "text-delta", id: "txt_1", text: "world" },
      { type: "text-end", id: "txt_1" },
      { type: "finish-step" },
      { type: "finish" },
    ];
    mockAiModule();

    const outcome = await run({ messages: [], tools: [], model: testModel, environment }, mockSink);

    expect(outcome.type).toBe("stop");
    const lastMessage = capturedMessages.at(-1);
    expect(lastMessage).toBeDefined();
    const textParts = (lastMessage?.parts ?? []).filter((part) => part.type === "text");
    expect(textParts.length).toBe(1);
    expect(textParts[0]?.text).toBe("hello world");
    expect(textParts.some((part) => part.text === "")).toBe(false);
  });

  test("resolves a sanitized error outcome without leaking the materialized credential", async () => {
    const rawSecret = "test-key-run";
    mockStreamChunks = [
      {
        type: "error",
        error: new Error(`provider rejected credential ${rawSecret}`),
      },
    ];
    mockAiModule();

    const outcome = await run({ messages: [], tools: [], model: testModel, environment }, mockSink);

    expect(outcome.type).toBe("error");
    if (outcome.type !== "error") throw new Error("expected error outcome");
    expect(outcome.error.name).toBe("Error");
    expect(outcome.error.message).toBe("provider rejected credential [REDACTED]");
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain(Buffer.from(rawSecret).toString("base64"));
  });

  test("returns RunOutcome with correct type mapping for processor results", () => {
    const testCases: Array<["stop" | "continue" | "compact", "stop" | "continue" | "compact"]> = [
      ["stop", "stop"],
      ["continue", "continue"],
      ["compact", "compact"],
    ];

    for (const [processorResult, expectedOutcomeType] of testCases) {
      const switchResult = (() => {
        switch (processorResult) {
          case "stop":
            return { type: "stop" as const };
          case "continue":
            return { type: "continue" as const };
          case "compact":
            return { type: "compact" as const };
          default:
            return { type: "stop" as const };
        }
      })();

      expect(switchResult.type).toBe(expectedOutcomeType);
    }
  });
});
