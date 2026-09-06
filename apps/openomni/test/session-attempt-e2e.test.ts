import { expect, test } from "bun:test";
import { Auth } from "@openomni/llm";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { residentSuite } from "./helpers/resident-suite";
import { nextMessage } from "./helpers/ws";

const suite = residentSuite();
function stream(text: string, fail: boolean, tool: boolean): Response {
  const frames = [
    {
      type: "message_start",
      message: {
        id: "attempt",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: tool
        ? { type: "tool_use", id: "call", name: "provision", input: {} }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: tool
        ? {
            type: "input_json_delta",
            partial_json: JSON.stringify({ operation: { op: "status", args: {} } }),
          }
        : { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 0 },
    ...(fail
      ? [{ type: "error", error: { type: "overloaded_error", message: "overloaded" } }]
      : [
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 3 },
          },
          { type: "message_stop" },
        ]),
  ];
  return new Response(
    frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

for (const visible of ["none", "text", "tool"] as const) {
  test(`real SSE ${visible} visibility has exact provider invocation and durable child topology`, async () => {
    let requests = 0;
    const waits: number[] = [];
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests += 1;
        if (visible === "none" && requests < 3)
          return Response.json(
            { type: "error", error: { type: "overloaded_error", message: "overloaded" } },
            { status: 529, headers: { "retry-after-ms": "0" } },
          );
        return stream("visible", visible !== "none", visible === "tool");
      },
    });
    suite.defer(() => provider.stop(true));
    const config = suite.config("937-real-attempt-", {
      wsToken: "token",
      compactionSummarizer: false,
      model: {
        provider: "anthropic",
        id: "claude-opus-4-5",
        apiKey: "primary-key",
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      },
    });
    const app = await suite.boot({
      config,
      sessionRuntime: {
        waitRetry: async (delay) => {
          waits.push(delay);
        },
      },
    });
    const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "token"]);
    const reply = nextMessage(socket);
    socket.send(JSON.stringify({ type: "message", text: "attempt" }));
    await reply;
    const sessionId = SessionHandleStore.listRows()[0]?.id;
    if (sessionId === undefined) throw new Error("missing session");
    const db = new Database(config.dbPath, { readonly: true });
    try {
      const parents = db
        .query(
          "SELECT id FROM action WHERE session_id=? AND kind='llm' AND json_extract(intent,'$.phase')='intent'",
        )
        .all(sessionId);
      const attempts = db
        .query(
          "SELECT parent_id FROM action WHERE session_id=? AND kind='attempt' AND json_extract(intent,'$.phase')='intent' ORDER BY ordinal",
        )
        .all(sessionId);
      expect(parents).toHaveLength(1);
      expect(attempts).toHaveLength(visible === "none" ? 3 : 1);
      const parent = parents[0];
      expect(attempts).toEqual(
        Array.from({ length: attempts.length }, () => ({
          parent_id:
            typeof parent === "object" && parent !== null && "id" in parent ? parent.id : null,
        })),
      );
      expect(requests).toBe(visible === "none" ? 3 : 1);
      expect(waits).toEqual(visible === "none" ? [0, 0] : []);
      expect(
        db
          .query(
            "SELECT count(*) AS count FROM action WHERE kind='attempt' AND json_extract(effect,'$.failure.usage.inputTokens') IS NOT NULL",
          )
          .get(),
      ).toEqual({ count: visible === "none" ? 2 : 1 });
      if (visible !== "none")
        expect(SessionHandleStore.getSnapshot(sessionId).turns[0]?.terminal?.kind).toBe("error");
      console.log(
        "937 SSE attempt",
        JSON.stringify({ visible, requests, waits, parents, attempts }),
      );
    } finally {
      db.close();
      await suite.cleanup();
    }
  });
}

test("real cross-provider fallback sends only the fallback's stored credential", async () => {
  const authorization: { path: string; key: string | null }[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      authorization.push({
        path: new URL(request.url).pathname,
        key: request.headers.get("authorization") ?? request.headers.get("x-api-key"),
      });
      if (authorization.length === 1)
        return Response.json(
          { type: "error", error: { type: "overloaded_error", message: "overloaded" } },
          { status: 529, headers: { "retry-after-ms": "0" } },
        );
      const item = {
        id: "message",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "fallback completed", annotations: [] }],
        status: "completed",
      };
      return new Response(
        [
          {
            type: "response.created",
            response: { id: "fallback", created_at: 1, model: "gpt-4o" },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, content: [], status: "in_progress" },
          },
          {
            type: "response.output_text.delta",
            item_id: "message",
            output_index: 0,
            content_index: 0,
            delta: "fallback completed",
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "fallback",
              created_at: 1,
              model: "gpt-4o",
              status: "completed",
              output: [item],
              usage: {
                input_tokens: 4,
                output_tokens: 2,
                total_tokens: 6,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 0 },
              },
            },
          },
        ]
          .map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  suite.defer(() => provider.stop(true));
  const config = suite.config("937-fallback-auth-", {
    wsToken: "token",
    compactionSummarizer: false,
    model: {
      provider: "anthropic",
      id: "claude-opus-4-5",
      apiKey: "primary-key",
      baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      fallbacks: [{ provider: "openai", id: "gpt-4o" }],
    },
  });
  const old = process.env.OPENOMNI_AUTH_FILE;
  process.env.OPENOMNI_AUTH_FILE = join(config.dbPath, "..", "auth.json");
  suite.defer(() => {
    if (old === undefined) delete process.env.OPENOMNI_AUTH_FILE;
    else process.env.OPENOMNI_AUTH_FILE = old;
  });
  await Auth.set("openai", { type: "api", key: "fallback-key" });
  const app = await suite.boot({ config, sessionRuntime: { waitRetry: async () => undefined } });
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "token"]);
  const reply = nextMessage(socket);
  socket.send(JSON.stringify({ type: "message", text: "fallback" }));
  await reply;
  expect(authorization.map((request) => request.key)).toEqual([
    "primary-key",
    "Bearer fallback-key",
  ]);
  expect(authorization[1]?.path).toBe("/v1/responses");
  const row = SessionHandleStore.listRows()[0];
  if (row === undefined) throw new Error("missing fallback session");
  expect(SessionHandleStore.getSnapshot(row.id).turns[0]?.terminal?.kind).toBe("result");
  expect(SessionHandleStore.getSnapshot(row.id).turns[0]?.messages.at(-1)?.text).toBe(
    "fallback completed",
  );
  expect(Storage.getInitializedDbPath()).toBe(config.dbPath);
  console.log("937 fallback transport", JSON.stringify(authorization));
  await suite.cleanup();
});
