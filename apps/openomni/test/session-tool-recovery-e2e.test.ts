import { Effect } from "effect";
import { generationServices } from "./helpers/generation-services";
import { observationService } from "../../../packages/agent/test/helpers/service-layers";
import { beforeEach, expect, test } from "bun:test";
import { acquireEffect, runEffect } from "./helpers/effect";
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

import { contentBlocks, messageStart, messageEnd, sseResponse } from "./helpers/anthropic-sse";
import { bounded, commitInterrupt, ProviderRequest as Request } from "./helpers/session-wave";

beforeEach(() => Storage.reset());

function response(names: readonly string[]): Response {
  const blocks =
    names.length > 0
      ? names.map((name) => ({
          start: { type: "tool_use", id: `call-${name}`, name, input: {} },
          delta: { type: "input_json_delta", partial_json: JSON.stringify({ slot: name }) },
        }))
      : [{ start: { type: "text", text: "" }, delta: { type: "text_delta", text: "finished" } }];
  const frames = [
    messageStart(crypto.randomUUID(), "claude-opus-4-5", 10),
    ...contentBlocks(blocks),
    ...messageEnd(names.length > 0 ? "tool_use" : "end_turn", 2),
  ];
  return sseResponse(frames);
}

// The second slot of a two-tool wave that never completed: a lost process is
// settled from evidence as outcome_unknown, never dressed up as a cancel.
const lostSlot = {
  "partial-wave": "Error: fiber_interrupted",
  "crash-window": "Error: B outcome unknown: the process was lost before a result was recorded",
  "after-wave": "Error: tool execution cancelled",
  "error-window": "Error: tool execution cancelled",
} as const;

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
    let saved = false;
    const interruptInbox = () => commitInterrupt(sessionId, `interrupt-${mode}`);
    const runtime: SessionRuntime = {};
    const observations = observationService({
        publish(event, payload) {
          Bus.publish(event, payload);
          if (mode === "crash-window" && event === L0Observation.ActionCommittedEvent && !saved) {
            const committed = L0Observation.ActionCommittedEvent.schema.parse(payload);
            const action = SessionHandleStore.tree(sessionId).find(
              (node) => node.id === committed.id,
            );
            if (
              action?.kind === "tool" &&
              z
                .object({ terminal: z.literal("executed"), callId: z.literal("call-A") })
                .safeParse(action.effect.value).success
            ) {
              // Snapshot synchronously at commit, before the next native Effect result.
              // Bus subscriptions are observational microtasks, not commit barriers.
              const db = new Database(dbPath, { readonly: true });
              try {
                writeFileSync(crashPath, db.serialize());
              } finally {
                db.close();
              }
              saved = true;
              interruptInbox();
            }
          }
          if (mode === "error-window" && event === Tool.Events.Completed)
            throw new Error("crash after committed result");
        },
    });
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
        return Effect.gen(function* () {
        const dispatcher = yield* createTurnDispatcher(input, runtime);
        return {
          traceContext: { traceId: "recovery", sessionId, runId: input.resultId },
          config: {
            executor: dispatcher.executor,
            tools: [...dispatcher.specs],
            toolWave: (calls, signal) =>
              dispatcher.executeWave(calls, { sessionId, turnId: input.turnId, signal }),
            model: { provider: "anthropic", id: "claude-opus-4-5" },
            auth: { type: "api", key: "recovery-key" },
            transport: { baseUrl: `http://127.0.0.1:${provider.port}/v1` },
          },
        };
        });
      },
    });
    let services = await acquireEffect(generationServices({ definitions: { resident: definitions, worker: [] }, observations }));
    let unsubscribe: () => void = () => undefined;
    try {
      initialize({ dbPath, observationSink: observations });
      seedKernelPolicyRows();
      const handle = await acquireEffect(
        session(
          { id: sessionId, role: "resident", runner, tools: definitions.map(sessionTool) },
          runtime,
        ).pipe(Effect.provide(services)),
      );
      unsubscribe = Bus.subscribe(Tool.Events.Completed, (event) => {
        if (
          event.sessionId !== sessionId ||
          mode === "partial-wave" ||
          mode === "crash-window" ||
          mode === "error-window"
        )
          return;
        interruptInbox();
      });
      const first = runEffect(handle.prompt("execute each slot once"));
      if (mode === "partial-wave") {
        await bounded(enteredB.promise);
        await bounded(runEffect(handle.interrupt()));
      }
      expect((await bounded(first))?.kind).toBe(mode === "error-window" ? "result" : "interrupted");
      unsubscribe();
      expect(requests).toHaveLength(mode === "error-window" ? 2 : 1);
      let prefix = SessionHandleStore.tree(sessionId);
      if (mode === "crash-window") {
        expect(saved).toBe(true);
        await runEffect(closeSessions(runtime).pipe(Effect.provide(services)));
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
        services = await acquireEffect(generationServices({ definitions: { resident: definitions, worker: [] }, clock: () => expiresAt + 1 }));
        await bounded(acquireEffect(sweepSessions(() => runner, runtime).pipe(Effect.provide(services))));
      } else if (mode !== "error-window") {
        await bounded(runEffect(handle.resume()));
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
        expect(results?.[1]).toMatchObject({ tool_use_id: "call-B", content: lostSlot[mode] });
      expect(requests).toHaveLength(2);
      expect(bodies).toEqual(names);
    } finally {
      unsubscribe();
      await runEffect(closeSessions(runtime).pipe(Effect.provide(services)));
      await provider.stop(true);
      Storage.reset();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
}
