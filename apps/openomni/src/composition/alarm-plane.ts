import { Bundle, Core } from "@openomni/agent";
import { Alarm, Cron, type LedgerAction, type PlainObject, PlainObjectSchema } from "@openomni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import { MonitorRefused, type MonitorPorts, type WatchState } from "../tools/core/watch";
import { CRON_SOURCE, CRON_TICK, CronPayload } from "./bundles/cron";
import type { SessionKernel } from "./cluster-runtime";

/**
 * The app's alarm plane (#1254): every lifecycle fact is one `alarm{arm}` /
 * `alarm{fired}` chain row from the core writers, folded on read — no epochs,
 * no process memory. The committing `arm` verb below is what the composition
 * injects into `Bundle.alarmCapability`; the capability only guards purposes
 * and delegates here.
 *
 * Interim at this sha: scheduled occurrences are sent through the entity's
 * `alarm` door where unregistered purposes fold to recorded stale facts —
 * Lane 4 wires the wake dispatch that consumes them (S4).
 */

const ArmIntent = z.object({
  op: z.literal("arm"),
  purpose: z.string(),
  at: z.number().nullable(),
  supersedes: z.string().nullable(),
  alarmId: z.string(),
  sourceKey: z.string(),
  payload: PlainObjectSchema,
});

const FiredIntent = z.object({
  op: z.literal("fired"),
  occurrenceId: z.string(),
  outcome: z.enum(["delivered", "stale", "exhausted"]),
  alarmId: z.string(),
});

/** One folded arm row: the chain's current (or final) occurrence for its alarm. */
interface AlarmArmRow {
  readonly occurrenceId: string;
  readonly purpose: string;
  readonly at: number | null;
  readonly supersedes: string | null;
  readonly sourceKey: string;
  readonly payload: PlainObject;
  readonly ts: number;
  readonly actionId: string;
}

/** One alarm chain folded from committed history. */
export interface AlarmChainView {
  readonly alarmId: string;
  readonly latest: AlarmArmRow;
  readonly firstTs: number;
  readonly lastTs: number;
  readonly armCount: number;
  readonly delivered: number;
  readonly settled: ReadonlySet<string>;
}

/** Pure fold of a session's alarm chains from paged committed history. */
export function foldAlarmChains(
  kernel: SessionKernel,
  sessionId: string,
): ReadonlyMap<string, AlarmChainView> {
  interface Mutable {
    alarmId: string;
    latest: AlarmArmRow;
    firstTs: number;
    lastTs: number;
    armCount: number;
    delivered: number;
    settled: Set<string>;
  }
  const chains = new Map<string, Mutable>();
  let after = 0;
  for (;;) {
    const page = kernel.historyPage(sessionId, { afterRevision: after });
    for (const action of page.actions) {
      if (action.kind !== "alarm") continue;
      foldAlarmAction(chains, action);
    }
    if (page.nextRevision === null) return chains;
    after = page.nextRevision;
  }
}

function foldAlarmAction(
  chains: Map<
    string,
    {
      alarmId: string;
      latest: AlarmArmRow;
      firstTs: number;
      lastTs: number;
      armCount: number;
      delivered: number;
      settled: Set<string>;
    }
  >,
  action: LedgerAction.Node,
): void {
  const arm = ArmIntent.safeParse(action.intent.value);
  if (arm.success) {
    const effect = action.effect.value;
    const occurrenceId =
      effect !== null && typeof effect === "object" && !Array.isArray(effect)
        ? effect.occurrenceId
        : undefined;
    if (typeof occurrenceId !== "string") return;
    const row: AlarmArmRow = {
      occurrenceId,
      purpose: arm.data.purpose,
      at: arm.data.at,
      supersedes: arm.data.supersedes,
      sourceKey: arm.data.sourceKey,
      payload: arm.data.payload,
      ts: action.ts,
      actionId: action.id,
    };
    const existing = chains.get(arm.data.alarmId);
    if (existing === undefined) {
      chains.set(arm.data.alarmId, {
        alarmId: arm.data.alarmId,
        latest: row,
        firstTs: action.ts,
        lastTs: action.ts,
        armCount: 1,
        delivered: 0,
        settled: new Set(),
      });
      return;
    }
    existing.latest = row;
    existing.lastTs = Math.max(existing.lastTs, action.ts);
    existing.armCount += 1;
    return;
  }
  const fired = FiredIntent.safeParse(action.intent.value);
  if (!fired.success) return;
  const chain = chains.get(fired.data.alarmId);
  if (chain === undefined) return;
  chain.lastTs = Math.max(chain.lastTs, action.ts);
  if (fired.data.outcome === "stale") return;
  chain.settled.add(fired.data.occurrenceId);
  if (fired.data.outcome === "delivered") chain.delivered += 1;
}

/** `Core.AlarmChainReads` over the fold: what the chain guard consults at delivery. */
export function alarmChainReads(kernel: SessionKernel, sessionId: string): Core.AlarmChainReads {
  const chains = foldAlarmChains(kernel, sessionId);
  const settled = new Set<string>();
  for (const chain of chains.values()) for (const id of chain.settled) settled.add(id);
  return {
    latestArm: (alarmId) => {
      const chain = chains.get(alarmId);
      return chain === undefined
        ? undefined
        : { occurrenceId: chain.latest.occurrenceId, at: chain.latest.at };
    },
    settled: (occurrenceId) => settled.has(occurrenceId),
  };
}

const ARM_COMMIT_RETRIES = 5;

/** The full occurrence record one scheduled arm sends through the entity's `alarm` door. */
export interface ScheduledOccurrence {
  readonly occurrenceId: string;
  readonly purpose: string;
  readonly alarmId: string;
  readonly armSeq: number;
  readonly sourceKey: string;
  readonly payload: string;
  readonly fireAt: number;
}

/** Everything a committed `alarm{arm}` row carries, surfaced to the native-source hook. */
export interface ArmNotice {
  readonly sessionId: string;
  readonly purpose: string;
  readonly alarmId: string;
  readonly occurrenceId: string;
  readonly armSeq: number;
  readonly at: number | null;
  readonly supersedes: string | null;
  readonly payload: PlainObject;
}

export interface AlarmArmDeps {
  readonly openKernel: (sessionId: string) => SessionKernel;
  readonly clock: () => number;
  readonly entropy: () => string;
  /**
   * Persisted DeliverAt send for a scheduled occurrence. `monitor.hit` arms
   * are never scheduled — their native source resends the armed occurrence.
   */
  readonly schedule: (
    sessionId: string,
    occurrence: ScheduledOccurrence,
  ) => Effect.Effect<void, Error>;
  /** Observes every committed arm (native-source install/refresh/close hook). */
  readonly onArm?: (notice: ArmNotice) => void;
}

/**
 * Out-of-band arm commit: rides the session's CURRENT activation authority
 * (never adopts a fence of its own) and retries a lost revision race against
 * concurrent turn commits. A session without an active writer is a wiring
 * defect at every call site (tool turn or wake), so it dies, not refuses.
 */
export function createAlarmArmVerb(deps: AlarmArmDeps): (sessionId: string) => Bundle.ArmVerb {
  return (sessionId) => (input) =>
    Effect.gen(function* () {
      const kernel = deps.openKernel(sessionId);
      const alarmId = input.alarmId ?? deps.entropy();
      const committed = yield* commitArm(kernel, sessionId, { ...input, alarmId }, deps.clock);
      if (input.at !== null && input.purpose !== Bundle.MONITOR_HIT)
        yield* deps.schedule(sessionId, {
          occurrenceId: committed.occurrenceId,
          purpose: input.purpose,
          alarmId,
          armSeq: committed.armSeq,
          sourceKey: input.sourceKey,
          payload: JSON.stringify(input.payload),
          fireAt: input.at,
        }).pipe(Effect.orDie);
      deps.onArm?.({
        sessionId,
        purpose: input.purpose,
        alarmId,
        occurrenceId: committed.occurrenceId,
        armSeq: committed.armSeq,
        at: input.at,
        supersedes: input.supersedes ?? null,
        payload: input.payload,
      });
      return { alarmId, occurrenceId: committed.occurrenceId, armSeq: committed.armSeq };
    });
}

function commitArm(
  kernel: SessionKernel,
  sessionId: string,
  input: {
    readonly purpose: string;
    readonly at: number | null;
    readonly supersedes?: string;
    readonly alarmId: string;
    readonly sourceKey: string;
    readonly payload: PlainObject;
  },
  clock: () => number,
  retries = ARM_COMMIT_RETRIES,
): Effect.Effect<{ occurrenceId: string; armSeq: number }, never> {
  return Effect.suspend(() => {
    const row = kernel.row(sessionId);
    if (row.fenceOwner === null)
      return Effect.die(new Error(`alarm arm refused: ${sessionId} has no active writer`));
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
      ts: clock(),
    });
    return kernel
      .commit({
        sessionId,
        owner: row.fenceOwner,
        fence: row.fence,
        now: clock(),
        expectedRevision: row.revision,
        actions: [action],
        state: row.state,
      })
      .pipe(
        Effect.as({ occurrenceId, armSeq }),
        Effect.catch((error) =>
          retries > 0 && error._tag === "CommitRefused"
            ? commitArm(kernel, sessionId, input, clock, retries - 1)
            : Effect.die(error),
        ),
      );
  });
}

const RETIRED_STATUS: Record<string, WatchState["status"]> = {
  cancel: "cancelled",
  install: "cancelled",
  exhausted: "exhausted",
  fired: "fired",
  timeout: "fired",
};

/** Projects one alarm chain into the monitor tool's watch state. */
export function watchStateOf(chain: AlarmChainView, sessionId: string): WatchState {
  const retiredReason =
    typeof chain.latest.payload.reason === "string" ? chain.latest.payload.reason : undefined;
  const notifications =
    typeof chain.latest.payload.notifications === "number"
      ? chain.latest.payload.notifications
      : chain.delivered;
  return {
    id: chain.alarmId,
    sessionId,
    kind: chain.latest.sourceKey === CRON_SOURCE ? "cron" : "watch",
    status:
      chain.latest.at !== null
        ? "armed"
        : (RETIRED_STATUS[retiredReason ?? "fired"] ?? "fired"),
    fireAt: chain.latest.at,
    notifications,
    occurrenceId: chain.latest.occurrenceId,
    createdAt: chain.firstTs,
    updatedAt: chain.lastTs,
  };
}

interface AlarmMonitorDeps {
  readonly capability: Bundle.AlarmCapabilityDefinition;
  readonly openKernel: (sessionId: string) => SessionKernel;
  readonly clock: () => number;
  readonly entropy: () => string;
  readonly run: <A>(effect: Effect.Effect<A, Error>, signal: AbortSignal) => Promise<A>;
}

function requireChain(deps: AlarmMonitorDeps, sessionId: string, id: string): AlarmChainView {
  const chain = foldAlarmChains(deps.openKernel(sessionId), sessionId).get(id);
  if (chain === undefined) throw new MonitorRefused(new Error(`unknown watch: ${id}`));
  return chain;
}

/** The last committed arm payload that still carries the chain's spec (watch) or cron fields. */
function chainSpec(deps: AlarmMonitorDeps, sessionId: string, id: string) {
  const kernel = deps.openKernel(sessionId);
  let found: PlainObject | undefined;
  let after = 0;
  for (;;) {
    const page = kernel.historyPage(sessionId, { afterRevision: after });
    for (const action of page.actions) {
      if (action.kind !== "alarm") continue;
      const arm = ArmIntent.safeParse(action.intent.value);
      if (!arm.success || arm.data.alarmId !== id) continue;
      if (arm.data.payload.spec !== undefined || arm.data.payload.expr !== undefined)
        found = arm.data.payload;
    }
    if (page.nextRevision === null) return found;
    after = page.nextRevision;
  }
}

/** The monitor tool's ports over the alarm capability (chain facts + native sources). */
export function createAlarmMonitorPorts(deps: AlarmMonitorDeps): MonitorPorts {
  const state = (sessionId: string, id: string) =>
    watchStateOf(requireChain(deps, sessionId, id), sessionId);
  const retire = (
    sessionId: string,
    chain: AlarmChainView,
    reason: "cancel",
    signal: AbortSignal,
  ) =>
    deps.run(
      deps
        .capability.verbs.arm(sessionId)({
          purpose: chain.latest.purpose,
          at: null,
          alarmId: chain.alarmId,
          supersedes: chain.latest.occurrenceId,
          sourceKey: chain.latest.sourceKey,
          payload: { reason },
        })
        .pipe(Effect.asVoid, Effect.mapError((error) => new Error(error.code))),
      signal,
    );
  return {
    clock: deps.clock,
    entropy: deps.entropy,
    openKernel: deps.openKernel,
    async create(input, signal) {
      if (input.kind === "cron") {
        const { expr, tz } = input;
        const at = Cron.next(expr, deps.clock(), tz);
        await deps.run(
          deps
            .capability.verbs.arm(input.sessionId)({
              purpose: CRON_TICK,
              at,
              alarmId: input.id,
              sourceKey: CRON_SOURCE,
              payload: { expr, tz, description: input.description },
            })
            .pipe(Effect.asVoid, Effect.mapError((error) => new Error(error.code))),
          signal,
        );
        return state(input.sessionId, input.id);
      }
      await deps.run(
        deps.capability.verbs
          .watch({
            sessionId: input.sessionId,
            watchId: input.id,
            spec: input.spec,
            now: deps.clock(),
          })
          .pipe(Effect.asVoid, Effect.mapError((error) => new Error(error.message))),
        signal,
      );
      return state(input.sessionId, input.id);
    },
    async cancel(id, sessionId, _at, signal) {
      const chain = requireChain(deps, sessionId, id);
      if (chain.latest.at !== null) await retire(sessionId, chain, "cancel", signal);
      const chains = foldAlarmChains(deps.openKernel(sessionId), sessionId);
      const timeout = chains.get(`${id}:timeout`);
      if (timeout !== undefined && timeout.latest.at !== null)
        await retire(sessionId, timeout, "cancel", signal);
      return state(sessionId, id);
    },
    async rearm(id, sessionId, at, signal) {
      const chain = requireChain(deps, sessionId, id);
      if (chain.latest.at !== null) return watchStateOf(chain, sessionId);
      const payload = chainSpec(deps, sessionId, id);
      if (chain.latest.sourceKey === CRON_SOURCE) {
        const cron = CronPayload.safeParse(payload);
        if (!cron.success)
          throw new MonitorRefused(new Error(`cron chain without an expression: ${id}`));
        await deps.run(
          deps
            .capability.verbs.arm(sessionId)({
              purpose: CRON_TICK,
              at: Cron.next(cron.data.expr, at, cron.data.tz),
              alarmId: id,
              supersedes: chain.latest.occurrenceId,
              sourceKey: CRON_SOURCE,
              payload: cron.data,
            })
            .pipe(Effect.asVoid, Effect.mapError((error) => new Error(error.code))),
          signal,
        );
        return state(sessionId, id);
      }
      const spec = Alarm.WatchSpec.safeParse(payload?.spec);
      if (!spec.success)
        throw new MonitorRefused(new Error(`watch chain without a spec: ${id}`));
      await deps.run(
        deps.capability.verbs
          .watch({ sessionId, watchId: id, spec: spec.data, now: at })
          .pipe(Effect.asVoid, Effect.mapError((error) => new Error(error.message))),
        signal,
      );
      return state(sessionId, id);
    },
  };
}
