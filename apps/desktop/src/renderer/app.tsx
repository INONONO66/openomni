import { Console } from "@openomni/ui";
import { useMemo, useState } from "react";
import { applyAtBoundary, orderByAttention } from "./attention";
import type { Boundary, Held, ProjectSessionFacts, Signals } from "./attention";
import {
  lastReadAt,
  now,
  pins,
  projects,
  selectedSessionId,
  sessions,
  snoozes,
} from "./mock/console";
import { approvals, timelines, turnCosts } from "./mock/timelines";
import { SessionTree } from "./shell/session-tree";

/**
 * Static shell over the mock data: [session navigator | transcript].
 *
 * The right-hand detail column is gone. A third column that is empty by design
 * spends a fifth of the window on nothing, and the surface this system is
 * building keeps content centered with the sides deliberately clear.
 *
 * The composer and the approval tray are wired to LOCAL STATE only. There is no
 * kernel behind this shell yet, so sending clears the draft and approving drops
 * the decision from the pending list — enough for the controls to be real and
 * reviewable, and honest about the fact that nothing is executed.
 *
 * Ordering runs through `attention` and is applied at a focus boundary only —
 * here, a selection change. Between boundaries the previous order is held, so
 * the list never reflows under the cursor.
 *
 * A selection made FROM the search field is deliberately not a boundary. The
 * operator is still inside the control, narrowing; reordering the rows they are
 * arrowing through is the exact reflow the rule exists to prevent, and it is
 * worse under a query than at rest because the result set moves too.
 *
 * The screen itself is `Console` from `@openomni/ui`, rendered here with live
 * data and in the showcase with a fixture — one component, so the two cannot
 * drift. This file's job is what the design system must not know: which session
 * is selected, how the list is ranked, and what the product's words are. It
 * composes the shell; it does not draw one.
 */
export function App() {
  const [selected, setSelected] = useState(selectedSessionId);
  const [held, setHeld] = useState<Held>(() => ({
    shown: idealOrder(selectedSessionId),
    pendingChanges: 0,
  }));
  // The draft is per session: switching away and back must not hand the Owner
  // a half-written message addressed to a different agent.
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [decided, setDecided] = useState<ReadonlySet<string>>(() => new Set());

  const session = sessions.find((candidate) => candidate.id === selected);
  const nodes = useMemo(() => timelines[selected] ?? [], [selected]);
  const costs = useMemo(() => turnCosts[selected] ?? {}, [selected]);
  const pending = useMemo(
    () => (approvals[selected] ?? []).filter((entry) => !decided.has(entry.toolId)),
    [selected, decided],
  );

  // Both decisions resolve the same way here, because with no kernel behind the
  // shell the only honest effect either one can have is to stop asking.
  const decide = (toolId: string) =>
    setDecided((was) => new Set(was).add(toolId));

  // Selection change IS the breakpoint: the Owner has just finished deciding
  // what to look at, so a new order costs them nothing — UNLESS the decision
  // was made from inside the search field, where they have not finished yet.
  const select = (id: string, boundary: Boundary | null = "selection") => {
    setSelected(id);
    setHeld((previous) => applyAtBoundary(previous, idealOrder(id), boundary));
  };

  return (
    // The window's own height. `Console` fills whatever box it is given, which
    // is what lets the showcase mount the same component in a bounded pane.
    <div className="h-screen min-h-0">
      <Console
        composerHint={session?.agent ?? "—"}
        composerMeta={`${Object.keys(costs).length} turns`}
        costs={costs}
        detail={session?.agent ?? "—"}
        draft={drafts[selected] ?? ""}
        emptyLabel="No turns in this session yet."
        nodes={nodes}
        onApprove={decide}
        onDeny={decide}
        onDraftChange={(value) => setDrafts((was) => ({ ...was, [selected]: value }))}
        onSubmit={() => setDrafts((was) => ({ ...was, [selected]: "" }))}
        pending={pending}
        sessionId={selected}
        sidebar={
          <SessionTree
            onSelect={select}
            ordered={held.shown}
            pendingChanges={held.pendingChanges}
            projects={projects}
            selectedId={selected}
            sessions={sessions}
          />
        }
        title={session?.name ?? "—"}
      />
    </div>
  );
}

/**
 * The engine's input. `now` is the mock's fixed instant rather than the wall
 * clock, so the shell renders the same ranking on every run — the same property
 * the tests rely on, for the same reason.
 */
function idealOrder(activeSessionId: string) {
  const signals: Signals = {
    now,
    activeSessionId,
    pins,
    snoozes,
    lastReadAt,
    userBusy: false,
  };
  const facts: readonly ProjectSessionFacts[] = sessions.map((session) => ({
    id: session.id,
    projectId: session.projectId,
    state: session.state,
    lastEventAt: session.lastEventAt,
    lastUserTurnAt: session.lastUserTurnAt,
    unreadCount: session.unreadCount,
  }));

  return orderByAttention(
    projects.map((project) => project.id),
    facts,
    signals,
  );
}
