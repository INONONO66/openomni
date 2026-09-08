import { relativeTime } from "@openomni/ui";
import { sessionReason } from "../attention/reason";
import type { Session } from "../state/store";

export function SessionSecondary({
  session,
  now,
  project,
}: {
  readonly session: Session;
  readonly now: number;
  readonly project?: string;
}) {
  const timedReason =
    session.phase === "waiting_input" ||
    session.phase === "waiting_approval" ||
    session.phase === "interrupted";
  const timestamp = timedReason ? session.phaseSince : session.lastActivityAt;
  return (
    <span className="flex min-w-0 items-center gap-2">
      {project !== undefined && <span className="max-w-24 truncate">{project}</span>}
      {!timedReason && <span className="truncate">{sessionReason(session, now)}</span>}
      <time className="truncate" dateTime={new Date(timestamp).toISOString()}>
        {timedReason ? sessionReason(session, now) : relativeTime(timestamp, now)}
      </time>
    </span>
  );
}
