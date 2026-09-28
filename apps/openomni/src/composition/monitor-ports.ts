import type { SessionEntityTimerContext } from "@openomni/agent";
import {
  Alarm,
  EncodedPayload,
  type LedgerAction,
  type PlainObject,
} from "@openomni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import { MonitorRefused, type MonitorPorts, type WatchState } from "../tools/core/monitor-ports";
import type { SessionKernel } from "./cluster-runtime";
import type { WatchSources } from "./watch-sources";

/**
 * Watch plane over the session chain (W5.2 plan F2): every watch lifecycle
 * fact is a chain action under deterministic ids, so `watchState` is a pure
 * fold and a redelivered entity wake dedupes on committed occurrence ids.
 * This is the Effect-bearing half of the monitor surface; the tool-facing
 * schemas and ports interface stay in `src/tools/core/monitor-ports.ts`.
 *
 * Chain ids per (watchId, epoch):
 *   arm      `<watchId>:arm:<epoch>`        kind alarm.arm
 *   cancel   `<watchId>:cancel:<epoch>`     kind alarm.paused
 *   paused   `<watchId>:paused:<epoch>`     kind alarm.paused
 *   fired    the sender's occurrence key    kind alarm.fired (child of arm)
 *   timeout  `<watchId>:timeout:<epoch>`    kind alarm.fired (agent watchTimeoutKey)
 */

/** The sealed spec an arm commits: source, pinned policy, wake budget. */
export const WatchSpec = z
  .object({
    watch: Alarm.Watch,
    policyGeneration: z.number().int().nonnegative(),
    notificationLimit: z.number().int().positive(),
  })
  .strict();
export type WatchSpec = z.infer<typeof WatchSpec>;

const watchArmId = (watchId: string, epoch: number) => `${watchId}:arm:${epoch}`;
const watchCancelId = (watchId: string, epoch: number) => `${watchId}:cancel:${epoch}`;
const watchPausedId = (watchId: string, epoch: number) => `${watchId}:paused:${epoch}`;
const watchTimeoutId = (watchId: string, epoch: number) => `${watchId}:timeout:${epoch}`;
/** The occurrence chain id one `WatchFired` message commits under (its `sourceKey`). */
export const watchOccurrenceKey = (watchId: string, epoch: number, sourceKey: string) =>
  `${watchId}:occ:${epoch}:${sourceKey}`;

interface ArmEffectValue {
  readonly status: "armed";
  readonly fireAt: number;
  readonly spec: WatchSpec;
}

function armEffect(action: LedgerAction.Node): ArmEffectValue | undefined {
  const value = action.effect.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const spec = WatchSpec.safeParse(value.spec);
  if (!spec.success || typeof value.fireAt !== "number") return undefined;
  return { status: "armed", fireAt: value.fireAt, spec: spec.data };
}

interface WatchFold {
  readonly state: WatchState;
  readonly spec: WatchSpec;
  readonly armId: string;
  readonly terminal: boolean;
}

function firedActions(
  kernel: SessionKernel,
  sessionId: string,
  armId: string,
): LedgerAction.Node[] {
  const fired: LedgerAction.Node[] = [];
  let cursor = 0;
  for (;;) {
    const page = kernel.operationChildrenPage(sessionId, armId, cursor);
    for (const child of page) if (child.kind === "alarm.fired") fired.push(child);
    if (page.length < 256) return fired;
    cursor = page.at(-1)?.ordinal ?? cursor;
  }
}

function firedTerminal(action: LedgerAction.Node): boolean {
  const value = action.effect.value;
  return (
    value !== null && typeof value === "object" && !Array.isArray(value) && value.terminal === true
  );
}

function firedContent(action: LedgerAction.Node | undefined): string | null {
  const value = action?.effect.value;
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    typeof value?.content === "string"
    ? value.content
    : null;
}

/** Pure chain fold: the latest arm epoch overridden by cancel/paused/fired facts. */
export function watchState(
  kernel: SessionKernel,
  sessionId: string,
  watchId: string,
): WatchFold | undefined {
  let epoch = 0;
  let arm: LedgerAction.Node | undefined;
  let first: LedgerAction.Node | undefined;
  for (let next = 1; ; next += 1) {
    const action = kernel.actionById(watchArmId(watchId, next));
    if (action === undefined) break;
    first ??= action;
    epoch = next;
    arm = action;
  }
  if (arm === undefined || first === undefined) return undefined;
  const parsed = armEffect(arm);
  if (parsed === undefined) return undefined;
  const cancelled = kernel.actionById(watchCancelId(watchId, epoch));
  const paused = kernel.actionById(watchPausedId(watchId, epoch));
  const timeout = kernel.actionById(watchTimeoutId(watchId, epoch));
  const fired = firedActions(kernel, sessionId, arm.id);
  const terminal = timeout !== undefined || fired.some(firedTerminal);
  const last = fired.at(-1);
  const lastBatch = firedContent(last);
  const status =
    cancelled !== undefined
      ? ("cancelled" as const)
      : paused !== undefined
        ? ("paused" as const)
        : terminal
          ? ("fired" as const)
          : ("armed" as const);
  const updatedAt = Math.max(
    arm.ts,
    cancelled?.ts ?? 0,
    paused?.ts ?? 0,
    timeout?.ts ?? 0,
    last?.ts ?? 0,
  );
  return {
    armId: arm.id,
    spec: parsed.spec,
    terminal,
    state: {
      id: watchId,
      sessionId,
      kind: "watch",
      fireAt: parsed.fireAt,
      spec: { encodingVersion: 1, value: parsed.spec },
      status,
      epoch,
      fence: kernel.row(sessionId).leaseFence,
      lastBatch,
      notifications: fired.length + (timeout === undefined ? 0 : 1),
      createdAt: first.ts,
      updatedAt,
    },
  };
}

/** A watch lifecycle chain action under a deterministic id. */
function watchAction(input: {
  readonly id: string;
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly kind: "alarm.arm" | "alarm.fired" | "alarm.paused";
  readonly intent: PlainObject;
  readonly effect: PlainObject;
  readonly at: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: input.parentId,
    sessionId: input.sessionId,
    kind: input.kind,
    intent: EncodedPayload.parse({ encodingVersion: 1, value: input.intent }),
    effect: EncodedPayload.parse({ encodingVersion: 1, value: input.effect }),
    irreversible: true,
    ts: input.at,
  };
}

/** A watch wake prompt: the agent's received-message shape, alarm-originated. */
function watchPromptAction(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly watchId: string;
  readonly epoch: number;
  readonly sourceKey: string;
  readonly content: string;
  readonly at: number;
}): LedgerAction.Append {
  return {
    id: input.id,
    parentId: null,
    sessionId: input.sessionId,
    kind: "prompt",
    intent: EncodedPayload.parse({
      encodingVersion: 1,
      value: {
        kind: "alarm",
        watchId: input.watchId,
        epoch: input.epoch,
        sourceKey: input.sourceKey,
      },
    }),
    effect: EncodedPayload.parse({
      encodingVersion: 1,
      value: { inboxKind: "prompt", content: input.content },
    }),
    irreversible: true,
    ts: input.at,
  };
}

const WATCH_COMMIT_RETRIES = 5;

/**
 * Out-of-band watch commit: rides the session's CURRENT activation authority
 * (never adopts a fence of its own, which would stale the live activation)
 * and retries a lost revision race against concurrent turn commits.
 */
function commitWatchActions(
  kernel: SessionKernel,
  sessionId: string,
  actions: readonly LedgerAction.Append[],
  retries = WATCH_COMMIT_RETRIES,
): Effect.Effect<void, Error> {
  return Effect.suspend(() => {
    const row = kernel.row(sessionId);
    if (row.leaseOwner === null)
      return Effect.fail(new Error(`watch commit refused: ${sessionId} has no active writer`));
    return kernel
      .commit({
        sessionId,
        owner: row.leaseOwner,
        fence: row.leaseFence,
        now: actions[0]?.ts ?? Date.now(),
        expectedRevision: row.revision,
        actions: [...actions],
        state: row.state,
      })
      .pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          retries > 0 && error._tag === "CommitRefused"
            ? commitWatchActions(kernel, sessionId, actions, retries - 1)
            : Effect.fail(new Error(`watch commit failed: ${error._tag}`)),
        ),
      );
  });
}

interface WatchPlaneDeps {
  readonly openKernel: (sessionId: string) => SessionKernel;
  readonly sources: WatchSources;
  readonly clock: () => number;
  readonly entropy: () => string;
  readonly run: <A>(effect: Effect.Effect<A, Error>, signal: AbortSignal) => Promise<A>;
}

function requireFold(kernel: SessionKernel, sessionId: string, id: string): WatchFold {
  const fold = watchState(kernel, sessionId, id);
  if (fold === undefined) throw new MonitorRefused(new Error(`unknown watch: ${id}`));
  return fold;
}

/** The monitor tool's ports over the watch plane (chain facts + native sources). */
export function createWatchMonitorPorts(deps: WatchPlaneDeps): MonitorPorts {
  async function install(sessionId: string, id: string, epoch: number, spec: WatchSpec) {
    await deps.sources.install({ sessionId, id, epoch, watch: spec.watch });
    return requireFold(deps.openKernel(sessionId), sessionId, id).state;
  }
  async function armEpoch(
    sessionId: string,
    id: string,
    epoch: number,
    fireAt: number,
    spec: WatchSpec,
    at: number,
    signal: AbortSignal,
  ) {
    const kernel = deps.openKernel(sessionId);
    const action = watchAction({
      id: watchArmId(id, epoch),
      parentId: epoch > 1 ? watchArmId(id, epoch - 1) : null,
      sessionId,
      kind: "alarm.arm",
      intent: { op: "arm", watchId: id, epoch },
      effect: { status: "armed", fireAt, spec },
      at,
    });
    await deps.run(commitWatchActions(kernel, sessionId, [action]), signal);
    return install(sessionId, id, epoch, spec);
  }
  return {
    clock: deps.clock,
    entropy: deps.entropy,
    openKernel: deps.openKernel,
    async arm(input, signal) {
      const spec = WatchSpec.parse(input.spec?.value);
      const existing = watchState(deps.openKernel(input.sessionId), input.sessionId, input.id);
      const epoch = (existing?.state.epoch ?? 0) + 1;
      return armEpoch(input.sessionId, input.id, epoch, input.fireAt, spec, deps.clock(), signal);
    },
    async cancel(id, sessionId, at, signal) {
      const kernel = deps.openKernel(sessionId);
      const fold = requireFold(kernel, sessionId, id);
      if (fold.state.status !== "cancelled") {
        const action = watchAction({
          id: watchCancelId(id, fold.state.epoch),
          parentId: fold.armId,
          sessionId,
          kind: "alarm.paused",
          intent: { op: "cancel", watchId: id, epoch: fold.state.epoch },
          effect: { status: "cancelled" },
          at,
        });
        await deps.run(commitWatchActions(kernel, sessionId, [action]), signal);
      }
      await deps.sources.close(id);
      return requireFold(kernel, sessionId, id).state;
    },
    async rearm(id, sessionId, at, signal) {
      const kernel = deps.openKernel(sessionId);
      const fold = requireFold(kernel, sessionId, id);
      if (fold.state.status === "armed") return fold.state;
      return armEpoch(sessionId, id, fold.state.epoch + 1, at, fold.spec, at, signal);
    },
  };
}

interface WatchHookDeps {
  /** Fire-and-forget close of the process-local native source. */
  readonly closeSource: (watchId: string) => void;
}

/**
 * `WatchFired` fold body (entity timer hook): commits the occurrence, its wake
 * prompt, and — when the source is terminal or the wake budget is exhausted —
 * the pausing fact, all in one chain batch under the activation's fence.
 */
export function watchFiredHook(deps: WatchHookDeps) {
  return (
    context: SessionEntityTimerContext,
    payload: {
      readonly watchId: string;
      readonly epoch: number;
      readonly sourceKey: string;
      readonly batch: string;
    },
  ): Effect.Effect<"applied" | "noop"> =>
    Effect.gen(function* () {
      const { kernel, authority } = context;
      const fold = watchState(kernel, authority.sessionId, payload.watchId);
      if (fold === undefined || fold.state.epoch !== payload.epoch) return "noop" as const;
      if (fold.state.status !== "armed") {
        deps.closeSource(payload.watchId);
        return "noop" as const;
      }
      const batch = z
        .object({ content: z.string(), terminal: z.boolean() })
        .parse(JSON.parse(payload.batch));
      const actions: LedgerAction.Append[] = [
        watchAction({
          id: payload.sourceKey,
          parentId: fold.armId,
          sessionId: authority.sessionId,
          kind: "alarm.fired",
          intent: { op: "fired", watchId: payload.watchId, epoch: payload.epoch },
          effect: { status: "fired", content: batch.content, terminal: batch.terminal },
          at: context.now,
        }),
        watchPromptAction({
          id: `${payload.sourceKey}:prompt`,
          sessionId: authority.sessionId,
          watchId: payload.watchId,
          epoch: payload.epoch,
          sourceKey: payload.sourceKey,
          content: batch.content,
          at: context.now,
        }),
      ];
      const exhausted =
        !batch.terminal && fold.state.notifications + 1 >= fold.spec.notificationLimit;
      if (exhausted)
        actions.push(
          watchAction({
            id: watchPausedId(payload.watchId, payload.epoch),
            parentId: fold.armId,
            sessionId: authority.sessionId,
            kind: "alarm.paused",
            intent: { op: "paused", watchId: payload.watchId, epoch: payload.epoch },
            effect: { status: "paused", reason: "notification_budget" },
            at: context.now,
          }),
        );
      const row = kernel.row(authority.sessionId);
      yield* kernel
        .commit({
          sessionId: authority.sessionId,
          owner: authority.owner,
          fence: authority.fence,
          now: context.now,
          expectedRevision: row.revision,
          actions,
          state: row.state,
        })
        .pipe(Effect.orDie);
      if (batch.terminal || exhausted) deps.closeSource(payload.watchId);
      return "applied" as const;
    });
}

/** `WatchTimeout` fold body: the timed watch expires with one terminal wake. */
export function watchTimeoutHook(deps: WatchHookDeps) {
  return (
    context: SessionEntityTimerContext,
    payload: { readonly watchId: string; readonly epoch: number; readonly fireAt: number },
  ): Effect.Effect<"applied" | "noop"> =>
    Effect.gen(function* () {
      const { kernel, authority } = context;
      const fold = watchState(kernel, authority.sessionId, payload.watchId);
      if (fold === undefined || fold.state.epoch !== payload.epoch) return "noop" as const;
      if (fold.state.status !== "armed") return "noop" as const;
      const id = watchTimeoutId(payload.watchId, payload.epoch);
      const content = JSON.stringify({
        watchId: payload.watchId,
        epoch: payload.epoch,
        reason: "timeout",
      });
      const row = kernel.row(authority.sessionId);
      yield* kernel
        .commit({
          sessionId: authority.sessionId,
          owner: authority.owner,
          fence: authority.fence,
          now: context.now,
          expectedRevision: row.revision,
          actions: [
            watchAction({
              id,
              parentId: fold.armId,
              sessionId: authority.sessionId,
              kind: "alarm.fired",
              intent: { op: "timeout", watchId: payload.watchId, epoch: payload.epoch },
              effect: { status: "fired", terminal: true, reason: "timeout", content },
              at: context.now,
            }),
            watchPromptAction({
              id: `${id}:prompt`,
              sessionId: authority.sessionId,
              watchId: payload.watchId,
              epoch: payload.epoch,
              sourceKey: id,
              content,
              at: context.now,
            }),
          ],
          state: row.state,
        })
        .pipe(Effect.orDie);
      deps.closeSource(payload.watchId);
      return "applied" as const;
    });
}
