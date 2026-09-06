import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../src/renderer/app";
import type { ProjectSessionFacts, Signals } from "../src/renderer/attention";
import { orderByAttention } from "../src/renderer/attention";
import {
  lastReadAt,
  now,
  pins,
  projects,
  selectedSessionId,
  sessions,
  snoozes,
} from "../src/renderer/mock/console";
import { timelines } from "../src/renderer/mock/timelines";
import { SessionTree } from "../src/renderer/shell/session-tree";

/**
 * Selection is renderer view state (app.tsx). These assert the render contract
 * that state feeds: the header names the selected session and its agent, the
 * selected row is the only marked one, and the main column shows that session's
 * transcript.
 *
 * The click/keydown handlers are exercised in visual QA — there is no DOM test
 * runner here, and the engine's own behavior is covered by the attention tests.
 */
const selected = sessions.find((session) => session.id === selectedSessionId);

const signals: Signals = {
  now,
  activeSessionId: selectedSessionId,
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

const ordered = orderByAttention(
  projects.map((project) => project.id),
  facts,
  signals,
);

const tree = (selectedId: string) =>
  renderToStaticMarkup(
    <SessionTree
      onSelect={() => undefined}
      ordered={ordered}
      pendingChanges={0}
      projects={projects}
      selectedId={selectedId}
      sessions={sessions}
    />,
  );

describe("selection drives the main header", () => {
  test("Given the initial selection, When the app renders, Then the header names it", () => {
    const html = renderToStaticMarkup(<App />);

    expect(selected).toBeDefined();
    expect(html).toContain(selected?.name ?? "");
    expect(html).toContain(selected?.agent ?? "");
  });

  test("Given every mock session, When inspected, Then each can be named by the header", () => {
    for (const session of sessions) {
      expect(session.name.length).toBeGreaterThan(0);
      expect(session.agent.length).toBeGreaterThan(0);
    }
  });
});

describe("selection drives the transcript", () => {
  test("Given the initial selection, When the app renders, Then its own timeline is shown", () => {
    const html = renderToStaticMarkup(<App />);
    const timeline = timelines[selectedSessionId] ?? [];
    const prompt = timeline.find((node) => node.kind === "prompt");

    expect(prompt).toBeDefined();
    if (prompt?.kind === "prompt") {
      expect(html).toContain(prompt.text.slice(0, 40));
    }
  });

  test("Given every mock session, When looked up, Then each resolves to a timeline", () => {
    for (const session of sessions) {
      expect(timelines[session.id]).toBeDefined();
    }
  });
});

describe("the sidebar marks exactly one selected row", () => {
  test("Given a selection, When the tree renders, Then one row is marked current", () => {
    expect(tree(selectedSessionId).match(/aria-current="true"/g)).toHaveLength(1);
  });

  test("Given a different selection, When the tree renders, Then the marker moves", () => {
    const other = sessions.find((session) => session.id !== selectedSessionId);
    expect(other).toBeDefined();

    expect(tree(other?.id ?? "").match(/aria-current="true"/g)).toHaveLength(1);
  });
});

describe("the sidebar is project groups over sessions", () => {
  const html = tree(selectedSessionId);

  test("Given the ordered groups, When the tree renders, Then every project is a disclosure header", () => {
    for (const group of ordered.projects) {
      const name = projects.find((project) => project.id === group.id)?.name ?? "";
      expect(html).toContain(name);
    }
    expect(html.match(/aria-expanded="true"/g)?.length).toBeGreaterThanOrEqual(
      ordered.projects.length,
    );
  });

  test("Given each live row, When the tree renders, Then its reason is the second line", () => {
    // The reason line is the column's whole justification: without it the order
    // is an unexplained ranking.
    for (const group of ordered.projects) {
      for (const entry of group.live) {
        expect(html).toContain(entry.reason);
      }
    }
  });

  test("Given a project with settled work, When the tree renders, Then it collapses to a counted tail", () => {
    const withSettled = ordered.projects.filter((group) => group.settled.length > 0);

    expect(withSettled.length).toBeGreaterThan(0);
    for (const group of withSettled) {
      expect(html).toContain(`settled · ${group.settled.length}`);
    }
  });

  test("Given a collapsed settled tail, When the tree renders, Then its rows are absent from the tree", () => {
    const settledIds = ordered.projects.flatMap((group) => group.settled);
    const settledNames = settledIds.map(
      (id) => sessions.find((session) => session.id === id)?.name ?? "",
    );

    expect(settledNames.length).toBeGreaterThan(0);
    for (const name of settledNames) {
      expect(html).not.toContain(name);
    }
  });

  test("Given no pending drift, When the tree renders, Then no change hint is shown", () => {
    expect(html).not.toContain("changes");
  });

  test("Given pending drift, When the tree renders, Then the hint reports the count", () => {
    const html = renderToStaticMarkup(
      <SessionTree
        onSelect={() => undefined}
        ordered={ordered}
        pendingChanges={3}
        projects={projects}
        selectedId={selectedSessionId}
        sessions={sessions}
      />,
    );

    expect(html).toContain("3 changes");
  });
});
