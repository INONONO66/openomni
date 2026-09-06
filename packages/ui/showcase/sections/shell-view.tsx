import { useRef, useState } from "react";
import {
  Console,
  Disclosure,
  Highlight,
  Panel,
  Row,
  ScrollArea,
  SearchLine,
  SidebarHeader,
  type StateTier,
  StatusDot,
  type StatusShape,
  Text,
} from "../../src";
import { costs, pending, transcript } from "../fixture";

/**
 * The Shell tab renders `Console` — the SAME component the desktop renderer
 * mounts — over a fixture.
 *
 * Only the NAVIGATOR is assembled here, as the slot `Console` deliberately
 * leaves open. That is the honest seam: what ranks and filters those rows is
 * the app's attention and search engines, which name sessions and projects and
 * cannot cross into `@openomni/ui`. The showcase supplies a fixture tree, the
 * app supplies a live one, and everything to the right of that edge is one
 * shared component.
 *
 * The composer and the tray are wired to local state for the same reason the
 * app wires them to local state: the controls have to be REAL to be reviewed,
 * and there is nothing behind them to execute.
 */
export function ShellView() {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [decided, setDecided] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const groups = GROUPS.map((group) => ({
    ...group,
    live: group.live.filter((session) => matches(session.name, query)),
  })).filter((group) => query.length === 0 || group.live.length > 0);
  const total = groups.reduce((count, group) => count + group.live.length, 0);

  return (
    <div className="h-[calc(100vh-var(--spacing-titlebar))] min-h-0">
      <Console
        composerHint="claude-sonnet-4-6"
        composerMeta="39.8k · 2 turns"
        costs={costs}
        detail="claude-sonnet-4-6"
        draft={draft}
        emptyLabel="No turns in this session yet."
        nodes={transcript}
        onApprove={() => setDecided(true)}
        onDeny={() => setDecided(true)}
        onDraftChange={setDraft}
        onSubmit={() => setDraft("")}
        pending={decided ? [] : pending}
        sessionId="showcase"
        sidebar={
          <Panel
            aria-label="Sessions"
            as="nav"
            className="flex min-h-0 w-tree flex-col"
            edge="right"
            tone="sunken"
          >
            <SidebarHeader createLabel="New session" />
            <SearchLine
              controlsId="showcase-tree"
              inputRef={inputRef}
              label="Search sessions"
              onKeyDown={() => undefined}
              onValueChange={setQuery}
              resultLabel={resultLabel(query, total)}
              value={query}
            />
            <ScrollArea className="flex-1" contentClassName="flex flex-col px-inset pb-section">
              {/* PROJECT → SESSION, and that is the whole depth. Whitespace sits
                  ABOVE a group header and not below it, so each block reads
                  top-down instead of a header having equal claim on the group
                  above it. No connectors: two levels are stated completely by
                  indentation, and an elbow beside a row that is already the only
                  thing at its x is topology redrawn in ink. */}
              {groups.map((group) => (
                <Disclosure
                  className="mt-section first:mt-0"
                  collapsedCount={group.live.length + group.settled.length}
                  key={group.project}
                  label={group.project}
                >
                  <ul className="flex flex-col" id="showcase-tree">
                    {group.live.map((session) => (
                      <SidebarRow key={session.name} query={query} session={session} />
                    ))}
                  </ul>
                  {group.settled.length > 0 && (
                    // Settled sessions are PLAIN ROWS at the same depth as live
                    // ones, under a quieter header. They are not a third level:
                    // they are sessions in this project that have finished.
                    <Disclosure
                      label={`settled · ${group.settled.length}`}
                      level={1}
                      tone="faint"
                    >
                      <ul className="flex flex-col">
                        {group.settled.map((session) => (
                          <SidebarRow key={session.name} query={query} session={session} />
                        ))}
                      </ul>
                    </Disclosure>
                  )}
                </Disclosure>
              ))}
            </ScrollArea>
          </Panel>
        }
        title="ledger append path"
      />
    </div>
  );
}

interface ShellSession {
  readonly name: string;
  readonly state: "running" | "waiting" | "done" | "interrupted";
  readonly reason: string;
  readonly current?: boolean;
}

/**
 * The navigator's own shape and tone table.
 *
 * It survives because the sidebar row survives: these are session states, the
 * product's vocabulary, and the fixture has to resolve them exactly as
 * `apps/desktop/src/renderer/run-state.ts` does for the live tree.
 */
const DOT: Record<ShellSession["state"], StatusShape> = {
  running: "pulse",
  waiting: "ring",
  done: "filled",
  interrupted: "slashed",
};

const TIER: Record<ShellSession["state"], StateTier> = {
  running: "live",
  waiting: "attention",
  done: "settled",
  interrupted: "settled",
};

const GROUPS: readonly {
  readonly project: string;
  readonly live: readonly ShellSession[];
  readonly settled: readonly ShellSession[];
}[] = [
  {
    project: "openomni-kernel",
    live: [
      { name: "ledger append path", state: "running", reason: "running", current: true },
      { name: "alarm replay", state: "interrupted", reason: "interrupted \u00b7 2h" },
    ],
    settled: [{ name: "schema drift audit", state: "done", reason: "finished \u00b7 3h" }],
  },
  {
    project: "channel-perimeter",
    live: [
      { name: "router backpressure", state: "waiting", reason: "waiting for you \u00b7 12m" },
      { name: "slack bridge", state: "running", reason: "running" },
    ],
    settled: [],
  },
  {
    project: "atlas-migration",
    live: [{ name: "cutover rehearsal", state: "done", reason: "finished \u00b7 40m" }],
    settled: [
      { name: "index backfill", state: "done", reason: "finished \u00b7 1d" },
      { name: "shadow read check", state: "done", reason: "finished \u00b7 2d" },
    ],
  },
];

/** Case-insensitive substring, for the showcase's own inline strings only. */
function matches(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.trim().toLowerCase());
}

function resultLabel(query: string, total: number): string | undefined {
  if (query.trim().length === 0) return undefined;
  if (total === 0) return "no sessions match";
  return `${total} result${total === 1 ? "" : "s"}`;
}

/**
 * Split a label around a substring hit, so the showcase can demonstrate the
 * weight-only highlight. Matched glyphs go medium in the primary tone; the rest
 * stays where it was. No color and no fill — the accent is spent elsewhere.
 */
function runsFor(name: string, query: string): readonly { text: string; matched: boolean }[] {
  const needle = query.trim().toLowerCase();
  const at = needle.length === 0 ? -1 : name.toLowerCase().indexOf(needle);
  if (at === -1) return [{ text: name, matched: false }];
  return [
    { text: name.slice(0, at), matched: false },
    { text: name.slice(at, at + needle.length), matched: true },
    { text: name.slice(at + needle.length), matched: false },
  ].filter((run) => run.text.length > 0);
}

/** Two lines: the session, then why the engine put it here. */
function SidebarRow({
  session,
  query,
}: {
  readonly session: ShellSession;
  readonly query: string;
}) {
  return (
    <li className="list-none">
      <Row chevronSlot current={session.current ?? false} level={1} lines="two">
        <Highlight
          className="w-full"
          runs={runsFor(session.name, query)}
          tone={session.current ? "fg" : "muted"}
        />
        <span className="flex w-full min-w-0 items-center">
          <StatusDot shape={DOT[session.state]} tier={TIER[session.state]} />
          <Text
            className="min-w-0 flex-1 truncate"
            level="meta"
            tone={session.state === "running" ? "accent" : "faint"}
          >
            {session.reason}
          </Text>
        </span>
      </Row>
    </li>
  );
}
