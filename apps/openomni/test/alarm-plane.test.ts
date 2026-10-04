import { expect, test } from "bun:test";
import { Core } from "@openomni/agent";
import { Effect } from "effect";
import {
  alarmChainReads,
  createLiveArmRegistry,
  foldAlarmChains,
  watchStateOf,
} from "../src/composition/alarm-plane";
import { runEffect } from "./helpers/effect";
import {
  awaitScheduled,
  commitArm,
  FIXTURE_BASE,
  watchFixture,
  withEntityAlarmPorts,
} from "./helpers/watch-fixture";

const OWNER = "alarm-plane-owner";
const SESSION = "alarm-plane-session";

const watchSpec = (notificationLimit: number) => ({
  watch: { command: "true", description: "coverage", persistent: true as const },
  policyGeneration: 1,
  notificationLimit,
});

test("the live arm registry binds continuations to the authorizing activation's turn (H3)", async () => {
  const registry = createLiveArmRegistry();
  const armInput = {
    purpose: "monitor.hit",
    at: 1000,
    alarmId: "watch-1",
    sourceKey: "monitor",
    payload: {},
  };
  // No live activation: the app path commits nothing and refuses typed.
  const refused = await runEffect(Effect.flip(registry.arm(SESSION, "t1")(armInput)));
  expect(refused.code).toBe("not_live");
  // A registered activation's verb commits only for the turn it owns.
  const calls: string[] = [];
  const verbOf =
    (occurrenceId: string): Core.ArmVerb =>
    (input) =>
      Effect.sync(() => {
        calls.push(occurrenceId);
        return { alarmId: input.alarmId ?? "minted", occurrenceId, armSeq: 1 };
      });
  const release = registry.onLive(SESSION, {
    arm: verbOf("occ-old"),
    ownsTurn: (turnId) => turnId === "t1",
  });
  // A continuation minted under the old activation's turn t1 — NOT yet executed.
  const continuation = registry.arm(SESSION, "t1")(armInput);
  // The successor activation registers; it owns t2, never t1.
  registry.onLive(SESSION, { arm: verbOf("occ-new"), ownsTurn: (turnId) => turnId === "t2" });
  // Executing the stale continuation refuses stale_turn: it is never
  // re-resolved to the successor and NEITHER verb commits anything.
  expect((await runEffect(Effect.flip(continuation))).code).toBe("stale_turn");
  expect(calls).toEqual([]);
  // The successor's own turn commits through the successor's verb.
  expect((await runEffect(registry.arm(SESSION, "t2")(armInput))).occurrenceId).toBe("occ-new");
  expect(calls).toEqual(["occ-new"]);
  // A stale release (prior activation) never evicts the newer registration.
  release();
  expect((await runEffect(registry.arm(SESSION, "t2")(armInput))).occurrenceId).toBe("occ-new");
  // Another session stays not_live.
  expect((await runEffect(Effect.flip(registry.arm("other-session", "t2")(armInput)))).code).toBe(
    "not_live",
  );
});

test("the chain fold pages full history and feeds the chain-guard reads", async () => {
  const state = await watchFixture(SESSION, OWNER);
  try {
    const first = await commitArm(state, SESSION, {
      purpose: "monitor.hit",
      at: 1000,
      alarmId: "paged",
      sourceKey: "monitor",
      payload: { spec: watchSpec(400), notifications: 0 },
    });
    // One 300-row fired batch pushes the second arm past the first history page.
    const row = state.kernel.row(SESSION);
    await runEffect(
      state.kernel.commit({
        sessionId: SESSION,
        owner: OWNER,
        fence: state.fence,
        now: 3000,
        expectedRevision: row.revision,
        actions: Array.from({ length: 300 }, (_: undefined, index) =>
          Core.firedAction({
            parentId: null,
            sessionId: SESSION,
            purpose: "monitor.hit",
            alarmId: "paged",
            occurrenceId: `${first.occurrenceId}:${index}`,
            outcome: "delivered",
            ts: 2000 + index,
          }),
        ),
        state: row.state,
      }),
    );
    const second = await commitArm(state, SESSION, {
      purpose: "monitor.hit",
      at: 4000,
      alarmId: "paged",
      supersedes: first.occurrenceId,
      sourceKey: "monitor",
      payload: { spec: watchSpec(400), notifications: 300 },
      ts: 4000,
    });
    const chain = foldAlarmChains(state.kernel, SESSION).get("paged");
    expect(chain?.latest.occurrenceId).toBe(second.occurrenceId);
    expect(chain?.armCount).toBe(2);
    expect(chain?.delivered).toBe(300);
    const reads = alarmChainReads(state.kernel, SESSION);
    expect(reads.latestArm("paged")).toEqual({ occurrenceId: second.occurrenceId, at: 4000 });
    expect(reads.settled(`${first.occurrenceId}:5`)).toBe(true);
    expect(reads.settled(second.occurrenceId)).toBe(false);
  } finally {
    state.plane.close();
  }
});

test("watchStateOf projects armed and retired chains from the latest arm payload", async () => {
  const state = await watchFixture(SESSION, OWNER);
  try {
    const armed = await commitArm(state, SESSION, {
      purpose: "monitor.hit",
      at: 1500,
      alarmId: "proj",
      sourceKey: "monitor",
      payload: { spec: watchSpec(4), notifications: 2 },
    });
    const chains = () => foldAlarmChains(state.kernel, SESSION);
    const live = chains().get("proj");
    if (live === undefined) throw new Error("missing chain");
    expect(watchStateOf(live, SESSION)).toMatchObject({
      id: "proj",
      kind: "watch",
      status: "armed",
      fireAt: 1500,
      notifications: 2,
      occurrenceId: armed.occurrenceId,
    });
    for (const [reason, status] of [
      ["cancel", "cancelled"],
      // #1254 r2 H2: the watch verb's create compensation retires with this reason.
      ["create", "cancelled"],
      ["exhausted", "exhausted"],
      ["fired", "fired"],
      ["timeout", "fired"],
    ] as const) {
      await commitArm(state, SESSION, {
        purpose: "monitor.hit",
        at: null,
        alarmId: "proj",
        supersedes: armed.occurrenceId,
        sourceKey: "monitor",
        payload: { reason },
      });
      const retired = chains().get("proj");
      if (retired === undefined) throw new Error("missing chain");
      expect(watchStateOf(retired, SESSION)).toMatchObject({ status, fireAt: null });
    }
    const cron = await commitArm(state, SESSION, {
      purpose: "cron.tick",
      at: 9000,
      alarmId: "tick",
      sourceKey: "cron",
      payload: { expr: "*/5 * * * *", tz: "UTC", description: "grid" },
    });
    const cronChain = chains().get("tick");
    if (cronChain === undefined) throw new Error("missing cron chain");
    expect(watchStateOf(cronChain, SESSION)).toMatchObject({
      kind: "cron",
      status: "armed",
      occurrenceId: cron.occurrenceId,
    });
  } finally {
    state.plane.close();
  }
});

test("monitor ports drive the watch lifecycle through the real entity's committing verb", async () => {
  await withEntityAlarmPorts("entity-lifecycle-session", async (fx) => {
    const signal = new AbortController().signal;
    const created = await fx.ports.create(
      {
        sessionId: fx.sessionId,
        turnId: fx.turnId,
        id: "lifecycle",
        kind: "watch",
        spec: {
          watch: { command: "true", description: "timed", timeout_ms: 500 },
          policyGeneration: 1,
          notificationLimit: 2,
        },
      },
      signal,
    );
    expect(created).toMatchObject({
      id: "lifecycle",
      kind: "watch",
      status: "armed",
      fireAt: FIXTURE_BASE,
      notifications: 0,
    });
    expect(fx.installed.map((spec) => spec.id)).toEqual(["lifecycle"]);
    // The timed watch armed its timeout chain; the ENTITY forwarded the
    // non-hit occurrence through the durable DeliverAt door.
    const timeoutChain = foldAlarmChains(fx.kernel, fx.sessionId).get("lifecycle:timeout");
    expect(timeoutChain?.latest.at).toBe(FIXTURE_BASE + 500);
    await awaitScheduled(fx.catalogFile, FIXTURE_BASE + 500);
    // A continuation under a turn the live activation does not own is
    // refused by the production registry — the entity appends nothing.
    const stale = await runEffect(
      Effect.flip(
        fx.registryArm(fx.sessionId, "some-other-turn")({
          purpose: "monitor.hit",
          at: FIXTURE_BASE + 9_000,
          alarmId: "stale-arm",
          sourceKey: "monitor",
          payload: {},
        }),
      ),
    );
    expect(stale.code).toBe("stale_turn");
    expect(foldAlarmChains(fx.kernel, fx.sessionId).get("stale-arm")).toBeUndefined();
    // Rearm of a live watch is a no-op: the armed chain stands.
    expect(
      await fx.ports.rearm("lifecycle", fx.sessionId, fx.turnId, FIXTURE_BASE, signal),
    ).toMatchObject({ status: "armed", occurrenceId: created.occurrenceId });
    // A chain the session never armed is refused, not cancelled.
    await expect(
      fx.ports.cancel("ghost", fx.sessionId, fx.turnId, FIXTURE_BASE, signal),
    ).rejects.toMatchObject({ _tag: "MonitorRefused" });
    const cancelled = await fx.ports.cancel("lifecycle", fx.sessionId, fx.turnId, FIXTURE_BASE, signal);
    expect(cancelled).toMatchObject({ status: "cancelled", fireAt: null });
    expect(fx.closed).toEqual(["lifecycle"]);
    // The timeout chain retired with its watch.
    const timeout = foldAlarmChains(fx.kernel, fx.sessionId).get("lifecycle:timeout");
    expect(timeout?.latest).toMatchObject({ at: null, payload: { reason: "cancel" } });
    // Rearm revives the retired chain from its last sealed spec and reinstalls.
    const revived = await fx.ports.rearm("lifecycle", fx.sessionId, fx.turnId, FIXTURE_BASE, signal);
    expect(revived).toMatchObject({ status: "armed", notifications: 0 });
    expect(revived.occurrenceId).not.toBe(created.occurrenceId);
    expect(fx.installed.map((spec) => spec.id)).toEqual(["lifecycle", "lifecycle"]);
  });
});

test("monitor ports arm and revive a cron chain on its grid through the real entity", async () => {
  await withEntityAlarmPorts("entity-cron-session", async (fx) => {
    const signal = new AbortController().signal;
    const created = await fx.ports.create(
      {
        sessionId: fx.sessionId,
        turnId: fx.turnId,
        id: "grid",
        kind: "cron",
        expr: "*/5 * * * *",
        tz: "UTC",
        description: "five",
      },
      signal,
    );
    // FIXTURE_BASE sits on a five-minute boundary; the next tick is +5min.
    expect(created).toMatchObject({
      id: "grid",
      kind: "cron",
      status: "armed",
      fireAt: FIXTURE_BASE + 300_000,
    });
    await awaitScheduled(fx.catalogFile, FIXTURE_BASE + 300_000);
    // Native sources never track cron chains.
    expect(fx.installed).toEqual([]);
    const cancelled = await fx.ports.cancel("grid", fx.sessionId, fx.turnId, FIXTURE_BASE, signal);
    expect(cancelled).toMatchObject({ status: "cancelled", fireAt: null });
    const revived = await fx.ports.rearm(
      "grid",
      fx.sessionId,
      fx.turnId,
      FIXTURE_BASE + 400_000,
      signal,
    );
    expect(revived).toMatchObject({ status: "armed", fireAt: FIXTURE_BASE + 600_000 });
    await awaitScheduled(fx.catalogFile, FIXTURE_BASE + 600_000);
  });
});
