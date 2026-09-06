import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

/**
 * @openomni/ui is the single design system for these surfaces: consumers
 * compose primitives and layout, and never name a color token themselves. That
 * boundary is invisible to the compiler — a `text-fg` in a renderer component
 * type-checks fine and silently forks the design system — so it is pinned here.
 *
 * Layout and spacing utilities stay allowed: they are structure, not surface.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** Every tree that must ask the design system for its surfaces. */
const SCANNED_ROOTS = [
  { label: "renderer", dir: join(REPO_ROOT, "apps", "desktop", "src") },
  { label: "showcase", dir: join(REPO_ROOT, "packages", "ui", "showcase") },
] as const;

/**
 * Class prefixes that resolve to a color token in packages/ui/src/styles.css.
 * A hit means a consumer is styling a surface directly instead of asking the
 * design system for a primitive.
 */
const COLOR_UTILITY_PREFIXES = [
  "bg-bg",
  "bg-sunken",
  "bg-raised",
  "bg-hover",
  "bg-active",
  "bg-accent",
  "bg-fg",
  "bg-line",
  "bg-neutral-",
  "text-fg",
  "text-accent",
  "text-neutral-",
  "border-line",
  "border-accent",
  "border-fg",
  "border-neutral-",
  "border-b-accent",
  "ring-accent",
  "ring-focus",
  "outline-accent",
  "divide-line",
  "fill-fg",
  "fill-accent",
  "stroke-fg",
  "stroke-accent",
] as const;

const LEAK_SOURCE = `(?<![\\w-])(?:[a-z-]+:)*(?:${COLOR_UTILITY_PREFIXES.map((prefix) =>
  prefix.replaceAll("-", "\\-"),
).join("|")})[\\w./\\[\\]%-]*`;

/**
 * Matches a color utility only when it stands alone as a class token, so a
 * variant prefix (`hover:bg-hover`) and a bare use (`bg-hover`) both trip,
 * while an unrelated identifier that merely contains the text does not.
 *
 * Built fresh per call: a shared `/g` regex carries `lastIndex` between uses,
 * which would make these assertions order-dependent.
 */
const leakPattern = () => new RegExp(LEAK_SOURCE, "g");

async function sourcesUnder(dir: string): Promise<readonly string[]> {
  const files: string[] = [];
  for await (const path of new Glob("**/*.{ts,tsx,css,html}").scan({ cwd: dir })) {
    // Build output is the compiled design system, so it legitimately contains
    // every token utility. Scanning it would only ever report the tool working.
    if (path.startsWith("dist/") || path.includes("/dist/")) continue;
    files.push(path);
  }
  return files.sort();
}

describe("design-system boundary", () => {
  test("Given each scanned root, When listed, Then the scan reaches a real component tree", async () => {
    for (const root of SCANNED_ROOTS) {
      const files = await sourcesUnder(root.dir);
      expect(files.length).toBeGreaterThan(2);
    }
  });

  test("Given the renderer, When scanned, Then it reaches the app entry", async () => {
    expect(await sourcesUnder(SCANNED_ROOTS[0].dir)).toContain("renderer/app.tsx");
  });

  test("Given every scanned source, When scanned, Then no color token utility is named", async () => {
    const leaks: string[] = [];

    for (const root of SCANNED_ROOTS) {
      for (const relative of await sourcesUnder(root.dir)) {
        const text = await Bun.file(join(root.dir, relative)).text();
        for (const [lineIndex, line] of text.split("\n").entries()) {
          for (const hit of line.matchAll(leakPattern())) {
            leaks.push(`${root.label}/${relative}:${lineIndex + 1}: ${hit[0]}`);
          }
        }
      }
    }

    expect(leaks).toEqual([]);
  });

  test("Given a real leak, When matched, Then the pattern catches it", () => {
    const samples = [
      'className="text-fg-muted"',
      'className="hover:bg-raised"',
      'className="border-line"',
      'className="bg-accent"',
      'className="group-hover:text-fg"',
    ];

    for (const sample of samples) {
      expect(sample).toMatch(leakPattern());
    }
  });

  test("Given layout and spacing utilities, When matched, Then they remain allowed", () => {
    const allowed = [
      'className="flex min-h-0 flex-1 flex-col"',
      'className="w-tree shrink-0 px-gutter"',
      'className="h-row gap-2 rounded-sm"',
      'className="max-w-[68ch] truncate tabular-nums"',
      'className="font-mono text-meta"',
    ];

    for (const sample of allowed) {
      expect(sample).not.toMatch(leakPattern());
    }
  });
});

/**
 * The same boundary, for DRAWN MARKS.
 *
 * The glyph allowlist this replaces is gone with the grammar it served. That
 * system let a component draw a tree connector or a status pip out of box-
 * drawing characters as long as the character was on an approved list, and the
 * list was the reason the transcript accumulated a `❯` prompt, a spine, and a
 * set of connectors that all rendered at whatever weight the user's mono font
 * happened to have.
 *
 * The replacement rule is stricter and needs no list: a mark is DRAWN, in SVG
 * or with a border, or it does not exist. So this scan no longer asks whether a
 * character is permitted — it asks whether any character in these ranges appears
 * at all, which is a rule with no exceptions to maintain and no allowlist to
 * quietly grow.
 */
const POLICED_RANGES: readonly (readonly [number, number])[] = [
  [0x2190, 0x21ff], // arrows
  [0x2500, 0x257f], // box drawing
  [0x2580, 0x259f], // block elements
  [0x25a0, 0x25ff], // geometric shapes
  [0x2600, 0x27bf], // misc symbols and dingbats
  [0x2800, 0x28ff], // braille
  [0xe000, 0xf8ff], // private use — Nerd Font and Powerline live here
  [0x1f000, 0x1ffff], // emoji planes
];

const isPoliced = (code: number) =>
  POLICED_RANGES.some(([low, high]) => code >= low && code <= high);

/**
 * Comments are prose, not interface: a doc comment writing `PROJECT → SESSION`
 * describes a hierarchy rather than drawing one, and failing on it would buy a
 * tighter character set at the cost of worse comments.
 */
const withoutComments = (source: string) =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, " ").replaceAll(/\/\/[^\n]*/g, " ");

/**
 * The keyboard legends the surfaces PRINT.
 *
 * These are the one honest exception, and they are an exception to a different
 * rule than the one that killed the allowlist. `⌘K` and `⌘↩` are not marks the
 * interface is drawing — they are the names of keys, quoted from the keycaps in
 * front of the Owner. Redrawing them in SVG would be redrawing the Apple glyphs
 * the platform already owns, and spelling them "Command-Enter" would be longer
 * than the line they sit on.
 */
const KEY_LEGENDS = new Set(["\u2318", "\u21a9", "\u232b", "\u21e7", "\u2325", "\u2303"]);

describe("marks are drawn, never typed", () => {
  test("Given every consumer source, When scanned, Then no mark is made of characters", async () => {
    const strays: string[] = [];

    for (const root of SCANNED_ROOTS) {
      for (const relative of await sourcesUnder(root.dir)) {
        const text = withoutComments(await Bun.file(join(root.dir, relative)).text());
        for (const [lineIndex, line] of text.split("\n").entries()) {
          for (const char of line) {
            const code = char.codePointAt(0) ?? 0;
            if (!isPoliced(code) || KEY_LEGENDS.has(char)) continue;
            strays.push(`${root.label}/${relative}:${lineIndex + 1}: ${char}`);
          }
        }
      }
    }

    expect(strays).toEqual([]);
  });

  test("Given the marks the rebuild deleted, When scanned, Then each would trip", () => {
    // Anti-vacuity, named concretely: every one of these was on screen in the
    // transcript the Owner rejected. The prompt caret, the tree connectors, the
    // spine, and the status pips are exactly what this gate now forbids, so it
    // is pinned against them by name rather than against an abstract range.
    for (const char of [
      "\u276f",
      "\u2514",
      "\u2500",
      "\u2502",
      "\u251c",
      "\u2713",
      "\u25cf",
      "\u256d",
      "\u2550",
      "\u{1f680}",
    ]) {
      const code = char.codePointAt(0) ?? 0;
      expect(isPoliced(code), `${char} is policed`).toBe(true);
      expect(KEY_LEGENDS.has(char), `${char} is not a key legend`).toBe(false);
    }
  });

  test("Given a keyboard legend, When scanned, Then it survives", () => {
    // The exception has to be REAL or the rule above is unshippable: the search
    // field prints Command-K and the approval tray prints Command-Return and
    // Command-Delete, and all three are quoted keycaps rather than drawn marks.
    //
    // Only the return and shift arrows actually fall inside a policed range \u2014
    // Command, Delete, Option and Control live in Miscellaneous Technical, which
    // this scan never covered. The allowlist still names all six, because the
    // set is "legends this interface may print" rather than "legends that
    // currently happen to trip the scan": pruning it to the two that collide
    // today would silently re-ban the other four the moment a range widened.
    expect(isPoliced("\u21a9".codePointAt(0) ?? 0)).toBe(true);
    expect(KEY_LEGENDS.has("\u21a9")).toBe(true);
    expect(KEY_LEGENDS.has("\u2318")).toBe(true);
  });
});
