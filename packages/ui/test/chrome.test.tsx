import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MainHeader, SearchLine, SidebarHeader } from "../src/chrome";

/** The primitive is data-blind, so every test supplies its own props. */
const searchLine = (props: Partial<Parameters<typeof SearchLine>[0]> = {}) =>
  renderToStaticMarkup(
    <SearchLine
      controlsId="session-tree"
      inputRef={null}
      label="Search sessions"
      onKeyDown={() => undefined}
      onValueChange={() => undefined}
      value=""
      {...props}
    />,
  );

describe("MainHeader", () => {
  test("Given a title and detail, When rendered, Then both are set in type and the row drags", () => {
    const html = renderToStaticMarkup(<MainHeader detail="claude-sonnet-4-6" title="worker-3" />);

    expect(html).toContain("worker-3");
    expect(html).toContain("claude-sonnet-4-6");
    expect(html).toContain("drag-region");
  });

  test("Given any header, When rendered, Then it carries no badge or toggle chrome", () => {
    // Counts belong to the rows that own them; the frame protects focus.
    const html = renderToStaticMarkup(<MainHeader detail="a" title="s" />);

    expect(html).not.toContain("<button");
    expect(html).not.toContain("aria-pressed");
  });
});

describe("SidebarHeader", () => {
  test("Given the header, When rendered, Then its only control opts out of dragging", () => {
    const html = renderToStaticMarkup(<SidebarHeader createLabel="New session" />);

    expect(html).toContain("drag-region");
    expect(html).toMatch(/<button[^>]*no-drag/);
  });

  test("Given a create label, When rendered, Then the frame names the action from the surface", () => {
    // The frame owns the button; the surface owns the word. Passing a
    // different label must actually change the accessible name, or the prop is
    // decoration over a hardcoded string.
    const html = renderToStaticMarkup(<SidebarHeader createLabel="New workspace" />);

    expect(html).toContain("New workspace");
    expect(html).not.toContain("New session");
  });
});

describe("SearchLine", () => {
  const html = searchLine();

  test("Given the search row, When rendered, Then it is a labelled field and nothing else", () => {
    // Search is the one feature that earns permanent chrome; the rest hides.
    expect(html).toContain("<input");
    expect(html).toContain("Search sessions");
    expect(html).not.toContain("<button");
  });

  test("Given a label, When rendered, Then the surface names the field, not the frame", () => {
    // The line owns the geometry and the wiring; what is being searched is the
    // app's word. A hardcoded name would make this prop decoration.
    const named = searchLine({ label: "Search workspaces" });

    expect(named).toContain("Search workspaces");
    expect(named).not.toContain("Search sessions");
  });

  test("Given the search row, When rendered, Then the shortcut is the affordance", () => {
    // The hint is what says "keyboard-first". Without it the line has no
    // affordance at all, which is the only thing the deleted fill was buying.
    expect(html).toContain("\u2318K");
  });

  test("Given the shortcut hint, When rendered, Then it is ambient and not a control", () => {
    // A second focus stop in front of the field costs the keyboard operator a
    // tab for nothing, and the hint is not pressed — it is read.
    const hint = html.slice(html.indexOf("\u2318K") - 220, html.indexOf("\u2318K"));

    expect(hint).toContain("text-fg-faint");
    expect(hint).toContain("tabular-nums");
    expect(html).not.toContain("tabindex");
  });

  test("Given the field at rest, When rendered, Then it is a line and not a box", () => {
    // The whole point: no fill and no drawn frame. A filled rectangle is the
    // loudest thing in a column whose hierarchy is quiet type on whitespace.
    expect(html).not.toContain("bg-raised");
    expect(html).not.toContain("bg-sunken");
    expect(html).not.toContain("rounded");
    expect(html).toContain("border-b-transparent");
  });

  test("Given focus, When rendered, Then the only change is a hairline underline", () => {
    // A hairline, NOT the accent: the accent budget is running state, the
    // primary action, and the focus ring — a search field is none of those.
    expect(html).toContain("focus-within:border-b-line");
    expect(html).not.toContain('accent-fg"');
    expect(html).not.toContain("focus-within:border-b-accent");
  });

  test("Given the field, When rendered, Then it hangs on the L0 text x", () => {
    // One left edge above the tree: the placeholder starts where a project
    // header's name starts, so the control does not introduce a second one.
    expect(html).toContain("--spacing-indent-slot");
    expect(html).toContain("h-row");
  });

  test("Given the placeholder, When rendered, Then it survives focus in the ambient tone", () => {
    // The placeholder IS the label here, so it must not vanish on focus: a
    // field that empties its own name on focus loses what it searches.
    expect(html).toContain('placeholder="Search"');
    expect(html).toContain("placeholder:text-fg-faint");
    expect(html).toContain("caret-fg");
  });

  test("Given a live query, When rendered, Then the hint reports the escape and not the entry", () => {
    // At rest the operator's question is how to get IN; with a query up it is
    // how to get OUT. One slot, answering whichever question is current.
    expect(html).toContain("\u2318K");
    expect(html).not.toContain(">esc<");

    const typing = searchLine({ value: "back" });
    expect(typing).toContain(">esc<");
    expect(typing).not.toContain("\u2318K");
  });

  test("Given the field, When rendered, Then it is wired as a combobox over the tree", () => {
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-controls="session-tree"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain("Search sessions");
  });

  test("Given an active result, When rendered, Then the field points at that row and not otherwise", () => {
    // A stale or absent activedescendant is silent: the field looks correct in
    // every screenshot and announces nothing.
    expect(html).not.toContain("aria-activedescendant");
    expect(searchLine({ value: "b", activeDescendantId: "session-row-kernel-ledger" })).toContain(
      'aria-activedescendant="session-row-kernel-ledger"',
    );
  });

  test("Given a query, When the field expands, Then it says so and rests closed", () => {
    expect(html).toContain('aria-expanded="false"');
    expect(searchLine({ value: "b" })).toContain('aria-expanded="true"');
  });

  test("Given no result label, When rendered, Then the count line is absent entirely", () => {
    // An always-on count is chrome spending a row to say nothing at rest.
    expect(html).not.toContain("aria-live");

    const counted = searchLine({ value: "back", resultLabel: "3 results" });
    expect(counted).toContain("3 results");
    expect(counted).toContain('aria-live="polite"');
    expect(counted).toContain("tabular-nums");
  });

  test("Given the count line, When rendered, Then it adds no surface of its own", () => {
    // "replaces nothing else, no extra chrome": one ambient line and no box.
    const counted = searchLine({ value: "x", resultLabel: "no sessions match" });

    expect(counted).toContain("no sessions match");
    expect(counted).not.toContain("bg-raised");
    expect(counted).not.toContain("rounded");
    expect(counted).not.toContain("<button");
  });

  test("Given the field, When rendered, Then it carries no platform clear control", () => {
    // `type="search"` draws the OS's own clear affordance — a second control
    // for what Esc already does, in a style this system does not own.
    expect(html).not.toContain('type="search"');
    expect(html).toContain('type="text"');
  });
});
