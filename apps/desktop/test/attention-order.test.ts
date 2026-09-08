import { describe, expect, test } from "bun:test";
import { orderByAttention } from "../src/renderer/attention";
import { makeSession } from "./helpers/session";

const facts = (id: string, createdAt: number, projectId: string | null = "p") =>
  makeSession({ id, projectId, createdAt });

const ids = (projectId: string | null, ordered: ReturnType<typeof orderByAttention>) =>
  ordered.groups.flatMap((kind) => kind.projects).find((group) => group.id === projectId)
    ?.sessions ?? [];

describe("recency inside a group", () => {
  test("Given two sessions, When ordered, Then the newer one leads", () => {
    const ordered = orderByAttention([facts("older", 10), facts("newer", 20)], 50);

    expect(ids("p", ordered)).toEqual(["newer", "older"]);
  });

  test("Given identical timestamps, When ordered from either input order, Then the sequence is stable", () => {
    const input = [facts("b", 5), facts("a", 5)];

    expect(ids("p", orderByAttention(input, 50))).toEqual(["a", "b"]);
    expect(ids("p", orderByAttention([...input].reverse(), 50))).toEqual(["a", "b"]);
  });
});

describe("groups follow their sessions", () => {
  test("Given sessions in two projects, When ordered, Then the project with the newest work leads", () => {
    const ordered = orderByAttention(
      [facts("q1", 30, "quiet"), facts("l1", 40, "loud"), facts("q0", 10, "quiet")],
      50,
    );

    expect(ordered.groups.flatMap((kind) => kind.projects).map((group) => group.id)).toEqual([
      "loud",
      "quiet",
    ]);
    expect(ids("quiet", ordered)).toEqual(["q1", "q0"]);
  });

  test("Given an unfiled session, When ordered, Then it forms the null group rather than vanishing", () => {
    const ordered = orderByAttention([facts("filed", 1), facts("loose", 2, null)], 50);

    expect(ordered.groups.flatMap((kind) => kind.projects).map((group) => group.id)).toEqual([
      null,
      "p",
    ]);
  });

  test("Given no sessions, When ordered, Then there are no groups", () => {
    expect(orderByAttention([], 50).groups).toEqual([]);
  });
});

describe("the engine is pure", () => {
  test("Given the same inputs, When called twice, Then the output is identical", () => {
    const input = [facts("a", 3), facts("b", 1), facts("c", 2, "other")];

    expect(orderByAttention(input, 50)).toEqual(orderByAttention(input, 50));
  });
});
