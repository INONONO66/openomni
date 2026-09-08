import { describe, expect, test } from "bun:test";
import type { Ordered } from "../src/renderer/attention";
import { filterOrdered, highlightRuns, type SearchFields, scoreText } from "../src/renderer/search";

/**
 * The two properties that matter are structural, and both are invisible to the
 * compiler: the tree must survive the filter, and the attention sequence must
 * survive the scorer. Both are asserted over a hand-built order small enough to
 * read, with titles chosen so each query below hits exactly what it says.
 */
const ordered: Ordered = {
  projects: [
    { id: "kernel", sessions: ["kernel-ledger", "kernel-lease"] },
    { id: "perimeter", sessions: ["perimeter-sync", "perimeter-bind"] },
  ],
};

const titles: Record<string, string> = {
  "kernel-ledger": "ledger append path",
  "kernel-lease": "lease semantics",
  "perimeter-sync": "sync engine",
  "perimeter-bind": "port binding",
};

const fieldsFor = (id: string): SearchFields => [titles[id] ?? id, id.split("-")[0] ?? ""];

const apply = (query: string) => filterOrdered(ordered, query, fieldsFor);

const rows = (filtered: ReturnType<typeof apply>) =>
  filtered.groups.flatMap((kind) => kind.projects).map((group) => group.sessions.map((entry) => entry.id));

describe("an empty query leaves the tree untouched", () => {
  test("Given no query, When filtered, Then every project and row survives", () => {
    const filtered = apply("");

    expect(filtered.unfiltered).toBe(true);
    expect(rows(filtered)).toEqual(ordered.groups.flatMap((kind) => kind.projects).map((group) => [...group.sessions]));
  });

  test("Given whitespace only, When filtered, Then it is the same as no query", () => {
    expect(apply("   ").unfiltered).toBe(true);
    expect(apply("   ").total).toBe(apply("").total);
  });

  test("Given no query, When filtered, Then no glyphs are weighted", () => {
    for (const group of apply("").groups.flatMap((kind) => kind.projects)) {
      for (const entry of group.sessions) expect(entry.spans).toEqual([]);
    }
  });
});

describe("filtering preserves the PROJECT to SESSION hierarchy", () => {
  test("Given a query matching one session, When filtered, Then its project is still its parent", () => {
    // The row must not float to the root: a result at an unexplained depth is
    // a result the operator cannot place.
    const filtered = apply("ledger");

    expect(filtered.groups.flatMap((kind) => kind.projects).map((group) => group.id)).toEqual(["kernel"]);
    expect(rows(filtered)).toEqual([["kernel-ledger"]]);
  });

  test("Given a query matching nothing, When filtered, Then there are no groups at all", () => {
    const filtered = apply("zzzqqq");

    expect(filtered.groups.flatMap((kind) => kind.projects)).toEqual([]);
    expect(filtered.total).toBe(0);
    expect(filtered.unfiltered).toBe(false);
  });

  test("Given a project-name query, When filtered, Then that project's rows all match", () => {
    // Matching the project is matching something the operator can see: it is
    // the row's own header.
    expect(rows(apply("perimeter"))).toEqual([["perimeter-sync", "perimeter-bind"]]);
  });
});

describe("the attention order survives the filter", () => {
  test("Given a query matching several rows, When filtered, Then they keep the engine's sequence", () => {
    const filtered = apply("e");
    const engineSequence = ordered.groups.flatMap((kind) => kind.projects).flatMap((group) => group.sessions);
    const survivors = engineSequence.filter((id) => filtered.sequence.includes(id));

    expect(filtered.sequence).toEqual(survivors);
  });

  test("Given a query that spells a later row better, When filtered, Then it does not rise", () => {
    // The load-bearing case. `sync` PREFIXES the second row's title and only
    // scatters through the first, so a score-sorted filter would swap them.
    // Sequence is the attention engine's call, so the first row still leads.
    const engineOrder: Ordered = { groups: [{ kind: "rest", projects: [{ id: "p", sessions: ["first", "second"] }] }] };
    const names: Record<string, string> = {
      first: "stale yamlninja cutover",
      second: "sync engine",
    };
    const filtered = filterOrdered(engineOrder, "sync", (id) => [names[id] ?? id, ""]);

    expect(rows(filtered)).toEqual([["first", "second"]]);
    expect(scoreText("sync engine", "sync")?.score ?? 0).toBeGreaterThan(
      scoreText("stale yamlninja cutover", "sync")?.score ?? 0,
    );
  });

  test("Given a query, When filtered, Then the count equals the painted sequence", () => {
    for (const query of ["", "e", "ledger", "zzz", "lease"]) {
      const filtered = apply(query);
      const painted = filtered.groups.flatMap((kind) => kind.projects).reduce((count, group) => count + group.sessions.length, 0);

      expect(filtered.total).toBe(painted);
      expect(filtered.sequence).toHaveLength(painted);
    }
  });

  test("Given identical inputs, When filtered twice, Then the result is identical", () => {
    expect(apply("le")).toEqual(apply("le"));
  });
});

describe("highlight runs weight the matched glyphs only", () => {
  test("Given a match on the session title, When run, Then the matched glyphs are marked", () => {
    const entry = apply("ledger").groups.flatMap((kind) => kind.projects)[0]?.sessions[0];
    const runs = highlightRuns("ledger append path", entry?.spans ?? []);

    expect(runs[0]).toEqual({ text: "ledger", matched: true });
    expect(runs[1]?.matched).toBe(false);
  });

  test("Given a match on the project only, When run, Then the title is left unweighted", () => {
    // The row prints its own title in full; weighting glyphs the query did not
    // hit there would report a match that is not on that string.
    for (const group of apply("perimeter").groups.flatMap((kind) => kind.projects)) {
      for (const entry of group.sessions) expect(entry.spans).toEqual([]);
    }
  });

  test("Given any runs, When joined, Then the original label is reproduced exactly", () => {
    for (const query of ["l", "led", "lap", "path", "zz"]) {
      const runs = highlightRuns("ledger append path", scoreSpans("ledger append path", query));

      expect(runs.map((run) => run.text).join("")).toBe("ledger append path");
    }
  });

  test("Given no spans, When run, Then the label is one unmatched run", () => {
    expect(highlightRuns("ledger", [])).toEqual([{ text: "ledger", matched: false }]);
  });

  test("Given a multi-byte label, When run, Then a glyph is never split", () => {
    // A span index applied to UTF-16 code units instead of code points would
    // cut a Hangul syllable in half.
    const runs = highlightRuns("리스 계약", [0, 1]);

    expect(runs.map((run) => run.text).join("")).toBe("리스 계약");
    expect(runs[0]).toEqual({ text: "리스", matched: true });
  });

  test("Given non-adjacent spans, When run, Then each match is its own run", () => {
    const runs = highlightRuns("ledger append path", [0, 7]);

    expect(runs).toEqual([
      { text: "l", matched: true },
      { text: "edger ", matched: false },
      { text: "a", matched: true },
      { text: "ppend path", matched: false },
    ]);
  });
});

/** The spans a query would produce on one label, for the round-trip checks. */
function scoreSpans(text: string, query: string): readonly number[] {
  const filtered = filterOrdered({ groups: [{ kind: "rest", projects: [{ id: "p", sessions: ["s"] }] }] }, query, () => [
    text,
    "",
  ]);
  return filtered.groups.flatMap((kind) => kind.projects)[0]?.sessions[0]?.spans ?? [];
}
