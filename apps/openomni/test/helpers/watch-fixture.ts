import { Bundle, Core } from "@openomni/agent";
import { Effect } from "effect";
import {
  blockingRunner,
  clusterMessages,
  clusterTempDir,
  runCluster,
  sendPrompt,
  waitUntil,
} from "../../../../packages/agent/test/helpers/cluster-runtime";
import { createAlarmMonitorPorts, createLiveArmRegistry } from "../../src/composition/alarm-plane";
import { cronPurposes } from "../../src/composition/bundles/cron";
import { monitorPurposes } from "../../src/composition/bundles/monitor";
import {
  createAppLedger,
  type AppLedgerPlane,
  type SessionKernel,
} from "../../src/composition/cluster-runtime";
import type { MonitorPorts } from "../../src/tools/core/watch";
import type { ArmedWatch, WatchSources } from "../../src/composition/watch-sources";
import { seedKernelPolicyRows } from "../../src/policy-seed";
import { runEffect } from "./effect";
import { adoptTestFence } from "./ledger";
import { testClock } from "./test-entropy";

interface WatchFixture {
  readonly plane: AppLedgerPlane;
  readonly kernel: SessionKernel;
  readonly fence: number;
  readonly sources: WatchSources;
  readonly installed: ArmedWatch[];
  readonly refreshed: ArmedWatch[];
  readonly closed: string[];
}

/** One real session and observable fake source lifecycle for monitor tests. */
export async function watchFixture(sessionId: string, owner: string): Promise<WatchFixture> {
  const plane = createAppLedger({ now: testClock() });
  const installed: ArmedWatch[] = [];
  const refreshed: ArmedWatch[] = [];
  const closed: string[] = [];
  const live = new Set<string>();
  const sources: WatchSources = {
    install: (spec) => {
      installed.push(spec);
      live.add(spec.id);
      return Promise.resolve();
    },
    refresh: (spec) => {
      if (!live.has(spec.id)) return false;
      refreshed.push(spec);
      return true;
    },
    observe: () => undefined,
    close: (id) => {
      closed.push(id);
      live.delete(id);
      return Promise.resolve();
    },
    closeAll: () => Promise.resolve(),
  };
  seedKernelPolicyRows(plane.catalog.policies);
  const kernel = plane.openKernel(sessionId);
  await runEffect(
    kernel.materialize({
      id: sessionId,
      parentId: null,
      role: "resident",
      tools: [],
      system: { preset: "", blocks: [] },
      policyGeneration: kernel.currentPolicyGeneration(),
      actionId: "configure",
      at: 1,
    }),
  );
  const fence = await runEffect(adoptTestFence(kernel, sessionId, owner));
  return { plane, kernel, fence, sources, installed, refreshed, closed };
}

/**
 * Pure fold seeding (#1254 r2 M2): commit one `alarm{arm}` LEDGER FACT
 * directly through the fixture's adopted fence. This seeds history for the
 * fold/projection tests only — it emulates no verb, schedules nothing and
 * notifies nobody; lifecycle behavior is tested through the real entity in
 * `withEntityAlarmPorts`.
 */
export async function commitArm(
  state: Pick<WatchFixture, "kernel" | "fence">,
  sessionId: string,
  input: {
    readonly purpose: string;
    readonly at: number | null;
    readonly alarmId: string;
    readonly supersedes?: string;
    readonly sourceKey: string;
    readonly payload: Parameters<typeof Core.armAction>[0]["payload"];
    readonly ts?: number;
  },
): Promise<{ readonly alarmId: string; readonly occurrenceId: string; readonly armSeq: number }> {
  const { kernel } = state;
  const row = kernel.row(sessionId);
  const owner = row.fenceOwner;
  if (owner === null) throw new Error(`fold seeding without an adopted fence: ${sessionId}`);
  const armSeq = row.revision + 1;
  const { action, occurrenceId } = Core.armAction({
    parentId: kernel.latestAction(sessionId)?.id ?? null,
    sessionId,
    purpose: input.purpose,
    at: input.at,
    supersedes: input.supersedes ?? null,
    alarmId: input.alarmId,
    sourceKey: input.sourceKey,
    payload: input.payload,
    armSeq,
    ts: input.ts ?? 1000,
  });
  await runEffect(
    kernel.commit({
      sessionId,
      owner,
      fence: state.fence,
      now: input.ts ?? 1000,
      expectedRevision: row.revision,
      actions: [action],
      state: row.state,
    }),
  );
  return { alarmId: input.alarmId, occurrenceId, armSeq };
}

/** Deterministic far-future clock base: every live arm schedules beyond the test's wall time. */
export const FIXTURE_BASE = 4_102_444_800_000;

/** What `withEntityAlarmPorts` hands the test body — the REAL entity is live underneath. */
export interface EntityAlarmFixture {
  readonly sessionId: string;
  /** The open (held) turn's id — the valid turn token for tool-facing arms. */
  readonly turnId: string;
  readonly catalogFile: string;
  readonly plane: AppLedgerPlane;
  readonly kernel: SessionKernel;
  readonly ports: MonitorPorts;
  readonly capability: Bundle.AlarmCapabilityDefinition;
  /** The production registry verb (not_live / stale_turn authority). */
  readonly registryArm: (sessionId: string, turnId: string) => Bundle.ArmVerb;
  /** The raw live entity verb, as the entity's own wake context holds it. */
  readonly entityArm: Core.ArmVerb;
  readonly installed: ArmedWatch[];
  readonly closed: string[];
}

/**
 * #1254 r2 M2: the alarm-plane lifecycle fixture over the REAL session entity.
 * One cluster activation holds a turn open (blocking detached runner), its
 * `onLive` verbs register in the production `createLiveArmRegistry`, and the
 * monitor ports commit every arm through the entity's one committing door.
 */
export async function withEntityAlarmPorts<A>(
  sessionId: string,
  body: (fx: EntityAlarmFixture) => Promise<A>,
): Promise<A> {
  const { sessionsDir, catalogFile } = clusterTempDir("entity-alarm-");
  const registry = createLiveArmRegistry();
  const rawVerbs = new Map<string, Core.ArmVerb>();
  const installed: ArmedWatch[] = [];
  const closed: string[] = [];
  const capability = await runEffect(
    Bundle.alarmCapability({
      bundles: [
        monitorPurposes({
          close: (id) => {
            closed.push(id);
          },
        }),
        cronPurposes(),
      ],
      compose: Core.composeAlarmPurposes,
      arm: registry.arm,
      watch: {
        install: ({ sessionId: armedSession, watchId, spec, occurrence }) =>
          Effect.sync(() => {
            installed.push({
              sessionId: armedSession,
              id: watchId,
              occurrence,
              base: { spec, notifications: 0 },
            });
          }),
      },
    }),
  );
  const plane = createAppLedger({ now: () => FIXTURE_BASE, catalogPath: catalogFile, sessionsDir });
  try {
    return await runCluster(
      {
        sessionsDir,
        catalogFile,
        clock: () => FIXTURE_BASE,
        runner: blockingRunner(() => undefined),
        detachTurns: true,
        alarmCapability: capability,
        // Mirrors the app root's onArmed follower (#1254 H1): a retiring
        // monitor.hit arm closes the native handle at the commit.
        onArmed: (notice) => {
          if (notice.purpose !== Bundle.MONITOR_HIT || notice.at !== null) return;
          closed.push(notice.alarmId);
        },
        onLive: (id, verbs) => {
          rawVerbs.set(id, verbs.arm);
          const release = registry.onLive(id, verbs);
          return () => {
            rawVerbs.delete(id);
            release();
          };
        },
      },
      Effect.gen(function* () {
        // The held prompt turn: boundary committed (the send acks), body open.
        yield* sendPrompt(sessionId, `${sessionId}:hold`, "hold the turn open");
        const entityArm = rawVerbs.get(sessionId);
        if (entityArm === undefined)
          return yield* Effect.die(new Error(`no live activation for ${sessionId}`));
        const ports = createAlarmMonitorPorts({
          capability,
          openKernel: plane.openKernel,
          clock: () => FIXTURE_BASE,
          entropy: () => "minted",
          run: (effect) => runEffect(effect),
        });
        return yield* Effect.promise(() =>
          body({
            sessionId,
            turnId: `${sessionId}:hold:turn`,
            catalogFile,
            plane,
            kernel: plane.openKernel(sessionId),
            ports,
            capability,
            registryArm: registry.arm,
            entityArm,
            installed,
            closed,
          }),
        );
      }),
    );
  } finally {
    plane.close();
  }
}

/**
 * Bounded wait for the entity's forked DeliverAt forward: polls the durable
 * cluster mailbox until an Alarm envelope with `deliver_at` lands (the commit
 * is sync, the schedule send is a fork — this is the only async edge).
 */
export function awaitScheduled(catalogFile: string, deliverAt: number): Promise<void> {
  return waitUntil(
    `scheduled Alarm envelope with deliver_at ${deliverAt}`,
    () => scheduledAt(catalogFile, deliverAt),
    5_000,
  );
}

/** True when some Alarm envelope carries the given deliver_at (deny-path zero checks). */
export function scheduledAt(catalogFile: string, deliverAt: number): boolean {
  return clusterMessages(catalogFile, "Session").some(
    (row) => row.tag === "Alarm" && row.deliver_at === deliverAt,
  );
}
