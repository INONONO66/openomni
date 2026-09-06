import { describe, expect, test } from "bun:test";
import { CLASS_RANK, reasonFor } from "../src/renderer/attention";
import { DAY, facts, HOUR, MINUTE, NOW, signals } from "./attention-fixture";

const s = () => facts("s", "running");

describe("every attention class can explain itself", () => {
  test("Given each class that ranks on a fact, When a reason is requested, Then a phrase comes back", () => {
    // A class with no reason string is a ranking decision the Owner cannot
    // interrogate, which is the failure this asserts against.
    //
    // `running` is the one exemption, and it is not a hole in the rule: the
    // reason a running row sits where it does is that it is running right now,
    // which is exactly what the accent dot beside the line already says. The
    // word was the dot's caption, printed on every live row in the column.
    for (const attentionClass of Object.keys(CLASS_RANK) as (keyof typeof CLASS_RANK)[]) {
      if (attentionClass === "running") continue;
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

  test("Given a running session, When explained, Then the dot is the whole readout", () => {
    // Not "running", and not a running age either. An age here would be a
    // number ticking under the cursor for a row that is not asking for
    // anything, and the word itself was the accent dot's caption — two marks
    // for one fact, on the only rows in the column that are alive.
    expect(reasonFor("running", s(), signals())).toBe("");
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
