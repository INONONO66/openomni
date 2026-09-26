import { writeSync } from "node:fs";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { SEEDED_POLICY_ROWS } from "@openomni/policy";
import { LedgerAction, SessionGeneration } from "@openomni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import { sessionTree } from "../../../ledger/test/helpers/session-tree";
import { ForeignFailure, type SessionError } from "../../src/errors";
import { closeSessions, session, wakeSession } from "../../src/session-handle";
import type { SessionRunnerInput } from "../../src/session-contract";
import { GenerationLayers, SessionLayer } from "../../src/services";
import { isolated } from "./isolated";
import { awaitCrashStart, holdCrashBarrier } from "./crash-channel";
import { allowConfigure, type SessionFixture, withSessionServices } from "./session-services";

export const configureCrashPoint = "session_configure_commit_before_hibernate";
const sessionId = "configure-crash-session";
export const configureCutProof = z.object({
  crashPoint: z.literal(configureCrashPoint), snapshot: SessionGeneration.Snapshot,
  actions: z.array(LedgerAction.Node), hibernations: z.number(),
}).strict();
export const configureRecoveryProof = z.object({
  before: z.array(LedgerAction.Node), idle: z.array(LedgerAction.Node),
  after: z.array(LedgerAction.Node), repeated: z.array(LedgerAction.Node),
  snapshot: SessionGeneration.Snapshot, captured: z.array(SessionGeneration.Snapshot),
  configureCalls: z.number(), runnerGenerations: z.array(z.number()),
}).strict();

function cut() {
  return Effect.gen(function* () {
    let hibernations = 0;
    const runtime: SessionFixture = {
      authorizeConfigure: allowConfigure, observations: { publish: () => undefined }, clock: () => 100,
      onHibernate: () => Effect.sync(() => { hibernations += 1; }),
    };
    return yield* withSessionServices(Effect.gen(function* () {
      const generations = yield* GenerationLayers;
      const handle = yield* session({ id: sessionId, role: "resident",
        runner: () => Effect.die("configure must not enter a runner"),
      }, runtime).pipe(Effect.provideService(GenerationLayers, {
        ...generations,
        configure: <A>(id: SessionGeneration.Id, snapshot: SessionGeneration.Snapshot, commit: Effect.Effect<A, SessionError>) =>
          generations.configure(id, snapshot, commit).pipe(Effect.tap(() => Effect.sync(() =>
            holdCrashBarrier(JSON.stringify(configureCutProof.parse({
              crashPoint: configureCrashPoint, snapshot: SessionHandleStore.latestGenerationFor(sessionId),
              actions: sessionTree(sessionId), hibernations,
            }))),
          ))),
      }));
      hibernations = 0;
      return yield* handle.system.blocks.set([{ id: "G1", source: "test", content: "G1_GENERATION_SENTINEL" }]);
    }), runtime);
  });
}

function recover() {
  return Effect.gen(function* () {
    const before = sessionTree(sessionId);
    const snapshot = SessionHandleStore.latestGenerationFor(sessionId);
    const captured: SessionGeneration.Snapshot[] = [];
    const runnerGenerations: number[] = [];
    let configureCalls = 0;
    const runtime: SessionFixture = {
      observations: { publish: () => undefined }, clock: () => 100_000,
      authorizeConfigure: () => Effect.suspend(() => {
        configureCalls += 1;
        return Effect.fail(new ForeignFailure({ operation: "configure.recovery", cause: "unexpected_reexecution" }));
      }),
    };
    const runner = (input: SessionRunnerInput) => Effect.gen(function* () {
      captured.push((yield* SessionLayer).snapshot);
      runnerGenerations.push(input.toolsGeneration);
      return { kind: "result" as const, text: "G1_RESULT" };
    });
    try {
      yield* withSessionServices(wakeSession(sessionId, runner, runtime), runtime);
      const idle = sessionTree(sessionId);
      yield* SessionHandleStore.commitReceivedMessage({
        id: "G1_PROBE", sessionId, kind: "prompt", content: "G1_PROBE", createdAt: 100_000,
        origin: { encodingVersion: 1, value: {} }, parentActionId: null,
      });
      yield* withSessionServices(wakeSession(sessionId, runner, runtime), runtime);
      const after = sessionTree(sessionId);
      yield* withSessionServices(wakeSession(sessionId, runner, runtime), runtime);
      return configureRecoveryProof.parse({ before, idle, after, repeated: sessionTree(sessionId),
        snapshot, captured, configureCalls, runnerGenerations });
    } finally {
      yield* closeSessions(runtime);
    }
  });
}

if (import.meta.main) {
  const [stage, dbPath] = z.tuple([z.enum(["crash", "recover"]), z.string().min(1)]).parse(process.argv.slice(2));
  awaitCrashStart();
  const proof = await isolated(Effect.gen(function* () {
    Storage.reset(); Storage.initialize({ dbPath });
    if (stage === "recover") return yield* recover();
    const policies = Storage.get().policies;
    if (policies === undefined) return yield* Effect.die("missing policies");
    policies.appendGeneration(() => SEEDED_POLICY_ROWS);
    return yield* cut();
  }));
  writeSync(1, `${JSON.stringify(proof)}\n`);
}
