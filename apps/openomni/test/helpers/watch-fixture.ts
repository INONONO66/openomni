import { Bundle, Core } from "@openomni/agent";
import { Effect } from "effect";
import {
  createAlarmArmVerb,
  createAlarmMonitorPorts,
  type ArmNotice,
  type ScheduledOccurrence,
} from "../../src/composition/alarm-plane";
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

/** Shared composition of the real capability over a fixture plane (#1254). */
export async function alarmPortsFixture(input: {
  readonly sessionId: string;
  readonly owner: string;
  /** #1254 S4: ctx.prompt — defaults to a silent verb for ports-only tests. */
  readonly prompt?: Bundle.AlarmPromptVerb;
}) {
  const state = await watchFixture(input.sessionId, input.owner);
  const scheduled: ScheduledOccurrence[] = [];
  const notices: ArmNotice[] = [];
  const prompt = input.prompt ?? (() => Effect.succeed({ seq: 0 }));
  const arm = createAlarmArmVerb({
    openKernel: state.plane.openKernel,
    clock: () => 1000,
    entropy: () => "minted",
    schedule: (_sessionId, occurrence) => Effect.sync(() => void scheduled.push(occurrence)),
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
      if (!state.sources.refresh(armedWatch)) void state.sources.install(armedWatch);
    },
  });
  const capability = await runEffect(
    Bundle.alarmCapability({
      bundles: [
        monitorPurposes({ prompt, close: (id) => void state.sources.close(id) }),
        cronPurposes({ prompt }),
      ],
      compose: Core.composeAlarmPurposes,
      arm,
      watch: { install: () => Effect.void },
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
