import { expect, test } from "bun:test";
import { ownerStart } from "./helpers/owner-start";
import { Bus, sessionTool } from "@openomni/agent";
import { createTools } from "../src/tools/core/catalog";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { rmSync } from "node:fs";
import { serveProcessSession } from "../src/process-entry";
import { messageFixture } from "./helpers/message-fixture";
import { Gateway, SessionTransition } from "@openomni/protocol";
import { assistantMessage, requestToolStep } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { messageStart, messageEnd, sseResponse } from "./helpers/anthropic-sse";

const suite = residentSuite();
function response(target?: string): Response {
  const block = target === undefined
    ? { type: "text", text: "" }
    : { type: "tool_use", id: "process-tool", name: "send_message", input: {} };
  const delta = target === undefined
    ? { type: "text_delta", text: "PROCESS_SENTINEL" }
    : { type: "input_json_delta", partial_json: JSON.stringify({
        to: { kind: "session", id: target }, message: "PROCESS_TOOL_SENTINEL",
      }) };
  const frames = [
    messageStart(crypto.randomUUID(), "claude-opus-4-5", 4),
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    ...messageEnd(target === undefined ? "end_turn" : "tool_use", 2),
  ];
  return sseResponse(frames);
}

test.each([false, true])("process-session entry preserves deadline and parent with tool send %s", async (toolSend) => {
  const fixture = messageFixture("resident", undefined,
    toolSend ? createTools({}, { sessionId: "worker", role: "worker" }).map(sessionTool) : [],
  );
  let requests = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests += 1;
      return response(toolSend && requests === 1 ? "sender" : undefined);
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
          ...(toolSend ? {} : { deadline }),
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
    expect(requests).toBe(toolSend ? 2 : 1);
    expect(notified).toContain("sender");
    expect(SessionHandleStore.inboxRows("sender").filter((row) => row.content === "PROCESS_TOOL_SENTINEL")).toHaveLength(toolSend ? 1 : 0);
    const received = SessionHandleStore.inboxRows("sender").filter(
      (row) => SessionTransition.OutboundMessage.safeParse(row.origin.value).success,
    );
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      content: "PROCESS_SENTINEL",
      origin: { value: { replyTo: "process-original", terminal: "completed" } },
    });
    expect(
      SessionHandleStore.tree(child.id).filter((action) => action.kind === "alarm.arm"),
    ).toEqual([]);
    expect(SessionHandleStore.requestRows("sender")[0]?.state).toBe("resolved");
    expect(Storage.get().alarms?.due(deadline)).toEqual([]);
  } finally {
    await provider.stop(true);
    Storage.reset();
    Bus.reset();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("startOpenOmni runs a process session and drains its atomic parent reply without ACK settlement", async () => {
  const parentReply = Promise.withResolvers<void>();
  const timer = setTimeout(
    () => parentReply.reject(new Error("process reply was not drained")),
    5000,
  );
  const received = parentReply.promise.then(
    () => ({ ok: true }),
    (error: Error) => ({ ok: false, error }),
  );
  suite.defer(() => clearTimeout(timer));
  suite.defer(
    Bus.subscribe(Gateway.MessageObserved, (event) => {
      if (event.kind === "message.drained" && event.messageId.endsWith(":reply"))
        parentReply.resolve();
    }),
  );
  let requests = 0;
  let parentSessionId = "";
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      requests += 1;
      return response(requests === 1 ? parentSessionId : undefined);
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
        parentSessionId = input.trace.sessionId;
        if (!commissioned) {
          const output = requestToolStep(input, sink, {
            id: "process-send",
            tool: "send_message",
            input: {
              to: { kind: "new_session", role: "worker", runner: "process", parent: "me" },
              message: "run process",
              reply_to: "process-binding",
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
  await ownerStart(app, "initial-process");
  expect(await received).toEqual({ ok: true });
  const child = SessionHandleStore.listRows().find((row) => row.role === "worker");
  if (child?.parentId === undefined || child.parentId === null)
    throw new Error("missing process child");
  const replies = SessionHandleStore.inboxRows(child.parentId).filter((row) =>
    row.id.endsWith(":reply"),
  );
  expect(requests).toBe(2);
  expect(SessionHandleStore.inboxRows(child.parentId).some((row) => row.content === "PROCESS_TOOL_SENTINEL")).toBe(true);
  expect(replies).toHaveLength(1);
  expect(replies[0]?.content).toBe("PROCESS_SENTINEL");
  expect(replies[0]?.origin.value).toMatchObject({
    sourceSessionId: child.id,
    replyTo: "process-binding",
    terminal: "completed",
  });
}, 15000);
