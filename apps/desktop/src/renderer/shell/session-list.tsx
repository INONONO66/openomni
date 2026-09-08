import { StatusGlyph, Text, TreeRow } from "@openomni/ui";
import type { Boundary, Ordered } from "../attention";
import { ATTENTION_LABEL, orderByAttention } from "../attention/order";
import { rowDensity } from "../attention/reason";
import type { Session, SessionId } from "../state/store";
import { sessionGlyphProps } from "./session-glyph";
import { SessionSecondary } from "./session-secondary";

export function SessionList({
  sessions,
  now,
  onSelect,
  ordered = orderByAttention(sessions, now),
}: {
  readonly sessions: readonly Session[];
  readonly now: number;
  readonly ordered?: Ordered;
  readonly onSelect: (id: SessionId, boundary?: Boundary | null, newTab?: boolean) => void;
}) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  if (sessions.length === 0)
    return (
      <Text as="p" level="meta" tone="faint">
        No sessions yet.
      </Text>
    );
  return (
    <section aria-label="All sessions" className="flex flex-col gap-4">
      {ordered.groups.map((group) => (
        <section data-attention-kind={group.kind} key={group.kind}>
          <Text as="h2" className="px-2 font-semibold" level="label">
            {ATTENTION_LABEL[group.kind]} ·{" "}
            {group.projects.reduce((count, project) => count + project.sessions.length, 0)}
          </Text>
          {group.projects.map((project) => (
            <ul className="flex flex-col gap-px" key={project.id ?? ""}>
              {project.sessions.map((id) => {
                const session = byId.get(id);
                if (!session) return null;
                return (
                  <li key={id}>
                    <TreeRow
                      aria-label={session.title}
                      secondary={
                        rowDensity(session) === "double" ? (
                          <SessionSecondary
                            session={session}
                            now={now}
                            project={session.projectId ?? "no project"}
                          />
                        ) : undefined
                      }
                      onClick={(event) => onSelect(id, "selection", event.metaKey || event.ctrlKey)}
                    >
                      <span className="flex w-full items-center gap-2">
                        <Text className="min-w-0 flex-1 truncate" level="label">
                          {session.title}
                        </Text>
                        <StatusGlyph {...sessionGlyphProps(session.phase)} />
                      </span>
                    </TreeRow>
                  </li>
                );
              })}
            </ul>
          ))}
        </section>
      ))}
    </section>
  );
}
