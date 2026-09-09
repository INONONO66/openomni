import { Alarm, canonicalDigest } from "@openomni/protocol";

export interface AlarmOccurrence {
  readonly actionId: string;
  readonly inboxId: string;
  readonly status: Alarm.Status;
  readonly content: string;
  readonly terminal: boolean;
}

/** Durable identity, fence, dedupe and notification-budget admission for one alarm occurrence. */
export default function alarmOccurrence(
  row: Alarm.Row,
  input: Alarm.Fire,
): AlarmOccurrence | undefined {
  if (
    row.status !== "armed" ||
    row.epoch !== input.epoch ||
    row.fence !== input.fence ||
    input.at < row.fireAt
  )
    return undefined;
  const spec = row.kind === "watch" ? Alarm.WatchSpec.parse(row.spec?.value) : undefined;
  const expired =
    spec?.watch.timeout_ms !== undefined && input.at >= row.fireAt + spec.watch.timeout_ms;
  if (
    !(expired || input.terminal) &&
    input.batchHash !== undefined &&
    row.lastBatch === input.batchHash
  )
    return undefined;
  const identity = {
    actionId: Alarm.occurrenceId(row.id, row.epoch, input.sourceKey),
    inboxId: canonicalDigest(["alarm.inbox", row.id, row.epoch, input.sourceKey]),
  };
  if (expired)
    return {
      ...identity,
      status: "fired",
      terminal: true,
      content: JSON.stringify({
        alarmId: row.id,
        epoch: row.epoch,
        reason: "timeout",
        exitCode: null,
      }),
    };
  if (input.terminal || spec === undefined)
    return { ...identity, status: "fired", terminal: true, content: input.content };
  if (row.notifications >= spec.notificationLimit)
    return {
      ...identity,
      status: "paused",
      terminal: false,
      content: JSON.stringify({
        alarmId: row.id,
        epoch: row.epoch,
        reason: "wake_budget",
        status: "paused",
      }),
    };
  return { ...identity, status: "armed", terminal: false, content: input.content };
}
