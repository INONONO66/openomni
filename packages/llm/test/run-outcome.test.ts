import { expect, test } from "bun:test";
import { Policy, type Message } from "@openomni/protocol";
import { run, runEffect, LlmRunFailure } from "./helpers/native";
import { Auth } from "../src/auth";
import type { StreamEvent } from "../src/processor/stream-events";
import { streamArguments } from "../src/provider/stream";
import { getLanguage } from "../src/provider/sdk";

const input = {
  messages: [],
  tools: [],
  model: { id: "model", name: "model", providerID: "provider" },
  trace: { traceId: "trace", sessionId: "session", runId: "run" },
  events: { publish: () => undefined },
};
const sink = {
  onMessage: () => undefined,
  onToolCall: () => undefined,
  onToolResult: () => undefined,
};

test("the provider produces typed failure facts, never a legacy error shape", async () => {
  const cause = new Error("provider failure");
  const result = await run(input, sink, {
    createStream: async () => {
      throw cause;
    },
  });
  expect(result.type).toBe("error");
  if (result.type !== "error") throw new Error("missing failure");
  expect(result.error).toBeInstanceOf(LlmRunFailure);
  expect(result.error).toMatchObject({
    aborted: false,
    contextOverflow: false,
    visibleOutput: false,
    usage: { inputTokens: 0, outputTokens: 0 },
  });
    expect(result.error.cause).toContain(cause.message);
});

test("stop and aborted are produced by the real attempt entry", async () => {
  const stop = await run(input, sink, {
    createStream: async () => ({
      fullStream: (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
        yield { type: "finish" };
      })(),
    }),
  });
  expect(stop).toEqual({
    type: "stop",
    evidence: {
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      visibleOutput: false,
      finishReason: "stop",
      credential: null,
    },
  });
  expect(await run({ ...input, signal: AbortSignal.abort() }, sink)).toEqual({ type: "aborted" });
});

/**
 * Mirrors run()'s production stream creation minus module `ai`: sibling test
 * files install process-global mock.module("ai", ...) mocks, which must not
 * detach this test from the local HTTP server. Credential resolution, route
 * binding and the provider SDK's real fetch all stay on the wire; retry
 * ownership is asserted separately at the streamText argument surface.
 */
function overWire(call: Parameters<typeof run>[0]) {
  return async () => {
    const auth = await runEffect(
      Auth.resolve(call.model.providerID, call.auth, call.authProvider, call.allowAuthFallback),
    );
    await getLanguage(call.model, auth, call.transport).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    // The server above only ever answers 503, so doStream always throws first.
    throw new Error("unreachable: the local route only answers 503");
  };
}

test("SDK retry ownership and route-bound credentials hold at the HTTP surface", async () => {
  const authorizations: Array<string | null> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (request) => {
      authorizations.push(request.headers.get("authorization"));
      return Response.json({ error: { message: "overloaded", type: "server_error" } }, { status: 503 });
    },
  });
  const auth = { type: "api", key: "route-a-key" } as const;
  const userMessage: Message.WithParts = {
    info: {
      id: "msg-user", sessionID: "session", role: "user", time: { created: 1000 },
      agent: "default", model: { providerID: "provider", modelID: "model" },
    },
    parts: [{ id: "part-user", sessionID: "session", messageID: "msg-user", type: "text", text: "hello" }],
  };
  const base = { ...input, messages: [userMessage], auth, authProvider: "provider", allowAuthFallback: false,
    transport: { baseUrl: `${server.url}v1` } };
  try {
    expect(streamArguments(base, "", new AbortController().signal, [],
      getLanguage(base.model, auth, base.transport)).maxRetries).toBe(0);
    expect(await run(base, sink, { createStream: overWire(base) })).toMatchObject({ type: "error", error: { statusCode: 503 } });
    expect(authorizations).toEqual(["Bearer route-a-key"]);
    const changed = { ...base, model: { ...input.model, providerID: "fallback" } };
    expect(await run(changed, sink, { createStream: overWire(changed) })).toMatchObject({ type: "error", error: { visibleOutput: false } });
    expect(authorizations).toEqual(["Bearer route-a-key"]);
    const rebound = { ...changed, authProvider: "fallback", auth: { type: "api", key: "route-b-key" } as const };
    expect(await run(rebound, sink, { createStream: overWire(rebound) }))
      .toMatchObject({ type: "error", error: { statusCode: 503, provider: "fallback" } });
    expect(authorizations).toEqual(["Bearer route-a-key", "Bearer route-b-key"]);
  } finally {
    await server.stop(true);
  }
});

test("reasoning-only failure retains billed usage without marking an assistant prefix visible", async () => {
  let subscriptions = 0;
  const outcome = await run(input, sink, {
    createStream: async () => ({
      fullStream: (async function* (): AsyncGenerator<StreamEvent, void, undefined> {
        subscriptions += 1;
        yield { type: "reasoning-delta", id: "private", text: "reasoning" };
        yield { type: "step-finish", usage: { inputTokens: 13, outputTokens: 7, reasoningTokens: 5 } };
        throw new Error("provider_lost");
      })(),
    }),
  });
  expect(subscriptions).toBe(1);
  expect(outcome).toMatchObject({ type: "error", error: {
    visibleOutput: false, usage: { inputTokens: 13, outputTokens: 7, reasoningTokens: 5 },
  } });
});

test("policy owns persisted lifecycle validation independently of the static provider outcome", async () => {
  const schema = Policy.PolicyPoint.InputSchemas["run.lifecycle.post"];
  const embed = (runOutcome: { type: string }) => ({
    sessionId: "session",
    runId: "run",
    runOutcome,
  });
  expect(schema.safeParse(embed({ type: "stop" })).success).toBe(true);
  expect(schema.safeParse(embed({ type: "max-steps" })).success).toBe(true);
  expect(schema.safeParse(embed({ type: "invalid" })).success).toBe(false);
  const root = await import("../src");
  expect("FailureError" in root).toBe(false);
});
