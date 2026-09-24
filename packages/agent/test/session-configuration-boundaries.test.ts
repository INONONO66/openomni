import { sessionTree } from "../../ledger/test/helpers/session-tree";
import { type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices } from "./helpers/session-services";
import { Effect, Fiber } from "effect";
import { expect, it } from "bun:test";
import { SessionHandleStore } from "@openomni/ledger";
import { session, closeSessions, type SessionHandle } from "../src/session-handle";
import { collector } from "./helpers/observation-collector";
import { seedPolicy } from "./helpers/seed-policy";
import { isolated } from "./helpers/isolated";
import { failure } from "./helpers/effect-g2";

function withSession<E, R>(
  authorizeConfigure: NonNullable<SessionRuntime["authorizeConfigure"]>,
  test: (handle: SessionHandle) => Effect.Effect<void, E, R>,
) {
  return Effect.gen(function* () {
    let sequence = 0;
    const runtime: SessionRuntime = {
      observations: collector(),
      clock: () => 1000,
      entropy: () => `configuration-${++sequence}`,
      processId: "configuration",
      scheduleHeartbeat: () => () => undefined,
      authorizeConfigure,
    };
    seedPolicy();
    yield* Effect.addFinalizer(() => closeSessions(runtime).pipe(Effect.orDie));
    const handle = yield* Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({
        id: "configuration-session",
        role: "resident",
        runner: () => Effect.succeed({ kind: "result", text: "done" }),
      }, fixture), fixture); });
    yield* test(handle);
  });
}

it("does not record a denied configuration", () =>
  isolated(
    Effect.scoped(
      withSession(
        () => Effect.succeed(false),
        (handle: SessionHandle) =>
          Effect.gen(function* () {
            const before = sessionTree(handle.id);
            expect(yield* failure(handle.system.blocks.set([]))).toMatchObject({
              _tag: "ForeignFailure",
              operation: "session.configure",
              cause: "denied",
            });
            expect(sessionTree(handle.id)).toEqual(before);
          }),
      ),
    ),
  ));

it("rejects configuration whose authorization outlives its captured generation", () =>
  isolated(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let authorizations = 0;
        yield* withSession(
          () =>
            Effect.gen(function* () {
              authorizations += 1;
              if (authorizations === 1) {
                entered.resolve();
                yield* Effect.promise(() => release.promise);
              }
              return true;
            }),
          (handle: SessionHandle) =>
            Effect.gen(function* () {
              const first = yield* Effect.forkScoped(
                failure(
                  handle.system.blocks.set([{ id: "first", source: "test", content: "first" }]),
                ),
              );
              yield* Effect.promise(() => entered.promise).pipe(Effect.timeout("5 seconds"));
              try {
                const receipt = yield* handle.system.blocks.set([
                  { id: "second", source: "test", content: "second" },
                ]);
                release.resolve();
                expect(yield* Fiber.join(first)).toMatchObject({
                  _tag: "ForeignFailure",
                  operation: "session.configure",
                  cause: "stale",
                });
                expect(
                  SessionHandleStore.latestGeneration(sessionTree(handle.id))
                    .generation,
                ).toBe(receipt.generation);
              } finally {
                release.resolve();
              }
            }),
        );
      }),
    ),
  ));
