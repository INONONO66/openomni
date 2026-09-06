import { describe, expect, test } from "bun:test";
import { CLASS_RANK, reasonFor } from "../src/renderer/attention";
import { DAY, facts, HOUR, MINUTE, NOW, signals } from "./attention-fixture";

const s = () => facts("s", "running");

describe("every attention class can explain itself", () => {
  test("Given each class, When a reason is requested, Then a non-empty phrase comes back", () => {
    // A class with no reason string is a ranking decision the Owner cannot
    // interrogate, which is the failure this asserts against.
    for (const attentionClass of Object.keys(CLASS_RANK) as (keyof typeof CLASS_RANK)[]) {
      expect(reasonFor(attentionClass, s(), signals()).length).toBeGreaterThan(0);
    }
  });
});

describe("reasons name the signal that produced them", () => {
  test("Given a waiting session, When explained, Then the reason says it needs the Owner", () => {
    expect(
      reasonFor("waiting", facts("s", "waiting", { lastEventAt: NOW - 9 * MINUTE }), signals()),
    ).toBe("waiting for you · 9m");
  });

  test("Given an interrupted session, When explained, Then the reason names the state and age", () => {
    expect(
      reasonFor(
        "interrupted",
        facts("s", "interrupted", { lastEventAt: NOW - 3 * HOUR }),
        signals(),
      ),
    ).toBe("interrupted · 3h");
  });

  test("Given a finished session, When explained, Then the reason says finished", () => {
    expect(
      reasonFor(
        "finished",
        facts("s", "done", { lastEventAt: NOW - 50 * MINUTE, unreadCount: 2 }),
        signals(),
      ),
    ).toBe("finished · 50m");
  });

  test("Given a snoozed session, When explained, Then the reason names the wake time", () => {
    const wake = Date.parse("2026-09-03T15:30:00.000Z");

    expect(reasonFor("settled", s(), signals({ snoozes: new Map([["s", wake]]) }))).toBe(
      "snoozed until 15:30",
    );
  });

  test("Given an expired snooze, When explained as settled, Then the wake time is not claimed", () => {
    expect(reasonFor("settled", s(), signals({ snoozes: new Map([["s", NOW - MINUTE]]) }))).toBe(
      "done · 1h",
    );
  });

  test("Given a pinned session, When explained, Then the reason is the override itself", () => {
    expect(reasonFor("pinned", s(), signals())).toBe("pinned");
  });

  test("Given a running session, When explained, Then the reason carries no age", () => {
    // Ambient progress: an age here would be a number ticking under the cursor
    // for a row that is not asking for anything.
    expect(reasonFor("running", s(), signals())).toBe("running");
  });
});

describe("ages are coarse on purpose", () => {
  test("Given ages across the unit boundaries, When formatted, Then the coarse unit is used", () => {
    const at = (ms: number) =>
      reasonFor("waiting", facts("s", "waiting", { lastEventAt: NOW - ms }), signals());

    expect(at(30_000)).toBe("waiting for you · just now");
    expect(at(5 * MINUTE)).toBe("waiting for you · 5m");
    expect(at(2 * HOUR)).toBe("waiting for you · 2h");
    expect(at(3 * DAY)).toBe("waiting for you · 3d");
  });

  test("Given a future timestamp, When formatted, Then the age floors at just now", () => {
    expect(
      reasonFor("waiting", facts("s", "waiting", { lastEventAt: NOW + MINUTE }), signals()),
    ).toBe("waiting for you · just now");
  });
});
