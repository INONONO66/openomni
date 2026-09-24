import { sessionTree } from "../../ledger/test/helpers/session-tree";
import { turnTestLayer, catalogLayer } from "./helpers/service-layers";
import { allowConfigure, type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices } from "./helpers/session-services";
import { Effect, Fiber } from "effect";
import type { ResolvedExecutorOptions } from "../src/executor-contract";
import { isolated } from "./helpers/isolated";
import { expect, it } from "bun:test";
import { seedPolicy } from "./helpers/seed-policy";
import { Storage, SessionHandleStore } from "@openomni/ledger";
import type { SessionTransition } from "@openomni/protocol";
import { session, closeSessions } from "../src/session-handle";
import { createTurnDispatcher, eraseTool, sessionTool } from "../src/tool-dispatcher";
import { valueTool } from "./helpers/query-tool";
import { createSessionRequests } from "../src/session-requests";
import { suspendedRequest, failure } from "./helpers/effect-g2";

let runtime: SessionRuntime;
function setup() {
  return Effect.gen(function* () {
    let now = 100;
    const suspended = Promise.withResolvers<void>();
    const effects: string[] = [];
    runtime = {
      authorizeConfigure: allowConfigure,
      clock: () => now,
      entropy: () => crypto.randomUUID(),
      observations: {
        publish: () => {
          if (
            SessionHandleStore.requestRows("controller").some(
              (request: import("@openomni/protocol").SessionTransition.Request) =>
                request.state === "open",
            )
          )
            suspended.resolve();
        },
      },
      scheduleHeartbeat: () => () => undefined,
    };
    const tool = eraseTool(
      valueTool({
        name: "protected",
        category: "mutation",
        execute: async (value: string) => {
          effects.push(value);
          return value;
        },
        approval: () => ({ required: true, domainRevisions: {} }),
      }),
    );
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:", observationSink: runtime.observations });
    seedPolicy();
    yield* Effect.addFinalizer(() => closeSessions(runtime).pipe(Effect.orDie));
    const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({
        id: "controller",
        role: "resident",
        tools: [sessionTool(tool)],
        runner: (input: import("../src/session-handle").SessionRunnerInput) =>
          Effect.gen(function* () {
            const dispatcher = (yield* Effect.gen(function* () { const turnInput: Parameters<typeof createTurnDispatcher>[0] & { readonly policy?: ResolvedExecutorOptions["policy"] } = input; const turnRuntime: Parameters<typeof createTurnDispatcher>[1] & Partial<Pick<ResolvedExecutorOptions, "clock" | "entropy" | "observations">> = runtime; return yield* createTurnDispatcher(turnInput, turnRuntime).pipe(Effect.provide(catalogLayer([tool])), Effect.provide(turnTestLayer(turnInput, turnRuntime))); }));
            yield* dispatcher.execute(
              { id: "original", tool: tool.name, input: { value: "original" } },
              { sessionId: input.sessionId, turnId: input.turnId, signal: input.signal },
            );
            return { kind: "result", text: "done" };
          }),
      }, fixture), fixture); });
    return {
      handle,
      effects,
      suspended: suspended.promise,
      setClock(at: number) {
        now = at;
      },
    };
  });
}
function answer(request: SessionTransition.Request): SessionTransition.Answer {
  return {
    inputId: "authenticated-answer",
    requestId: request.requestId,
    sessionId: request.sessionId,
    receivedAt: 100,
    principal: { kind: "owner", principalId: "owner", evidenceId: "auth" },
    bindingDigest: request.bindingDigest,
    inputHash: request.inputHash,
    effectHash: request.effectHash,
    generation: request.generation,
    toolsHash: request.toolsHash,
    domainRevisions: request.domainRevisions,
    decision: "approve",
    allowedAction: "report_result",
    content: "yes",
  };
}
it("the injected gateway port uses the live controller's fence and releases the original call", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup();
        const { running, request, fence } = yield* suspendedRequest(f.handle, f.suspended);
        expect(f.effects).toEqual([]);
        expect(yield* (yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(createSessionRequests(fixture), fixture); })).answer(answer(request))).toBe("resolved");
        yield* Fiber.join(running);
        expect(f.effects).toEqual(["original"]);
        expect(SessionHandleStore.row(f.handle.id).leaseFence).toBe(fence);
        expect(SessionHandleStore.requestById(request.requestId)?.state).toBe("resolved");
      }),
    ),
  ));
it("configuration drift refuses consent while interruption cancels the whole suspended call", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup();
        const { running, request } = yield* suspendedRequest(f.handle, f.suspended);
        yield* f.handle.system.blocks.set([{ id: "new", source: "owner", content: "changed" }]);
        expect(yield* (yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(createSessionRequests(fixture), fixture); })).answer(answer(request))).toBe("rejected");
        expect(f.effects).toEqual([]);
        yield* f.handle.interrupt();
        yield* Fiber.join(running);
        expect(SessionHandleStore.requestById(request.requestId)?.state).toBe("cancelled");
        expect(
          sessionTree(f.handle.id).some(
            (action: import("@openomni/protocol").LedgerAction.Node) => {
              const effect = action.effect.value;
              return (
                action.kind === "tool" &&
                action.parentId === request.requestId &&
                effect !== null &&
                typeof effect === "object" &&
                !Array.isArray(effect) &&
                effect.terminal === "blocked_pre" &&
                effect.reason === "approval_refused"
              );
            },
          ),
        ).toBe(true);
        expect(f.effects).toEqual([]);
      }),
    ),
  ));
it("does not reacquire an expired lease under a still-live suspended runner", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* setup();
        const { settled, request, fence } = yield* suspendedRequest(f.handle, f.suspended);
        f.setClock(40_000);
        expect(
          yield* failure((yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(createSessionRequests(fixture), fixture); })).answer(answer(request))),
        ).toMatchObject({
          _tag: "CommitFailed",
          error: { _tag: "LeaseRefused", reason: "stale" },
        });
        expect(SessionHandleStore.row(f.handle.id).leaseFence).toBe(fence);
        expect(f.effects).toEqual([]);
        yield* f.handle.close();
        yield* settled;
      }),
    ),
  ));
