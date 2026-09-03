import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatAgentConfig } from "@openomni/agent";
import { initialize, Session, SessionHandleStore, Storage } from "@openomni/ledger";
import { type Gateway, type Model, PolicyDecision } from "@openomni/protocol";
import { createPolicyRegistry } from "../src/composition/policy-registry";
import { createResidentGateway } from "../src/gateway";
import { createResident } from "../src/resident";
import { assistantMessage } from "./helpers/assistant-message";

const directories: string[] = [];

afterEach(() => {
  Storage.reset();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const PRIMARY: Model.Ref = { provider: "fake", id: "resident-test" };
const FALLBACK: Model.Ref = { provider: "other", id: "fallback-model" };

/**
 * Zero-backoff retry middleware: these tests pin WHICH model each attempt
 * resolves and WHAT the caller sees when the chain is spent — never the
 * backoff schedule, which would otherwise make them wall-clock bound.
 */
const zeroBackoff: NonNullable<ChatAgentConfig["middleware"]>[number] = {
  kind: "point",
  name: "test-zero-backoff",
  pointIds: ["run.error.error"],
  effectCapabilities: { "run.error.error": ["run.retry_after"] },
  priority: 100,
  fn: () =>
    PolicyDecision.allow({
      policyId: "test.zero-backoff",
      effects: [{ type: "run.retry_after", delayMs: 0 }],
    }),
};

function policies() {
  const registry = createPolicyRegistry({ mandatory: [] });
  registry.register("zero-backoff", () => zeroBackoff);
  return registry;
}

function openSession(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  initialize({ dbPath: join(directory, "chat.db") });
  return Session.create({
    traceId: "trace-llm-resilience",
    title: "resilience session",
    model: { providerID: PRIMARY.provider, modelID: PRIMARY.id },
  }).id;
}

function delivery(sessionId: string, meta?: Readonly<Record<string, unknown>>): Gateway.Deliver {
  const traceId = "0af7651916cd43dd8448eb211c80319c";
  return {
    sessionId,
    event: {
      id: "inbound-resilience",
      traceId,
      surface: "internal",
      userId: "owner",
      payload: "please answer",
      target: { kind: "resident" },
      mode: "direct",
      ...(meta === undefined ? {} : { meta }),
    },
    decision: {
      traceId,
      time: Date.now(),
      inboundId: "inbound-resilience",
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

describe("Resident model fallback wiring", () => {
  it("resolves the configured fallback on the retry after a transient failure", async () => {
    const sessionId = openSession("openomni-resident-fallback-");
    const resolved: Model.Ref[] = [];
    const auths: unknown[] = [];
    let calls = 0;

    const resident = createResident({
      model: PRIMARY,
      modelFallbacks: [FALLBACK],
      apiKey: "test-key",
      policies: policies(),
      tools: {},
      targets: () => [],
      llm: {
        resolveProviderModel: async (model) => {
          resolved.push(model);
          return { id: model.id, name: model.id, providerID: model.provider };
        },
        run: async (input, sink) => {
          auths.push(input.auth);
          calls += 1;
          if (calls === 1) {
            return { type: "error", error: { message: "transient blip", name: "Error" } };
          }
          sink.onMessage(assistantMessage(input, { call: calls, text: "recovered" }));
          return { type: "stop" };
        },
      },
    });

    const result = await resident(delivery(sessionId));

    expect(resolved).toEqual([PRIMARY, FALLBACK]);
    expect(auths).toEqual([{ type: "api", key: "test-key" }, undefined]);
    expect(result.kind).not.toBe("dropped");
  });

  it("keeps every attempt on the primary when no fallback is configured", async () => {
    const sessionId = openSession("openomni-resident-no-fallback-");
    const resolved: Model.Ref[] = [];
    let calls = 0;

    const resident = createResident({
      model: PRIMARY,
      apiKey: "test-key",
      policies: policies(),
      tools: {},
      targets: () => [],
      llm: {
        resolveProviderModel: async (model) => {
          resolved.push(model);
          return { id: model.id, name: model.id, providerID: model.provider };
        },
        run: async (input, sink) => {
          calls += 1;
          if (calls === 1) {
            return { type: "error", error: { message: "transient blip", name: "Error" } };
          }
          sink.onMessage(assistantMessage(input, { call: calls, text: "recovered" }));
          return { type: "stop" };
        },
      },
    });

    await resident(delivery(sessionId));

    expect(resolved).toEqual([PRIMARY, PRIMARY]);
  });
});

/**
 * An AI SDK provider error as the SDK actually raises it: the retry facts
 * live on the error object, not under `.data`. Building the fixture this way
 * (rather than importing the llm package's internal APIError) keeps the test
 * on the same shape production coercion has to survive.
 */
function providerError(fields: {
  readonly message: string;
  readonly isRetryable: boolean;
  readonly statusCode?: number;
  readonly responseBody?: string;
}): Error {
  return Object.assign(new Error(fields.message), {
    name: "AI_APICallError",
    isRetryable: fields.isRetryable,
    ...(fields.statusCode === undefined ? {} : { statusCode: fields.statusCode }),
    ...(fields.responseBody === undefined ? {} : { responseBody: fields.responseBody }),
  });
}

describe("Resident terminal LLM failure surfacing", () => {
  function alwaysFailing(error: Error) {
    return {
      resolveProviderModel: async (model: Model.Ref) => ({
        id: model.id,
        name: model.id,
        providerID: model.provider,
      }),
      run: async () => ({ type: "error" as const, error }),
    };
  }

  function residentThatAlwaysFails(error: Error) {
    return createResident({
      model: PRIMARY,
      apiKey: "test-key",
      policies: policies(),
      tools: {},
      targets: () => [],
      llm: alwaysFailing(error),
    });
  }

  it("answers a rate-limited exhaustion with a classified, attempt-counted reply", async () => {
    const sessionId = openSession("openomni-resident-ratelimit-");
    const resident = residentThatAlwaysFails(
      providerError({ message: "rate limited", isRetryable: true, statusCode: 429 }),
    );

    const result = await resident(delivery(sessionId));

    if (result.kind === "dropped") throw new Error("terminal failure was dropped, not answered");
    expect(result.result.output).toContain("rate limited upstream");
    expect(result.result.output).toContain("tried 3 times");
    expect(result.result.finishReason).toBe("error");
  });

  it("names a spent balance for a billing exhaustion, unhedged", async () => {
    const sessionId = openSession("openomni-resident-billing-");
    const resident = residentThatAlwaysFails(
      providerError({
        message: JSON.stringify({ error: { code: "insufficient_quota", message: "no credit" } }),
        isRetryable: true,
        statusCode: 429,
      }),
    );

    const result = await resident(delivery(sessionId));

    if (result.kind === "dropped") throw new Error("terminal failure was dropped, not answered");
    expect(result.result.output).toContain("quota/billing exhausted");
    expect(result.result.output).toContain("check provider account");
    expect(result.result.output).not.toContain("may be exhausted");
  });

  it.each([
    { message: "402 Payment Required", name: "a bare payment-required response" },
    { message: "billing_error: card declined", name: "a declined-card billing error" },
  ])("hedges $name as MAY be exhausted", async ({ message }) => {
    const sessionId = openSession("openomni-resident-billing-hedged-");
    const resident = residentThatAlwaysFails(
      providerError({ message, isRetryable: false, statusCode: 402 }),
    );

    const result = await resident(delivery(sessionId));

    if (result.kind === "dropped") throw new Error("terminal failure was dropped, not answered");
    expect(result.result.output).toContain("may be exhausted");
  });

  it("names a content-policy refusal", async () => {
    const sessionId = openSession("openomni-resident-content-policy-");
    const resident = residentThatAlwaysFails(
      providerError({
        message: JSON.stringify({
          error: { type: "invalid_request_error", code: "content_policy_violation" },
        }),
        isRetryable: false,
        statusCode: 400,
      }),
    );

    const result = await resident(delivery(sessionId));

    if (result.kind === "dropped") throw new Error("terminal failure was dropped, not answered");
    expect(result.result.output).toContain("content policy");
  });

  it("does not expose raw unknown-fault details", async () => {
    const sessionId = openSession("openomni-resident-unknown-");
    const resident = residentThatAlwaysFails(
      new Error("request failed apiKey=sk-live-SECRET baseURL=https://internal.example/v1"),
    );

    const result = await resident(delivery(sessionId));

    if (result.kind === "dropped") throw new Error("terminal failure was dropped, not answered");
    expect(result.result.output).toContain("could not reach the model");
    expect(result.result.output).not.toContain("sk-live-SECRET");
    expect(result.result.output).not.toContain("https://internal.example/v1");
  });

  it("returns one sanitized reply through gateway ingestion", async () => {
    openSession("openomni-resident-gateway-");
    const resident = residentThatAlwaysFails(
      providerError({ message: "rate limited", isRetryable: true, statusCode: 429 }),
    );
    const gateway = createResidentGateway(resident);

    const result = await gateway.ingest({
      id: "inbound-resilience-gateway",
      traceId: "0af7651916cd43dd8448eb211c80319c",
      mode: "direct",
      surface: "ws",
      userId: "owner",
      payload: "please answer",
      meta: { actor: { role: "user" } },
    });

    if (result.kind === "dropped") throw new Error("terminal failure was dropped, not answered");
    expect(result.result.output).toContain("rate limited upstream");
    expect(SessionHandleStore.getSnapshot(result.sessionId).turns.at(-1)?.terminal?.kind).toBe(
      "error",
    );
  });

  it("does not convert a configuration failure into a model reply", async () => {
    const sessionId = openSession("openomni-resident-config-failure-");
    const resident = createResident({
      model: PRIMARY,
      apiKey: "test-key",
      policies: policies(),
      tools: {},
      targets: () => [],
      llm: {
        resolveProviderModel: async () => {
          throw new Error("catalog invariant failed");
        },
      },
    });

    await expect(resident(delivery(sessionId))).rejects.toThrow("catalog invariant failed");
  });

  it("records the classified reply in session history so the turn is auditable", async () => {
    const sessionId = openSession("openomni-resident-failure-history-");
    const resident = residentThatAlwaysFails(
      providerError({ message: "rate limited", isRetryable: true, statusCode: 429 }),
    );

    await resident(delivery(sessionId));

    const tail = SessionHandleStore.getSnapshot(sessionId).turns.at(-1);
    expect(tail?.terminal?.kind).toBe("error");
    expect(tail?.messages.at(-1)?.text).toContain("rate limited upstream");
  });

  it("lets a failed delegation wake keep throwing — the receipt must not be consumed", async () => {
    // A wake's RESOLUTION is the durable `markWoken` receipt. Converting its
    // failure into a reply would mark the settlement delivered and lose it,
    // and no one is waiting on a channel for it — so it stays a throw and the
    // next boot's rescan retries.
    const sessionId = openSession("openomni-resident-wake-");
    const resident = residentThatAlwaysFails(
      providerError({ message: "rate limit exceeded", isRetryable: true, statusCode: 429 }),
    );

    await expect(
      resident(delivery(sessionId, { kind: "delegation.settled" })),
    ).rejects.toBeInstanceOf(Error);

    // The failed attempt remains auditable as an error terminal, never a
    // successful reply that could receipt the wake.
    expect(SessionHandleStore.getSnapshot(sessionId).turns.at(-1)?.terminal?.kind).toBe("error");
  });

  it("lets an abort keep propagating — a stopped run is not a model fault", async () => {
    const sessionId = openSession("openomni-resident-abort-");
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    const resident = residentThatAlwaysFails(aborted);

    await expect(resident(delivery(sessionId))).rejects.toThrow("aborted");
  });
});
