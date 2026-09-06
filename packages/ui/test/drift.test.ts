import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { dirname, join } from "node:path";

/**
 * The Shell tab and the app must render ONE component.
 *
 * This is the gate on the defect that made this pass necessary. The showcase's
 * Shell tab was a hand-assembled copy of the console — its own tool rows, its
 * own status-shape table, its own transcript — and because it was a copy, it
 * stayed green through an entire redesign of the surface it claimed to
 * document. Nothing it drew was the thing that had changed. A reviewer looking
 * at the Shell shots was reviewing a screen the product does not ship.
 *
 * The fix is structural: the transcript moved into `@openomni/ui` and both
 * consumers render `Console`. That arrangement is invisible to the compiler,
 * though — a second `<Row>`-built tool row type-checks perfectly — so the two
 * halves of it are pinned here.
 *
 *   1. The showcase imports NOTHING from `apps/desktop`. If it could, the
 *      easiest way to make the Shell tab realistic would be to import the app's
 *      mock, and `@openomni/ui` would depend on the app it dresses.
 *   2. The renderer imports the transcript ONLY from `@openomni/ui`. A relative
 *      path back into a local `timeline/` directory is the exact regression
 *      this pass undid, and it is how the fork happened the first time.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const SHOWCASE = join(REPO_ROOT, "packages", "ui", "showcase");
const RENDERER = join(REPO_ROOT, "apps", "desktop", "src", "renderer");

/** Every import specifier in a file, from static and dynamic forms alike. */
function specifiersOf(source: string): readonly string[] {
  const found: string[] = [];
  // `from "x"`, `import "x"`, `import("x")`, and `require("x")`, which is every
  // form that can pull a module in. Comments are stripped first so that a path
  // named in prose — this file's own header does it — cannot trip the gate.
  const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
  for (const match of code.matchAll(/\bfrom\s*["']([^"']+)["']/g)) found.push(match[1] ?? "");
  for (const match of code.matchAll(/\bimport\s*\(?\s*["']([^"']+)["']/g))
    found.push(match[1] ?? "");
  for (const match of code.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g))
    found.push(match[1] ?? "");
  return found.filter((specifier) => specifier.length > 0);
}

async function sourcesUnder(dir: string): Promise<readonly string[]> {
  const files: string[] = [];
  for await (const path of new Glob("**/*.{ts,tsx}").scan({ cwd: dir })) {
    if (path.startsWith("dist/") || path.includes("/dist/")) continue;
    files.push(path);
  }
  return files.sort();
}

describe("the showcase and the app cannot fork", () => {
  test("Given the showcase, When scanned, Then it imports nothing from apps/desktop", async () => {
    const offenders: string[] = [];

    for (const relative of await sourcesUnder(SHOWCASE)) {
      const source = await Bun.file(join(SHOWCASE, relative)).text();
      for (const specifier of specifiersOf(source)) {
        // Either spelling of the same mistake: the workspace package name, or a
        // relative climb out of `packages/ui` and back down into the app.
        const reachesApp =
          specifier.includes("apps/desktop") ||
          specifier.startsWith("@openomni/desktop") ||
          /^(\.\.\/)+apps\//.test(specifier);
        if (reachesApp) offenders.push(`${relative} -> ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("Given the renderer, When scanned, Then the transcript comes only from @openomni/ui", async () => {
    // The modules that moved. A relative import of any of these names is a
    // local reimplementation by definition, because none of them exist under
    // `apps/desktop` any more.
    const MOVED = [
      "timeline",
      "work-group",
      "work-group-view",
      "worker-tree",
      "markdown-block",
      "anchor",
      "spacing",
      "turns",
      "console",
    ];
    const offenders: string[] = [];

    for (const relative of await sourcesUnder(RENDERER)) {
      const source = await Bun.file(join(RENDERER, relative)).text();
      for (const specifier of specifiersOf(source)) {
        if (!specifier.startsWith(".")) continue;
        // Resolve against the importing file, because the same specifier means
        // different things from different directories: `./console` from
        // `mock/timelines.ts` is the app's own session fixture, while the same
        // string from `app.tsx` would be a local rebuild of the composition.
        // Matching on the raw string cannot tell those apart.
        const resolved = join(dirname(join(RENDERER, relative)), specifier);
        if (resolved.startsWith(join(RENDERER, "mock"))) continue;
        const module = resolved.split("/").pop() ?? "";
        if (MOVED.includes(module)) offenders.push(`${relative} -> ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("Given the moved files, When looked for under apps/desktop, Then none remain", async () => {
    // Grep-zero, stated as a fact about the tree rather than about imports: a
    // file that still exists is a file something can start importing again.
    const survivors: string[] = [];
    for await (const path of new Glob("src/renderer/timeline/**").scan({
      cwd: join(REPO_ROOT, "apps", "desktop"),
    })) {
      survivors.push(path);
    }

    expect(survivors).toEqual([]);
  });

  test("Given the Shell tab, When read, Then it renders Console rather than assembling one", async () => {
    // The positive half of the gate. The two negatives above stop the showcase
    // reaching for the app's code; this one stops it quietly rebuilding the
    // console out of primitives instead, which is exactly what it used to do.
    const shell = await Bun.file(join(SHOWCASE, "sections", "shell-view.tsx")).text();

    expect(shell).toContain("<Console");

    // The transcript's own parts must not be assembled here. If the Shell tab
    // ever needs one of these directly, the composition has sprung a leak.
    for (const forbidden of ["<WorkGroupView", "<WorkRow", "<Timeline", "<TurnFooter"]) {
      expect(shell, `the Shell tab must not assemble ${forbidden}`).not.toContain(forbidden);
    }
  });

  test("Given the package, When its exports are read, Then the inspector is not among them", async () => {
    // The inspector is a REVIEW instrument: it installs a mousemove listener, a
    // keyup hook and a capture-phase click handler, and it exists to report the
    // surface's own addresses to whoever is looking at the showcase. Exporting
    // it would put all three into every desktop window for the benefit of a
    // reviewer who is not there.
    //
    // Both halves are checked, because either one alone is passable while the
    // instrument still ships: `src/` may not import it (a component reaching
    // into `showcase/` would drag it into the bundle), and the barrel may not
    // name it (an export makes it a consumer's to mount).
    const barrel = await Bun.file(join(SHOWCASE, "..", "src", "index.ts")).text();
    expect(barrel).not.toContain("Inspector");
    expect(barrel).not.toContain("showcase/");

    const reaching: string[] = [];
    const SRC = join(SHOWCASE, "..", "src");
    for (const relative of await sourcesUnder(SRC)) {
      const source = await Bun.file(join(SRC, relative)).text();
      for (const specifier of specifiersOf(source)) {
        if (specifier.includes("showcase")) reaching.push(`${relative} -> ${specifier}`);
      }
    }

    expect(reaching, "src may not import anything from the showcase").toEqual([]);
  });
});
