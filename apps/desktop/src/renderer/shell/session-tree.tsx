import {
  Highlight,
  NavItem,
  ScrollArea,
  SectionHeader,
  SectionSearchInput,
  SidebarFooter,
  SidebarNav,
  SidebarSection,
  Text,
  TreeRow,
} from "@openomni/ui";
import { Brain, Inbox, MessageSquare, Settings, Workflow } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useRef } from "react";
import type { Boundary, Ordered } from "../attention";
import { highlightRuns } from "../search";
import type { FilteredSession } from "../search";
import {
  type ProjectId,
  type Route,
  ROUTE_LABEL,
  ROUTES,
  type Session,
  type SessionId,
} from "../state/store";
import { rowId, TREE_ID } from "./row-id";
import { useSearch } from "./use-search";

/**
 * The sidebar column: header, the four destinations, the session tree under
 * its section header, and the footer.
 *
 * PROJECT → SESSION, and that is the whole depth today. The hierarchy IS the
 * geometry: one indent step per level, each row's text starting at its
 * level's x, so selection reports depth instead of flattening it. There are no
 * connectors and no status marks anywhere in this column (docs/desktop-shell.md,
 * Deferred): a row is one line, the session's title.
 *
 * Filtering preserves that hierarchy rather than flattening to a result list. A
 * matched session keeps its project row as its parent, so a result never
 * appears at an unexplained depth, and a project with nothing matching
 * disappears instead of leaving an empty row behind.
 */
export function SessionTree({
  ordered,
  pendingChanges,
  sessions,
  selectedId,
  route,
  collapsedProjectIds,
  onToggleProject,
  onSelect,
  onNavigate,
  defaultSearching = false,
}: {
  readonly ordered: Ordered;
  /** Rows that moved since this order was adopted; held until a boundary. */
  readonly pendingChanges: number;
  readonly sessions: readonly Session[];
  readonly selectedId: SessionId | null;
  readonly route: Route;
  readonly collapsedProjectIds: ReadonlySet<ProjectId | null>;
  readonly onToggleProject: (id: ProjectId | null) => void;
  /**
   * `boundary` is how the caller learns whether the order may advance. A row
   * clicked or arrowed in the tree is a finished decision; one committed from
   * the search field is not, so that path passes `null` and the order holds.
   */
  readonly onSelect: (id: SessionId, boundary?: Boundary | null) => void;
  readonly onNavigate: (route: Route) => void;
  /** Whether the section opens in search mode; uncontrolled after mount. */
  readonly defaultSearching?: boolean;
}) {
  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );

  const rowRefs = useRef(new Map<SessionId, HTMLButtonElement>());
  const registerRef = useCallback((id: SessionId, node: HTMLButtonElement | null) => {
    if (node) rowRefs.current.set(id, node);
    else rowRefs.current.delete(id);
  }, []);

  const focusSelectedRow = useCallback(() => {
    if (selectedId !== null) rowRefs.current.get(selectedId)?.focus();
  }, [selectedId]);

  const search = useSearch({ ordered, sessions, onSelect, focusSelectedRow, defaultSearching });
  const { filtered, state } = search;

  // Arrow keys travel the painted sequence, so they cross group boundaries the
  // way the eye does: down from a project's last row lands on the next one's
  // first. While a query is live the sequence is the RESULT order, so the keys
  // never step onto a row that is not on screen.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>, id: SessionId) => {
      const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (delta === 0) return;

      event.preventDefault();
      const index = filtered.sequence.indexOf(id);
      const next = filtered.sequence[index + delta];
      if (index === -1 || next === undefined) return;

      onSelect(next);
      rowRefs.current.get(next)?.focus();
    },
    [filtered.sequence, onSelect],
  );

  return (
    <>
      <SidebarNav>
        {ROUTES.map((destination) => (
          <NavItem
            active={destination === route}
            icon={ROUTE_ICON[destination]}
            key={destination}
            onClick={() => onNavigate(destination)}
          >
            {ROUTE_LABEL[destination]}
          </NavItem>
        ))}
      </SidebarNav>
      <SidebarSection>
        <SectionHeader
          label="Sessions"
          onSearchingChange={search.setSearching}
          resultLabel={search.resultLabel}
          searchLabel="Search sessions"
          searching={search.searching}
        >
          <SectionSearchInput
            activeDescendantId={state.activeId === null ? undefined : rowId(state.activeId)}
            controlsId={TREE_ID}
            inputRef={search.inputRef}
            label="Search sessions"
            onKeyDown={search.onKeyDown}
            onValueChange={search.onValueChange}
            placeholder="Search sessions"
            value={state.query}
          />
        </SectionHeader>
        <ScrollArea className="flex-1" contentClassName="flex flex-col gap-px px-2 pb-2">
          <div aria-label="Sessions" id={TREE_ID} role="tree">
            {/* One sentence when there is nothing to list, on the row's own
                text x so it sits where the first row would. It names the way
                out rather than describing the absence: the `+` it points at is
                in the tab strip. */}
            {sessions.length === 0 && (
              <Text as="p" className="px-2" level="meta" tone="faint">
                No sessions yet — press +
              </Text>
            )}
            {filtered.projects.map((group) => {
              // A query overrides a closed group: a result behind a collapsed
              // row is a result nobody was shown.
              const open = !filtered.unfiltered || !collapsedProjectIds.has(group.id);
              return (
                <div key={group.id ?? ""}>
                  <TreeRow
                    expanded={open}
                    level={0}
                    onClick={() => onToggleProject(group.id)}
                    role="treeitem"
                  >
                    <span className="flex items-center gap-2">
                      <span className="truncate">{group.id ?? "no project"}</span>
                      {group === filtered.projects[0] && <ChangeHint count={pendingChanges} />}
                    </span>
                  </TreeRow>
                  {open && (
                    // biome-ignore lint/a11y/useSemanticElements: a tree's children are a `group` by the ARIA tree pattern; no native element carries that role.
                    <ul className="flex flex-col gap-px" role="group">
                      {group.sessions.map((entry) => {
                        const session = sessionById.get(entry.id);
                        if (!session) return null;
                        return (
                          <SessionRow
                            active={entry.id === state.activeId}
                            current={entry.id === selectedId}
                            entry={entry}
                            key={entry.id}
                            onKeyDown={onKeyDown}
                            onSelect={onSelect}
                            registerRef={registerRef}
                            session={session}
                          />
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </SidebarSection>
      <SidebarFooter>
        <NavItem className="w-full" icon={<Settings />} disabled>
          Settings
        </NavItem>
      </SidebarFooter>
    </>
  );
}

const ROUTE_ICON: Record<Route, ReactNode> = {
  sessions: <MessageSquare />,
  inbox: <Inbox />,
  automations: <Workflow />,
  memory: <Brain />,
};

/**
 * A one-line row: the session's title, weighted where the query hit it.
 *
 * `active` is the arrow-key cursor while searching. It reuses the SELECTION
 * fill rather than inventing a second highlight: two different marks for "the
 * one you are on" is one mark too many in a column this quiet.
 */
function SessionRow({
  session,
  entry,
  current,
  active,
  onSelect,
  onKeyDown,
  registerRef,
}: {
  readonly session: Session;
  readonly entry: FilteredSession;
  readonly current: boolean;
  readonly active: boolean;
  readonly onSelect: (id: SessionId) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLElement>, id: SessionId) => void;
  readonly registerRef: (id: SessionId, node: HTMLButtonElement | null) => void;
}) {
  return (
    <TreeRow
      aria-selected={active}
      current={current || active}
      id={rowId(session.id)}
      level={1}
      onClick={() => onSelect(session.id)}
      onKeyDown={(event) => onKeyDown(event, session.id)}
      ref={(node: HTMLButtonElement | null) => registerRef(session.id, node)}
      role="treeitem"
    >
      {/* The remainder goes MUTED as soon as there is a match to show, even
          on the selected row. That row is already primary tone at medium
          weight — the same treatment matched glyphs get — so keeping it at
          `fg` would make the highlight invisible on precisely the row the
          operator is standing on. */}
      <Highlight
        className="w-full"
        runs={highlightRuns(session.title, entry.spans)}
        tone={entry.spans.length > 0 || !(current || active) ? "muted" : "fg"}
      />
    </TreeRow>
  );
}

/**
 * Drift the Owner has not been shown yet. A count, never motion: the order is
 * held while they are working, and this is how the row says so without
 * reflowing anything under the cursor.
 */
function ChangeHint({ count }: { readonly count: number }) {
  if (count === 0) return null;
  return (
    <Text level="micro" numeric tone="faint">
      {count} changes
    </Text>
  );
}
