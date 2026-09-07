import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize, Storage } from "@openomni/ledger";
import type { RunInput, Sink } from "@openomni/llm";
import { modelTransport, type OpenOmniConfig } from "../src/config";
import { ProcessSessionRequest } from "../src/process-entry";
import { residentRunner as createResident } from "./helpers/resident-runner";
import { createLlmToolPort } from "../src/tools/execution/llm";
import { assistantMessage } from "./helpers/assistant-message";
import { admittedOperation } from "./helpers/admitted-operation";

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

const resolveModel = async (model: { provider: string; id: string }) => ({
  id: model.id,
  name: model.id,
  providerID: model.provider,
});

function createSession(): string {
  // The real Resident materializes this gateway-minted identity on delivery.
  return crypto.randomUUID();
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
  it("the Resident forwards it to the llm call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openomni-model-transport-"));
    directories.push(directory);
    initialize({ dbPath: join(directory, "chat.db") });
    let seen: RunInput | undefined;

    const resident = createResident({
      model: { provider: "fake", id: "resident-test" },
      apiKey: "test-key",
      transport: OPERATOR_TRANSPORT,
      tools: {},
      llm: {
        resolveModel,
        run: async (input, sink: Sink) => {
          seen = input;
          sink.onMessage(assistantMessage(input, { call: 1 }));
          return { type: "stop" };
        },
      },
    });

    await resident.prompt(createSession(), "resident question");

    expect(seen?.transport).toEqual(OPERATOR_TRANSPORT);
  });

  it("the llm tool port forwards it to its one-shot sub-model call", async () => {
    let seen: RunInput | undefined;
    const port = createLlmToolPort(
      { provider: "fake", id: "port-test", apiKey: "port-key", transport: OPERATOR_TRANSPORT },
      {
        resolveModel,
        run: async (input, sink) => {
          seen = input;
          sink.onMessage(assistantMessage(input, { call: 1, text: "answered" }));
          return { type: "stop" };
        },
      },
    );

    await admittedOperation(() => port("summarize"));

    expect(seen?.transport).toEqual(OPERATOR_TRANSPORT);
  });

  it("the process worker wire carries it across the process boundary", () => {
    const request = ProcessSessionRequest.parse({
      sessionId: "worker-session",
      dbPath: "test.sqlite",
      model: { provider: "fake", id: "worker-test" },
      apiKey: "test-key",
      transport: OPERATOR_TRANSPORT,
    });

    expect(request.transport).toEqual(OPERATOR_TRANSPORT);
  });

  it("the process worker wire rejects an unknown transport field", () => {
    const parsed = ProcessSessionRequest.safeParse({
      sessionId: "worker-session",
      dbPath: "test.sqlite",
      model: { provider: "fake", id: "worker-test" },
      apiKey: "test-key",
      transport: { baseUrl: "https://gw/v1", insecure: true },
    });

    expect(parsed.success).toBe(false);
  });
});
