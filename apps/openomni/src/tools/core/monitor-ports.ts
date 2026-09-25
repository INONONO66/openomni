import { currentInvocation, ToolRefused } from "@openomni/agent";
import { type LedgerError, SessionHandleStore } from "@openomni/ledger";
import { Alarm, type ToolExecutionContext } from "@openomni/protocol";

export interface MonitorPorts {
  readonly arm: (input: Alarm.Arm, signal: AbortSignal) => Promise<Alarm.Row>;
  readonly cancel: (
    id: string,
    sessionId: string,
    at: number,
    signal: AbortSignal,
  ) => Promise<Alarm.Row>;
  readonly rearm: (
    id: string,
    sessionId: string,
    at: number,
    signal: AbortSignal,
  ) => Promise<Alarm.Row>;
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
