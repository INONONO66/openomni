/**
 * #1254 S4 D3 — the per-session armed-alarm budget, against the REAL entity:
 * a capability wake arming through `ctx.arm` succeeds until the durable armed
 * index holds `maxArmed` rows, then receives the typed
 * `ArmRefused{code: alarm_budget}` — and reserved purposes are refused with
 * `reserved_purpose` regardless of budget headroom. At a full budget a re-arm
 * of an armed chain (upsert) and a retire (`at: null`, delete) still commit —
 * only an arm that adds a chain consults the budget — and the retire frees one
 * slot. The same wake commits one alarm-originated prompt through `ctx.prompt`
 * (origin fixed by the core).
 */
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Effect, Result } from "effect";
import type { Alarm } from "@openomni/protocol";
import { armAction, composeAlarmPurposes, firedAction, type AlarmCapability, type ArmRefused, type ArmVerb } from "../../src/core/alarm";
import { alarmCapability, watchPurposes, WatchRefused, type WatchInstallDeps } from "../../src/plugins/alarm";
import { openCatalogStore } from "../../src/core/store/catalog";
import { openSessionStore } from "../../src/core/store/session-file";
import * as SessionHandleStore from "../../src/core/store/fence";
import { clusterTempDir, runCluster, sendAlarm, sendPrompt, sessionFileFor } from "../helpers/cluster-runtime";
import { runAgent } from "../helpers/executor";

const { dir, sessionsDir, catalogFile } = clusterTempDir("w52-alarm-budget-");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sessionId = "budget-session";
const MAX_ARMED = 64;
const FAR_FUTURE = 4_102_444_800_000;

// Non-empty on purpose: the resent occurrence must carry the arm's payload as
// JSON bytes a capability can parse (`{}` would pass under any serializer).
const BOOT_PAYLOAD = { reason: "boot", attempt: 1, tags: ["a", "b"] };

test("ctx.arm fills the budget to maxArmed, then ArmRefused{alarm_budget}; re-arm/retire pass at full budget; reserved purposes always refuse", async () => {
  // Seed: one committed boot arm (purpose test.tick) whose resent occurrence
  // triggers the capability wake on activation.
  const boot = await runAgent(
    Effect.gen(function* () {
      const catalog = openCatalogStore(catalogFile, { now: () => 1 });
      const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), { now: () => 1 });
      const kernel = SessionHandleStore.createSessionKernel(store, catalog);
      yield* kernel.materialize({
        id: sessionId,
        parentId: null,
        role: "resident",
        tools: [],
        system: { preset: "", blocks: [] },
        policyGeneration: 1,
        actionId: `${sessionId}:materialize`,
        at: 1,
      });
      catalog.indexSession({ id: sessionId, parentId: null, role: "resident", createdAt: 1 });
      const fence = catalog.rotateFence(sessionId);
      yield* kernel.adoptFence({ sessionId, owner: "seeder", fence });
      const row = kernel.row(sessionId);
      const armed = armAction({
        parentId: `${sessionId}:materialize`,
        sessionId,
        purpose: "test.tick",
        at: 100,
        supersedes: null,
        alarmId: "boot",
        sourceKey: "boot",
        payload: BOOT_PAYLOAD,
        armSeq: row.revision + 1,
        ts: 100,
      });
      yield* kernel.commit({
        sessionId,
        owner: "seeder",
        fence,
        now: 100,
        expectedRevision: row.revision,
        actions: [armed.action],
        state: row.state,
      });
      store.close();
      catalog.close();
      return armed;
    }),
  );

  // The wake arms until refused; results surface through this settled promise.
  interface WakeReport {
    readonly armed: number;
    readonly refusal: ArmRefused | undefined;
    readonly reserved: ArmRefused | undefined;
    /** At the full budget: re-arm of tick-0, retire of tick-1, then one new chain. */
    readonly atFull: {
      readonly rearm: ArmRefused | { readonly alarmId: string; readonly armSeq: number };
      readonly retire: ArmRefused | { readonly alarmId: string };
      readonly freed: ArmRefused | { readonly alarmId: string };
    };
    readonly prompt: { readonly seq: number };
    readonly fired: {
      readonly occurrenceId: string;
      readonly alarmId: string;
      readonly payload: string;
    };
  }
  let resolveReport: (report: WakeReport) => void = () => undefined;
  const report = new Promise<WakeReport>((resolve) => {
    resolveReport = resolve;
  });
  const capability: AlarmCapability = {
    purposes: ["test.tick"],
    wake: (fired, ctx) =>
      Effect.gen(function* () {
        const prompt = yield* ctx.prompt({ content: "WAKE tick", payload: { detail: "line:1" } });
        const reserved = yield* Effect.result(
          ctx.arm({ purpose: "retry", at: FAR_FUTURE, payload: {}, sourceKey: "t" }),
        );
        let armed = 0;
        let refusal: ArmRefused | undefined;
        // The boot row occupies one slot until its fired fact retires it, so
        // headroom is maxArmed - 1; the next attempt crosses the budget.
        for (let index = 0; index < MAX_ARMED; index += 1) {
          const outcome = yield* Effect.result(
            ctx.arm({
              purpose: "test.tick",
              at: FAR_FUTURE + index,
              payload: { index },
              alarmId: `tick-${index}`,
              sourceKey: "t",
            }),
          );
          if (Result.isFailure(outcome)) {
            refusal = outcome.failure;
            break;
          }
          armed += 1;
        }
        const settle = <A>(outcome: Result.Result<A, ArmRefused>) =>
          Result.isFailure(outcome) ? outcome.failure : outcome.success;
        const rearm = settle(
          yield* Effect.result(
            ctx.arm({ purpose: "test.tick", at: FAR_FUTURE + 1_000, payload: {}, alarmId: "tick-0", sourceKey: "t" }),
          ),
        );
        const retire = settle(
          yield* Effect.result(
            ctx.arm({ purpose: "test.tick", at: null, payload: {}, alarmId: "tick-1", sourceKey: "t" }),
          ),
        );
        const freed = settle(
          yield* Effect.result(
            ctx.arm({ purpose: "test.tick", at: FAR_FUTURE, payload: {}, alarmId: "tick-freed", sourceKey: "t" }),
          ),
        );
        resolveReport({
          armed,
          refusal,
          reserved: Result.isFailure(reserved) ? reserved.failure : undefined,
          atFull: { rearm, retire, freed },
          prompt,
          fired: {
            occurrenceId: fired.occurrenceId,
            alarmId: fired.alarmId,
            payload: fired.payload,
          },
        });
        return "delivered" as const;
      }),
  };

  const outcome = await runCluster(
    { sessionsDir, catalogFile, alarmCapability: capability },
    Effect.gen(function* () {
      // Any occurrence activates the entity; activation resends the boot arm,
      // whose delivery runs the wake above.
      yield* sendAlarm(sessionId, {
        occurrenceId: "kick",
        purpose: "rescan",
        alarmId: "kick",
        armSeq: 1,
        sourceKey: "rescan",
        payload: "{}",
        fireAt: Date.now() - 1,
      });
      return yield* Effect.promise(() => report);
    }),
  );

  expect(outcome.reserved?.code).toBe("reserved_purpose");
  expect(outcome.armed).toBe(MAX_ARMED - 1);
  expect(outcome.refusal?.code).toBe("alarm_budget");
  // Full budget: the upsert and the delete commit (neither adds a row); the
  // retire frees exactly one slot for a new chain.
  expect(outcome.atFull.rearm).toMatchObject({ alarmId: "tick-0" });
  expect(outcome.atFull.retire).toMatchObject({ alarmId: "tick-1" });
  expect(outcome.atFull.freed).toMatchObject({ alarmId: "tick-freed" });

  // Durable index after the wake: the boot row retired on `fired{delivered}`,
  // the 63 accepted arms remain; the wake's prompt is one `prompt` row keyed
  // by the fired occurrence with the core-fixed alarm origin.
  const after = await runAgent(
    Effect.sync(() => {
      const catalog = openCatalogStore(catalogFile, { now: () => Date.now() });
      const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), {
        now: () => Date.now(),
      });
      try {
        const kernel = SessionHandleStore.createSessionKernel(store, catalog);
        return {
          armed: kernel.armedAlarms(),
          prompt: kernel.actionById(`${outcome.fired.occurrenceId}:prompt`),
        };
      } finally {
        store.close();
        catalog.close();
      }
    }),
  );
  expect(after.armed.find((row) => row.occurrenceId === boot.occurrenceId)).toBeUndefined();
  // 63 accepted arms − retired tick-1 + tick-freed; tick-0 moved to its re-arm.
  expect(after.armed).toHaveLength(MAX_ARMED - 1);
  expect(after.armed.find((row) => row.alarmId === "tick-1")).toBeUndefined();
  expect(after.armed.find((row) => row.alarmId === "tick-freed")).toBeDefined();
  expect(after.armed.find((row) => row.alarmId === "tick-0")?.fireAt).toBe(FAR_FUTURE + 1_000);
  expect(outcome.fired.alarmId).toBe("boot");
  expect(JSON.parse(outcome.fired.payload)).toEqual(BOOT_PAYLOAD);
  expect(after.prompt?.kind).toBe("prompt");
  expect(after.prompt?.ordinal).toBe(outcome.prompt.seq);
  expect(after.prompt?.effect.value).toMatchObject({ content: "WAKE tick" });
  expect(after.prompt?.intent.value).toMatchObject({
    kind: "alarm",
    alarmId: "boot",
    occurrenceId: outcome.fired.occurrenceId,
    purpose: "test.tick",
    sourceKey: "boot",
    payload: { detail: "line:1" },
  });
});

test("the app capability path arms through the live activation's budgeted entity verb — one committing door (H3)", async () => {
  const sessionId = "live-budget-session";
  // Seed: the session exists (materialized + indexed) but holds no armed rows.
  await runAgent(
    Effect.gen(function* () {
      const catalog = openCatalogStore(catalogFile, { now: () => 1 });
      const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), { now: () => 1 });
      const kernel = SessionHandleStore.createSessionKernel(store, catalog);
      yield* kernel.materialize({
        id: sessionId,
        parentId: null,
        role: "resident",
        tools: [],
        system: { preset: "", blocks: [] },
        policyGeneration: 1,
        actionId: `${sessionId}:materialize`,
        at: 1,
      });
      catalog.indexSession({ id: sessionId, parentId: null, role: "resident", createdAt: 1 });
      store.close();
      catalog.close();
    }),
  );

  // The app-side registry shape (H3): activations hand their budgeted arm
  // verb to the composition root; the capability delegates — no app commit.
  const liveVerbs = new Map<string, ArmVerb>();
  const outcome = await runCluster(
    {
      sessionsDir,
      catalogFile,
      onLive: (id, verbs) => {
        liveVerbs.set(id, verbs.arm);
        return () => {
          liveVerbs.delete(id);
        };
      },
    },
    Effect.gen(function* () {
      // Activation: the Deliver turn resolves and the entity stays live (idle 60s).
      yield* sendPrompt(sessionId, `${sessionId}:m-1`, "hello");
      const capability = yield* alarmCapability({
        bundles: [
          {
            bundle: "t",
            purposes: [{ name: "test.tick", handler: () => Effect.succeed("delivered" as const) }],
          },
        ],
        compose: composeAlarmPurposes,
        arm: (id) => (input) =>
          Effect.suspend(() => {
            const verb = liveVerbs.get(id);
            return verb === undefined
              ? Effect.die(new Error(`no live activation for ${id}`))
              : verb(input);
          }),
        watch: { install: () => Effect.void },
      });
      let armed = 0;
      let refusal: ArmRefused | undefined;
      for (let index = 0; index <= MAX_ARMED; index += 1) {
        const attempt = yield* Effect.result(
          capability.verbs.arm(sessionId, "turn-1")({
            purpose: "test.tick",
            at: FAR_FUTURE + index,
            alarmId: `app-${index}`,
            sourceKey: "t",
            payload: { index },
          }),
        );
        if (Result.isFailure(attempt)) {
          refusal = attempt.failure;
          break;
        }
        armed += 1;
      }
      return { armed, refusal };
    }),
  );
  // 64 chains through the app path commit against the entity's budget; the
  // 65th is the typed refusal, not an app-side commit.
  expect(outcome.armed).toBe(MAX_ARMED);
  expect(outcome.refusal?.code).toBe("alarm_budget");

  // Durable index: exactly the budget — no second committing path added rows.
  const after = await runAgent(
    Effect.sync(() => {
      const catalog = openCatalogStore(catalogFile, { now: () => 1 });
      const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), { now: () => 1 });
      try {
        return SessionHandleStore.createSessionKernel(store, catalog).armedAlarms().length;
      } finally {
        store.close();
        catalog.close();
      }
    }),
  );
  expect(after).toBe(MAX_ARMED);
});

test("r2 H2: a refusal after the first committed arm retires exactly the committed chains through the real entity verb", async () => {
  const sessionId = "h2-compensation-session";
  const liveVerbs = new Map<string, ArmVerb>();
  const installs: string[] = [];
  const timedSpec: Alarm.WatchSpec = {
    watch: { command: "true", description: "timed", timeout_ms: 60_000 },
    policyGeneration: 1,
    notificationLimit: 2,
  };
  const makeCapability = (install: WatchInstallDeps["install"]) =>
    alarmCapability({
      bundles: [
        { bundle: "monitor", purposes: watchPurposes({ close: () => undefined }) },
      ],
      compose: composeAlarmPurposes,
      arm: (id) => (input) =>
        Effect.suspend(() => {
          const verb = liveVerbs.get(id);
          return verb === undefined
            ? Effect.die(new Error(`no live activation for ${id}`))
            : verb(input);
        }),
      watch: { install },
    });
  const outcome = await runCluster(
    {
      sessionsDir,
      catalogFile,
      onLive: (id, verbs) => {
        liveVerbs.set(id, verbs.arm);
        return () => {
          liveVerbs.delete(id);
        };
      },
    },
    Effect.gen(function* () {
      yield* sendPrompt(sessionId, `${sessionId}:m-1`, "hello");
      // Install refused under a committed timeout chain: BOTH chains retire.
      const refusing = yield* makeCapability(() =>
        Effect.fail(new WatchRefused({ reason: "no machines plane" })),
      );
      const installRefused = yield* Effect.flip(
        refusing.verbs.watch({
          sessionId,
          turnId: "turn-1",
          watchId: "h2-install",
          spec: timedSpec,
          now: FAR_FUTURE,
        }),
      );
      // Fill the budget to maxArmed - 1 so the timed watch's main arm takes
      // the LAST slot and its timeout arm is the typed boundary refusal.
      const working = yield* makeCapability(({ watchId }) =>
        Effect.sync(() => {
          installs.push(watchId);
        }),
      );
      const armDirect = working.verbs.arm(sessionId, "turn-1");
      for (let index = 0; index < MAX_ARMED - 1; index += 1)
        yield* armDirect({
          purpose: "monitor.hit",
          at: FAR_FUTURE + index,
          alarmId: `h2-fill-${index}`,
          sourceKey: "monitor",
          payload: {},
        });
      const budgetRefused = yield* Effect.flip(
        working.verbs.watch({
          sessionId,
          turnId: "turn-1",
          watchId: "h2-watch",
          spec: timedSpec,
          now: FAR_FUTURE,
        }),
      );
      return { installRefused, budgetRefused };
    }),
  );
  // The caller receives the ORIGINAL typed refusals, not a compensation error.
  expect(outcome.installRefused).toBeInstanceOf(WatchRefused);
  expect((outcome.installRefused as WatchRefused).reason).toBe("no machines plane");
  expect(outcome.budgetRefused).toMatchObject({ _tag: "ArmRefused", code: "alarm_budget" });
  // The refused watch's native source was never installed.
  expect(installs).toEqual([]);
  // Durable index: exactly the fillers — no partially created watch survives
  // (main retired after the timeout refusal; install-refused chains retired).
  const armed = await runAgent(
    Effect.sync(() => {
      const catalog = openCatalogStore(catalogFile, { now: () => 1 });
      const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), { now: () => 1 });
      try {
        return SessionHandleStore.createSessionKernel(store, catalog).armedAlarms();
      } finally {
        store.close();
        catalog.close();
      }
    }),
  );
  expect(armed).toHaveLength(MAX_ARMED - 1);
  expect(
    armed.filter((row) => row.alarmId.startsWith("h2-watch") || row.alarmId.startsWith("h2-install")),
  ).toEqual([]);
});

test("r2 H3: a fence-stale commit from a zombie activation is the typed ArmRefused stale_activation", async () => {
  const sessionId = "h3-stale-activation-session";
  const liveVerbs = new Map<string, ArmVerb>();
  const refused = await runCluster(
    {
      sessionsDir,
      catalogFile,
      onLive: (id, verbs) => {
        liveVerbs.set(id, verbs.arm);
        return () => {
          liveVerbs.delete(id);
        };
      },
    },
    Effect.gen(function* () {
      yield* sendPrompt(sessionId, `${sessionId}:m-1`, "hello");
      const verb = liveVerbs.get(sessionId);
      if (verb === undefined) return yield* Effect.die(new Error("no live activation"));
      // Sanity: the live activation commits under its pinned fence.
      yield* verb({ purpose: "h3.tick", at: FAR_FUTURE, alarmId: "h3-live", sourceKey: "t", payload: {} });
      // A successor elsewhere takes the session over: rotate + adopt the fence.
      yield* Effect.promise(() =>
        runAgent(
          Effect.gen(function* () {
            const catalog = openCatalogStore(catalogFile, { now: () => Date.now() });
            const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), {
              now: () => Date.now(),
            });
            try {
              const kernel = SessionHandleStore.createSessionKernel(store, catalog);
              const fence = catalog.rotateFence(sessionId);
              yield* kernel.adoptFence({ sessionId, owner: "usurper", fence });
            } finally {
              store.close();
              catalog.close();
            }
          }),
        ),
      );
      // The zombie's next commit is a typed refusal, not a defect.
      return yield* Effect.flip(
        verb({ purpose: "h3.tick", at: FAR_FUTURE, alarmId: "h3-zombie", sourceKey: "t", payload: {} }),
      );
    }),
  );
  expect(refused).toMatchObject({ _tag: "ArmRefused", code: "stale_activation" });
  // The zombie appended nothing: only the sane pre-usurp arm is indexed.
  const armed = await runAgent(
    Effect.sync(() => {
      const catalog = openCatalogStore(catalogFile, { now: () => 1 });
      const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), { now: () => 1 });
      try {
        return SessionHandleStore.createSessionKernel(store, catalog).armedAlarms();
      } finally {
        store.close();
        catalog.close();
      }
    }),
  );
  expect(armed.map((row) => row.alarmId)).toEqual(["h3-live"]);
});

test("r2 H3: three exhausted CAS attempts on the arm commit surface the typed ArmRefused revision", async () => {
  const sessionId = "h3-revision-session";
  const liveVerbs = new Map<string, ArmVerb>();
  const contend = { active: false, bumps: 0 };
  // One REAL competing row lands through a second kernel right before each of
  // the entity's commit attempts, so every bounded attempt sees a moved
  // revision — deterministic contention, no sleeps.
  const competingBump = Effect.gen(function* () {
    const catalog = openCatalogStore(catalogFile, { now: () => Date.now() });
    const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), {
      now: () => Date.now(),
    });
    try {
      const kernel = SessionHandleStore.createSessionKernel(store, catalog);
      const row = kernel.row(sessionId);
      contend.bumps += 1;
      yield* kernel.commit({
        sessionId,
        owner: row.fenceOwner ?? "competitor",
        fence: row.fence,
        now: Date.now(),
        expectedRevision: row.revision,
        actions: [
          firedAction({
            parentId: null,
            sessionId,
            purpose: "h3.tick",
            alarmId: "h3-competitor",
            occurrenceId: `h3-competitor-${contend.bumps}`,
            outcome: "stale",
            ts: Date.now(),
          }),
        ],
        state: row.state,
      });
    } finally {
      store.close();
      catalog.close();
    }
  });
  const refused = await runCluster(
    {
      sessionsDir,
      catalogFile,
      onLive: (id, verbs) => {
        liveVerbs.set(id, verbs.arm);
        return () => {
          liveVerbs.delete(id);
        };
      },
      wrapStore: (id, store) => {
        if (id !== sessionId) return store;
        const sessions = store.sessions;
        const wrapped: typeof sessions = {
          ...sessions,
          commit: (input) =>
            contend.active && input.actions.some((action) => action.id.startsWith("h3-cas:arm:"))
              ? competingBump.pipe(
                  Effect.orDie,
                  Effect.flatMap(() => sessions.commit(input)),
                )
              : sessions.commit(input),
        };
        Object.defineProperty(store, "sessions", { value: wrapped });
        return store;
      },
    },
    Effect.gen(function* () {
      yield* sendPrompt(sessionId, `${sessionId}:m-1`, "hello");
      const verb = liveVerbs.get(sessionId);
      if (verb === undefined) return yield* Effect.die(new Error("no live activation"));
      contend.active = true;
      const refusal = yield* Effect.flip(
        verb({ purpose: "h3.tick", at: FAR_FUTURE, alarmId: "h3-cas", sourceKey: "t", payload: {} }),
      );
      contend.active = false;
      return refusal;
    }),
  );
  expect(refused).toMatchObject({ _tag: "ArmRefused", code: "revision" });
  // Exactly the bounded three attempts hit the contended commit.
  expect(contend.bumps).toBe(3);
});

test("r2 M2 (H5): a settled watch wakes exactly once — the exhausted hit retires both chains and the later timeout delivery lapses stale", async () => {
  const sessionId = "h5-sequence-session";
  const liveVerbs = new Map<string, ArmVerb>();
  const closed: string[] = [];
  const installs: string[] = [];
  // A far-future timeout: the DeliverAt door alone would release it in an
  // hour, so the TEST — not the wall clock — decides when it arrives (r3 M2).
  const TIMEOUT_MS = 3_600_000;
  const spec: Alarm.WatchSpec = {
    watch: { command: "true", description: "timed", timeout_ms: TIMEOUT_MS },
    policyGeneration: 1,
    notificationLimit: 1,
  };
  const capability = await runAgent(
    alarmCapability({
      bundles: [
        {
          bundle: "monitor",
          purposes: watchPurposes({
            close: (id) => {
              closed.push(id);
            },
          }),
        },
      ],
      compose: composeAlarmPurposes,
      arm: (id) => (input) =>
        Effect.suspend(() => {
          const verb = liveVerbs.get(id);
          return verb === undefined
            ? Effect.die(new Error(`no live activation for ${id}`))
            : verb(input);
        }),
      watch: {
        install: ({ watchId }) =>
          Effect.sync(() => {
            installs.push(watchId);
          }),
      },
    }),
  );
  const readArmed = Effect.sync(() => {
    const catalog = openCatalogStore(catalogFile, { now: () => 1 });
    const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), { now: () => 1 });
    try {
      return SessionHandleStore.createSessionKernel(store, catalog).armedAlarms();
    } finally {
      store.close();
      catalog.close();
    }
  });
  // r3 M2: HOLD the entity's forked DeliverAt forwards instead of racing them.
  // The explicit `sendAlarm` sends below are then the ONLY envelopes under
  // those occurrence ids, and each RPC ack — sent only after the corresponding
  // fired-fact commit (messages.ts F4) — is the exact, bounded completion
  // barrier. No polling, no wall-clock ordering.
  const heldForwards: string[] = [];
  const outcome = await runCluster(
    {
      sessionsDir,
      catalogFile,
      alarmCapability: capability,
      wrapSendAlarm: () => (_, occurrence) =>
        Effect.sync(() => {
          heldForwards.push(occurrence.alarmId);
        }),
      onLive: (id, verbs) => {
        liveVerbs.set(id, verbs.arm);
        return () => {
          liveVerbs.delete(id);
        };
      },
    },
    Effect.gen(function* () {
      yield* sendPrompt(sessionId, `${sessionId}:m-1`, "hello");
      // The REAL watch verb arms the main chain and its timeout companion;
      // both DeliverAt forwards are held by the wrapper above.
      const armNow = Date.now();
      const main = yield* capability.verbs.watch({
        sessionId,
        turnId: "turn-1",
        watchId: "h5",
        spec,
        now: armNow,
      });
      const timeoutRow = (yield* readArmed).find((row) => row.alarmId === "h5:timeout");
      if (timeoutRow === undefined) return yield* Effect.die(new Error("missing timeout row"));
      // The exhausting native hit (budget 1) retires the main chain AND the
      // companion; the `delivered` ack arrives only after the fired fact and
      // the retiring arms committed — the committed-retirement barrier.
      const hit = yield* sendAlarm(sessionId, {
        occurrenceId: main.occurrenceId,
        purpose: "monitor.hit",
        alarmId: "h5",
        armSeq: main.armSeq,
        sourceKey: "monitor",
        payload: JSON.stringify({
          spec,
          notifications: 0,
          hit: { content: "DONE", terminal: false, detail: "line:1" },
        }),
        fireAt: armNow,
      }).pipe(Effect.timeout("15 seconds"), Effect.orDie);
      // Only AFTER that committed retirement: release the held timeout
      // occurrence through the entity\u2019s alarm RPC. `fireAt: armNow` makes the
      // envelope due NOW — the chain guard folds on occurrenceId/alarmId/
      // armSeq, not the instant — and the `stale` ack follows the committed
      // `<occurrenceId>:stale` fact.
      const late = yield* sendAlarm(sessionId, {
        occurrenceId: timeoutRow.occurrenceId,
        purpose: timeoutRow.purpose,
        alarmId: timeoutRow.alarmId,
        armSeq: timeoutRow.armSeq,
        sourceKey: timeoutRow.sourceKey,
        payload: timeoutRow.payload,
        fireAt: armNow,
      }).pipe(Effect.timeout("15 seconds"), Effect.orDie);
      return { main, timeoutRow, hit, late, armNow };
    }),
  );
  expect(outcome.hit).toMatchObject({ outcome: "delivered" });
  // The retired companion\u2019s late delivery folded to the recorded stale fact.
  expect(outcome.late).toMatchObject({ outcome: "stale" });
  // The timeout was armed at exactly `now + timeout_ms` (injected instants,
  // no elapsed-wall-clock assertion — r3 M2).
  expect(outcome.timeoutRow.fireAt).toBe(outcome.armNow + TIMEOUT_MS);
  // The entity forwarded both committed chains to the (held) DeliverAt door.
  expect([...heldForwards].sort()).toEqual(["h5", "h5:timeout"]);
  expect(installs).toEqual(["h5"]);
  // The exhausted hit\u2019s handler closed the native source exactly once; the
  // stale timeout fold ran zero handler effects.
  expect(closed).toEqual(["h5"]);
  // Durable facts: zero watch-plane rows survive; exactly ONE prompt
  // committed; the late timeout delivery folded to fired{stale}.
  const after = await runAgent(
    Effect.sync(() => {
      const catalog = openCatalogStore(catalogFile, { now: () => 1 });
      const store = openSessionStore(sessionFileFor(sessionsDir, sessionId), { now: () => 1 });
      try {
        const kernel = SessionHandleStore.createSessionKernel(store, catalog);
        return {
          armed: kernel.armedAlarms(),
          hitPrompt: kernel.actionById(`${outcome.main.occurrenceId}:prompt`),
          timeoutPrompt: kernel.actionById(`${outcome.timeoutRow.occurrenceId}:prompt`),
          timeoutStale: kernel.actionById(`${outcome.timeoutRow.occurrenceId}:stale`),
        };
      } finally {
        store.close();
        catalog.close();
      }
    }),
  );
  // Zero watch-plane rows survive (the entity\u2019s own passivation `resume`
  // chain is loop-reserved bookkeeping, not a monitor arm).
  expect(after.armed.filter((row) => row.sourceKey === "monitor")).toEqual([]);
  expect(after.hitPrompt?.kind).toBe("prompt");
  expect(after.hitPrompt?.effect.value).toMatchObject({ content: "DONE" });
  expect(after.timeoutPrompt).toBeUndefined();
  expect(after.timeoutStale?.kind).toBe("alarm");
});
