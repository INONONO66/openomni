import { KERNEL_POLICY_REGISTRY } from "@openomni/policy";
import type { ResolvedExecutorOptions } from "../../../src/executor-contract";
import { executorLayer } from "../../helpers/service-layers";
import { Effect, Fiber } from "effect";
import { isolated } from "../../helpers/isolated";
import { describe, expect, it, mock } from "bun:test";
import { createExecutor } from "../../../src/index";
import {
  recordingLedger,
  runTestOperation,
  failure as effectFailure,
  foreign,
} from "../../helpers/effect-g2";
import { compilePolicySnapshot } from "@openomni/policy";
import type { LedgerAction, PlainValue, PolicyRow } from "@openomni/protocol";

const kinds = ["prompt", "turn", "llm", "tool"] as const;

function row(
  name: string,
  kind: (typeof kinds)[number],
  phase: PolicyRow.Phase,
  verdict: PlainValue,
  priority = 0,
): PolicyRow.Row {
  return {
    name,
    kind,
    phase,
    match: { encodingVersion: 1, value: { op: "test" } },
    verdict: { encodingVersion: 1, value: verdict },
    priority,
    generation: 1,
  };
}

const mandatory: PolicyRow.Row = {
  ...row("compaction", "turn", "post", { type: "allow" }),
  match: { encodingVersion: 1, value: { op: "compaction" } },
};

function harness(rows: readonly PolicyRow.Row[]) {
  const { committed: actions, ledger } = recordingLedger();
  const executor = Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = {
    policy: compilePolicySnapshot({ registry: KERNEL_POLICY_REGISTRY,
      generation: 1,
      rows: [mandatory, ...rows],
      mandatory: ["compaction"],
    }),
    ledger,
    observations: { publish: () => undefined },
    identity: { sessionId: "session-1", role: "resident", parentActionId: null },
    clock: () => 100,
    entropy: (() => {
      let value = 0;
      return () => `action-${++value}`;
    })(),
  }; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); }));
  return { actions, executor };
}

type Executor = ReturnType<typeof harness>["executor"];
type RunRequest = Parameters<Executor["run"]>[0];

/** One "test" operation whose handler reports success; extras add revert/boundary. */
function runTestSuccess(
  executor: Executor,
  kind: (typeof kinds)[number],
  extras: Partial<RunRequest> = {},
) {
  return executor.run(
    { kind, op: "test", intent: { requested: true }, effect: { completed: true }, ...extras },
    () =>
      Effect.sync(() => {
        return { ok: true };
      }),
  );
}

function resultEffects(actions: readonly LedgerAction.Append[], kind: LedgerAction.Kind) {
  return actions
    .filter((action: import("@openomni/protocol").LedgerAction.Append) => action.kind === kind)
    .map((action: import("@openomni/protocol").LedgerAction.Append) => action.effect.value)
    .filter((effect: import("@openomni/protocol").PlainValue) =>
      typeof effect === "object" && effect !== null && !Array.isArray(effect)
        ? effect.phase === "result"
        : false,
    );
}

describe("the single L2 executor's four-kind verdict model", () => {
  it("refuses an unregistered kind with a typed error before policy or body", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { actions, executor } = harness([]);
          const body = mock(() =>
            Effect.sync(() => {
              return { ok: true };
            }),
          );

          const refused = executor.run(
            { kind: "channel.send", op: "test", intent: {}, effect: {} },
            body,
          );
          expect(yield* effectFailure(refused)).toMatchObject({
            _tag: "ForeignFailure",
            operation: "executor.admit",
            cause: "unregistered_execution_kind:channel.send",
          });
          expect(body).toHaveBeenCalledTimes(0);
          expect(actions).toHaveLength(0);
        }),
      ),
    ));

  it("registers extension kinds as declarative data", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const actions: LedgerAction.Append[] = [];
          let revision = 0;
          const executor = Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = {
            policy: compilePolicySnapshot({ registry: KERNEL_POLICY_REGISTRY,
              generation: 1,
              rows: [mandatory],
              mandatory: ["compaction"],
            }),
            ledger: {
              commit(action: import("@openomni/protocol").LedgerAction.Append) {
                return Effect.sync(() => {
                  actions.push(action);
                  revision += 1;
                  return {
                    action: {
                      ...action,
                      ordinal: revision,
                      prevHash: "fixture-prev",
                      actionHash: "fixture-hash",
                    },
                    revision,
                  };
                });
              },
            },
            observations: { publish: () => undefined },
            identity: { sessionId: "session-1", role: "resident", parentActionId: null },
            clock: () => 100,
            entropy: () => `extension-${revision + 1}`,
            extensionKinds: [
              {
                kind: "channel.send",
                effect: { grade: "external" },
                reversible: false,
                inputSchema: { type: "object" },
              },
            ],
          }; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); }));

          const result = yield* executor.run(
            { kind: "channel.send", op: "test", intent: {}, effect: {} },
            () =>
              Effect.sync(() => {
                return { delivered: true };
              }),
          );

          expect(result).toMatchObject({ terminal: "executed" });
          expect(actions).toHaveLength(4);
        }),
      ),
    ));

  it("passes the committed intent receipt to the body after its commit resolves", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const intentCommitReached = Promise.withResolvers<void>();
          const releaseIntentCommit = Promise.withResolvers<void>();
          let revision = 0;
          let committedIntent: LedgerAction.Receipt | undefined;
          let bodyIntent: LedgerAction.Receipt | undefined;
          const body = mock((intent: LedgerAction.Receipt) =>
            Effect.sync(() => {
              bodyIntent = intent;
              return { ok: true };
            }),
          );
          const executor = Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = {
            policy: compilePolicySnapshot({ registry: KERNEL_POLICY_REGISTRY,
              generation: 1,
              rows: [mandatory],
              mandatory: ["compaction"],
            }),
            ledger: {
              commit(action: import("@openomni/protocol").LedgerAction.Append) {
                return Effect.gen(function* () {
                  const isIntent = action.kind === "llm" && committedIntent === undefined;
                  if (isIntent) {
                    intentCommitReached.resolve();
                    yield* Effect.promise(() => releaseIntentCommit.promise);
                  }
                  revision += 1;
                  const receipt = {
                    action: {
                      ...action,
                      ordinal: revision,
                      prevHash: "fixture-prev",
                      actionHash: "fixture-hash",
                    },
                    revision,
                  } satisfies LedgerAction.Receipt;
                  if (isIntent) committedIntent = receipt;
                  return receipt;
                });
              },
            },
            observations: { publish: () => undefined },
            identity: {
              sessionId: "session-1",
              role: "resident",
              parentActionId: "turn-intent-1",
            },
            clock: () => 100,
            entropy: () => `receipt-${revision + 1}`,
          }; return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); }));

          const running = yield* Effect.forkScoped(
            executor.run({ kind: "llm", op: "test", intent: {}, effect: {} }, body),
          );
          yield* Effect.promise(() => intentCommitReached.promise).pipe(
            Effect.timeout("5 seconds"),
          );
          expect(body).toHaveBeenCalledTimes(0);

          releaseIntentCommit.resolve();
          yield* Fiber.join(running);

          expect(body).toHaveBeenCalledTimes(1);
          expect(bodyIntent).toBe(committedIntent);
          expect(bodyIntent?.action.parentId).toBe("turn-intent-1");
        }),
      ),
    ));

  it("fails closed when a transform removes the result envelope", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { actions, executor } = harness([
            row("remove-result", "tool", "post", {
              type: "transform",
              name: "redact",
              paths: ["result"],
            }),
          ]);

          const result = yield* executor.run(
            { kind: "tool", op: "test", intent: {}, effect: {} },
            () =>
              Effect.sync(() => {
                return { ok: true };
              }),
          );

          expect(result).toMatchObject({ terminal: "blocked_post", reason: "invalid_output" });
          expect(resultEffects(actions, "tool")).toEqual([
            expect.objectContaining({ terminal: "blocked_post", reason: "invalid_output" }),
          ]);
        }),
      ),
    ));

  it("commits a linked failed result carrying the typed body failure", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { actions, executor } = harness([]);
          const failure = foreign("test", new TypeError("body failed"));

          const outcome = yield* effectFailure(
            executor.run(
              {
                kind: "tool",
                op: "test",
                intent: { requested: true },
                effect: { completed: false },
              },
              () => Effect.fail(failure),
            ),
          );
          expect(outcome).toBe(failure);

          expect(
            actions.map((action: import("@openomni/protocol").LedgerAction.Append) => action.kind),
          ).toEqual(["policy.decision", "tool", "tool"]);
          const intent = actions[1];
          const result = actions[2];
          expect(result?.parentId).toBe(intent?.id);
          expect(result?.effect.value).toMatchObject({
            phase: "result",
            terminal: "executed",
            effect: { completed: false },
            evidence: {
              failures: [{ tag: "ForeignFailure", operation: "test" }],
              defects: [],
              interrupted: false,
            },
          });
        }),
      ),
    ));

  for (const kind of kinds) {
    it(`${kind}: pre deny commits no intent/result and never calls body`, () =>
      isolated(
        Effect.scoped(
          Effect.gen(function* () {
            const { actions, executor } = harness([
              row(`deny-${kind}-pre`, kind, "pre", { type: "deny", reason: "pre blocked" }),
            ]);
            const body = mock(() =>
              Effect.sync(() => {
                return { ok: true };
              }),
            );

            const result = yield* runTestOperation(executor, kind, body);

            expect(result).toMatchObject({ terminal: "blocked_pre", reason: "pre blocked" });
            expect(body).toHaveBeenCalledTimes(0);
            expect(
              actions.filter(
                (action: import("@openomni/protocol").LedgerAction.Append) => action.kind === kind,
              ),
            ).toHaveLength(0);
            expect(resultEffects(actions, kind)).toHaveLength(0);
          }),
        ),
      ));

    it(`${kind}: allow commits intent/result and calls body exactly once`, () =>
      isolated(
        Effect.scoped(
          Effect.gen(function* () {
            const { actions, executor } = harness([]);
            const body = mock(() =>
              Effect.sync(() => {
                return { ok: true };
              }),
            );

            const result = yield* runTestOperation(executor, kind, body);

            expect(result).toMatchObject({ terminal: "executed", value: { ok: true } });
            expect(body).toHaveBeenCalledTimes(1);
            expect(
              actions.filter(
                (action: import("@openomni/protocol").LedgerAction.Append) => action.kind === kind,
              ),
            ).toHaveLength(2);
            expect(resultEffects(actions, kind)).toEqual([
              expect.objectContaining({ phase: "result", terminal: "executed" }),
            ]);
          }),
        ),
      ));

    it(`${kind}: post deny reverts when a reverter exists`, () =>
      isolated(
        Effect.scoped(
          Effect.gen(function* () {
            const { actions, executor } = harness([
              row(`deny-${kind}-post`, kind, "post", { type: "deny", reason: "post blocked" }),
            ]);
            const revert = mock(() =>
              Effect.sync(() => {
                return undefined;
              }),
            );

            const result = yield* runTestSuccess(executor, kind, { revert });

            expect(result).toMatchObject({
              terminal: "blocked_post",
              disposition: "reverted",
              reason: "post blocked",
            });
            expect(revert).toHaveBeenCalledTimes(1);
            expect(resultEffects(actions, kind)).toEqual([
              expect.objectContaining({
                phase: "result",
                terminal: "blocked_post",
                disposition: "reverted",
              }),
            ]);
          }),
        ),
      ));

    it(`${kind}: post deny records irreversible when no reverter exists`, () =>
      isolated(
        Effect.scoped(
          Effect.gen(function* () {
            const { actions, executor } = harness([
              row(`deny-${kind}-post`, kind, "post", { type: "deny", reason: "post blocked" }),
            ]);

            const result = yield* runTestSuccess(executor, kind);

            expect(result).toMatchObject({
              terminal: "blocked_post",
              disposition: "irreversible",
              reason: "post blocked",
            });
            expect(resultEffects(actions, kind)).toEqual([
              expect.objectContaining({
                phase: "result",
                terminal: "blocked_post",
                disposition: "irreversible",
              }),
            ]);
          }),
        ),
      ));
  }
});

describe("the durable boundary child action commits only for executed outcomes", () => {
  const boundaryChildren = (actions: readonly LedgerAction.Append[]) =>
    actions.filter((action: import("@openomni/protocol").LedgerAction.Append) =>
      action.id.endsWith(":boundary"),
    );

  it("an executed boundary request commits exactly one boundary child under its intent", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { actions, executor } = harness([]);

          const result = yield* runTestSuccess(executor, "tool", { boundary: true });

          expect(result).toMatchObject({ terminal: "executed", value: { ok: true } });
          const children = boundaryChildren(actions);
          expect(children).toHaveLength(1);
          const child = children[0];
          const intent = actions.find(
            (action: import("@openomni/protocol").LedgerAction.Append) =>
              `${action.id}:boundary` === child?.id,
          );
          expect(child?.parentId).toBe(intent?.id);
          expect(child?.kind).toBe("tool");
          expect(child !== undefined && "irreversible" in child && child.irreversible).toBe(true);
          expect(child?.effect?.value).toMatchObject({ phase: "boundary", result: { ok: true } });
        }),
      ),
    ));

  it("a post-denied boundary request commits NO boundary child: recovery must never resurrect a reverted outcome as executed", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const { actions, executor } = harness([
            row("deny-boundary-post", "tool", "post", { type: "deny", reason: "post blocked" }),
          ]);
          const revert = mock(() =>
            Effect.sync(() => {
              return undefined;
            }),
          );

          const result = yield* runTestSuccess(executor, "tool", { boundary: true, revert });

          expect(result).toMatchObject({
            terminal: "blocked_post",
            disposition: "reverted",
            reason: "post blocked",
          });
          expect(revert).toHaveBeenCalledTimes(1);
          expect(boundaryChildren(actions)).toEqual([]);
          expect(resultEffects(actions, "tool")).toEqual([
            expect.objectContaining({ phase: "result", terminal: "blocked_post" }),
          ]);
        }),
      ),
    ));
});
