import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObservationBus } from "@openomni/agent";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { run, type Provider } from "@openomni/llm";
import { LlmCall, type Message, type Tool } from "@openomni/protocol";
import { z } from "zod";
import { startOpenOmni } from "../../src/index";
import { closeSocket, nextMessage, openSocket } from "./ws";

// A local provider speaks real Anthropic SSE to the installed SDK, not a run/SDK mock.
function response(tool: boolean): Response {
  const frames = [
    {
      type: "message_start",
      message: {
        id: "provider-message",
        type: "message",
        role: "assistant",
        model: "fixture",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: tool ? 5 : 11, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: tool
        ? { type: "tool_use", id: "paired", name: "lookup", input: {} }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: tool
        ? { type: "input_json_delta", partial_json: "{}" }
        : { type: "text_delta", text: "retained reply" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: tool ? 7 : 13 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(
            new TextEncoder().encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`),
          );
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const directory = mkdtempSync(join(tmpdir(), "openomni-967-fact-tap-"));
const dbPath = join(directory, "chat.db");
let requests = 0;
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/v1/messages");
    assert.equal(request.headers.get("x-api-key"), "fixture-key");
    const body = await request.text();
    z.object({ stream: z.literal(true) }).parse(JSON.parse(body));
    requests += 1;
    if (requests === 2) {
      return Response.json(
        { type: "error", error: { type: "overloaded_error", message: "retry fixture" } },
        {
          status: 529,
          headers: { "retry-after-ms": "1" },
        },
      );
    }
    return response(requests === 1);
  },
});
const providerPort = provider.port;
const model: Provider.Model = {
  id: "fixture",
  name: "fixture",
  providerID: "anthropic",
  api: { npm: "@ai-sdk/anthropic", url: `http://127.0.0.1:${provider.port}/v1` },
};
const events = createObservationBus();
const messages: Message.WithParts[] = [];
const calls: Tool.Call[] = [];
const results: Tool.Result[] = [];
let stopApp: (() => Promise<void>) | undefined;
let ws: WebSocket | undefined;
let appPort: number | undefined;
let unsubscribe: (() => void) | undefined;
try {
  // Given: a tool step that bills usage, a failed next HTTP request, then a successful retry.
  const completed = new Promise<{ input: number; output: number }>((resolve) => {
    unsubscribe = events.subscribe(LlmCall.Events.Completed, (event) => {
      resolve({ input: event.inputTokens, output: event.outputTokens });
    });
  });
  const outcome = await run(
    {
      model,
      auth: { type: "api", key: "fixture-key" },
      events,
      trace: { traceId: "967-provider", sessionId: "967-provider", runId: "967-provider" },
      system: "Answer using the supplied tool.",
      messages: [],
      tools: [
        {
          name: "lookup",
          description: "Fixture lookup",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      maxRetryAttempts: 1,
      toolExecutor: async (call) => ({ id: "result", toolCallId: call.id, output: "42" }),
    },
    {
      onMessage: (message) => messages.push(message),
      onToolCall: (call) => calls.push(call),
      onToolResult: (result) => results.push(result),
    },
  );
  assert.deepEqual(outcome, { type: "stop" });
  const billed = await completed;
  assert.deepEqual(billed, { input: 16, output: 20 });
  assert.equal(requests, 3);
  assert.deepEqual(calls, [{ id: "paired", tool: "lookup", input: {} }]);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.toolCallId, "paired");
  assert.equal(results[0]?.output, "42");
  const terminals = messages.filter(
    (message) => message.info.role === "assistant" && message.info.finish !== undefined,
  );
  assert.deepEqual(
    terminals.map((message) => (message.info.role === "assistant" ? message.info.finish : null)),
    ["error", "stop"],
  );
  assert.equal(messages[0]?.info.role === "assistant" ? messages[0].info.tokens.input : -1, 0);
  assert.deepEqual(
    messages
      .at(-1)
      ?.parts.filter((part) => part.type === "text")
      .map((part) => part.text),
    ["retained reply"],
  );
  assert.equal(terminals[0]?.parts.find((part) => part.type === "tool")?.state.status, "completed");
  console.log("967 provider", JSON.stringify({ requests, billed, calls, results, terminals }));

  // When: the production app calls the same real SDK through its configured transport.
  const app = await startOpenOmni({
    config: {
      dbPath,
      host: "127.0.0.1",
      wsPort: 0,
      wsToken: "fixture-token",
      model: {
        provider: "anthropic",
        id: "fixture",
        apiKey: "fixture-key",
        baseUrl: model.api?.url,
      },
    },
    llm: { resolveProviderModel: async () => model },
  });
  stopApp = app.stop;
  appPort = app.port;
  ws = await openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "fixture-token"]);
  const replyEvent = nextMessage(ws, 5000);
  ws.send(JSON.stringify({ type: "message", text: "967 input" }));
  const reply = z
    .object({ type: z.literal("response"), text: z.string() })
    .parse(JSON.parse(String((await replyEvent).data)));

  // Then: the transport reply and committed SQLite terminal agree.
  assert.deepEqual(reply, { type: "response", text: "retained reply" });
  assert.equal(requests, 4);
  const rows = SessionHandleStore.listRows();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  const snapshot = SessionHandleStore.getSnapshot(row.id);
  assert.equal(snapshot.state, "idle");
  assert.deepEqual(snapshot.turns.at(-1)?.messages, [
    { role: "user", text: "967 input" },
    { role: "assistant", text: "retained reply" },
  ]);
  assert.equal(snapshot.turns.at(-1)?.terminal?.kind, "result");
  const db = new Database(dbPath, { readonly: true });
  try {
    const actions = db
      .query<{ session_id: string; kind: string; ordinal: number }, []>(
        "SELECT session_id, kind, ordinal FROM action ORDER BY ordinal",
      )
      .all();
    assert.ok(actions.length > 0);
    assert.deepEqual(
      db
        .query<{ table: string; rowid: number; parent: string; fkid: number }, []>(
          "PRAGMA foreign_key_check",
        )
        .all(),
      [],
    );
    console.log(
      "967 app SQLite",
      JSON.stringify({ reply, requests, appPort, dbPath, actions, turns: snapshot.turns }),
    );
  } finally {
    db.close();
  }
} finally {
  unsubscribe?.();
  try {
    if (ws !== undefined) await closeSocket(ws);
  } finally {
    try {
      await stopApp?.();
    } finally {
      await provider.stop(true);
      Storage.reset();
      rmSync(directory, { recursive: true, force: true });
      for (const port of [providerPort, appPort]) {
        if (port === undefined) continue;
        const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
        await probe.stop(true);
      }
      assert.equal(existsSync(directory), false);
      if (ws !== undefined) assert.equal(ws.readyState, WebSocket.CLOSED);
      console.log(
        "967 cleanup",
        JSON.stringify({
          appPort,
          providerPort,
          directory,
          directoryExists: existsSync(directory),
          socketState: ws?.readyState,
        }),
      );
    }
  }
}
