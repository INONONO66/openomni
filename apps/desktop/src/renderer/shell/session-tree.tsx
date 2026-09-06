import {
  Disclosure,
  Highlight,
  Panel,
  Row,
  ScrollArea,
  SearchLine,
  SidebarHeader,
  StatusDot,
  Text,
} from "@openomni/ui";
import { useCallback, useMemo, useRef } from "react";
import type { Boundary, Ordered } from "../attention";
import type { Project, Session, SessionId } from "../mock/console";
import { highlightRuns } from "../search";
import type { FilteredSession } from "../search";
import { RUN_STATE_SHAPE, RUN_STATE_TIER } from "../run-state";
import { rowId, TREE_ID } from "./row-id";
import { useSearch } from "./use-search";

/**
 * Left column: the session navigator, and the search line that filters it.
 *
 * PROJECT → SESSION, and that is the whole depth. The hierarchy IS the
 * geometry: one indent step, a chevron slot reserved at every level so text
 * hangs on one x, and each row's own fill starting at its own indent so
 * selection reports depth instead of flattening it.
 *
 * There are no connectors anywhere in this column, and the settled tail is no
 * longer a third depth. Two levels are stated completely by indentation — a
 * drawn elbow beside a row that is already the only thing at its x is topology
 * redrawn in ink. Settled sessions are plain rows under a quiet header at the
 * SAME depth as live ones, because that is what they are: sessions in this
 * project that have finished.
 *
 * Filtering preserves that hierarchy rather than flattening to a result list. A
 * matched session keeps its project header as its parent, so a result never
 * appears at an unexplained depth, and a project with nothing matching
 * disappears instead of leaving an empty header behind.
 *
 * Each live row is two lines: the session name, then the engine's `reason` in
 * the muted ramp. The second line is the point of the whole column — a ranking
 * the Owner cannot interrogate is a ranking they have to re-derive by opening
 * things, which is the cost this ordering exists to remove.
 */
export function SessionTree({
  ordered,
  pendingChanges,
  projects,
  sessions,
  selectedId,
  onSelect,
}: {
  readonly ordered: Ordered;
  /** Rows that moved since this order was adopted; held until a boundary. */
  readonly pendingChanges: number;
  readonly projects: readonly Project[];
  readonly sessions: readonly Session[];
  readonly selectedId: SessionId;
  /**
   * `boundary` is how the caller learns whether the order may advance. A row
   * clicked or arrowed in the tree is a finished decision; one committed from
   * the search field is not, so that path passes `null` and the order holds.
   */
  readonly onSelect: (id: SessionId, boundary?: Boundary | null) => void;
}) {
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const sessionById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );

  const rowRefs = useRef(new Map<SessionId, HTMLButtonElement>());
  const registerRef = useCallback((id: SessionId, node: HTMLButtonElement | null) => {
    if (node) rowRefs.current.set(id, node);
    else rowRefs.current.delete(id);
  }, []);

  const focusSelectedRow = useCallback(
    () => rowRefs.current.get(selectedId)?.focus(),
    [selectedId],
  );

  const search = useSearch({ ordered, sessions, projectNames, onSelect, focusSelectedRow });
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
    <Panel
      aria-label="Sessions"
      as="nav"
      className="flex min-h-0 w-tree flex-col"
      edge="right"
      tone="sunken"
    >
      <SidebarHeader createLabel="New session" />
      <SearchLine
        activeDescendantId={state.activeId === null ? undefined : rowId(state.activeId)}
        controlsId={TREE_ID}
        inputRef={search.inputRef}
        label="Search sessions"
        onKeyDown={search.onKeyDown}
        onValueChange={search.onValueChange}
        resultLabel={search.resultLabel}
        value={state.query}
      />
      <ScrollArea className="flex-1" contentClassName="flex flex-col px-inset pb-section">
        <div id={TREE_ID}>
          {/* Groups are separated by `section` ABOVE the header and nothing
              below it, so the whitespace belongs to the group it introduces and
              the block reads top-down. A symmetric gap gives a header equal
              claim on the group above it, which is how three groups read as
              six. */}
          {filtered.projects.map((group) => (
            <Disclosure
              collapsedCount={group.live.length + group.settled.length}
              className="mt-section first:mt-0"
              key={group.id}
              label={projectNames.get(group.id) ?? group.id}
              trailing={<ChangeHint count={group === filtered.projects[0] ? pendingChanges : 0} />}
            >
              <ul className="flex flex-col">
                {group.live.map((entry) => {
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
              {group.settled.length > 0 && (
                <Disclosure
                  // The open state rides the key so the uncontrolled disclosure
                  // re-mounts when filtering changes whether it holds a match:
                  // a result behind a closed group is a result nobody was shown.
                  defaultOpen={group.settledOpen}
                  key={`settled:${group.settledOpen}`}
                  label={`settled · ${group.settled.length}`}
                  level={1}
                  tone="faint"
                >
                  <ul className="flex flex-col">
                    {group.settled.map((entry) => {
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
                </Disclosure>
              )}
            </Disclosure>
          ))}
        </div>
      </ScrollArea>
    </Panel>
  );
}

/**
 * A two-line row: the session name, then why the engine put it here.
 *
 * There is no `State` chip on this row. The reason line already carries the
 * state and adds the age — "interrupted · 2h" next to a right-aligned
 * "interrupted" is the same fact printed twice, and the duplicate is the one
 * that costs a scan without paying for it. `State` is spent where the reason
 * line is not available.
 *
 * The reason line does get the DOT, though, and the distinction matters: a dot
 * is not a second copy of the word, it is the same word made scannable. The
 * reason line already begins with the state ("interrupted · 2h"), so the dot
 * marks that line rather than adding a column — the eye runs the dots down the
 * sidebar to find what is live, then reads the line it landed on.
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
    <li className="list-none">
      <Row
        aria-selected={active}
        current={current || active}
        id={rowId(session.id)}
        level={1}
        lines="two"
        onClick={() => onSelect(session.id)}
        onKeyDown={(event) => onKeyDown(event, session.id)}
        chevronSlot
        ref={(node: HTMLButtonElement | null) => registerRef(session.id, node)}
        role="option"
      >
        {/* The remainder goes MUTED as soon as there is a match to show, even
            on the selected row. That row is already primary tone at medium
            weight — the same treatment matched glyphs get — so keeping it at
            `fg` would make the highlight invisible on precisely the row the
            operator is standing on. Dropping the remainder instead means the
            matched glyphs are what stays put, and the mechanism is still only
            weight and the neutral ramp. */}
        <Highlight
          className="w-full"
          runs={highlightRuns(session.name, entry.spans)}
          tone={entry.spans.length > 0 || !(current || active) ? "muted" : "fg"}
        />
        <span className="flex w-full min-w-0 items-center">
          <StatusDot shape={RUN_STATE_SHAPE[session.state]} tier={RUN_STATE_TIER[session.state]} />
          <Text
            className="min-w-0 flex-1 truncate"
            level="meta"
            tone={session.state === "running" ? "accent" : "faint"}
          >
            {entry.reason}
          </Text>
        </span>
      </Row>
    </li>
  );
}

/**
 * Drift the Owner has not been shown yet. A count, never motion: the order is
 * held while they are working, and this is how the header says so without
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
