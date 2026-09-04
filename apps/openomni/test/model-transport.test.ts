import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize, Session, SessionHandleStore, Storage } from "@openomni/ledger";
import type { RunInput, Sink } from "@openomni/llm";
import type { Gateway } from "@openomni/protocol";
import { modelTransport, type OpenOmniConfig } from "../src/config";
import type { DelegationKernel } from "../src/delegation/kernel";
import { createChildKernel, ProcessWorkerRequest } from "../src/delegation/process-entry";
import { createInlineWorkerRunner } from "../src/delegation/worker-loop";
import { createResident } from "../src/resident";
import { createLlmToolPort } from "../src/tools/execution/llm";
import { assistantMessage } from "./helpers/assistant-message";

const directories: string[] = [];

afterEach(() => {
  Storage.reset();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const OPERATOR_TRANSPORT = {
  baseUrl: "https://gateway.internal/v1",
  headers: { "x-tenant": "acme" },
} as const;

const resolveProviderModel = async (model: { provider: string; id: string }) => ({
  id: model.id,
  name: model.id,
  providerID: model.provider,
});

function createSession(): string {
  return Session.create({
    traceId: "trace-model-transport",
    title: "transport session",
    model: { providerID: "fake", modelID: "resident-test" },
  }).id;
}

function residentDelivery(sessionId: string): Gateway.Deliver {
  const id = "inbound-transport";
  const traceId = "1".padStart(32, "0");
  return {
    sessionId,
    event: {
      id,
      traceId,
      surface: "internal",
      userId: "owner",
      payload: "resident question",
      target: { kind: "resident" },
      mode: "direct",
    },
    decision: {
      traceId,
      time: Date.now(),
      inboundId: id,
      surface: "internal",
      mode: "direct",
      stage: "surface_default",
      outcome: "route",
      reason: "test",
      factsUsed: [],
      target: "resident",
      sessionId,
    },
  };
}

describe("modelTransport", () => {
  const base: OpenOmniConfig["model"] = { provider: "fake", id: "m", apiKey: "k" };

  it("is absent when the operator configured neither field", () => {
    expect(modelTransport(base)).toBeUndefined();
  });

  it("carries whichever fields the operator set", () => {
    expect(modelTransport({ ...base, baseUrl: "https://gw/v1" })).toEqual({
      baseUrl: "https://gw/v1",
    });
    expect(modelTransport({ ...base, headers: { "x-tenant": "acme" } })).toEqual({
      headers: { "x-tenant": "acme" },
    });
  });

  it("copies the header map so later config mutation cannot reach a live call", () => {
    const headers = { "x-tenant": "acme" };
    const transport = modelTransport({ ...base, headers });

    headers["x-tenant"] = "someone-else";

    expect(transport?.headers).toEqual({ "x-tenant": "acme" });
  });
});

describe("operator transport reaches every model caller", () => {
  it("the worker loop forwards it to the llm call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openomni-worker-transport-"));
    directories.push(directory);
    initialize({ dbPath: join(directory, "chat.db") });
    SessionHandleStore.materialize({
      id: "session-transport",
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: 0,
      actionId: "session-transport:configure",
      at: 1,
    });
    let seen: RunInput | undefined;
    let kernel: DelegationKernel;
    const runner = createInlineWorkerRunner({
      model: { provider: "fake", id: "worker-test" },
      apiKey: "test-key",
      transport: OPERATOR_TRANSPORT,
      llm: {
        resolveProviderModel,
        run: async (input: RunInput, sink: Sink) => {
          seen = input;
          sink.onMessage(assistantMessage(input, { call: 1, text: "done" }));
          return { type: "stop" };
        },
      },
      kernel: () => kernel,
    });
    kernel = createChildKernel(runner);

    try {
      await runner({
        delegationId: "d-transport",
        operation: "ask",
        instruction: "answer",
        acceptanceCriteria: [],
        origin: { role: "worker", depth: 1, sessionId: "session-transport" },
        signal: new AbortController().signal,
      });
    } finally {
      kernel.stop();
    }

    expect(seen?.transport).toEqual(OPERATOR_TRANSPORT);
  });

  it("the Resident forwards it to the llm call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openomni-model-transport-"));
    directories.push(directory);
    initialize({ dbPath: join(directory, "chat.db") });
    let seen: RunInput | undefined;

    const resident = createResident({
      model: { provider: "fake", id: "resident-test" },
      apiKey: "test-key",
      transport: OPERATOR_TRANSPORT,
      middleware: [],
      tools: {},
      targets: () => [],
      llm: {
        resolveProviderModel,
        run: async (input, sink: Sink) => {
          seen = input;
          sink.onMessage(assistantMessage(input, { call: 1 }));
          return { type: "stop" };
        },
      },
    });

    await resident(residentDelivery(createSession()));

    expect(seen?.transport).toEqual(OPERATOR_TRANSPORT);
  });

  it("the llm tool port forwards it to its one-shot sub-model call", async () => {
    let seen: RunInput | undefined;
    const port = createLlmToolPort(
      { provider: "fake", id: "port-test", apiKey: "port-key", transport: OPERATOR_TRANSPORT },
      {
        resolveProviderModel,
        run: async (input, sink) => {
          seen = input;
          sink.onMessage(assistantMessage(input, { call: 1, text: "answered" }));
          return { type: "stop" };
        },
      },
    );

    await port("summarize");

    expect(seen?.transport).toEqual(OPERATOR_TRANSPORT);
  });

  it("the process worker wire carries it across the process boundary", () => {
    const request = ProcessWorkerRequest.parse({
      delegationId: "d-1",
      workerRunId: "run-transport",
      operation: "ask",
      instruction: "answer",
      acceptanceCriteria: [],
      origin: { role: "worker", depth: 1, sessionId: "session-transport" },
      model: { provider: "fake", id: "worker-test" },
      apiKey: "test-key",
      transport: OPERATOR_TRANSPORT,
    });

    expect(request.transport).toEqual(OPERATOR_TRANSPORT);
  });

  it("the process worker wire rejects an unknown transport field", () => {
    const parsed = ProcessWorkerRequest.safeParse({
      delegationId: "d-1",
      workerRunId: "run-transport",
      operation: "ask",
      instruction: "answer",
      acceptanceCriteria: [],
      origin: { role: "worker", depth: 1, sessionId: "session-transport" },
      model: { provider: "fake", id: "worker-test" },
      apiKey: "test-key",
      transport: { baseUrl: "https://gw/v1", insecure: true },
    });

    expect(parsed.success).toBe(false);
  });
});
