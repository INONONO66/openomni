import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Glob } from "bun";
import { renderToStaticMarkup } from "react-dom/server";
import { CONDITIONAL_NAMES, UI_NAMES, type UiName } from "../src";
import { ShellView } from "../showcase/sections/shell-view";
import { SystemView } from "../showcase/sections/system-view";

/**
 * The Owner reviews this surface by NAMING what is wrong, so a name has to be
 * three things at once: written in one place, documented, and actually on
 * screen. This file is the gate on all three.
 *
 * The failure it exists to prevent is not a broken render — it is a review that
 * cannot be executed. `ToolGroup.Summary is too dim` costs nothing to say and
 * everything to act on if the name addresses no element, addresses two, or
 * names something the doc calls by another word.
 */

const SRC = join(import.meta.dir, "..", "src");
const DOC = join(import.meta.dir, "..", "COMPONENTS.md");

const ALL_NAMES: readonly UiName[] = Object.values(UI_NAMES);

/** Every `data-ui` value in a rendered tree, in document order. */
function rendered(html: string): readonly string[] {
  return [...html.matchAll(/data-ui="([^"]+)"/g)].map((match) => match[1] ?? "");
}

/**
 * The two showcase surfaces, rendered once.
 *
 * The Shell tab is the CONSOLE fixture — the same `Console` the desktop
 * renderer mounts, over the same transcript the screenshots use. The System
 * page is the specimen sheet, and it is where a conditional name has to be
 * reachable: a name nobody can see is not an address, and "it renders when
 * something streams" is not a place the Owner can go and look.
 */
const CONSOLE_HTML = renderToStaticMarkup(<ShellView />);
const SYSTEM_HTML = renderToStaticMarkup(<SystemView />);
const IN_CONSOLE = new Set(rendered(CONSOLE_HTML));
const IN_SYSTEM = new Set(rendered(SYSTEM_HTML));

describe("UI_NAMES is the single owner of every address", () => {
  test("Given the sources, When scanned, Then no call site spells a name as a literal", async () => {
    // The defect this catches is a rename that half-lands: the const changes,
    // one component keeps the old string, and the Owner's word now addresses
    // an element the doc no longer lists. A literal is how that happens.
    const offenders: string[] = [];

    for await (const relative of new Glob("**/*.{ts,tsx}").scan({ cwd: SRC })) {
      if (relative === "names.ts") continue;
      const source = await Bun.file(join(SRC, relative)).text();
      for (const match of source.matchAll(/data-ui\s*=\s*["'{]?\s*["']([^"']+)["']/g)) {
        offenders.push(`${relative} -> data-ui="${match[1]}"`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("Given UI_NAMES, When read, Then no two keys share a value", () => {
    // Two keys with one value is an address that resolves to two components,
    // which is the same as no address at all.
    expect(new Set(ALL_NAMES).size).toBe(ALL_NAMES.length);
  });

  test("Given a dotted name, When split, Then its parent is also a name", () => {
    // A dot means containment, and the inspector prints the chain on that
    // promise. `Foo.Bar` with no `Foo` renders a chain that skips a level and
    // reads as if the part were a component of its own.
    for (const name of ALL_NAMES) {
      if (!name.includes(".")) continue;
      const parent = name.slice(0, name.indexOf("."));
      expect(ALL_NAMES as readonly string[], `${name} has no parent named ${parent}`).toContain(
        parent,
      );
    }
  });
});

describe("COMPONENTS.md and UI_NAMES are 1:1", () => {
  test("Given the doc, When compared to UI_NAMES, Then neither has a name the other lacks", async () => {
    const doc = await Bun.file(DOC).text();
    // The main table's first cell, which is the row's subject. Reading the cell
    // rather than searching the whole file is deliberate: a name that appears
    // only in the prose is mentioned, not documented, and a gate satisfied by a
    // mention would pass on a table that lists nothing.
    const documented = new Set(
      [...doc.matchAll(/^\| `([A-Z][\w.]*)` \|/gm)].map((match) => match[1] ?? ""),
    );

    const undocumented = ALL_NAMES.filter((name) => !documented.has(name));
    const orphaned = [...documented].filter(
      (name) => !(ALL_NAMES as readonly string[]).includes(name),
    );

    expect(undocumented, "names with no row in COMPONENTS.md").toEqual([]);
    expect(orphaned, "rows in COMPONENTS.md naming nothing in UI_NAMES").toEqual([]);
  });

  test("Given the main table, When a row is read, Then it carries a file, a description, and a vocabulary", async () => {
    // Four filled cells, because a row missing the last one is a name with no
    // stated vocabulary — the Owner can address it and still not know whether a
    // note about it belongs there or one level up.
    //
    // Only the MAIN table is checked, and it is identified by its shape: four
    // cells. The conditional table below it is deliberately two, and a check
    // that swept the whole file would demand three columns of a table that has
    // one thing to say.
    const text = await Bun.file(DOC).text();
    const thin: string[] = [];
    let seen = 0;

    for (const line of text.split("\n")) {
      const match = /^\| `([A-Z][\w.]*)` \|(.*)\|$/.exec(line);
      if (match === null) continue;
      const cells = (match[2] ?? "").split("|").map((cell) => cell.trim());
      // A two-cell row is a conditional entry, not a thin main-table row.
      if (cells.length < 2) continue;
      seen += 1;
      if (cells.some((cell) => cell.length === 0)) thin.push(match[1] ?? "");
    }

    expect(thin, "rows missing file, description, or vocabulary").toEqual([]);
    // Anti-vacuity: a regex that stopped matching would report a clean sweep of
    // nothing, which is the quietest way for a doc gate to die.
    expect(seen).toBe(ALL_NAMES.length);
  });

  test("Given CONDITIONAL_NAMES, When compared to the doc, Then the conditions agree verbatim", async () => {
    // The condition is the whole value of the entry: it tells a reviewer where
    // to go to see the element. Two copies of it are two chances for the doc to
    // send them somewhere the code no longer renders.
    const doc = await Bun.file(DOC).text();

    for (const [name, condition] of Object.entries(CONDITIONAL_NAMES)) {
      expect(doc, `${name}'s condition is not in COMPONENTS.md verbatim`).toContain(
        `| \`${name}\` | ${condition} |`,
      );
    }

    const rows = [...doc.matchAll(/^\| `([A-Z][\w.]*)` \| ([^|]*\S) \|$/gm)].map(
      (match) => match[1] ?? "",
    );
    expect(rows.sort()).toEqual(Object.keys(CONDITIONAL_NAMES).sort());
  });
});

describe("every name is reachable", () => {
  test("Given the Console fixture, When rendered, Then every unconditional name is in it", () => {
    const missing = ALL_NAMES.filter(
      (name) => CONDITIONAL_NAMES[name] === undefined && !IN_CONSOLE.has(name),
    );

    expect(missing, "named but absent from the rendered Console").toEqual([]);
  });

  test("Given a conditional name, When the System page is rendered, Then it is still reachable", () => {
    // Conditional means "not in the idle console", never "nowhere". A name the
    // Owner cannot go and look at is not an address they can use.
    const unreachable = Object.keys(CONDITIONAL_NAMES).filter(
      (name) => !IN_SYSTEM.has(name) && !IN_CONSOLE.has(name),
    );

    expect(unreachable, "conditional names that render on neither surface").toEqual([]);
  });

  test("Given both surfaces, When scanned, Then nothing renders a name UI_NAMES does not declare", () => {
    // The other direction. An element carrying `data-ui="Whatever"` is a piece
    // of the surface with an address nobody documented, which is worse than one
    // with no address: the Owner can read it off the inspector and find no row.
    const undeclared = [...new Set([...IN_CONSOLE, ...IN_SYSTEM])].filter(
      (name) => !(ALL_NAMES as readonly string[]).includes(name),
    );

    expect(undeclared).toEqual([]);
  });

  test("Given a named part, When found in the console, Then its parent name encloses it", () => {
    // The inspector's chain is only true if the DOM nests the way the dots
    // claim. This checks the claim on real markup: a `Turn.Prompt` that is not
    // inside a `Turn` would print a chain that lies about containment.
    const orphans: string[] = [];

    for (const name of ALL_NAMES) {
      if (!name.includes(".") || !IN_CONSOLE.has(name)) continue;
      const parent = name.slice(0, name.indexOf("."));
      // Document order is enough here because the console is rendered as one
      // static tree: a part cannot appear before the first instance of its own
      // parent unless it is nested somewhere else entirely.
      const chain = rendered(CONSOLE_HTML);
      const firstParent = chain.indexOf(parent);
      const firstPart = chain.indexOf(name);
      if (firstParent === -1 || firstParent > firstPart) orphans.push(`${name} outside ${parent}`);
    }

    expect(orphans).toEqual([]);
  });
});
