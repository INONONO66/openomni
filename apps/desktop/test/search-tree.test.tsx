import { describe, expect, test } from "bun:test";
import { Highlight } from "@openomni/ui";
import { renderToStaticMarkup } from "react-dom/server";
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
import { SessionTree } from "../src/renderer/shell/session-tree";

/**
 * The rendered wiring between the search field and the tree it filters.
 *
 * `aria-controls` and `aria-activedescendant` are the two facts a screen reader
 * uses to follow the field, and both fail SILENTLY: a mismatched id announces
 * nothing while looking perfect in every screenshot. So the ids are asserted to
 * agree with the rows that actually rendered, rather than to match a literal.
 *
 * Behavior driven by real key events is covered by search-keyboard.test.ts (the
 * reducer) and script/probe-search.ts (the browser).
 */
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

const html = renderToStaticMarkup(
  <SessionTree
    onSelect={() => undefined}
    ordered={ordered}
    pendingChanges={0}
    projects={projects}
    selectedId={selectedSessionId}
    sessions={sessions}
  />,
);

describe("the field is wired to the tree it filters", () => {
  test("Given the sidebar, When rendered, Then the field is a combobox over a real element", () => {
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];

    expect(html).toContain('role="combobox"');
    expect(controls).toBeDefined();
    // The target must EXIST — an aria-controls pointing at nothing is silent.
    expect(html).toContain(`id="${controls}"`);
  });

  test("Given the sidebar, When rendered, Then it is labelled for a screen reader", () => {
    expect(html).toContain("Search sessions");
  });

  test("Given every session row, When rendered, Then each carries the id the field can point at", () => {
    // The reserved shape: `aria-activedescendant` is set from the same helper,
    // so a row missing its id is a row the field can never announce.
    for (const group of ordered.projects) {
      for (const entry of group.live) {
        expect(html).toContain(`id="session-row-${entry.id}"`);
      }
    }
  });

  test("Given the rows, When rendered, Then they are options inside the controlled element", () => {
    const liveRows = ordered.projects.reduce((total, group) => total + group.live.length, 0);

    expect(html.match(/role="option"/g)).toHaveLength(liveRows);
  });

  test("Given no active row, When rendered, Then the field points at nothing", () => {
    // A stale activedescendant is worse than none: it announces a row the
    // operator is not on.
    expect(html).not.toContain("aria-activedescendant");
    expect(html.match(/aria-selected="true"/g)).toBeNull();
  });

  test("Given the field at rest, When rendered, Then the entry shortcut is shown and no count", () => {
    expect(html).toContain("\u2318K");
    expect(html).not.toContain("results");
    expect(html).not.toContain("no sessions match");
  });
});

describe("the tree still reads as a tree under the search field", () => {
  test("Given the sidebar, When rendered, Then the three depths survive", () => {
    const levels = [...html.matchAll(/data-level="(\d)"/g)].map((hit) => Number(hit[1]));
    const liveRows = ordered.projects.reduce((total, group) => total + group.live.length, 0);
    const tails = ordered.projects.filter((group) => group.settled.length > 0).length;

    expect(levels.filter((level) => level === 0)).toHaveLength(ordered.projects.length);
    expect(levels.filter((level) => level === 1)).toHaveLength(liveRows + tails);
  });

  test("Given a selection, When rendered, Then exactly one row is current", () => {
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  });

  test("Given a running session, When rendered, Then the dot is the readout and the word is gone", () => {
    // The fixture has to contain the case, or the two assertions below are
    // satisfied by an empty column.
    const unphrased = ordered.projects.flatMap((group) =>
      group.live.filter((entry) => entry.reason === ""),
    );
    expect(unphrased.length).toBeGreaterThan(0);
    expect(
      unphrased.every((entry) => sessions.find((s) => s.id === entry.id)?.state === "running"),
    ).toBe(true);

    // The accent dot already says "right now" — it is the one thing in the
    // column allowed to make that claim — so the word beside it was the same
    // fact printed twice, on precisely the rows that are busiest.
    expect(html).not.toContain(">running</");
    expect(html).toContain('data-status-dot="running"');
  });

  test("Given a dot with no phrase beside it, When read by assistive technology, Then the state is still announced", () => {
    // Dropping the word from the screen must not drop it from the accessibility
    // tree: a dot that only exists visually is a state a screen reader cannot
    // report at all. The row's status cell carries the name, because
    // `StatusDot` is `aria-hidden` by contract.
    //
    // Counted over rows whose reason is EMPTY rather than over running sessions:
    // a pinned session is also running, and it prints "pinned" — a phrase, which
    // is a readout, so that row needs no substitute name.
    const unphrased = ordered.projects.flatMap((group) =>
      group.live.filter((entry) => entry.reason === ""),
    );

    expect(html.match(/title="running"/g) ?? []).toHaveLength(unphrased.length);
    expect(html.match(/aria-label="running"/g) ?? []).toHaveLength(unphrased.length);
    // The role is what makes the label land: a bare span is `generic`, and a
    // `generic` element's accessible name is not exposed by any mapping — the
    // attribute reads correctly in the markup and announces nothing.
    expect(html).toMatch(/<span aria-label="running" role="img" title="running">/);
  });

  test("Given every live row, When rendered, Then its reason is still the second line", () => {
    for (const group of ordered.projects) {
      // A running row's reason is empty by design (see below), and `toContain`
      // on an empty string asserts nothing at all.
      for (const entry of group.live.filter((live) => live.reason !== "")) {
        expect(html).toContain(entry.reason);
      }
    }
  });

  test("Given every live row, When rendered, Then its name survives the highlight split", () => {
    // At rest there are no matched glyphs, so each name must render as ONE
    // unweighted run — a split label would show as the same text with a seam.
    for (const group of ordered.projects) {
      for (const entry of group.live) {
        const name = sessions.find((session) => session.id === entry.id)?.name ?? "";
        expect(html).toContain(`>${name}</span>`);
      }
    }
  });

  test("Given the field at rest, When rendered, Then no glyph run is emphasised", () => {
    // A weighted RUN at rest would mean the highlight fires with no query,
    // which is how a highlight becomes decoration. The selected row's own
    // `font-medium` is selection and stays — so this looks at the run spans
    // only, which are the exact elements the highlight owns.
    expect(html).not.toContain('<span class="font-medium text-fg">');
  });

  test("Given no query, When rendered, Then the selected row keeps the primary tone", () => {
    // At rest there is nothing to separate, so the selected row reads at full
    // strength. The muting below is a filtering treatment, not the resting one.
    const selected = sessions.find((session) => session.id === selectedSessionId)?.name ?? "";

    // Read off the selected row's Highlight element rather than a raw substring
    // spanning the tag boundary. The old form pinned `...w-full"><span...`,
    // which broke the moment the element gained an attribute after its class —
    // a false failure about a tone that had not changed. The name is the stable
    // handle; `packages/ui/test/names.test.tsx` fails if it moves.
    const highlight = /<span class="([^"]*)" data-ui="Highlight"><span class="([^"]*)">([^<]*)</g;
    const labels = [...html.matchAll(highlight)].map((match) => ({
      tone: match[1] ?? "",
      run: match[2] ?? "",
      text: match[3] ?? "",
    }));

    const row = labels.find((label) => label.text === selected);
    expect(row, `no Highlight rendered for the selected row "${selected}"`).toBeDefined();
    // Full strength, and not the muted tone the unselected rows carry.
    expect(row?.tone).toContain("text-fg");
    expect(row?.tone).not.toContain("text-fg-muted");
    // Unweighted, because at rest there is no query to emphasise against.
    expect(row?.run).toBe("font-normal");
  });

  test("Given a match, When the same span markup is produced, Then this test would see it", () => {
    // Guards the assertion above against passing vacuously: if the highlight's
    // emitted class string ever changes, the negative check must stop matching
    // the real thing, and this catches that instead of going quietly green.
    const emphasised = renderToStaticMarkup(<Highlight runs={[{ text: "led", matched: true }]} />);

    expect(emphasised).toContain('<span class="font-medium text-fg">');
  });
});
