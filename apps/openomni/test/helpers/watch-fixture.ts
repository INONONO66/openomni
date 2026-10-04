import { Bundle, Core } from "@openomni/agent";
import { Effect } from "effect";
import { createAlarmMonitorPorts } from "../../src/composition/alarm-plane";
import { cronPurposes } from "../../src/composition/bundles/cron";
import { monitorPurposes } from "../../src/composition/bundles/monitor";
import { createAppLedger, type AppLedgerPlane, type SessionKernel } from "../../src/composition/cluster-runtime";
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

/** What one scheduled (non-`monitor.hit`) arm sends through the DeliverAt door. */
export interface FixtureScheduledOccurrence {
  readonly occurrenceId: string;
  readonly purpose: string;
  readonly alarmId: string;
  readonly armSeq: number;
  readonly sourceKey: string;
  readonly payload: string;
  readonly fireAt: number;
}

/** Everything a committed `alarm{arm}` row carries, surfaced to the fixture hook. */
export interface FixtureArmNotice {
  readonly sessionId: string;
  readonly purpose: string;
  readonly alarmId: string;
  readonly occurrenceId: string;
  readonly armSeq: number;
  readonly at: number | null;
  readonly supersedes: string | null;
  readonly payload: Parameters<typeof Core.armAction>[0]["payload"];
}

/**
 * #1254 H3: the production app no longer commits arm rows — every app-side
 * arm delegates to the live activation's entity verb. These unit fixtures
 * have no entity, so this verb EMULATES the entity's committing arm (one
 * chain row through the kernel, schedule of non-`monitor.hit` live arms,
 * post-commit notice) against the fixture's adopted fence.
 */
export function fixtureEntityArmVerb(deps: {
  readonly openKernel: (sessionId: string) => SessionKernel;
  readonly clock: () => number;
  readonly entropy: () => string;
  readonly schedule: (sessionId: string, occurrence: FixtureScheduledOccurrence) => void;
  readonly onArm?: (notice: FixtureArmNotice) => void;
}): (sessionId: string) => Bundle.ArmVerb {
  return (sessionId) => (input) =>
    Effect.gen(function* () {
      const kernel = deps.openKernel(sessionId);
      const alarmId = input.alarmId ?? deps.entropy();
      const row = kernel.row(sessionId);
      if (row.fenceOwner === null)
        return yield* Effect.die(new Error(`fixture arm without an adopted fence: ${sessionId}`));
      const armSeq = row.revision + 1;
      const { action, occurrenceId } = Core.armAction({
        parentId: kernel.latestAction(sessionId)?.id ?? null,
        sessionId,
        purpose: input.purpose,
        at: input.at,
        supersedes: input.supersedes ?? null,
        alarmId,
        sourceKey: input.sourceKey,
        payload: input.payload,
        armSeq,
        ts: deps.clock(),
      });
      yield* kernel
        .commit({
          sessionId,
          owner: row.fenceOwner,
          fence: row.fence,
          now: deps.clock(),
          expectedRevision: row.revision,
          actions: [action],
          state: row.state,
        })
        .pipe(Effect.orDie);
      if (input.at !== null && input.purpose !== Bundle.MONITOR_HIT)
        deps.schedule(sessionId, {
          occurrenceId,
          purpose: input.purpose,
          alarmId,
          armSeq,
          sourceKey: input.sourceKey,
          payload: JSON.stringify(input.payload),
          fireAt: input.at,
        });
      deps.onArm?.({
        sessionId,
        purpose: input.purpose,
        alarmId,
        occurrenceId,
        armSeq,
        at: input.at,
        supersedes: input.supersedes ?? null,
        payload: input.payload,
      });
      return { alarmId, occurrenceId, armSeq };
    });
}

/** Shared composition of the real capability over a fixture plane (#1254). */
export async function alarmPortsFixture(input: {
  readonly sessionId: string;
  readonly owner: string;
}) {
  const state = await watchFixture(input.sessionId, input.owner);
  const scheduled: FixtureScheduledOccurrence[] = [];
  const notices: FixtureArmNotice[] = [];
  const arm = fixtureEntityArmVerb({
    openKernel: state.plane.openKernel,
    clock: () => 1000,
    entropy: () => "minted",
    schedule: (_sessionId, occurrence) => void scheduled.push(occurrence),
    onArm: (notice) => {
      notices.push(notice);
      if (notice.purpose !== Bundle.MONITOR_HIT) return;
      if (notice.at === null) {
        void state.sources.close(notice.alarmId);
        return;
      }
      const payload = Bundle.WatchHitPayload.safeParse(notice.payload);
      if (!payload.success) return;
      const armedWatch: ArmedWatch = {
        sessionId: notice.sessionId,
        id: notice.alarmId,
        occurrence: {
          occurrenceId: notice.occurrenceId,
          alarmId: notice.alarmId,
          armSeq: notice.armSeq,
        },
        base: { spec: payload.data.spec, notifications: payload.data.notifications },
      };
      state.sources.refresh(armedWatch);
    },
  });
  const capability = await runEffect(
    Bundle.alarmCapability({
      bundles: [
        monitorPurposes({ close: (id) => void state.sources.close(id) }),
        cronPurposes(),
      ],
      compose: Core.composeAlarmPurposes,
      arm,
      watch: {
        install: ({ sessionId, watchId, spec, occurrence }) =>
          Effect.tryPromise({
            try: () =>
              state.sources.install({
                sessionId,
                id: watchId,
                occurrence,
                base: { spec, notifications: 0 },
              }),
            catch: (error) =>
              new Bundle.WatchRefused({
                reason: error instanceof Error ? error.message : String(error),
              }),
          }),
      },
    }),
  );
  const ports = createAlarmMonitorPorts({
    capability,
    openKernel: state.plane.openKernel,
    clock: () => 1000,
    entropy: () => "minted",
    run: (effect) => runEffect(effect),
  });
  return { state, scheduled, notices, arm, capability, ports };
}
