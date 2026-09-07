import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { relativeTime } from "../src/history-menu";
import { clampSidebarWidth, Sidebar, SidebarContainer, SidebarGap } from "../src/sidebar";
import { SectionHeader, SidebarHeader } from "../src/sidebar-nav";
import { TabStrip, type WindowPlatform } from "../src/tab-strip";
import { TreeRow } from "../src/tree-row";
import { STRIP } from "./fixture";

/**
 * The frame's class-state contract, asserted on static markup: which classes
 * and attributes each sidebar state produces. The numbers are the reference console's
 * (docs/desktop-shell.md); the tests pin the ones a regression would move.
 */

function frame(open: boolean, children: ReactNode, platform: WindowPlatform = "darwin") {
  return renderToStaticMarkup(
    <Sidebar onToggle={() => undefined} onWidthCommit={() => undefined} open={open} width={240}>
      <TabStrip
        createLabel="New"
        history={STRIP.history}
        onCreate={() => undefined}
        platform={platform}
      />
      <SidebarGap />
      <SidebarContainer>{children}</SidebarContainer>
    </Sidebar>,
  );
}

/** The element carrying a `data-ui` name, as its opening tag. */
function tag(html: string, name: string): string {
  const match = html.match(new RegExp(`<[a-z]+[^>]*data-ui="${name.replace(".", "\\.")}"[^>]*>`));
  if (match === null) throw new Error(`no element named ${name}`);
  return match[0];
}

describe("the width clamp", () => {
  test("Given widths outside 224..330, When clamped, Then they land on the edges", () => {
    expect(clampSidebarWidth(100)).toBe(224);
    expect(clampSidebarWidth(400)).toBe(330);
  });

  test("Given a fractional width inside the range, When clamped, Then it is a whole pixel", () => {
    expect(clampSidebarWidth(250.4)).toBe(250);
    expect(clampSidebarWidth(250.6)).toBe(251);
  });
});

describe("the sidebar root", () => {
  test("Given an open sidebar, When rendered, Then the root states it and carries the width", () => {
    const root = tag(frame(true, null), "Sidebar");
    expect(root).toContain('data-sidebar-state="open"');
    expect(root).toContain("--sidebar-width:240px");
  });

  test("Given a collapsed sidebar, When rendered, Then the column is inert and the handle leaves the tab order", () => {
    const html = frame(false, <p>rows</p>);
    expect(tag(html, "Sidebar")).toContain('data-sidebar-state="collapsed"');
    expect(tag(html, "Sidebar.Content")).toContain("inert");
    expect(tag(html, "Sidebar.ResizeHandle")).toContain('tabindex="-1"');
  });

  test("Given an open sidebar, When rendered, Then the column is live and the handle is a focus stop", () => {
    const html = frame(true, <p>rows</p>);
    expect(tag(html, "Sidebar.Content")).not.toContain("inert");
    expect(tag(html, "Sidebar.ResizeHandle")).toContain('tabindex="0"');
  });

  test("Given the three moving parts, When rendered, Then each animates its own property and yields to reduced motion", () => {
    const html = frame(true, null);
    const gap = tag(html, "Sidebar.Gap");
    const container = tag(html, "Sidebar.Container");
    const content = tag(html, "Sidebar.Content");
    expect(gap).toContain("transition-[width]");
    expect(gap).toContain("group-data-[sidebar-state=collapsed]/sidebar:w-0");
    expect(container).toContain("transition-[translate]");
    expect(container).toContain("group-data-[sidebar-state=collapsed]/sidebar:-translate-x-full");
    expect(content).toContain("transition-[opacity,translate]");
    expect(content).toContain("delay-[40ms]");
    for (const part of [gap, container, content]) {
      expect(part).toContain("motion-reduce:transition-none");
      expect(part).toContain("group-data-[resizing]/sidebar:duration-0");
    }
  });
});

describe("the tab strip's controls zone", () => {
  test("Given an open sidebar, When rendered, Then the zone is the sidebar's width and holds no toggle", () => {
    const html = frame(true, null);
    expect(tag(html, "TabStrip.Controls")).toContain("w-(--sidebar-width)");
    expect(html).not.toContain('aria-label="Expand sidebar"');
  });

  test("Given a collapsed sidebar on darwin, When rendered, Then the zone clears the traffic lights and leads with the toggle", () => {
    const html = frame(false, null);
    const zone = tag(html, "TabStrip.Controls");
    expect(zone).toContain("pl-[76px]");
    expect(zone).toContain("w-tab-controls-collapsed ");
    expect(zone).toContain("duration-fast");
    expect(html.indexOf('aria-label="Expand sidebar"')).toBeLessThan(
      html.indexOf('aria-label="History"'),
    );
  });

  test("Given a collapsed sidebar elsewhere, When rendered, Then the zone starts at the window edge", () => {
    const zone = tag(frame(false, null, "other"), "TabStrip.Controls");
    expect(zone).toContain("w-tab-controls-collapsed-generic");
    expect(zone).not.toContain("pl-[76px]");
  });

  test("Given the zone, When rendered, Then it animates width and padding on the frame's curve and yields to reduced motion", () => {
    const zone = tag(frame(true, null), "TabStrip.Controls");
    expect(zone).toContain("transition-[width,padding]");
    expect(zone).toContain("ease-out-quint");
    expect(zone).toContain("motion-reduce:transition-none");
    expect(zone).toContain("group-data-[resizing]/sidebar:duration-0");
  });

  test("Given no title, When rendered, Then no tab is drawn but the create control is", () => {
    const html = frame(true, null);
    expect(html).not.toContain('data-ui="Tab"');
    expect(html).toContain('aria-label="New"');
  });

  test("Given a title, When rendered, Then the tab is a 28px card with no status mark", () => {
    const html = renderToStaticMarkup(
      <Sidebar onToggle={() => undefined} onWidthCommit={() => undefined} open width={240}>
        <TabStrip
          createLabel="New"
          history={STRIP.history}
          onCreate={() => undefined}
          platform="darwin"
          title="ledger"
        />
      </Sidebar>,
    );
    const tab = tag(html, "Tab");
    expect(tab).toContain("h-7 w-56");
    expect(tab).toContain("rounded-card");
    expect(html).not.toContain('data-ui="StatusDot"');
  });

  test("Given a history at its ends, When rendered, Then back and forward are disabled", () => {
    const html = frame(true, null);
    expect(html).toMatch(/aria-label="Back"[^>]*disabled/);
    expect(html).toMatch(/aria-label="Forward"[^>]*disabled/);
  });
});

describe("the sidebar header", () => {
  test("Given the header, When rendered, Then it is a 44px drag surface with search then toggle at the right", () => {
    const html = frame(true, <SidebarHeader onSearch={() => undefined} />);
    const header = tag(html, "Sidebar.Header");
    expect(header).toContain("h-11");
    expect(header).toContain("drag-region");
    expect(html.indexOf('aria-label="Search (⌘K)"')).toBeLessThan(
      html.indexOf('aria-label="Collapse sidebar"'),
    );
  });
});

describe("the section header", () => {
  const rest = renderToStaticMarkup(
    <SectionHeader
      label="Sessions"
      onSearchingChange={() => undefined}
      searchLabel="Search sessions"
      searching={false}
    >
      <input />
    </SectionHeader>,
  );
  const searching = renderToStaticMarkup(
    <SectionHeader
      label="Sessions"
      onSearchingChange={() => undefined}
      resultLabel="2 results"
      searchLabel="Search sessions"
      searching
    >
      <input />
    </SectionHeader>,
  );

  test("Given a section at rest, When rendered, Then it is a 32px row with the label on the text x and a search toggle", () => {
    expect(rest).toContain("h-8");
    expect(rest).toContain("pl-4");
    expect(rest).toContain("Sessions");
    expect(rest).toContain('aria-label="Search sessions"');
    expect(rest).not.toContain("<input");
  });

  test("Given a searching section, When rendered, Then the field replaces the label, the inset tightens, and the toggle closes", () => {
    expect(searching).toContain("<input");
    expect(searching).not.toContain(">Sessions<");
    expect(searching).toContain("pl-2");
    expect(searching).toContain('aria-label="Close search"');
    expect(searching).toContain("2 results");
  });
});

describe("a tree row", () => {
  test("Given each level, When rendered, Then the depth is an attribute and a padding step", () => {
    expect(renderToStaticMarkup(<TreeRow level={0}>a</TreeRow>)).toContain('data-level="0"');
    const one = renderToStaticMarkup(<TreeRow level={1}>a</TreeRow>);
    expect(one).toContain('data-level="1"');
    expect(one).toContain("var(--spacing-indent))]");
    expect(renderToStaticMarkup(<TreeRow level={2}>a</TreeRow>)).toContain(
      "var(--spacing-indent)*2)]",
    );
  });

  test("Given a row, When rendered, Then it is one 28px line with no mark or connector", () => {
    const html = renderToStaticMarkup(<TreeRow>a very long session title</TreeRow>);
    expect(html).toContain("h-7");
    expect(html).toContain("truncate");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("StatusDot");
  });

  test("Given the current row, When rendered, Then it says so and takes the raised fill", () => {
    const html = renderToStaticMarkup(<TreeRow current>a</TreeRow>);
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("bg-raised");
  });

  test("Given a group row, When rendered, Then only it carries the chevron and its state", () => {
    const html = renderToStaticMarkup(<TreeRow expanded>a</TreeRow>);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("<svg");
    expect(html).toContain("rotate-90");
  });
});

describe("history time", () => {
  test("Given elapsed spans, When formatted, Then the coarsest whole unit is used", () => {
    const now = 1_000_000_000;
    expect(relativeTime(now, now)).toBe("now");
    expect(relativeTime(now - 59_000, now)).toBe("now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d");
  });

  test("Given a clock behind the entry, When formatted, Then it never goes negative", () => {
    expect(relativeTime(10, 0)).toBe("now");
  });
});
