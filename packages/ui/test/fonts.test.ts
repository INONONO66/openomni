import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The two families ship as npm assets and are bundled into the renderer, so a
 * console opened on a plane renders in Pretendard and JetBrains Mono rather
 * than in whatever the platform substitutes.
 *
 * The failure this guards is one line long and invisible in review: a single
 * `@import url("https://fonts.googleapis.com/...")` restores the surface's
 * appearance on a developer's machine while making the shipped app depend on a
 * network it may not have and leaking every window open to a third party. So
 * the rule is stated as a property of the stylesheet we author — no absolute
 * URL of any scheme is fetched from it — rather than as a review habit.
 */

const UI_SRC = join(import.meta.dir, "..", "src");
const TOKENS = join(UI_SRC, "styles.css");

/** Every `url(...)` and `@import` target this stylesheet resolves at runtime. */
function fetchedTargets(css: string): readonly string[] {
  const targets: string[] = [];
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
    if (match[2] !== undefined) targets.push(match[2]);
  }
  for (const match of css.matchAll(/@import\s+(['"])([^'"]+)\1/g)) {
    if (match[2] !== undefined) targets.push(match[2]);
  }
  return targets;
}

describe("fonts are bundled, never fetched", () => {
  test("Given the design system's stylesheet, When scanned, Then nothing is fetched over the network", async () => {
    const css = await Bun.file(TOKENS).text();
    // Comments carry prose — including package URLs — and prose is not a
    // fetch. Only what the CSS engine resolves is policed.
    const remote = fetchedTargets(css).filter((target) => /^(?:https?:)?\/\//.test(target));

    expect(remote).toEqual([]);
  });

  test("Given the stylesheet, When scanned, Then both families arrive from npm packages", async () => {
    const css = await Bun.file(TOKENS).text();
    const imports = fetchedTargets(css);

    expect(imports).toContain("pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css");
    expect(imports).toContain("@fontsource-variable/jetbrains-mono/wght.css");
  });

  test("Given the font tokens, When read, Then each names its family first and then system fallbacks", async () => {
    const css = await Bun.file(TOKENS).text();
    const sans = /--font-sans:\s*([^;]+);/.exec(css)?.[1] ?? "";
    const mono = /--font-mono:\s*([^;]+);/.exec(css)?.[1] ?? "";

    // The bundled face leads and a system stack follows: a font file that
    // fails to decode must fall back to a real family, not to Times.
    expect(sans.trimStart().startsWith('"Pretendard Variable"')).toBe(true);
    expect(sans).toContain("system-ui");
    expect(sans.trimEnd().endsWith("sans-serif")).toBe(true);
    expect(mono.trimStart().startsWith('"JetBrains Mono Variable"')).toBe(true);
    expect(mono).toContain("ui-monospace");
    expect(mono.trimEnd().endsWith("monospace")).toBe(true);
  });

  test("Given the package manifest, When read, Then both font packages are real dependencies", async () => {
    const manifest = (await Bun.file(join(import.meta.dir, "..", "package.json")).json()) as {
      readonly dependencies?: Readonly<Record<string, string>>;
    };

    // A devDependency would type-check and then be missing from a consumer's
    // install, which is a broken render rather than a build failure.
    expect(manifest.dependencies?.pretendard).toBeDefined();
    expect(manifest.dependencies?.["@fontsource-variable/jetbrains-mono"]).toBeDefined();
  });

  test("Given the imported font stylesheets, When read from node_modules, Then their faces are local files", async () => {
    for (const specifier of [
      "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css",
      "@fontsource-variable/jetbrains-mono/wght.css",
    ]) {
      const path = Bun.resolveSync(specifier, UI_SRC);
      const remote = fetchedTargets(await Bun.file(path).text()).filter((target) =>
        /^(?:https?:)?\/\//.test(target),
      );
      expect(remote, `${specifier} fetches remote faces`).toEqual([]);
    }
  });
});
