import { relativeTime, Text, TreeRow } from "@openomni/ui";
import type { Session, SessionId } from "../state/store";

export function SessionList({
  sessions,
  now,
  onSelect,
}: {
  readonly sessions: readonly Session[];
  readonly now: number;
  readonly onSelect: (id: SessionId) => void;
}) {
  if (sessions.length === 0)
    return (
      <Text as="p" level="meta" tone="faint">
        No sessions yet.
      </Text>
    );
  return (
    <ul aria-label="All sessions" className="flex flex-col gap-px">
      {sessions.map((session) => (
        <li key={session.id}>
          <TreeRow aria-label={session.title} level={0} onClick={() => onSelect(session.id)}>
            <span className="flex items-center gap-3">
              <Text className="min-w-0 flex-1 truncate" level="label">
                {session.title}
              </Text>
              <Text className="truncate" level="meta" tone="faint">
                {session.projectId ?? "no project"}
              </Text>
              <Text className="shrink-0" level="meta" numeric tone="faint">
                <time dateTime={new Date(session.createdAt).toISOString()}>
                  {relativeTime(session.createdAt, now)}
                </time>
              </Text>
            </span>
          </TreeRow>
        </li>
      ))}
    </ul>
  );
}
