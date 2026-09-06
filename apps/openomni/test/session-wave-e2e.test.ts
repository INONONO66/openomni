import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  Bus,
  defineTool,
  eraseTool,
  currentExecutor,
  createDispatcher,
  type ExecutionApprovalRequest,
  type SessionHandle,
} from "@openomni/agent";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { z } from "zod";
import {
  LlmCall,
  L0Observation,
  Tool,
  type AnyToolDefinition,
  type PlainObject,
} from "@openomni/protocol";
import { residentSuite } from "./helpers/resident-suite";
import { nextMessage } from "./helpers/ws";

const suite = residentSuite();

interface ProviderCall {
  readonly id: string;
  readonly name: string;
  readonly input: PlainObject;
}
function providerResponse(calls: readonly ProviderCall[]): Response {
  const blocks =
    calls.length > 0
      ? calls.map((call) => ({
          start: { type: "tool_use", id: call.id, name: call.name, input: {} },
          delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
        }))
      : [{ start: { type: "text", text: "" }, delta: { type: "text_delta", text: "finished" } }];
  const frames = [
    {
      type: "message_start",
      message: {
        id: "wave-provider",
        type: "message",
        role: "assistant",
        model: "wave",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    ...blocks.flatMap((block, index) => [
      { type: "content_block_start", index, content_block: block.start },
      { type: "content_block_delta", index, delta: block.delta },
      { type: "content_block_stop", index },
    ]),
    {
      type: "message_delta",
      delta: { stop_reason: calls.length > 0 ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("real provider returns calls before any app tool body starts", async () => {
  // Given: real app, SQLite, SDK and a provider tool-use response.
  let requests = 0;
  let bodies = 0;
  const countsAtModelReturn: number[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests += 1;
      return providerResponse(
        requests === 1
          ? [
              {
                id: "original-call",
                name: "provision",
                input: { operation: { op: "status", args: {} } },
              },
            ]
          : [],
      );
    },
  });
  suite.defer(() => provider.stop(true));
  const app = await suite.boot({
    config: suite.config("openomni-937-wave-red-", {
      compactionSummarizer: false,
      wsToken: "wave-token",
      model: {
        provider: "anthropic",
        id: "wave",
        apiKey: "key",
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
      },
    }),
    llm: {
      resolveModel: async () => ({
        id: "wave",
        name: "wave",
        providerID: "anthropic",
        api: { npm: "@ai-sdk/anthropic" },
        limit: { context: 100000 },
      }),
    },
  });
  suite.defer(
    Bus.subscribe(Tool.Events.Started, () => {
      bodies += 1;
    }),
  );
  suite.defer(
    Bus.subscribe(LlmCall.Events.Completed, () => {
      countsAtModelReturn.push(bodies);
    }),
  );
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "wave-token"]);
  // When: the public channel triggers a model step with a native tool call.
  const response = nextMessage(socket, 5000);
  socket.send(JSON.stringify({ type: "message", text: "read current status" }));
  await response;
  // Then: provider I/O did not execute the body before returning its calls.
  expect(countsAtModelReturn[0]).toBe(0);
  expect(bodies).toBe(1);
});

const ProviderRequest = z.object({
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(
          z.object({
            type: z.string(),
            tool_use_id: z.string().optional(),
            content: z.string().optional(),
          }),
        ),
      ]),
    }),
  ),
});

function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("wave signal deadline")), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
}

function waveTool(
  name: string,
  execute: (signal: AbortSignal) => Promise<string>,
  sequential?: true,
): AnyToolDefinition {
  return eraseTool(
    defineTool({
      name,
      description: `test ${name}`,
      category: "query",
      visibility: { model: ["resident"], cell: [] },
      input: z.object({ slot: z.literal(name) }),
      output: z.string(),
      ...(sequential ? { sequential } : {}),
      execute: (_input, context) => execute(context.signal),
      render: (_input, result) => result,
    }),
  );
}

async function waveApp(
  definitions: readonly AnyToolDefinition[],
  names: readonly string[],
  sessionRuntime?: NonNullable<Parameters<typeof suite.boot>[0]>["sessionRuntime"],
) {
  const received: z.infer<typeof ProviderRequest>[] = [];
  const calls = names.map((name) => ({ id: `call-${name}`, name, input: { slot: name } }));
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      received.push(ProviderRequest.parse(JSON.parse(await request.text())));
      return providerResponse(received.length === 1 ? calls : []);
    },
  });
  suite.defer(async () => {
    const port = provider.port;
    await provider.stop(true);
    const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response() });
    await probe.stop(true);
  });
  const config = suite.config("openomni-937-wave-", {
    compactionSummarizer: false,
    wsToken: "wave-token",
    model: {
      provider: "anthropic",
      id: "wave",
      apiKey: "key",
      baseUrl: `http://127.0.0.1:${provider.port}/v1`,
    },
  });
  const app = await suite.boot({
    config,
    toolDefinitions: definitions,
    sessionRuntime,
    llm: {
      resolveModel: async () => ({
        id: "wave",
        name: "wave",
        providerID: "anthropic",
        api: { npm: "@ai-sdk/anthropic" },
        limit: { context: 100000 },
      }),
    },
  });
  const socket = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "wave-token"]);
  const cleanup = async () => {
    await suite.cleanup();
    expect(existsSync(dirname(config.dbPath))).toBe(false);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    const probe = Bun.serve({ hostname: "127.0.0.1", port: app.port, fetch: () => new Response() });
    await probe.stop(true);
  };
  return { app, socket, received, dbPath: config.dbPath, cleanup };
}

function toolResults(sessionId: string) {
  const result = z.object({ phase: z.literal("result"), terminal: z.string(), callId: z.string() });
  return SessionHandleStore.tree(sessionId)
    .filter((action) => action.kind === "tool")
    .flatMap((action) => {
      const parsed = result.safeParse(action.effect.value);
      return parsed.success ? [parsed.data] : [];
    });
}

function activeRow() {
  const row = SessionHandleStore.listRows()[0];
  if (row === undefined) throw new Error("missing app session");
  return row;
}

function nextApproval(app: Awaited<ReturnType<typeof waveApp>>["app"]) {
  const waiting = Promise.withResolvers<{
    handle: SessionHandle;
    request: ExecutionApprovalRequest;
  }>();
  suite.defer(
    Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
      const handle = app.sessions.get(event.sessionId);
      const request = handle?.approvals.pending()[0];
      if (handle !== undefined && request !== undefined) waiting.resolve({ handle, request });
    }),
  );
  return waiting.promise;
}

function requireBApproval() {
  const policies = Storage.get().policies;
  if (policies === undefined) throw new Error("missing policy adapter");
  expect(
    policies.append({
      name: "approve-B",
      kind: "tool",
      phase: "pre",
      generation: 1,
      priority: 2000,
      match: { encodingVersion: 1, value: { op: "B" } },
      verdict: { encodingVersion: 1, value: { type: "require_approval", reason: "owner" } },
    }),
  ).toBe(true);
}

test("after-model SDK interrupt starts zero bodies and seals one interrupted terminal", async () => {
  // Given: subscribe before the real model emits its complete invocation.
  let bodies = 0;
  const { app, socket, received } = await waveApp(
    [
      waveTool("A", async () => {
        bodies += 1;
        return "A";
      }),
    ],
    ["A"],
  );
  const interrupted = Promise.withResolvers<void>();
  suite.defer(
    Bus.subscribe(LlmCall.Events.Completed, (event) => {
      const handle = app.sessions.get(event.sessionId);
      if (handle === undefined) return interrupted.reject(new Error("missing live SDK handle"));
      void handle.interrupt().then(interrupted.resolve, interrupted.reject);
    }),
  );
  // When: interrupt at the real provider-return boundary, before any tool body.
  socket.send(JSON.stringify({ type: "message", text: "run A" }));
  await bounded(interrupted.promise);
  // Then: exactly the original turn is interrupted without a body or second call.
  expect(bodies).toBe(0);
  expect(received).toHaveLength(1);
  const terminals = SessionHandleStore.tree(activeRow().id).flatMap((action) => {
    const terminal = SessionHandleStore.turnTerminal(action);
    return terminal ? [terminal] : [];
  });
  expect(terminals.map((terminal) => terminal.kind)).toEqual(["interrupted"]);
});

test("all pre decisions precede A B C and reverse completion preserves ledger/provider order across D", async () => {
  // Given: exact body-entry signals and independently controlled completion.
  const gates = new Map(
    ["A", "B", "C", "D"].map((name) => [name, Promise.withResolvers<string>()]),
  );
  const entered = Promise.withResolvers<void>();
  const dEntered = Promise.withResolvers<void>();
  const started: string[] = [];
  const preCounts: number[] = [];
  const definitions = [...gates].map(([name, gate]) =>
    waveTool(
      name,
      async () => {
        started.push(name);
        preCounts.push(
          SessionHandleStore.tree(activeRow().id).filter(
            (action) =>
              action.kind === "policy.decision" &&
              z.object({ hook: z.literal("tool.pre") }).safeParse(action.intent.value).success,
          ).length,
        );
        if (started.length === 3) entered.resolve();
        if (name === "D") dEntered.resolve();
        return gate.promise;
      },
      name === "D" ? true : undefined,
    ),
  );
  const { socket, received, dbPath, cleanup } = await waveApp(definitions, ["A", "B", "C", "D"]);
  const response = nextMessage(socket, 5000);
  try {
    // When: complete parallel bodies in reverse while D is a sequential barrier.
    socket.send(JSON.stringify({ type: "message", text: "run wave" }));
    await bounded(entered.promise);
    expect(started).toEqual(["A", "B", "C"]);
    expect(preCounts).toEqual([4, 4, 4]);
    gates.get("C")?.resolve("C");
    gates.get("B")?.resolve("B");
    expect(started).toEqual(["A", "B", "C"]);
    gates.get("A")?.resolve("A");
    await bounded(dEntered.promise);
    expect(received).toHaveLength(1);
    gates.get("D")?.resolve("D");
    await response;
    // Then: both durable result ordinals and real next-provider blocks preserve slots.
    expect(started).toEqual(["A", "B", "C", "D"]);
    expect(toolResults(activeRow().id).map((result) => result.callId)).toEqual([
      "call-A",
      "call-B",
      "call-C",
      "call-D",
    ]);
    const blocks =
      received[1]?.messages.flatMap((message) =>
        typeof message.content === "string" ? [] : message.content,
      ) ?? [];
    expect(
      blocks.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id),
    ).toEqual(["call-A", "call-B", "call-C", "call-D"]);
    const db = new Database(dbPath, { readonly: true });
    try {
      const persisted = db
        .query<{ effect: string }, []>(
          "SELECT effect FROM action WHERE kind = 'tool' ORDER BY ordinal",
        )
        .all();
      const decoded = persisted.flatMap((row) => {
        const parsed = z
          .object({ phase: z.literal("result"), callId: z.string() })
          .safeParse(JSON.parse(row.effect));
        return parsed.success ? [parsed.data.callId] : [];
      });
      expect(decoded).toEqual(["call-A", "call-B", "call-C", "call-D"]);
    } finally {
      db.close();
    }
    console.log(
      "937 ordered wave",
      JSON.stringify({
        preCounts,
        results: toolResults(activeRow().id),
        requests: received.length,
      }),
    );
  } finally {
    for (const [name, gate] of gates) gate.resolve(name);
    await cleanup();
  }
});

for (const decision of ["approve", "refuse"] as const) {
  test(`authenticated ${decision} of B holds A/C and retains the original invocation`, async () => {
    const started: string[] = [];
    const definitions = ["A", "B", "C"].map((name) =>
      waveTool(name, async () => {
        started.push(name);
        return name;
      }),
    );
    const { app, socket, received } = await waveApp(definitions, ["A", "B", "C"]);
    requireBApproval();
    const waiting = nextApproval(app);
    const response = nextMessage(socket, 5000);
    socket.send(JSON.stringify({ type: "message", text: "approved wave" }));
    const { handle, request } = await bounded(waiting);
    expect(started).toEqual([]);
    expect(request).toMatchObject({ callId: "call-B", generation: 1, intent: { slot: "B" } });
    await expect(
      handle.approvals.answer({ request, decision, credential: "forged" }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(
      handle.approvals.answer({
        request: { ...request, inputHash: "wrong" },
        decision,
        credential: "wave-token",
      }),
    ).rejects.toMatchObject({ code: "stale_approval" });
    expect(started).toEqual([]);
    // When: authenticated Owner evidence answers the captured original request.
    await handle.approvals.answer({ request, decision, credential: "wave-token" });
    await response;
    // Then: refusal affects only B, approval executes that same slot exactly once.
    expect(started).toEqual(decision === "approve" ? ["A", "B", "C"] : ["A", "C"]);
    expect(received).toHaveLength(2);
    expect(toolResults(handle.id).map((result) => [result.callId, result.terminal])).toEqual([
      ["call-A", "executed"],
      ["call-B", decision === "approve" ? "executed" : "blocked_pre"],
      ["call-C", "executed"],
    ]);
    await expect(
      handle.approvals.answer({ request, decision, credential: "wave-token" }),
    ).rejects.toMatchObject({ code: "stale_approval" });
  });
}

test("interrupting pending B cancels every unstarted positional slot", async () => {
  const started: string[] = [];
  const { app, socket, received } = await waveApp(
    ["A", "B", "C"].map((name) =>
      waveTool(name, async () => {
        started.push(name);
        return name;
      }),
    ),
    ["A", "B", "C"],
  );
  requireBApproval();
  const waiting = nextApproval(app);
  socket.send(JSON.stringify({ type: "message", text: "hold wave" }));
  const { handle, request } = await bounded(waiting);
  expect(started).toEqual([]);
  await bounded(handle.interrupt());
  expect(started).toEqual([]);
  expect(received).toHaveLength(1);
  expect(toolResults(handle.id).map((result) => [result.callId, result.terminal])).toEqual([
    ["call-A", "cancelled"],
    ["call-B", "cancelled"],
    ["call-C", "cancelled"],
  ]);
  await expect(
    handle.approvals.answer({ request, decision: "approve", credential: "wave-token" }),
  ).rejects.toMatchObject({ code: "stale_approval" });
});

test("noncooperative bodies release the wave but retain the lease and cannot commit late", async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const late = Promise.withResolvers<string>();
  let signal: AbortSignal | undefined;
  const definitions = [
    waveTool("A", async () => "A", true),
    waveTool("B", async (currentSignal) => {
      signal = currentSignal;
      const executor = currentExecutor();
      entered.resolve();
      await gate.promise;
      try {
        await executor.run(
          { kind: "tool", op: "late-callback", intent: {}, effect: {} },
          async () => ({ bad: true }),
        );
        late.resolve("committed");
      } catch (error) {
        late.resolve(error instanceof Error ? error.name : "non-error");
      }
      return "late B";
    }),
  ];
  const { app, socket, received } = await waveApp(definitions, ["A", "B"]);
  const channelSettled = nextMessage(socket, 5000);
  try {
    socket.send(JSON.stringify({ type: "message", text: "interrupt running wave" }));
    await bounded(entered.promise);
    const row = activeRow();
    const handle = app.sessions.get(row.id);
    if (handle === undefined) throw new Error("missing session handle");
    await bounded(handle.interrupt());
    expect(signal?.aborted).toBe(true);
    expect(toolResults(row.id).map((result) => [result.callId, result.terminal])).toEqual([
      ["call-A", "executed"],
      ["call-B", "cancelled"],
    ]);
    expect(SessionHandleStore.row(row.id).leaseOwner).not.toBeNull();
    expect(received).toHaveLength(1);
    gate.resolve();
    expect(await bounded(late.promise)).toBe("AbortError");
    await channelSettled;
    expect(SessionHandleStore.row(row.id).leaseOwner).toBeNull();
    expect(
      SessionHandleStore.tree(row.id).some(
        (action) =>
          z.object({ op: z.literal("late-callback") }).safeParse(action.intent.value).success,
      ),
    ).toBe(false);
    expect(received).toHaveLength(1);
  } finally {
    gate.resolve();
  }
});

for (const door of ["current-run", "current-batch", "captured-run", "captured-batch", "captured-cell", "captured-wave"] as const) {
  test(`nested raw effects retain the lease through ${door} after caller interruption`, async () => {
    // Given: the review countercase, through the real app/SDK/SSE and file SQLite.
    const captured = Promise.withResolvers<ReturnType<typeof currentExecutor>>();
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const outerDone = Promise.withResolvers<void>();
    const parentSettled = Promise.withResolvers<void>();
    const wrapperSettled = Promise.withResolvers<string>();
    const directory = suite.tempDir("openomni-937-nested-effect-");
    const marker = join(directory, "effect.bin");
    const bytes = new Uint8Array([9, 3, 7]);
    const rawBody = async () => {
      entered.resolve();
      await gate.promise;
      writeFileSync(marker, bytes);
      completed.resolve();
      return "effect";
    };
    const request = { kind: "tool", op: "nested-effect", intent: {}, effect: {} };
    const isCurrent = door.startsWith("current-");
    let signal = new AbortController().signal;
    let sessionId = "";
    const invoke = async (executor: ReturnType<typeof currentExecutor>): Promise<string> => {
      try {
        switch (door) {
          case "current-run":
          case "captured-run":
            await executor.run(request, rawBody);
            return "executed";
          case "current-batch":
          case "captured-batch": {
            if (executor.runBatch === undefined) throw new Error("missing batch executor");
            const results = await executor.runBatch([{ request, body: rawBody }], { signal });
            return results.map((result) => result.terminal).join(",");
          }
          case "captured-cell":
          case "captured-wave": {
            const dispatcher = createDispatcher([waveTool("inner", rawBody)], { executor });
            const call = { id: "inner-call", tool: "inner", input: { slot: "inner" } };
            const context = { sessionId, turnId: "captured-turn", signal };
            if (door === "captured-cell") {
              await dispatcher.executeCell(call, context);
              return "executed";
            }
            const results = await dispatcher.executeWave([call], context);
            return results.every((result) => result.isError) ? "cancelled" : "executed";
          }
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return error.name;
      }
    };
    const { app, socket, received, cleanup } = await waveApp([
      waveTool("A", async () => "A", true),
      waveTool("outer", async (turnSignal) => {
        signal = turnSignal;
        const executor = currentExecutor();
        captured.resolve(executor);
        try {
          if (isCurrent) wrapperSettled.resolve(await invoke(currentExecutor()));
          else await outerDone.promise;
        } finally {
          parentSettled.resolve();
        }
        return "outer";
      }),
    ], ["A", "outer"]);
    const reply = nextMessage(socket, 5000);
    let handle: SessionHandle | undefined;
    let competitorFence: number | undefined;
    try {
      socket.send(JSON.stringify({ type: "message", text: "run nested effect" }));
      const executor = await bounded(captured.promise);
      const row = activeRow();
      sessionId = row.id;
      handle = app.sessions.get(row.id);
      if (handle === undefined) throw new Error("missing live SDK handle");
      if (!isCurrent) {
        // This continuation was registered outside both ambient execution scopes.
        expect(() => currentExecutor()).toThrow("executor context is required");
        void invoke(executor).then(wrapperSettled.resolve, wrapperSettled.reject);
      }
      await bounded(entered.promise);
      // When: interrupt returns and the parent unwinds while the raw effect is gated.
      if (isCurrent) await bounded(handle.interrupt());
      else {
        // Finish the top-level body first, so it cannot mask missing captured retention.
        const interrupted = Promise.withResolvers<void>();
        suite.defer(Bus.subscribe(LlmCall.Events.Completed, () => {
          if (received.length !== 2 || handle === undefined) return;
          void handle.interrupt().then(interrupted.resolve, interrupted.reject);
        }));
        outerDone.resolve();
        await bounded(interrupted.promise);
      }
      await bounded(parentSettled.promise);
      expect(await bounded(wrapperSettled.promise)).toBe(
        door === "captured-batch" || door === "captured-wave" ? "cancelled" : "AbortError",
      );
      expect(existsSync(marker)).toBe(false);
      expect(signal.aborted).toBe(true);
      expect(toolResults(row.id).filter((result) => result.callId.startsWith("call-")).map(
        (result) => [result.callId, result.terminal],
      )).toEqual([["call-A", "executed"], ["call-outer", isCurrent ? "cancelled" : "executed"]]);
      const held = SessionHandleStore.row(row.id);
      const now = Date.now();
      const competitor = SessionHandleStore.acquireLease({
        sessionId: row.id, owner: "nested-contender", expectedFence: held.leaseFence,
        now, expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
      });
      if (competitor.ok) competitorFence = competitor.fence;
      // Then: abort-raced wrapper settlement cannot transfer the live effect's lease.
      expect(competitor).toMatchObject({ ok: false });
      expect(held.leaseOwner).toBe(row.leaseOwner);
      const beforeActions = SessionHandleStore.tree(row.id).length;
      let staleBodyStarts = 0;
      const stale = () => executor.run(request, async () => { staleBodyStarts += 1; return null; });
      await expect(stale()).rejects.toMatchObject({ name: "SessionCommitError" });
      expect(staleBodyStarts).toBe(0);
      expect(SessionHandleStore.tree(row.id)).toHaveLength(beforeActions);
      gate.resolve();
      await bounded(completed.promise);
      // The channel's binding close joins retention before replying; SDK interrupt above does not.
      await reply;
      expect(readFileSync(marker)).toEqual(Buffer.from(bytes));
      const released = SessionHandleStore.row(row.id);
      expect(released.leaseOwner).toBeNull();
      const next = SessionHandleStore.acquireLease({
        sessionId: row.id, owner: "nested-contender", expectedFence: released.leaseFence,
        now: Date.now(), expiresAt: Date.now() + SessionHandleStore.LEASE_TTL_MS,
      });
      if (next.ok) competitorFence = next.fence;
      expect(next).toMatchObject({ ok: true, fence: row.leaseFence + 1 });
      await expect(stale()).rejects.toMatchObject({ name: "SessionCommitError" });
      expect(staleBodyStarts).toBe(0);
      expect(SessionHandleStore.tree(row.id)).toHaveLength(beforeActions);
      expect(received).toHaveLength(isCurrent ? 1 : 2);
    } finally {
      outerDone.resolve();
      gate.resolve();
      await bounded(completed.promise);
      await bounded(wrapperSettled.promise);
      await bounded(handle?.close() ?? Promise.resolve());
      if (competitorFence !== undefined) {
        const row = SessionHandleStore.row(sessionId);
        expect(SessionHandleStore.commit({
          sessionId, owner: "nested-contender", fence: competitorFence, now: Date.now(),
          expectedRevision: row.revision, actions: [], consumeInboxIds: [],
          state: row.state, releaseLease: true,
        }).ok).toBe(true);
      }
      await cleanup();
      expect(existsSync(directory)).toBe(false);
    }
  }, 15000);
}

for (const door of ["current-cell", "current-wave", "captured-cell", "captured-wave"] as const) {
  for (const rejects of [false, true]) {
    test(`timed ${door} retains the actual definition until ${rejects ? "rejection" : "fulfillment"}`, async () => {
      // Given: the review timeout countercase with a real file effect and actual app stack.
      const captured = Promise.withResolvers<ReturnType<typeof currentExecutor>>();
      const outerGate = Promise.withResolvers<void>();
      const rawGate = Promise.withResolvers<void>();
      const timedOut = Promise.withResolvers<void>();
      const rawDone = Promise.withResolvers<void>();
      const wrapper = Promise.withResolvers<readonly { readonly isError?: boolean }[]>();
      const directory = suite.tempDir("openomni-937-timed-effect-");
      const marker = join(directory, "effect.bin");
      const current = door.startsWith("current-");
      let rawStarted = false;
      let sessionId = "";
      const inner = waveTool("inner", async (signal) => {
        signal.addEventListener("abort", () => timedOut.resolve(), { once: true });
        rawStarted = true;
        await rawGate.promise;
        writeFileSync(marker, new Uint8Array([9, 3, 7]));
        rawDone.resolve();
        if (rejects) throw new Error("raw effect rejected");
        return "effect";
      });
      const dispatch = (executor?: ReturnType<typeof currentExecutor>) => {
        // The current door resolves its executor from the enclosing tool scope.
        const dispatcher = createDispatcher([inner], {
          executor: executor ?? currentExecutor(), timeoutMs: 0,
        });
        const call = { id: "timed-inner", tool: "inner", input: { slot: "inner" } };
        const context = { sessionId, turnId: "timed-turn", signal: new AbortController().signal };
        return door.endsWith("cell")
          ? dispatcher.executeCell(call, context).then((result) => [result])
          : dispatcher.executeWave([call], context);
      };
      const { app, socket, received, dbPath, cleanup } = await waveApp([
        waveTool("A", async () => "A", true),
        waveTool("outer", async () => {
          captured.resolve(currentExecutor());
          await outerGate.promise;
          if (current) wrapper.resolve(await dispatch());
          return "outer";
        }),
      ], ["A", "outer"]);
      const reply = nextMessage(socket, 5000);
      let handle: SessionHandle | undefined;
      let competitorFence: number | undefined;
      try {
        socket.send(JSON.stringify({ type: "message", text: "run timed nested effect" }));
        const executor = await bounded(captured.promise);
        const row = activeRow();
        sessionId = row.id;
        handle = app.sessions.get(sessionId);
        if (handle === undefined) throw new Error("missing SDK handle");
        const interrupted = Promise.withResolvers<void>();
        suite.defer(Bus.subscribe(LlmCall.Events.Completed, () => {
          if (received.length !== 2 || handle === undefined) return;
          void handle.interrupt().then(interrupted.resolve, interrupted.reject);
        }));
        if (current) outerGate.resolve();
        else {
          expect(() => currentExecutor()).toThrow("executor context is required");
          void dispatch(executor).then(wrapper.resolve, wrapper.reject);
        }
        // When: the real zero-duration timeout releases the wrapper, not the definition.
        await bounded(timedOut.promise);
        expect((await bounded(wrapper.promise)).map((result) => result.isError)).toEqual([true]);
        outerGate.resolve();
        await bounded(interrupted.promise);
        expect(existsSync(marker)).toBe(false);
        expect(toolResults(sessionId).map((result) => [result.callId, result.terminal])).toEqual([
          ["timed-inner", "executed"], ["call-A", "executed"], ["call-outer", "executed"],
        ]);
        const held = SessionHandleStore.row(sessionId);
        const contender = SessionHandleStore.acquireLease({
          sessionId, owner: "timed-contender", expectedFence: held.leaseFence,
          now: Date.now(), expiresAt: Date.now() + SessionHandleStore.LEASE_TTL_MS,
        });
        if (contender.ok) competitorFence = contender.fence;
        // Then: neither timeout nor SDK interruption transfers the live effect's lease.
        expect(contender).toMatchObject({ ok: false });
        expect(held.leaseOwner).toBe(row.leaseOwner);
        const beforeActions = SessionHandleStore.tree(sessionId).length;
        const db = new Database(dbPath, { readonly: true });
        try {
          expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM action").get()?.count)
            .toBe(beforeActions);
        } finally { db.close(); }
        let staleStarts = 0;
        const stale = () => executor.run({ kind: "tool", op: "stale", intent: {}, effect: {} }, async () => {
          staleStarts += 1;
          return null;
        });
        await expect(stale()).rejects.toMatchObject({ name: "SessionCommitError" });
        rawGate.resolve();
        await bounded(rawDone.promise);
        await reply;
        expect(readFileSync(marker)).toEqual(Buffer.from([9, 3, 7]));
        const released = SessionHandleStore.row(sessionId);
        expect(released.leaseOwner).toBeNull();
        const next = SessionHandleStore.acquireLease({
          sessionId, owner: "timed-contender", expectedFence: released.leaseFence,
          now: Date.now(), expiresAt: Date.now() + SessionHandleStore.LEASE_TTL_MS,
        });
        if (next.ok) competitorFence = next.fence;
        expect(next).toMatchObject({ ok: true, fence: row.leaseFence + 1 });
        await expect(stale()).rejects.toMatchObject({ name: "SessionCommitError" });
        expect(staleStarts).toBe(0);
        expect(SessionHandleStore.tree(sessionId)).toHaveLength(beforeActions);
        expect(received).toHaveLength(2);
      } finally {
        outerGate.resolve();
        rawGate.resolve();
        if (rawStarted) await bounded(rawDone.promise);
        await reply;
        await bounded(handle?.close() ?? Promise.resolve());
        if (competitorFence !== undefined) {
          const row = SessionHandleStore.row(sessionId);
          expect(SessionHandleStore.commit({
            sessionId, owner: "timed-contender", fence: competitorFence, now: Date.now(),
            expectedRevision: row.revision, actions: [], consumeInboxIds: [],
            state: row.state, releaseLease: true,
          }).ok).toBe(true);
        }
        await cleanup();
        expect(existsSync(directory)).toBe(false);
      }
    }, 15000);
  }
}

test("approval-time prompts retain durable identities and enter the next model separately in order", async () => {
  // Given: a real model invocation suspended on its original B approval.
  const { app, socket, received } = await waveApp([waveTool("B", async () => "B")], ["B"]);
  requireBApproval();
  const waiting = nextApproval(app);
  const response = nextMessage(socket, 5000);
  socket.send(JSON.stringify({ type: "message", text: "initial" }));
  const { handle, request } = await bounded(waiting);
  // When: two SDK prompts arrive while the wave is held, before any next boundary.
  const first = handle.prompt("first continuation");
  const second = handle.prompt("second continuation");
  const prompts = SessionHandleStore.inboxRows(handle.id).filter((row) => row.kind === "prompt");
  expect(prompts.map((row) => row.status)).toEqual(["consumed", "pending", "pending"]);
  expect(received).toHaveLength(1);
  await handle.approvals.answer({ request, decision: "approve", credential: "wave-token" });
  await bounded(Promise.all([first, second, response]));
  // Then: canonical next-model admission names the original ordered prompt IDs.
  const modelIntent = z.object({
    phase: z.literal("intent"),
    op: z.literal("chat"),
    value: z.object({ messageIds: z.array(z.string()) }),
  });
  const inputs = SessionHandleStore.tree(handle.id)
    .filter((action) => action.kind === "llm")
    .flatMap((action) => {
      const parsed = modelIntent.safeParse(action.intent.value);
      return parsed.success ? [parsed.data.value.messageIds] : [];
    });
  expect(inputs).toHaveLength(2);
  const promptIds = prompts.map((row) => row.id);
  const [initialId, firstId, secondId] = promptIds;
  if (initialId === undefined || firstId === undefined || secondId === undefined)
    throw new Error("missing prompt IDs");
  expect(inputs[0]).toEqual([initialId]);
  expect(inputs[1]?.filter((id) => promptIds.includes(id))).toEqual(promptIds);
  const delivered = SessionHandleStore.tree(handle.id).flatMap((action) => {
    const delivery = SessionHandleStore.delivery(action);
    return delivery?.kind === "prompt" ? [delivery] : [];
  });
  expect(delivered.slice(1).map((delivery) => [delivery.inboxId, delivery.boundary])).toEqual([
    [firstId, "after_tools"],
    [secondId, "after_tools"],
  ]);
  expect(received).toHaveLength(2);
});

test("an exact approval deadline refuses only B and cannot grant late authority", async () => {
  let now = 100;
  let expire: (() => void) | undefined;
  const scheduled = Promise.withResolvers<void>();
  const started: string[] = [];
  const { app, socket } = await waveApp(
    ["A", "B", "C"].map((name) =>
      waveTool(name, async () => {
        started.push(name);
        return name;
      }),
    ),
    ["A", "B", "C"],
    {
      clock: () => now,
      approvalTimeoutMs: 1,
      scheduleApprovalTimeout(callback) {
        expire = callback;
        scheduled.resolve();
        return () => {
          expire = undefined;
        };
      },
    },
  );
  requireBApproval();
  const waiting = nextApproval(app);
  const response = nextMessage(socket, 5000);
  socket.send(JSON.stringify({ type: "message", text: "deadline wave" }));
  const { handle, request } = await bounded(waiting);
  try {
    expect(request.expiresAt).toBe(101);
    expect(started).toEqual([]);
    await bounded(scheduled.promise);
    now = 101;
    if (expire === undefined) throw new Error("missing deadline registration");
    expire();
    await response;
    expect(started).toEqual(["A", "C"]);
    expect(toolResults(handle.id).map((result) => [result.callId, result.terminal])).toEqual([
      ["call-A", "executed"],
      ["call-B", "blocked_pre"],
      ["call-C", "executed"],
    ]);
    await expect(
      handle.approvals.answer({ request, decision: "approve", credential: "wave-token" }),
    ).rejects.toMatchObject({ code: "stale_approval" });
  } finally {
    if (handle.approvals.pending().length > 0) await handle.interrupt();
  }
});

test("a durable after-model inbox interrupt drains before tools without an eager local signal", async () => {
  let bodies = 0;
  const { socket, received } = await waveApp(
    [
      waveTool("A", async () => {
        bodies += 1;
        return "A";
      }),
    ],
    ["A"],
  );
  let queued = false;
  suite.defer(
    Bus.subscribe(LlmCall.Events.Completed, (event) => {
      if (queued) return;
      queued = true;
      // Cross-process control arrives through the public durable inbox, not the local AbortController.
      SessionHandleStore.commitInbox({
        id: "after-model-interrupt",
        sessionId: event.sessionId,
        kind: "interrupt",
        content: "",
        createdAt: Date.now(),
        origin: { encodingVersion: 1, value: { kind: "sdk" } },
        parentActionId: SessionHandleStore.tree(event.sessionId).at(-1)?.id ?? null,
      });
    }),
  );
  const response = nextMessage(socket, 5000);
  socket.send(JSON.stringify({ type: "message", text: "interrupt at the drain" }));
  await response;
  expect(bodies).toBe(0);
  expect(received).toHaveLength(1);
  const deliveries = SessionHandleStore.tree(activeRow().id).flatMap((action) => {
    const delivery = SessionHandleStore.delivery(action);
    return delivery?.kind === "interrupt" ? [delivery] : [];
  });
  expect(deliveries).toMatchObject([{ inboxId: "after-model-interrupt", boundary: "after_llm" }]);
});

test("an interrupt after wave results drains before another provider step", async () => {
  const { socket, received } = await waveApp([waveTool("A", async () => "A")], ["A"]);
  suite.defer(
    Bus.subscribe(Tool.Events.Completed, (event) => {
      SessionHandleStore.commitInbox({
        id: "after-wave-interrupt",
        sessionId: event.sessionId,
        kind: "interrupt",
        content: "",
        createdAt: Date.now(),
        origin: { encodingVersion: 1, value: { kind: "sdk" } },
        parentActionId: SessionHandleStore.tree(event.sessionId).at(-1)?.id ?? null,
      });
    }),
  );
  const response = nextMessage(socket, 5000);
  socket.send(JSON.stringify({ type: "message", text: "stop after A" }));
  await response;
  expect(received).toHaveLength(1);
  expect(toolResults(activeRow().id)).toMatchObject([{ callId: "call-A", terminal: "executed" }]);
  const deliveries = SessionHandleStore.tree(activeRow().id).flatMap((action) => {
    const delivery = SessionHandleStore.delivery(action);
    return delivery?.kind === "interrupt" ? [delivery] : [];
  });
  expect(deliveries).toMatchObject([{ inboxId: "after-wave-interrupt", boundary: "after_tools" }]);
});
