import { testToolPorts } from "./helpers/tool-ports";
import { Effect } from "effect";
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize } from "@openomni/ledger";
import type { RunInput } from "@openomni/llm";
import { modelTransport, type OpenOmniConfig } from "../src/config";
import { ProcessSessionRequest } from "../src/process-entry";
import { residentRunner as createResident } from "./helpers/resident-runner";
import { completionFixture } from "./helpers/completion-fixture";
import { assistantMessage } from "./helpers/assistant-message";
import { admittedEffect } from "./helpers/admitted-effect";

import { storageDirectories } from "./helpers/storage-directories";

const directories = storageDirectories();

const OPERATOR_TRANSPORT = {
  baseUrl: "https://gateway.internal/v1",
  headers: { "x-tenant": "acme" },
} as const;

const resolveModel = (model: { provider: string; id: string }) => Effect.succeed({
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
      tools: { ...testToolPorts,},
      llm: {
        resolveModel,
        run: (input, sink) => Effect.sync(() => {
          seen = input;
          sink.onMessage(assistantMessage(input, { call: 1 }));
          return { type: "stop" as const };
        }),
      },
    });

    await resident.prompt(createSession(), "resident question");

    expect(seen?.transport).toEqual(OPERATOR_TRANSPORT);
  });

  it("the completion port forwards it to its one-shot sub-model call", async () => {
    let seen: RunInput | undefined;
    const port = completionFixture(
      { provider: "fake", id: "port-test", apiKey: "port-key", transport: OPERATOR_TRANSPORT },
      {
        resolveModel,
        run: (input, sink) => Effect.sync(() => {
          seen = input;
          sink.onMessage(assistantMessage(input, { call: 1, text: "answered" }));
          return { type: "stop" as const };
        }),
      },
    );

    await admittedEffect(port({ prompt: "summarize" }));

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
