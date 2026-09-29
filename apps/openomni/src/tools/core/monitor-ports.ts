import { currentInvocation, ToolRefused } from "@openomni/agent";
import { SessionHandleStore, type LedgerError } from "@openomni/ledger";
import { Alarm, EncodedPayload, type ToolExecutionContext } from "@openomni/protocol";
import { z } from "zod";
import type { SessionKernel } from "../../composition/cluster-runtime";

/**
 * The monitor tool's Effect-free surface (boundary law R1): schemas, the
 * ports interface, and the pure pre-arm policy gate. The Effect-bearing watch
 * plane (chain folds, commits, entity timer hooks) lives in
 * `src/composition/monitor-ports.ts`.
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
const WatchArm = WatchState.omit({
  status: true,
  epoch: true,
  fence: true,
  lastBatch: true,
  notifications: true,
  createdAt: true,
  updatedAt: true,
});
type WatchArm = z.infer<typeof WatchArm>;

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
  /** Handle-scoped chain reads for the arming session (W5.2 F1). */
  readonly openKernel: (sessionId: string) => SessionKernel;
}

export class MonitorRefused extends ToolRefused {
  readonly _tag = "MonitorRefused";

  constructor(readonly failure: LedgerError | Error) {
    super("monitor", failure.message);
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
  const kernel = ports.openKernel(context.sessionId);
  const turn = SessionHandleStore.turnIntent(kernel.actionById(context.turnId));
  if (turn === undefined) throw new ToolRefused("monitor", "no captured turn");
  const { policy } = currentInvocation();
  const evaluation = policy.evaluate({
    kind: "tool",
    phase: "pre",
    op: "monitor",
    role: kernel.row(context.sessionId).role,
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
