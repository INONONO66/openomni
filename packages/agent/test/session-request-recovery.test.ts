import { sessionTree } from "../../ledger/test/helpers/session-tree";
import { allowConfigure, type SessionFixture, withSessionServices } from "./helpers/session-services";
import { Effect, Fiber } from "effect";
import { isolated } from "./helpers/isolated";
import { ForeignFailure } from "../src/errors";
import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage, SessionHandleStore } from "@openomni/ledger";
import type { LedgerAction, PlainValue, SessionTransition } from "@openomni/protocol";
import { z } from "zod";
import { createTurnDispatcher, defineTool, eraseTool } from "../src/tool-dispatcher";
import { createSessionRequests } from "../src/session-requests";
import { compiledPolicy } from "./helpers/compiled-policy";
import { requestLedger, crashAfterRequestOpen, failure, type RequestLedger } from "./helpers/effect-g1";
import { bounded } from "./helpers/bounded";
import { catalogLayer, executorLayer } from "./helpers/service-layers";
import { fileRequest, planeAnswer, requestPlane } from "./helpers/session-request-plane";
import type { RunnerServices } from "../src/services";

function persisted<A, E>(program: (dbPath: string) => Effect.Effect<A, E, import("effect").Scope.Scope | RunnerServices>) {
  return isolated(Effect.scoped(Effect.gen(function* () {
    const directory = mkdtempSync(join(tmpdir(), "request-recovery-"));
    const dbPath = join(directory, "ledger.sqlite");
    Storage.reset();
    Storage.initialize({ dbPath });
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      Storage.reset();
      rmSync(directory, { recursive: true, force: true });
    }));
    return yield* program(dbPath);
  })));
}
const proof = { kind: "owner", principalId: "owner", evidenceId: "authenticated" } as const;
function definitions(bodies: string[]) {
  return ["read", "write", "last"].map((name: string) =>
    eraseTool(
      defineTool(
        {
          name,
          category: "mutation",
          description: name,
          input: z.object({ text: z.string() }).strict(),
          output: z.object({ value: z.string() }).strict(),
          visibility: { model: ["resident"], cell: ["resident"] },
          ...(name === "last" ? { sequential: true as const } : {}),
          execute: async (input: { text: string }) => {
            bodies.push(`${name}:${input.text}`);
            return { value: input.text };
          },
          render: (_input: { text: string }, result: { value: string }) => result.value,
        },
        () => ({ required: name === "write", domainRevisions: {} }),
      ),
    ),
  );
}
const calls = ["read", "write", "last"].map((tool: string) => ({
  id: `call:${tool}`,
  tool,
  input: { text: `original:${tool}` },
}));
function dispatcher(
  recording: RequestLedger,
  bodies: string[],
  ready?: () => void,
) {
  return Effect.gen(function* () {
  const result: Effect.Effect.Success<ReturnType<typeof createTurnDispatcher>> = yield* createTurnDispatcher(
    {
      ...recording.identity,
      ledger: {
        ...recording.ledger,
        requestById: (id) => {
          if ((result.executor.approvals?.pending().length ?? 0) > 0) ready?.();
          return recording.ledger.requestById?.(id);
        },
      },
      actionId: recording.identity.parentActionId,
    },
    {
      authorizeApproval: () => Effect.succeed(proof),
    },
  ).pipe(Effect.provide(catalogLayer(definitions(bodies))), Effect.provide(executorLayer({
    clock: recording.clock, entropy: recording.entropy, observations: { publish: () => undefined }, policy: compiledPolicy(),
  })));
  return result;
  });
}
function currentRequest(): SessionTransition.Request {
  const request = SessionHandleStore.requestRows()[0];
  if (request === undefined) throw new Error("missing durable request");
  return request;
}
function ownerAnswer(request: SessionTransition.Request): SessionTransition.Answer {
  return {
    inputId: "answer",
    requestId: request.requestId,
    sessionId: request.sessionId,
    receivedAt: 200,
    principal: proof,
    bindingDigest: request.bindingDigest,
    inputHash: request.inputHash,
    effectHash: request.effectHash,
    generation: request.generation,
    toolsHash: request.toolsHash,
    domainRevisions: request.domainRevisions,
    decision: "approve",
    allowedAction: "report_result",
    content: "approve",
  };
}
it("reopens SQLite and resumes the exact original wave without a model reconstruction", () => persisted((dbPath: string) => Effect.gen(function* () {
  const bodies: string[] = [];
  const initial = yield* requestLedger();
  const crashed = yield* dispatcher(
    crashAfterRequestOpen(initial, "process lost after durable suspension"),
    bodies,
  );
  expect(yield* failure(
    crashed.executeWave(calls, { sessionId: initial.identity.sessionId, turnId: "turn" }),
  )).toMatchObject({ _tag: "ForeignFailure", operation: "process lost after durable suspension" });
  const originalId = currentRequest().requestId;
  expect(bodies).toEqual([]);
  Storage.reset();
  Storage.initialize({ dbPath });
  const ready = Promise.withResolvers<void>();
  const recovered = yield* dispatcher(yield* requestLedger(), bodies, ready.resolve);
  const recovery = recovered.executor.recover?.();
  if (recovery === undefined) throw new Error("missing recovery");
  const recovering = yield* Effect.forkScoped(recovery);
  yield* Effect.promise(() => bounded(ready.promise));
  const approvals = recovered.executor.approvals;
  const pending = approvals?.pending()[0];
  if (approvals === undefined || pending === undefined) throw new Error("missing recovered approval");
  expect(pending.id).toBe(originalId);
  expect(pending.durable.parsedInput).toEqual({ text: "original:write" });
  yield* approvals.answer({
    request: pending,
    credential: "proof",
    decision: "approve",
  });
  yield* Fiber.join(recovering);
  expect(bodies).toEqual(["read:original:read", "write:original:write", "last:original:last"]);
  yield* recovered.executor.recover();
  expect(bodies).toHaveLength(3);
  expect(
    sessionTree(initial.identity.sessionId).filter(
      (action: LedgerAction.Node) => action.id === `${originalId}:application`,
    ),
  ).toHaveLength(1);
})));
it("a committed application claim prevents replay after result persistence fails", () => persisted((dbPath: string) => Effect.gen(function* () {
  const bodies: string[] = [];
  const ready = Promise.withResolvers<void>();
  const initial = yield* requestLedger();
  const commit = initial.ledger.commit;
  const crashed = yield* dispatcher(
    {
      ...initial,
      ledger: {
        ...initial.ledger,
        commit(action: LedgerAction.Append) {
          const effect = action.effect.value;
          if (
            action.kind === "tool" &&
            effect !== null &&
            typeof effect === "object" &&
            !Array.isArray(effect) &&
            effect.phase === "result"
          )
            return Effect.die(new ForeignFailure({ operation: "result.persist", cause: "crash" }));
          return commit(action);
        },
      },
    },
    bodies,
    ready.resolve,
  );
  const running = crashed.executeWave(calls, {
    sessionId: initial.identity.sessionId,
    turnId: "turn",
  });
  const settled = yield* Effect.forkScoped(failure(running));
  yield* Effect.promise(() => bounded(ready.promise));
  const approvals = crashed.executor.approvals;
  const pending = approvals?.pending()[0];
  if (approvals === undefined || pending === undefined) throw new Error("missing approval");
  yield* approvals.answer({
    request: pending,
    credential: "proof",
    decision: "approve",
  });
  expect(yield* Fiber.join(settled)).toMatchObject({ _tag: "ForeignFailure", operation: "result.persist" });
  expect(bodies).toHaveLength(3);
  Storage.reset();
  Storage.initialize({ dbPath });
  const recovered = yield* dispatcher(yield* requestLedger(), bodies);
  yield* recovered.executor.recover();
  expect(bodies).toHaveLength(3);
  const effects = sessionTree(initial.identity.sessionId).map(
    (action: LedgerAction.Node) => action.effect.value,
  );
  expect(
    effects.filter(
      (effect: PlainValue) =>
        effect !== null &&
        typeof effect === "object" &&
        !Array.isArray(effect) &&
        effect.terminal === "outcome_unknown",
    ),
  ).toHaveLength(3);
})));
it("a gateway answer cannot borrow another live owner's lease", () => persisted((_dbPath: string) => Effect.gen(function* () {
  const initial = yield* requestLedger();
  const crashed = yield* dispatcher(crashAfterRequestOpen(initial, "lost"), []);
  expect(yield* failure(
    crashed.executeWave(calls, { sessionId: initial.identity.sessionId, turnId: "turn" }),
  )).toMatchObject({ _tag: "ForeignFailure", operation: "lost" });
  const request = currentRequest();
  const before = SessionHandleStore.row(request.sessionId);
  const gateway = (yield* Effect.gen(function* () { const fixture: SessionFixture = {
    clock: () => 200,
    observations: { publish: () => undefined },
    authorizeConfigure: allowConfigure,
  }; return yield* withSessionServices(createSessionRequests(fixture), fixture); }));
  expect(yield* failure(gateway.answer(ownerAnswer(request)))).toMatchObject({
    _tag: "CommitFailed", error: {
    _tag: "LeaseRefused",
    reason: "held",
    holder: before.leaseOwner,
    fence: before.leaseFence,
  } });
  expect(SessionHandleStore.row(request.sessionId)).toEqual(before);
  expect(currentRequest().state).toBe("open");
  const dormant = (yield* Effect.gen(function* () { const fixture: SessionFixture = {
    clock: () => 40_000,
    observations: { publish: () => undefined },
    authorizeConfigure: allowConfigure,
  }; return yield* withSessionServices(createSessionRequests(fixture), fixture); }));
  expect(yield* dormant.answer(ownerAnswer(request))).toBe("resolved");
  expect(currentRequest().state).toBe("resolved");
  expect(SessionHandleStore.row(request.sessionId).leaseOwner).toBeNull();
})));

it.each(["answer", "timeout", "cancel"] as const)("%s wins once across a request-port restart", (winner: "answer" | "timeout" | "cancel") => fileRequest((dbPath) => Effect.gen(function* () {
  let now = 100;
  const { port, runtime, opening } = yield* requestPlane(() => now);
  const opened = yield* port.open(opening);
  const answer = planeAnswer(opened);
  const cancel = {
    requestId: opened.requestId, sessionId: opened.sessionId, inputId: "cancel",
    principal: { kind: "session" as const, principalId: opened.sessionId, evidenceId: "original-owner" }, at: 100,
  };
  expect(yield* port.cancel({ ...cancel, inputId: "foreign-cancel", principal: { ...cancel.principal, principalId: "stranger" } })).toBe("rejected");
  if (winner === "answer") expect(yield* port.answer(answer)).toBe("resolved");
  if (winner === "cancel") expect(yield* port.cancel(cancel)).toBe("cancelled");
  if (winner === "timeout") { now = 200; yield* port.timeout(opened.requestId, now); }
  const terminal = SessionHandleStore.actionById("invocation:resolution");
  Storage.reset();
  Storage.initialize({ dbPath });
  const reopened = yield* withSessionServices(createSessionRequests(runtime), runtime);
  expect(yield* reopened.cancel({ ...cancel, inputId: "cancel-after-reopen" })).toBe("duplicate");
  now = 200;
  yield* reopened.timeout(opened.requestId, now);
  expect(yield* reopened.answer({ ...answer, inputId: "late-answer", receivedAt: 199 })).toBe("late_unknown");
  expect(SessionHandleStore.actionById("invocation:resolution")).toEqual(terminal);
  expect(SessionHandleStore.requestById(opened.requestId)?.state).toBe(({ answer: "resolved", timeout: "expired", cancel: "cancelled" } as const)[winner]);
  expect(SessionHandleStore.pendingInbox("parent")).toHaveLength(winner === "answer" ? 1 : 0);
  expect(Storage.get().alarms?.get("invocation:deadline")?.status).toBe(winner === "timeout" ? "fired" : "cancelled");
})));
