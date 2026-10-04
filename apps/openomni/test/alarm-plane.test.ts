import { expect, test } from "bun:test";
import { type Bundle, Core } from "@openomni/agent";
import { Effect } from "effect";
import {
  alarmChainReads,
  createLiveArmRegistry,
  foldAlarmChains,
  watchStateOf,
} from "../src/composition/alarm-plane";
import { runEffect } from "./helpers/effect";
import {
  alarmPortsFixture,
  fixtureEntityArmVerb,
  watchFixture,
  type FixtureArmNotice,
  type FixtureScheduledOccurrence,
} from "./helpers/watch-fixture";

const OWNER = "alarm-plane-owner";
const SESSION = "alarm-plane-session";

const watchSpec = (notificationLimit: number) => ({
  watch: { command: "true", description: "coverage", persistent: true as const },
  policyGeneration: 1,
  notificationLimit,
});

interface Plane {
  readonly state: Awaited<ReturnType<typeof watchFixture>>;
  readonly scheduled: FixtureScheduledOccurrence[];
  readonly notices: FixtureArmNotice[];
  readonly arm: (sessionId: string) => Bundle.ArmVerb;
}

async function armFixture(): Promise<Plane> {
  const state = await watchFixture(SESSION, OWNER);
  const scheduled: FixtureScheduledOccurrence[] = [];
  const notices: FixtureArmNotice[] = [];
  const arm = fixtureEntityArmVerb({
    openKernel: state.plane.openKernel,
    clock: () => 1000,
    entropy: () => "minted",
    schedule: (_sessionId, occurrence) => void scheduled.push(occurrence),
    onArm: (notice) => notices.push(notice),
  });
  return { state, scheduled, notices, arm };
}

test("the fixture entity verb commits one chain row, schedules non-monitor purposes, and notifies onArm", async () => {
  const { state, scheduled, notices, arm } = await armFixture();
  try {
    const hit = await runEffect(
      arm(SESSION)({
        purpose: "monitor.hit",
        at: 1000,
        alarmId: "watch-1",
        sourceKey: "monitor",
        payload: { spec: watchSpec(2), notifications: 0 },
      }),
    );
    expect(hit.alarmId).toBe("watch-1");
    // A monitor.hit arm is never scheduled: its native source resends it.
    expect(scheduled).toEqual([]);
    expect(notices).toMatchObject([
      { purpose: "monitor.hit", alarmId: "watch-1", at: 1000, occurrenceId: hit.occurrenceId },
    ]);
    const timed = await runEffect(
      arm(SESSION)({
        purpose: "monitor.timeout",
        at: 2000,
        alarmId: "watch-1:timeout",
        sourceKey: "monitor",
        payload: { watchId: "watch-1" },
      }),
    );
    expect(scheduled).toMatchObject([
      {
        occurrenceId: timed.occurrenceId,
        purpose: "monitor.timeout",
        alarmId: "watch-1:timeout",
        fireAt: 2000,
        payload: JSON.stringify({ watchId: "watch-1" }),
      },
    ]);
    // A retiring arm (at: null) is recorded, never scheduled.
    await runEffect(
      arm(SESSION)({
        purpose: "monitor.hit",
        at: null,
        alarmId: "watch-1",
        supersedes: hit.occurrenceId,
        sourceKey: "monitor",
        payload: { reason: "cancel" },
      }),
    );
    expect(scheduled).toHaveLength(1);
    const chains = foldAlarmChains(state.kernel, SESSION);
    expect(chains.get("watch-1")?.latest).toMatchObject({
      at: null,
      supersedes: hit.occurrenceId,
      payload: { reason: "cancel" },
    });
    expect(chains.get("watch-1")?.armCount).toBe(2);
    // An omitted alarmId mints one from entropy.
    const minted = await runEffect(
      arm(SESSION)({ purpose: "cron.tick", at: 5000, sourceKey: "cron", payload: {} }),
    );
    expect(minted.alarmId).toBe("minted");
  } finally {
    state.plane.close();
  }
});

test("the live arm registry delegates to the registered activation verb and refuses not_live otherwise (H3)", async () => {
  const registry = createLiveArmRegistry();
  const armInput = {
    purpose: "monitor.hit",
    at: 1000,
    alarmId: "watch-1",
    sourceKey: "monitor",
    payload: {},
  };
  // No live activation: the app path commits nothing and refuses typed.
  const refused = await runEffect(Effect.flip(registry.arm(SESSION)(armInput)));
  expect(refused.code).toBe("not_live");
  // A registered activation's verb is the one committing path.
  const verbOf = (occurrenceId: string): Core.ArmVerb => (input) =>
    Effect.succeed({ alarmId: input.alarmId ?? "minted", occurrenceId, armSeq: 1 });
  const release = registry.onLive(SESSION, { arm: verbOf("occ-1") });
  expect((await runEffect(registry.arm(SESSION)(armInput))).occurrenceId).toBe("occ-1");
  // Another session stays not_live.
  const other = await runEffect(Effect.flip(registry.arm("other-session")(armInput)));
  expect(other.code).toBe("not_live");
  // Passivation releases the verb.
  release();
  expect((await runEffect(Effect.flip(registry.arm(SESSION)(armInput)))).code).toBe("not_live");
  // A stale release (prior activation) never evicts the newer registration.
  const first = registry.onLive(SESSION, { arm: verbOf("occ-old") });
  registry.onLive(SESSION, { arm: verbOf("occ-new") });
  first();
  expect((await runEffect(registry.arm(SESSION)(armInput))).occurrenceId).toBe("occ-new");
});

test("the chain fold pages full history and feeds the chain-guard reads", async () => {
  const { state, arm } = await armFixture();
  try {
    const first = await runEffect(
      arm(SESSION)({
        purpose: "monitor.hit",
        at: 1000,
        alarmId: "paged",
        sourceKey: "monitor",
        payload: { spec: watchSpec(400), notifications: 0 },
      }),
    );
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
    const second = await runEffect(
      arm(SESSION)({
        purpose: "monitor.hit",
        at: 4000,
        alarmId: "paged",
        supersedes: first.occurrenceId,
        sourceKey: "monitor",
        payload: { spec: watchSpec(400), notifications: 300 },
      }),
    );
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
  const { state, arm } = await armFixture();
  try {
    const armed = await runEffect(
      arm(SESSION)({
        purpose: "monitor.hit",
        at: 1500,
        alarmId: "proj",
        sourceKey: "monitor",
        payload: { spec: watchSpec(4), notifications: 2 },
      }),
    );
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
      ["exhausted", "exhausted"],
      ["fired", "fired"],
      ["timeout", "fired"],
    ] as const) {
      await runEffect(
        arm(SESSION)({
          purpose: "monitor.hit",
          at: null,
          alarmId: "proj",
          supersedes: armed.occurrenceId,
          sourceKey: "monitor",
          payload: { reason },
        }),
      );
      const retired = chains().get("proj");
      if (retired === undefined) throw new Error("missing chain");
      expect(watchStateOf(retired, SESSION)).toMatchObject({ status, fireAt: null });
    }
    const cron = await runEffect(
      arm(SESSION)({
        purpose: "cron.tick",
        at: 9000,
        alarmId: "tick",
        sourceKey: "cron",
        payload: { expr: "*/5 * * * *", tz: "UTC", description: "grid" },
      }),
    );
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

test("monitor ports drive the watch lifecycle as chain facts plus native handles", async () => {
  const { state, scheduled, ports } = await alarmPortsFixture({ sessionId: SESSION, owner: OWNER });
  const signal = new AbortController().signal;
  try {
    const created = await ports.create(
      {
        sessionId: SESSION,
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
      fireAt: 1000,
      notifications: 0,
    });
    expect(state.installed.map((spec) => spec.id)).toEqual(["lifecycle"]);
    // The timed watch armed its timeout chain as a scheduled occurrence.
    expect(scheduled).toMatchObject([
      { purpose: "monitor.timeout", alarmId: "lifecycle:timeout", fireAt: 1500 },
    ]);
    // Rearm of a live watch is a no-op: the armed chain stands.
    expect(await ports.rearm("lifecycle", SESSION, 1000, signal)).toMatchObject({
      status: "armed",
    });
    // A chain the session never armed is refused, not cancelled.
    await expect(ports.cancel("ghost", SESSION, 1000, signal)).rejects.toMatchObject({
      _tag: "MonitorRefused",
    });
    const cancelled = await ports.cancel("lifecycle", SESSION, 1000, signal);
    expect(cancelled).toMatchObject({ status: "cancelled", fireAt: null });
    expect(state.closed).toEqual(["lifecycle"]);
    // The timeout chain retired with its watch.
    const timeout = foldAlarmChains(state.kernel, SESSION).get("lifecycle:timeout");
    expect(timeout?.latest).toMatchObject({ at: null, payload: { reason: "cancel" } });
    // Rearm revives the retired chain from its last sealed spec and reinstalls.
    const revived = await ports.rearm("lifecycle", SESSION, 1000, signal);
    expect(revived).toMatchObject({ status: "armed", notifications: 0 });
    expect(state.installed.map((spec) => spec.id)).toEqual(["lifecycle", "lifecycle"]);
  } finally {
    state.plane.close();
  }
});

test("monitor ports arm and revive a cron chain on its grid", async () => {
  const { state, scheduled, ports } = await alarmPortsFixture({ sessionId: SESSION, owner: OWNER });
  const signal = new AbortController().signal;
  try {
    const created = await ports.create(
      { sessionId: SESSION, id: "grid", kind: "cron", expr: "*/5 * * * *", tz: "UTC", description: "five" },
      signal,
    );
    expect(created).toMatchObject({ id: "grid", kind: "cron", status: "armed", fireAt: 300_000 });
    expect(scheduled).toMatchObject([
      { purpose: "cron.tick", alarmId: "grid", fireAt: 300_000 },
    ]);
    // Native sources never track cron chains.
    expect(state.installed).toEqual([]);
    const cancelled = await ports.cancel("grid", SESSION, 1000, signal);
    expect(cancelled).toMatchObject({ status: "cancelled", fireAt: null });
    const revived = await ports.rearm("grid", SESSION, 400_000, signal);
    expect(revived).toMatchObject({ status: "armed", fireAt: 600_000 });
    expect(scheduled).toHaveLength(2);
  } finally {
    state.plane.close();
  }
});
