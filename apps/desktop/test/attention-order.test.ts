import { describe, expect, test } from "bun:test";
import type { ProjectSessionFacts } from "../src/renderer/attention";
import { classify, orderByAttention, score } from "../src/renderer/attention";
import {
  facts,
  HOUR,
  liveIds,
  MINUTE,
  NOW,
  reasons,
  settledIds,
  signals,
} from "./attention-fixture";

describe("attention class ordering", () => {
  test("Given one session per class, When ordered, Then rank decides regardless of freshness", () => {
    // Every session below is EQUALLY fresh, so only the class can explain the
    // sequence — if recency leaked into the ranking this table would shuffle.
    const ordered = orderByAttention(
      ["p"],
      [
        facts("running", "running"),
        facts("waiting", "waiting"),
        facts("finished", "done", { unreadCount: 2 }),
        facts("interrupted", "interrupted"),
        facts("pinned", "running"),
      ],
      signals({ pins: new Set(["pinned"]) }),
    );

    expect(liveIds(ordered)).toEqual(["pinned", "waiting", "interrupted", "finished", "running"]);
  });

  test("Given a waiting session far older than a running one, When ordered, Then waiting still leads", () => {
    const ordered = orderByAttention(
      ["p"],
      [
        facts("fresh-running", "running", { lastEventAt: NOW - MINUTE }),
        facts("stale-waiting", "waiting", { lastEventAt: NOW - 40 * HOUR }),
      ],
      signals(),
    );

    expect(liveIds(ordered)).toEqual(["stale-waiting", "fresh-running"]);
  });

  test("Given a read done session, When classified, Then it settles rather than staying live", () => {
    expect(classify(facts("s", "done", { unreadCount: 0 }), signals())).toBe("settled");
    expect(classify(facts("s", "done", { unreadCount: 1 }), signals())).toBe("finished");
  });
});

describe("recency tie-break inside a class", () => {
  test("Given two running sessions, When ordered, Then the fresher one leads", () => {
    const ordered = orderByAttention(
      ["p"],
      [
        facts("older", "running", { lastEventAt: NOW - 5 * HOUR }),
        facts("newer", "running", { lastEventAt: NOW - 5 * MINUTE }),
      ],
      signals(),
    );

    expect(liveIds(ordered)).toEqual(["newer", "older"]);
  });

  test("Given identical timestamps, When ordered from either input order, Then the sequence is stable", () => {
    const input = [facts("b", "running"), facts("a", "running")];

    expect(liveIds(orderByAttention(["p"], input, signals()))).toEqual(
      liveIds(orderByAttention(["p"], [...input].reverse(), signals())),
    );
  });
});

describe("attention residue", () => {
  test("Given an unanswered user turn, When scored, Then it outranks an equally fresh answered session", () => {
    // Same lastEventAt: the ONLY difference is whether the Owner's turn is the
    // most recent event, which is exactly what the residue term measures.
    const unanswered = facts("unanswered", "running", {
      lastEventAt: NOW - HOUR,
      lastUserTurnAt: NOW - HOUR,
    });
    const answered = facts("answered", "running", {
      lastEventAt: NOW - HOUR,
      lastUserTurnAt: NOW - 10 * HOUR,
    });

    expect(score(unanswered, NOW)).toBeGreaterThan(score(answered, NOW));
    expect(liveIds(orderByAttention(["p"], [answered, unanswered], signals()))).toEqual([
      "unanswered",
      "answered",
    ]);
  });

  test("Given the agent has replied, When scored, Then the residue bump is gone", () => {
    const replied = facts("s", "running", {
      lastEventAt: NOW - MINUTE,
      lastUserTurnAt: NOW - HOUR,
    });
    const waitingOnAgent = facts("s", "running", {
      lastEventAt: NOW - MINUTE,
      lastUserTurnAt: NOW - MINUTE,
    });

    expect(score(waitingOnAgent, NOW) - score(replied, NOW)).toBeGreaterThan(0.4);
  });
});

describe("snooze", () => {
  test("Given a snoozed waiting session, When ordered, Then it drops to the settled tail", () => {
    const ordered = orderByAttention(
      ["p"],
      [facts("snoozed", "waiting"), facts("live", "running")],
      signals({ snoozes: new Map([["snoozed", NOW + HOUR]]) }),
    );

    expect(liveIds(ordered)).toEqual(["live"]);
    expect(settledIds(ordered)).toEqual(["snoozed"]);
  });

  test("Given a snooze that has expired, When ordered, Then the session returns to its class", () => {
    const ordered = orderByAttention(
      ["p"],
      [facts("expired", "waiting"), facts("live", "running")],
      signals({ snoozes: new Map([["expired", NOW - MINUTE]]) }),
    );

    expect(liveIds(ordered)).toEqual(["expired", "live"]);
  });
});

describe("pin override", () => {
  test("Given a pinned settled session, When ordered, Then the pin lifts it to the top", () => {
    const ordered = orderByAttention(
      ["p"],
      [facts("pinned-done", "done", { unreadCount: 0 }), facts("waiting", "waiting")],
      signals({ pins: new Set(["pinned-done"]) }),
    );

    expect(liveIds(ordered)).toEqual(["pinned-done", "waiting"]);
    expect(reasons(ordered)[0]).toBe("pinned");
  });

  test("Given a pin and a snooze on one session, When classified, Then the pin wins", () => {
    const attentionClass = classify(
      facts("both", "waiting"),
      signals({ pins: new Set(["both"]), snoozes: new Map([["both", NOW + HOUR]]) }),
    );

    expect(attentionClass).toBe("pinned");
  });
});

describe("settled tail", () => {
  test("Given read done sessions, When ordered, Then they leave the live list in recency order", () => {
    const ordered = orderByAttention(
      ["p"],
      [
        facts("old", "done", { lastEventAt: NOW - 30 * HOUR }),
        facts("recent", "done", { lastEventAt: NOW - 2 * HOUR }),
        facts("live", "running"),
      ],
      signals(),
    );

    expect(liveIds(ordered)).toEqual(["live"]);
    expect(settledIds(ordered)).toEqual(["recent", "old"]);
  });
});

describe("project order follows its most demanding session", () => {
  test("Given one project holding the only waiting session, When ordered, Then that project leads", () => {
    const ordered = orderByAttention(
      ["quiet", "loud"],
      [
        { ...facts("q1", "running"), projectId: "quiet", lastEventAt: NOW - MINUTE },
        { ...facts("l1", "waiting"), projectId: "loud", lastEventAt: NOW - 20 * HOUR },
      ],
      signals(),
    );

    expect(ordered.projects.map((group) => group.id)).toEqual(["loud", "quiet"]);
  });

  test("Given a project with only settled work, When ordered, Then it sorts last", () => {
    const ordered = orderByAttention(
      ["archive", "active"],
      [
        { ...facts("a1", "done", { unreadCount: 0 }), projectId: "archive" },
        { ...facts("b1", "running"), projectId: "active" },
      ],
      signals(),
    );

    expect(ordered.projects.map((group) => group.id)).toEqual(["active", "archive"]);
  });

  test("Given a session naming an unknown project, When ordered, Then no group is fabricated", () => {
    const ordered = orderByAttention(
      ["p"],
      [facts("ok", "running"), { ...facts("orphan", "running"), projectId: "ghost" }],
      signals(),
    );

    expect(ordered.projects.map((group) => group.id)).toEqual(["p"]);
    expect(liveIds(ordered)).toEqual(["ok"]);
  });
});

describe("the engine is pure", () => {
  test("Given the same inputs, When called twice, Then the output is identical", () => {
    const input = [facts("a", "waiting"), facts("b", "running"), facts("c", "done")];

    expect(orderByAttention(["p"], input, signals())).toEqual(
      orderByAttention(["p"], input, signals()),
    );
  });

  test("Given a later now, When ordered, Then ages decay without changing class rank", () => {
    const input = [facts("w", "waiting"), facts("r", "running")];
    const later = signals({ now: NOW + 12 * HOUR });

    expect(liveIds(orderByAttention(["p"], input, later))).toEqual(["w", "r"]);
    expect(score(input[0] as ProjectSessionFacts, NOW + 12 * HOUR)).toBeLessThan(
      score(input[0] as ProjectSessionFacts, NOW),
    );
  });
});
