import { Effect, Fiber } from "effect";
import { isolated } from "./helpers/isolated";
import { ForeignFailure } from "../src/errors";
import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage, SessionHandleStore } from "@openomni/ledger";
import type { LedgerAction, SessionTransition } from "@openomni/protocol";
import { z } from "zod";
import { createTurnDispatcher, defineTool, eraseTool } from "../src/tool-dispatcher";
import { createSessionRequests } from "../src/session-requests";
import { compiledPolicy } from "./helpers/compiled-policy";
import { requestLedger, crashAfterRequestOpen, failure, type RequestLedger } from "./helpers/effect-g1";
import { bounded } from "./helpers/bounded";

function persisted<A, E>(program: (dbPath: string) => Effect.Effect<A, E, import("effect").Scope.Scope>) {
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
  return ["read", "write", "last"].map((name) =>
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
          execute: async (input) => {
            bodies.push(`${name}:${input.text}`);
            return { value: input.text };
          },
          render: (_input, result) => result.value,
        },
        () => ({ required: name === "write", domainRevisions: {} }),
      ),
    ),
  );
}
const calls = ["read", "write", "last"].map((tool) => ({
  id: `call:${tool}`,
  tool,
  input: { text: `original:${tool}` },
}));
function dispatcher(
  recording: RequestLedger,
  bodies: string[],
  ready?: () => void,
) {
  const result = createTurnDispatcher(
    definitions(bodies),
    {
      ...recording.identity,
      ledger: {
        ...recording.ledger,
        actions: () => {
          if ((result.executor.approvals?.pending().length ?? 0) > 0) ready?.();
          return recording.ledger.actions?.() ?? [];
        },
      },
      actionId: recording.identity.parentActionId,
      policy: compiledPolicy(),
    },
    {
      clock: recording.clock,
      entropy: recording.entropy,
      observations: { publish: () => undefined },
      authorizeApproval: () => Effect.succeed(proof),
    },
  );
  return result;
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
  const crashed = dispatcher(
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
  const recovered = dispatcher(yield* requestLedger(), bodies, ready.resolve);
  const recovery = recovered.executor.recover?.();
  if (recovery === undefined) throw new Error("missing recovery");
  const recovering = yield* Effect.forkScoped(recovery);
  yield* Effect.promise(() => bounded(ready.promise));
  const pending = recovered.executor.approvals?.pending()[0];
  if (pending === undefined) throw new Error("missing recovered approval");
  expect(pending.id).toBe(originalId);
  expect(pending.durable.parsedInput).toEqual({ text: "original:write" });
  yield* recovered.executor.approvals.answer({
    request: pending,
    credential: "proof",
    decision: "approve",
  });
  yield* Fiber.join(recovering);
  expect(bodies).toEqual(["read:original:read", "write:original:write", "last:original:last"]);
  yield* recovered.executor.recover();
  expect(bodies).toHaveLength(3);
  expect(
    SessionHandleStore.tree(initial.identity.sessionId).filter(
      (action) => action.id === `${originalId}:application`,
    ),
  ).toHaveLength(1);
})));
it("a committed application claim prevents replay after result persistence fails", () => persisted((dbPath: string) => Effect.gen(function* () {
  const bodies: string[] = [];
  const ready = Promise.withResolvers<void>();
  const initial = yield* requestLedger();
  const commit = initial.ledger.commit;
  const crashed = dispatcher(
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
  const pending = crashed.executor.approvals?.pending()[0];
  if (pending === undefined) throw new Error("missing approval");
  yield* crashed.executor.approvals.answer({
    request: pending,
    credential: "proof",
    decision: "approve",
  });
  expect(yield* Fiber.join(settled)).toMatchObject({ _tag: "ForeignFailure", operation: "result.persist" });
  expect(bodies).toHaveLength(3);
  Storage.reset();
  Storage.initialize({ dbPath });
  const recovered = dispatcher(yield* requestLedger(), bodies);
  yield* recovered.executor.recover();
  expect(bodies).toHaveLength(3);
  const effects = SessionHandleStore.tree(initial.identity.sessionId).map(
    (action) => action.effect.value,
  );
  expect(
    effects.filter(
      (effect) =>
        effect !== null &&
        typeof effect === "object" &&
        !Array.isArray(effect) &&
        effect.terminal === "outcome_unknown",
    ),
  ).toHaveLength(3);
})));
it("a gateway answer cannot borrow another live owner's lease", () => persisted((_dbPath: string) => Effect.gen(function* () {
  const initial = yield* requestLedger();
  const crashed = dispatcher(crashAfterRequestOpen(initial, "lost"), []);
  expect(yield* failure(
    crashed.executeWave(calls, { sessionId: initial.identity.sessionId, turnId: "turn" }),
  )).toMatchObject({ _tag: "ForeignFailure", operation: "lost" });
  const request = currentRequest();
  const before = SessionHandleStore.row(request.sessionId);
  const gateway = createSessionRequests({
    clock: () => 200,
    observations: { publish: () => undefined },
  });
  expect(yield* failure(gateway.answer(ownerAnswer(request)))).toMatchObject({
    _tag: "CommitFailed", error: {
    _tag: "LeaseRefused",
    reason: "held",
    holder: before.leaseOwner,
    fence: before.leaseFence,
  } });
  expect(SessionHandleStore.row(request.sessionId)).toEqual(before);
  expect(currentRequest().state).toBe("open");
  const dormant = createSessionRequests({
    clock: () => 40_000,
    observations: { publish: () => undefined },
  });
  expect(yield* dormant.answer(ownerAnswer(request))).toBe("resolved");
  expect(currentRequest().state).toBe("resolved");
  expect(SessionHandleStore.row(request.sessionId).leaseOwner).toBeNull();
})));
