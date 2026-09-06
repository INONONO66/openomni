import { describe, expect, test } from "bun:test";
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
import { filterOrdered, highlightRuns, type SearchFields, scoreText } from "../src/renderer/search";

/**
 * Filtering is asserted against the REAL attention order over the real fixture,
 * not a synthetic list. The two properties that matter are structural, and both
 * are invisible to the compiler: the tree must survive the filter, and the
 * attention sequence must survive the scorer.
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

const projectNames = new Map(projects.map((project) => [project.id, project.name]));

const fieldsFor = (id: string, reason: string): SearchFields => {
  const session = sessions.find((candidate) => candidate.id === id);
  return [
    session?.name ?? id,
    projectNames.get(session?.projectId ?? "") ?? "",
    reason.length > 0 ? reason : (session?.state ?? ""),
  ];
};

const apply = (query: string) => filterOrdered(ordered, query, fieldsFor);

describe("an empty query leaves the tree untouched", () => {
  test("Given no query, When filtered, Then every project and live row survives", () => {
    const filtered = apply("");

    expect(filtered.unfiltered).toBe(true);
    expect(filtered.projects).toHaveLength(ordered.projects.length);
    for (const [index, group] of filtered.projects.entries()) {
      expect(group.live.map((entry) => entry.id)).toEqual(
        ordered.projects[index]?.live.map((entry) => entry.id) ?? [],
      );
    }
  });

  test("Given whitespace only, When filtered, Then it is the same as no query", () => {
    expect(apply("   ").unfiltered).toBe(true);
    expect(apply("   ").total).toBe(apply("").total);
  });

  test("Given no query, When filtered, Then no settled tail is forced open", () => {
    // At rest the tail is collapsed: finished work stays reachable without
    // spending a row of attention.
    for (const group of apply("").projects) expect(group.settledOpen).toBe(false);
  });

  test("Given no query, When filtered, Then no glyphs are weighted", () => {
    for (const group of apply("").projects) {
      for (const entry of group.live) expect(entry.spans).toEqual([]);
    }
  });
});

describe("filtering preserves the PROJECT to SESSION hierarchy", () => {
  test("Given a query matching one session, When filtered, Then its project is still its parent", () => {
    // The row must not float to the root: a result at an unexplained depth is
    // a result the operator cannot place.
    const filtered = apply("ledger");
    const holder = filtered.projects.find((group) =>
      group.live.some((entry) => entry.id === "kernel-ledger"),
    );

    expect(holder).toBeDefined();
    expect(holder?.id).toBe("kernel");
  });

  test("Given a query no session in a project matches, When filtered, Then that project is gone", () => {
    // An empty header is a row spent saying nothing.
    const filtered = apply("ledger");

    expect(filtered.projects.map((group) => group.id)).toEqual(["kernel"]);
  });

  test("Given a query matching nothing, When filtered, Then there are no groups at all", () => {
    const filtered = apply("zzzqqq");

    expect(filtered.projects).toEqual([]);
    expect(filtered.total).toBe(0);
    expect(filtered.unfiltered).toBe(false);
  });

  test("Given a match inside a settled tail, When filtered, Then the tail is opened", () => {
    // A result behind a collapsed disclosure is a result that was not shown.
    // `lease semantics` is settled in the fixture (done, zero unread).
    const filtered = apply("lease");
    const holder = filtered.projects.find((group) => group.settled.length > 0);

    expect(holder).toBeDefined();
    expect(holder?.settledOpen).toBe(true);
    expect(holder?.settled.map((entry) => entry.id)).toContain("kernel-lease");
  });

  test("Given a match on a live row only, When filtered, Then the tail stays closed", () => {
    const filtered = apply("ledger");

    for (const group of filtered.projects) {
      expect(group.settled).toEqual([]);
      expect(group.settledOpen).toBe(false);
    }
  });

  test("Given a project-name query, When filtered, Then that project's rows all match", () => {
    // Matching the project is matching something the operator can see: it is
    // the row's own header.
    const filtered = apply("perimeter");
    const source = ordered.projects.find((group) => group.id === "perimeter");

    expect(filtered.projects.map((group) => group.id)).toEqual(["perimeter"]);
    expect(filtered.projects[0]?.live).toHaveLength(source?.live.length ?? -1);
  });

  test("Given a reason-text query, When filtered, Then rows match on their second line", () => {
    // The reason line is on screen, so it is searchable. `waiting for you` is
    // the only reason carrying that phrase in the fixture.
    const filtered = apply("waiting");

    expect(filtered.total).toBeGreaterThan(0);
    for (const group of filtered.projects) {
      for (const entry of group.live) expect(entry.reason).toContain("waiting");
    }
  });
});

describe("the attention order survives the filter", () => {
  test("Given a query matching several rows, When filtered, Then they keep the engine's sequence", () => {
    // The scorer must not re-sort across classes: a waiting session does not
    // sink below a running one because the query spells the running one better.
    const filtered = apply("e");
    const engineSequence = ordered.projects.flatMap((group) => [
      ...group.live.map((entry) => entry.id),
      ...group.settled,
    ]);
    const survivors = engineSequence.filter((id) => filtered.sequence.includes(id));

    expect(filtered.sequence).toEqual(survivors);
  });

  test("Given a query, When filtered, Then the project sequence is the engine's own", () => {
    const filtered = apply("e");
    const engineProjects = ordered.projects.map((group) => group.id);
    const survivors = engineProjects.filter((id) =>
      filtered.projects.some((group) => group.id === id),
    );

    expect(filtered.projects.map((group) => group.id)).toEqual(survivors);
  });

  test("Given a query that spells a lower-class row better, When filtered, Then it does not rise", () => {
    // The load-bearing case. `sync` PREFIXES the running row's name and only
    // scatters through the waiting one, so a score-sorted filter would lift the
    // running row to the top. Class rank is the attention engine's call, so the
    // waiting row must still lead.
    const engineOrder = {
      projects: [
        {
          id: "p",
          live: [
            { id: "waiting-row", reason: "waiting for you" },
            { id: "running-row", reason: "running" },
          ],
          settled: [],
        },
      ],
    };
    const names: Record<string, string> = {
      // Scattered subsequence (s-y-n-c across four words) — scores ~1288.
      "waiting-row": "stale yamlninja cutover",
      // Clean prefix — scores ~3900, three times the waiting row's evidence.
      "running-row": "sync engine",
    };
    const filtered = filterOrdered(engineOrder, "sync", (id, reason) => [
      names[id] ?? id,
      "",
      reason,
    ]);
    const live = filtered.projects[0]?.live.map((entry) => entry.id) ?? [];

    // Both match, the running one scores strictly higher, and the order holds.
    expect(live).toEqual(["waiting-row", "running-row"]);
    expect(scoreText("sync engine", "sync")?.score ?? 0).toBeGreaterThan(
      scoreText("schema notes yield", "sync")?.score ?? 0,
    );
  });

  test("Given rows in one class, When filtered, Then the engine's own sequence is still kept", () => {
    // Score breaks ties INSIDE a class in the engine, not here: this module
    // never sorts, so even two same-class rows keep the sequence they arrived
    // in. A filter that re-sorted would silently override the engine.
    const engineOrder = {
      projects: [
        {
          id: "p",
          live: [
            { id: "weak", reason: "" },
            { id: "strong", reason: "" },
          ],
          settled: [],
        },
      ],
    };
    const names: Record<string, string> = { weak: "x sync", strong: "sync x" };
    const filtered = filterOrdered(engineOrder, "sync", (id) => [names[id] ?? id, "", ""]);

    expect(filtered.projects[0]?.live.map((entry) => entry.id)).toEqual(["weak", "strong"]);
  });

  test("Given a query, When filtered, Then the count equals the painted sequence", () => {
    for (const query of ["", "e", "ledger", "zzz", "lease"]) {
      const filtered = apply(query);
      const painted = filtered.projects.reduce(
        (count, group) =>
          count + group.live.length + (filtered.unfiltered ? 0 : group.settled.length),
        0,
      );

      expect(filtered.total).toBe(painted);
    }
  });

  test("Given identical inputs, When filtered twice, Then the result is identical", () => {
    expect(apply("le")).toEqual(apply("le"));
  });
});

describe("highlight runs weight the matched glyphs only", () => {
  test("Given a match on the session name, When run, Then the matched glyphs are marked", () => {
    const filtered = apply("ledger");
    const entry = filtered.projects[0]?.live.find((row) => row.id === "kernel-ledger");
    const runs = highlightRuns("ledger append path", entry?.spans ?? []);

    expect(runs[0]).toEqual({ text: "ledger", matched: true });
    expect(runs[1]?.matched).toBe(false);
  });

  test("Given a match on the project only, When run, Then the name is left unweighted", () => {
    // The row prints its own name in full; weighting glyphs the query did not
    // hit there would report a match that is not on that string.
    const filtered = apply("perimeter");

    for (const group of filtered.projects) {
      for (const entry of group.live) expect(entry.spans).toEqual([]);
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
    // The fixture carries Hangul intent text; a span index applied to UTF-16
    // code units instead of code points would cut a syllable in half.
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
  const filtered = filterOrdered(
    { projects: [{ id: "p", live: [{ id: "s", reason: "" }], settled: [] }] },
    query,
    () => [text, "", ""],
  );
  return filtered.projects[0]?.live[0]?.spans ?? [];
}
