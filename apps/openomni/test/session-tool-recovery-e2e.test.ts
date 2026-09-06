import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Bus,
  closeSessions,
  createSessionChatRunner,
  createTurnDispatcher,
  defineTool,
  eraseTool,
  session,
  sessionTool,
  sweepSessions,
  type SessionRuntime,
} from "@openomni/agent";
import { initialize, SessionHandleStore, Storage } from "@openomni/ledger";
import { L0Observation, Tool } from "@openomni/protocol";
import { z } from "zod";
import { seedKernelPolicyRows } from "../src/policy-seed";

const Request = z.object({
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

function response(names: readonly string[]): Response {
  const blocks =
    names.length > 0
      ? names.map((name) => ({
          start: { type: "tool_use", id: `call-${name}`, name, input: {} },
          delta: { type: "input_json_delta", partial_json: JSON.stringify({ slot: name }) },
        }))
      : [{ start: { type: "text", text: "" }, delta: { type: "text_delta", text: "finished" } }];
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
      delta: { stop_reason: names.length > 0 ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("tool recovery event deadline")), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
}

for (const mode of ["after-wave", "partial-wave", "crash-window", "error-window"] as const) {
  test(`real SDK ${mode} preserves committed rendered tool slots without replay`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "937-tool-recovery-"));
    const dbPath = join(directory, "live.sqlite");
    const crashPath = join(directory, "crash.sqlite");
    const sessionId = `tool-recovery-${mode}`;
    const names = mode === "partial-wave" || mode === "crash-window" ? ["A", "B"] : ["A"];
    const bodies: string[] = [];
    const requests: z.infer<typeof Request>[] = [];
    const enteredB = Promise.withResolvers<void>();
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push(Request.parse(await request.json()));
        return response(requests.length === 1 ? names : []);
      },
    });
    let runtime: SessionRuntime = {
      observations: {
        publish(event, payload) {
          Bus.publish(event, payload);
          if (mode === "error-window" && event === Tool.Events.Completed)
            throw new Error("crash after committed result");
        },
      },
    };
    const definitions = names.map((name) =>
      eraseTool(
        defineTool({
          name,
          description: `recover ${name}`,
          category: "query",
          visibility: { model: ["resident"], cell: [] },
          input: z.object({ slot: z.literal(name) }),
          output: z.object({ value: z.string() }),
          ...(name === "B" ? { sequential: true as const } : {}),
          async execute(_input, context) {
            bodies.push(name);
            if (mode === "partial-wave" && name === "B") {
              const aborted = new Promise<never>((_resolve, reject) => {
                context.signal.addEventListener(
                  "abort",
                  () => reject(new DOMException("cancelled", "AbortError")),
                  { once: true },
                );
              });
              enteredB.resolve();
              return aborted;
            }
            return { value: name };
          },
          render: (_input, output) => `ACTUAL_COMPLETED_RESULT:${output.value}`,
        }),
      ),
    );
    const runner = createSessionChatRunner({
      prepare(input) {
        const dispatcher = createTurnDispatcher(definitions, input, runtime);
        return {
          traceContext: { traceId: "recovery", sessionId, runId: input.resultId },
          config: {
            events: Bus,
            executor: dispatcher.executor,
            tools: [...dispatcher.specs],
            toolWave: (calls, signal) =>
              dispatcher.executeWave(calls, { sessionId, turnId: input.turnId, signal }),
            model: { provider: "anthropic", id: "claude-opus-4-5" },
            auth: { type: "api", key: "recovery-key" },
            transport: { baseUrl: `http://127.0.0.1:${provider.port}/v1` },
          },
        };
      },
    });
    let unsubscribe: () => void = () => undefined;
    try {
      initialize({ dbPath });
      seedKernelPolicyRows();
      const handle = session(
        { id: sessionId, role: "resident", runner, tools: definitions.map(sessionTool) },
        runtime,
      );
      const interruptInbox = () =>
        SessionHandleStore.commitInbox({
          id: `interrupt-${mode}`,
          sessionId,
          kind: "interrupt",
          content: "",
          createdAt: Date.now(),
          origin: { encodingVersion: 1, value: { kind: "sdk" } },
          parentActionId: SessionHandleStore.tree(sessionId).at(-1)?.id ?? null,
        });
      let saved = false;
      unsubscribe =
        mode === "crash-window"
          ? Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
              if (event.sessionId !== sessionId || saved) return;
              const action = SessionHandleStore.tree(sessionId).find(
                (node) => node.id === event.id,
              );
              if (
                !z
                  .object({ terminal: z.literal("executed"), callId: z.literal("call-A") })
                  .safeParse(action?.effect.value).success
              )
                return;
              // A consistent file-SQLite image of the exact committed prefix, before the
              // next positional result or assistant snapshot. No synthetic action repair.
              const db = new Database(dbPath, { readonly: true });
              try {
                writeFileSync(crashPath, db.serialize());
              } finally {
                db.close();
              }
              saved = true;
              interruptInbox();
            })
          : Bus.subscribe(Tool.Events.Completed, (event) => {
              if (
                event.sessionId !== sessionId ||
                mode === "partial-wave" ||
                mode === "error-window"
              )
                return;
              interruptInbox();
            });
      const first = handle.prompt("execute each slot once");
      if (mode === "partial-wave") {
        await bounded(enteredB.promise);
        await bounded(handle.interrupt());
      }
      expect((await bounded(first))?.kind).toBe(mode === "error-window" ? "error" : "interrupted");
      unsubscribe();
      expect(requests).toHaveLength(1);
      let prefix = SessionHandleStore.tree(sessionId);
      if (mode === "crash-window") {
        expect(saved).toBe(true);
        await closeSessions(runtime);
        Storage.reset();
        initialize({ dbPath: crashPath });
        prefix = SessionHandleStore.tree(sessionId);
        expect(SessionHandleStore.openTurns(prefix)).toHaveLength(1);
        expect(
          prefix.filter(
            (action) =>
              action.kind === "message" &&
              z.object({ terminal: z.literal("executed") }).safeParse(action.effect.value).success,
          ),
        ).toHaveLength(1);
        const expiresAt = SessionHandleStore.row(sessionId).leaseExpiresAt;
        if (expiresAt === null) throw new Error("missing crash lease");
        runtime = { observations: Bus, clock: () => expiresAt + 1 };
        await bounded(sweepSessions(() => runner, runtime));
      } else if (mode === "error-window") {
        await bounded(handle.prompt("continue without replay"));
      } else {
        await bounded(handle.resume());
      }
      expect(SessionHandleStore.tree(sessionId).slice(0, prefix.length)).toEqual(prefix);
      const results = requests[1]?.messages.flatMap((message) =>
        typeof message.content === "string"
          ? []
          : message.content.filter((part) => part.type === "tool_result"),
      );
      console.log("937 R1", JSON.stringify({ mode, bodies, results }));
      expect(results?.[0]).toMatchObject({
        tool_use_id: "call-A",
        content: "ACTUAL_COMPLETED_RESULT:A",
      });
      if (names.length === 2)
        expect(results?.[1]).toMatchObject({
          tool_use_id: "call-B",
          content: "Error: tool execution cancelled",
        });
      expect(requests).toHaveLength(2);
      expect(bodies).toEqual(names);
    } finally {
      unsubscribe();
      await closeSessions(runtime);
      await provider.stop(true);
      Storage.reset();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
}
