import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EpochRule } from "../src/primitives/epoch-rule";
import { GutterLine } from "../src/primitives/gutter";
import { StatusDot } from "../src/primitives/state";
import { HistoryMenu } from "../src/history-menu";
import {
  NavItem,
  SectionHeader,
  SectionSearchInput,
  SidebarFooter,
  SidebarNav,
  SidebarSection,
} from "../src/sidebar-nav";

describe("sidebar navigation controls", () => {
  test("renders active and inactive destinations with accessible state", () => {
    const html = renderToStaticMarkup(
      <SidebarNav>
        <NavItem active icon={<svg aria-hidden="true" />}>
          One
        </NavItem>
        <NavItem icon={<svg aria-hidden="true" />}>Two</NavItem>
      </SidebarNav>,
    );
    expect(html).toContain('aria-current="page"');
    expect(html.match(/data-ui="NavItem"/g)).toHaveLength(2);
    expect(html).toContain("text-fg-muted");
  });
  test("header toggles search semantics and result announcement", () => {
    const closed = renderToStaticMarkup(
      <SectionHeader
        label="Projects"
        searching={false}
        onSearchingChange={() => undefined}
        searchLabel="Search projects"
        resultLabel="2 results"
      />,
    );
    const open = renderToStaticMarkup(
      <SectionHeader
        label="Projects"
        searching
        onSearchingChange={() => undefined}
        searchLabel="Search projects"
      >
        <SectionSearchInput
          label="Projects"
          placeholder="Filter"
          value="x"
          onValueChange={() => undefined}
          onKeyDown={() => undefined}
          inputRef={() => undefined}
          controlsId="results"
          activeDescendantId="row-1"
        />
      </SectionHeader>,
    );
    expect(closed).not.toContain("data-searching");
    expect(closed).toContain('aria-live="polite"');
    expect(open).toContain('role="combobox"');
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('aria-controls="results"');
  });
  test("section and footer preserve their structural slots", () => {
    const html = renderToStaticMarkup(
      <SidebarSection>
        <SidebarFooter>footer</SidebarFooter>
      </SidebarSection>,
    );
    expect(html).toContain('data-ui="Sidebar.Footer"');
    expect(html).toContain("border-line");
  });
});

describe("drawn primitive behavior", () => {
  test("gutter marks encode add, remove, context and anchor interaction", () => {
    const html = renderToStaticMarkup(
      <>
        <GutterLine number={1} mark="add">
          a
        </GutterLine>
        <GutterLine number={2} mark="remove" anchored onAnchor={() => undefined}>
          b
        </GutterLine>
        <GutterLine number={3}>c</GutterLine>
      </>,
    );
    expect(html).toContain('data-mark="add"');
    expect(html).toContain('data-mark-char="remove"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="line 2"');
  });
  test("status shapes use distinct machine attributes", () => {
    const html = renderToStaticMarkup(
      <>
        <StatusDot shape="pulse" tier="live" />
        <StatusDot shape="ring" tier="attention" />
        <StatusDot shape="slashed" tier="settled" />
      </>,
    );
    expect(html).toContain('data-status-dot="running"');
    expect(html).toContain('data-status-dot="ring"');
    expect(html).toContain('data-status-dot="slashed"');
    expect(html).toContain("text-accent");
    expect(html).toContain("<mask");
  });
  test("epoch rule is inert without destination and a button with one", () => {
    const inert = renderToStaticMarkup(<EpochRule label="compacted" />);
    const jump = renderToStaticMarkup(
      <EpochRule label="resumed" meta="3h" onJump={() => undefined} />,
    );
    expect(inert).toContain("data-epoch-rule");
    expect(inert).not.toContain('type="button"');
    expect(jump).toContain('type="button"');
    expect(jump).toContain("tabular-nums");
  });
});

describe("history menu first paint", () => {
  test("empty and populated histories expose a closed menu trigger", () => {
    const empty = renderToStaticMarkup(
      <HistoryMenu entries={[]} currentId={null} now={0} onJump={() => undefined} />,
    );
    const entries = Array.from({ length: 21 }, (_: undefined, i: number) => ({
      id: String(i),
      title: `t${i}`,
      at: 0,
    }));
    const html = renderToStaticMarkup(
      <HistoryMenu entries={entries} currentId="20" now={0} onJump={() => undefined} />,
    );
    for (const markup of [empty, html]) {
      expect(markup).toContain('aria-haspopup="menu"');
      expect(markup).toContain('aria-expanded="false"');
      expect(markup).not.toContain('role="menuitem"');
    }
  });
});
