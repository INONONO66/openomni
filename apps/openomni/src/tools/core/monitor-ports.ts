import { currentInvocation, ToolRefused } from "@openomni/agent";
import { type LedgerError, SessionHandleStore } from "@openomni/ledger";
import { Alarm, EncodedPayload, type ToolExecutionContext } from "@openomni/protocol";
import { z } from "zod";

/**
 * Watch state the monitor tool reports: the projection the watch plane commits
 * for a monitored source. Owned here since W5.2 so the tool plane survives the
 * deletion of the alarm storage shapes (`Alarm.Row`/`Alarm.Arm`); today's
 * adapter rows satisfy it structurally.
 */
export const WatchState = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    kind: z.enum(["at", "watch"]),
    fireAt: z.number().finite().nonnegative(),
    spec: EncodedPayload.optional(),
    status: z.enum(["armed", "cancelled", "fired", "paused"]),
    epoch: z.number().int().positive(),
    fence: z.number().int().nonnegative(),
    lastBatch: z.string().nullable(),
    notifications: z.number().int().nonnegative(),
    createdAt: z.number().finite().nonnegative(),
    updatedAt: z.number().finite().nonnegative(),
  })
  .strict();
export type WatchState = z.infer<typeof WatchState>;

/** Arm input: identity, schedule, and sealed spec; lifecycle fields are plane-owned. */
export const WatchArm = WatchState.omit({
  status: true,
  epoch: true,
  fence: true,
  lastBatch: true,
  notifications: true,
  createdAt: true,
  updatedAt: true,
});
export type WatchArm = z.infer<typeof WatchArm>;

export interface MonitorPorts {
  readonly arm: (input: WatchArm, signal: AbortSignal) => Promise<WatchState>;
  readonly cancel: (
    id: string,
    sessionId: string,
    at: number,
    signal: AbortSignal,
  ) => Promise<WatchState>;
  readonly rearm: (
    id: string,
    sessionId: string,
    at: number,
    signal: AbortSignal,
  ) => Promise<WatchState>;
  readonly clock: () => number;
  readonly entropy: () => string;
}

export class MonitorRefused extends ToolRefused {
  readonly _tag = "MonitorRefused";

  constructor(readonly failure: LedgerError) {
    super("monitor", failure._tag);
  }
}

export async function armWatch(
  ports: MonitorPorts,
  source: Omit<Alarm.Watch, "description">,
  description: string,
  context: ToolExecutionContext,
  at: number,
) {
  const watch = Alarm.Watch.parse({ ...source, description });
  const turn = SessionHandleStore.turnIntent(SessionHandleStore.actionById(context.turnId));
  if (turn === undefined) throw new ToolRefused("monitor", "no captured turn");
  const { policy } = currentInvocation();
  const evaluation = policy.evaluate({
    kind: "tool",
    phase: "pre",
    op: "monitor",
    role: SessionHandleStore.row(context.sessionId).role,
    sessionId: context.sessionId,
    value: watch,
  });
  const limits = evaluation.obligations.filter(
    (obligation) => obligation.metric === "notifications",
  );
  if (evaluation.verdict === "deny" || evaluation.error !== undefined || limits.length === 0)
    throw new ToolRefused("monitor", "captured wake budget unavailable");
  return ports.arm(
    {
      id: ports.entropy(),
      sessionId: context.sessionId,
      kind: "watch",
      fireAt: at,
      spec: {
        encodingVersion: 1,
        value: {
          watch,
          policyGeneration: turn.policyGeneration,
          notificationLimit: Math.min(...limits.map((limit) => limit.limit)),
        },
      },
    },
    context.signal,
  );
}
