import { expect, test } from "bun:test";
import { Bus } from "@openomni/agent";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { rmSync } from "node:fs";
import { serveProcessSession } from "../src/process-entry";
import { messageFixture } from "./helpers/message-fixture";
import { Gateway } from "@openomni/protocol";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
const suite = residentSuite();
function response(): Response {
  const block = { type: "text", text: "" };
  const delta = { type: "text_delta", text: "PROCESS_SENTINEL" };
  const frames = [
    {
      type: "message_start",
      message: {
        id: crypto.randomUUID(),
        type: "message",
        role: "assistant",
        model: "claude-opus-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("process-session entry preserves the commissioned deadline and reports the committed parent", async () => {
  const fixture = messageFixture();
  let requests = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests += 1;
      return response();
    },
  });
  const deadline = Date.now() + 60_000;
  try {
    expect(
      (
        await fixture.send({
          to: { kind: "new_session", role: "worker", runner: "process", parent: "me" },
          type: "message",
          content: "work",
          deadline,
          replyTo: "process-original",
        })
      ).isError,
    ).not.toBe(true);
    const child = SessionHandleStore.listRows().find((row) => row.role === "worker");
    if (child === undefined) throw new Error("missing commissioned process session");
    const notified: string[] = [];
    await serveProcessSession(
      {
        sessionId: child.id,
        dbPath: fixture.dbPath,
        model: { provider: "anthropic", id: "claude-opus-4-5" },
        apiKey: "process-key",
        transport: { baseUrl: `http://127.0.0.1:${provider.port}/v1` },
      },
      (ids) => notified.push(...ids),
    );
    Storage.initialize({ dbPath: fixture.dbPath });
    expect(requests).toBe(1);
    expect(notified).toContain("sender");
    expect(SessionHandleStore.inboxRows("sender")).toHaveLength(1);
    expect(SessionHandleStore.inboxRows("sender")[0]).toMatchObject({
      content: "PROCESS_SENTINEL",
      origin: { value: { replyTo: "process-original", terminalKind: "result" } },
    });
    expect(
      SessionHandleStore.tree(child.id).filter((action) => action.kind === "alarm.arm"),
    ).toEqual([]);
    expect(SessionHandleStore.expireMessageDeadlines(deadline)).toEqual([]);
  } finally {
    await provider.stop(true);
    Storage.reset();
    Bus.reset();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("startOpenOmni runs a process session and drains its atomic parent reply without ACK settlement", async () => {
  const parentReply = Promise.withResolvers<void>();
  suite.defer(
    Bus.subscribe(Gateway.MessageObserved, (event) => {
      if (event.kind === "message.drained" && event.messageId.endsWith(":reply"))
        parentReply.resolve();
    }),
  );
  let requests = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests += 1;
      return response();
    },
  });
  suite.defer(() => provider.stop(true));
  let commissioned = false;
  const app = await suite.boot({
    config: suite.config("process-message-", {
      wsToken: "token",
      model: {
        provider: "anthropic",
        id: "claude-opus-4-5",
        apiKey: "process-key",
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      },
    }),
    llm: {
      resolveModel: fakeProviderModel,
      run: async (input, sink) => {
        if (!commissioned) {
          const output = requestToolStep(input, sink, {
            id: "process-send",
            tool: "sendMessage",
            input: {
              to: { kind: "new_session", role: "worker", runner: "process", parent: "me" },
              type: "message",
              content: "run process",
              replyTo: "process-binding",
            },
          });
          if (output === undefined) return { type: "stop" };
          expect(output.isError).not.toBe(true);
          commissioned = true;
        }
        sink.onMessage(assistantMessage(input, { text: "PARENT_SENTINEL" }));
        return { type: "stop" };
      },
    },
  });
  await app.gateway.ingest(
    { kind: "external", surface: "ws", externalId: "owner" },
    {
      eventId: "initial-process",
      surface: "ws",
      channelId: "owner",
      addressees: [],
      dm: true,
      payload: {},
      render: "start",
    },
  );
  await parentReply.promise;
  const child = SessionHandleStore.listRows().find((row) => row.role === "worker");
  if (child?.parentId === undefined || child.parentId === null)
    throw new Error("missing process child");
  const replies = SessionHandleStore.inboxRows(child.parentId).filter((row) =>
    row.id.endsWith(":reply"),
  );
  console.log("process evidence", JSON.stringify({ requests, child, replies }));
  expect(requests).toBe(1);
  expect(replies).toHaveLength(1);
  expect(replies[0]?.content).toBe("PROCESS_SENTINEL");
  expect(replies[0]?.origin.value).toMatchObject({
    childSessionId: child.id,
    replyTo: "process-binding",
    terminalKind: "result",
  });
}, 15000);
