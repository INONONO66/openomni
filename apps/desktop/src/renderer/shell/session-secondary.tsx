import { sessionReason, formatRelative } from "../attention/reason";
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
  const timestamp = session.lastActivityAt;
  return (
    <span className="flex min-w-0 items-center gap-2">
      {project !== undefined && <span className="max-w-24 truncate">{project}</span>}
      <span className="truncate">{sessionReason(session, now)}</span>
      <time className="truncate" dateTime={new Date(timestamp).toISOString()}>
        {formatRelative(now, timestamp)}
      </time>
    </span>
  );
}
