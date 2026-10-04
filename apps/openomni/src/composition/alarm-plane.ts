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
 * no process memory. The app never commits an arm row itself (H3): the live
 * registry below hands `Bundle.alarmCapability` each activation's budgeted
 * entity arm verb — the ONE committing arm path — and refuses `not_live`
 * when no activation is registered.
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

/**
 * #1254 H3: the live-activation arm registry — the app side of the entity's
 * ONE committing arm path. Each activation registers its budgeted arm verb
 * through `SessionEntityPorts.onLive` (after fence adoption, released at
 * passivation); the capability's app-side verbs delegate through `arm`. A
 * session with no live activation refuses `not_live` — the app never commits
 * an arm row of its own.
 */
export interface LiveArmRegistry {
  /** Bound as `SessionEntityPorts.onLive`; returns the passivation release. */
  readonly onLive: (sessionId: string, verbs: { readonly arm: Core.ArmVerb }) => () => void;
  /** The arm verb `Bundle.alarmCapability` composes: delegates to the live activation. */
  readonly arm: (sessionId: string) => Bundle.ArmVerb;
}

export function createLiveArmRegistry(): LiveArmRegistry {
  const live = new Map<string, Core.ArmVerb>();
  return {
    onLive: (sessionId, verbs) => {
      live.set(sessionId, verbs.arm);
      return () => {
        if (live.get(sessionId) === verbs.arm) live.delete(sessionId);
      };
    },
    arm: (sessionId) => (input) =>
      Effect.suspend(() => {
        const verb = live.get(sessionId);
        return verb === undefined
          ? Effect.fail(new Core.ArmRefused({ code: "not_live" }))
          : verb(input);
      }),
  };
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
