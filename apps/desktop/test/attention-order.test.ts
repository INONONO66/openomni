import { describe, expect, test } from "bun:test";
import { orderByAttention } from "../src/renderer/attention";
import type { SessionFacts } from "../src/renderer/attention";

/**
 * The ordering engine, over the one fact a session carries today: when it was
 * created. The rules that survive from the fuller engine are the structural
 * ones — groups exist because sessions do, a group weighs what its newest
 * session weighs, and the same input always produces the same output.
 */
const facts = (id: string, createdAt: number, projectId: string | null = "p"): SessionFacts => ({
  id,
  projectId,
  createdAt,
});

const ids = (projectId: string | null, ordered: ReturnType<typeof orderByAttention>) =>
  ordered.groups.flatMap((kind) => kind.projects).find((group) => group.id === projectId)?.sessions ?? [];

describe("recency inside a group", () => {
  test("Given two sessions, When ordered, Then the newer one leads", () => {
    const ordered = orderByAttention([facts("older", 10), facts("newer", 20)]);

    expect(ids("p", ordered)).toEqual(["newer", "older"]);
  });

  test("Given identical timestamps, When ordered from either input order, Then the sequence is stable", () => {
    const input = [facts("b", 5), facts("a", 5)];

    expect(ids("p", orderByAttention(input, 10, 10))).toEqual(["a", "b"]);
    expect(ids("p", orderByAttention([...input].reverse()))).toEqual(["a", "b"]);
  });
});

describe("groups follow their sessions", () => {
  test("Given sessions in two projects, When ordered, Then the project with the newest work leads", () => {
    const ordered = orderByAttention([
      facts("q1", 30, "quiet"),
      facts("l1", 40, "loud"),
      facts("q0", 10, "quiet"),
    ]);

    expect(ordered.groups.flatMap((kind) => kind.projects).map((group) => group.id)).toEqual(["loud", "quiet"]);
    expect(ids("quiet", ordered)).toEqual(["q1", "q0"]);
  });

  test("Given an unfiled session, When ordered, Then it forms the null group rather than vanishing", () => {
    const ordered = orderByAttention([facts("filed", 1), facts("loose", 2, null)]);

    expect(ordered.groups.flatMap((kind) => kind.projects).map((group) => group.id)).toEqual([null, "p"]);
  });

  test("Given no sessions, When ordered, Then there are no groups", () => {
    expect(orderByAttention([], 10, 10).projects).toEqual([]);
  });
});

describe("the engine is pure", () => {
  test("Given the same inputs, When called twice, Then the output is identical", () => {
    const input = [facts("a", 3), facts("b", 1), facts("c", 2, "other")];

    expect(orderByAttention(input, 10, 10)).toEqual(orderByAttention(input, 10, 10));
  });
});
