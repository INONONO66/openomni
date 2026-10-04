import { describe, expect, test } from "bun:test";
import { Cron, CronParseError } from "../src/cron.js";

const UTC = "UTC";
const NY = "America/New_York";

function errorCode(run: () => number | readonly number[]): string {
  try {
    run();
  } catch (error) {
    if (error instanceof CronParseError) {
      return error.code;
    }
    throw error;
  }
  return "none";
}

describe("Cron.next grid", () => {
  test("every-30-minutes grid from an arbitrary second lands on the next :00/:30 boundary", () => {
    // Given a from-instant mid-grid at 10:12:34
    const from = Date.UTC(2026, 0, 15, 10, 12, 34);
    // When / Then
    expect(Cron.next("*/30 * * * *", from, UTC)).toBe(Date.UTC(2026, 0, 15, 10, 30));
  });

  test("fromMs exactly on a grid instant yields the strictly-next instant", () => {
    const onGrid = Date.UTC(2026, 0, 15, 10, 30);
    expect(Cron.next("*/30 * * * *", onGrid, UTC)).toBe(Date.UTC(2026, 0, 15, 11, 0));
  });

  test("occurrences over a 3h window on a 30m schedule counts 6 missed firings", () => {
    // Given the issue's "3h down on a 30m schedule" window (after, until]
    const after = Date.UTC(2026, 0, 15, 10, 0);
    const until = after + 3 * 60 * 60 * 1000;
    // When
    const hits = Cron.occurrences("*/30 * * * *", after, until, UTC);
    // Then: 10:30 .. 13:00 inclusive, 10:00 itself excluded
    expect(hits.length).toBe(6);
    expect(hits[0]).toBe(Date.UTC(2026, 0, 15, 10, 30));
    expect(hits[5]).toBe(Date.UTC(2026, 0, 15, 13, 0));
  });

  test("occurrences respects the limit cap", () => {
    const after = Date.UTC(2026, 0, 15, 10, 0);
    const until = after + 3 * 60 * 60 * 1000;
    expect(Cron.occurrences("*/30 * * * *", after, until, UTC, 2).length).toBe(2);
  });
});

describe("Cron.missed saturation (#1254 r2 M1)", () => {
  test("1025 elapsed minute ticks saturate at the default 1024 cap with the flag raised", () => {
    const after = Date.UTC(2026, 0, 15, 10, 0);
    const until = after + 1025 * 60 * 1000;
    expect(Cron.missed("* * * * *", after, until, UTC)).toEqual({ count: 1024, saturated: true });
  });

  test("exactly 1024 elapsed minute ticks report the exact count, not saturated", () => {
    const after = Date.UTC(2026, 0, 15, 10, 0);
    const until = after + 1024 * 60 * 1000;
    expect(Cron.missed("* * * * *", after, until, UTC)).toEqual({ count: 1024, saturated: false });
  });

  test("a custom limit saturates without materializing instants past the cap", () => {
    const after = Date.UTC(2026, 0, 15, 10, 0);
    const until = after + 3 * 60 * 60 * 1000;
    expect(Cron.missed("*/30 * * * *", after, until, UTC, 2)).toEqual({ count: 2, saturated: true });
    expect(Cron.missed("*/30 * * * *", after, until, UTC)).toEqual({ count: 6, saturated: false });
  });

  test("unknown zone is a zone error from missed too", () => {
    expect(errorCode(() => Cron.missed("* * * * *", 0, 1, "Not/AZone").count)).toBe("zone");
  });
});

describe("Vixie day rule", () => {
  const expr = "0 0 13 * 5";

  test("dom and dow both restricted match Friday-the-13th (both sides hit)", () => {
    // 2026-02-13 is a Friday
    const from = Date.UTC(2026, 1, 12, 12, 0);
    expect(Cron.next(expr, from, UTC)).toBe(Date.UTC(2026, 1, 13, 0, 0));
  });

  test("dom and dow both restricted match a plain Friday (dow side alone)", () => {
    // Strictly after Friday 2026-02-13 00:00 the next hit is Friday 2026-02-20
    const from = Date.UTC(2026, 1, 13, 0, 0);
    expect(Cron.next(expr, from, UTC)).toBe(Date.UTC(2026, 1, 20, 0, 0));
  });

  test("dom and dow both restricted match a non-Friday 13th (dom side alone)", () => {
    // 2026-04-13 is a Monday; no Friday falls between Apr 11 and Apr 13
    const from = Date.UTC(2026, 3, 11, 0, 0);
    expect(Cron.next(expr, from, UTC)).toBe(Date.UTC(2026, 3, 13, 0, 0));
  });

  test("only dom restricted must match dom", () => {
    const from = Date.UTC(2026, 3, 11, 0, 0);
    expect(Cron.next("0 0 13 * *", from, UTC)).toBe(Date.UTC(2026, 3, 13, 0, 0));
  });

  test("only dow restricted must match dow", () => {
    // Next Friday after Sat 2026-04-11 is 2026-04-17
    const from = Date.UTC(2026, 3, 11, 0, 0);
    expect(Cron.next("0 0 * * 5", from, UTC)).toBe(Date.UTC(2026, 3, 17, 0, 0));
  });
});

describe("DST in America/New_York", () => {
  test("spring-forward gap 2026-03-08: 02:30 does not exist, fires 2026-03-09 02:30 EDT", () => {
    // Given midnight EST on the gap day (2026-03-08T00:00-05:00)
    const from = Date.UTC(2026, 2, 8, 5, 0);
    // Then no occurrence during the gap day (until 2026-03-09T00:00 EDT)
    expect(Cron.occurrences("30 2 * * *", from, Date.UTC(2026, 2, 9, 4, 0), NY).length).toBe(0);
    // And the next instant is 2026-03-09 02:30 EDT = 06:30Z
    expect(Cron.next("30 2 * * *", from, NY)).toBe(Date.UTC(2026, 2, 9, 6, 30));
  });

  test("fall-back overlap 2026-11-01: 01:30 fires only at its first instant (EDT, UTC-4)", () => {
    // Given midnight EDT on the overlap day (2026-11-01T00:00-04:00)
    const from = Date.UTC(2026, 10, 1, 4, 0);
    const firstInstant = Date.UTC(2026, 10, 1, 5, 30); // 01:30 EDT
    expect(Cron.next("30 1 * * *", from, NY)).toBe(firstInstant);
    // The repeated 01:30 EST (06:30Z) is skipped; next fires the following day
    expect(Cron.next("30 1 * * *", firstInstant, NY)).toBe(Date.UTC(2026, 10, 2, 6, 30));
    // Exactly one hit across the whole overlap day
    const hits = Cron.occurrences("30 1 * * *", from, Date.UTC(2026, 10, 2, 5, 0), NY);
    expect(hits).toEqual([firstInstant]);
  });
});

describe("field vocabulary", () => {
  test("month and weekday names are case-insensitive", () => {
    // First Monday of March 2026 is 2026-03-02
    const from = Date.UTC(2026, 1, 20, 0, 0);
    expect(Cron.next("0 12 * MaR MoN", from, UTC)).toBe(Date.UTC(2026, 2, 2, 12, 0));
  });

  test("7 and 0 both mean Sunday", () => {
    const from = Date.UTC(2026, 3, 11, 0, 0); // Saturday
    const sunday = Date.UTC(2026, 3, 12, 0, 0);
    expect(Cron.next("0 0 * * 7", from, UTC)).toBe(sunday);
    expect(Cron.next("0 0 * * 0", from, UTC)).toBe(sunday);
  });

  test("steps over ranges select the stepped values", () => {
    // 10-40/15 -> minutes {10, 25, 40}
    const from = Date.UTC(2026, 0, 15, 10, 26);
    expect(Cron.next("10-40/15 * * * *", from, UTC)).toBe(Date.UTC(2026, 0, 15, 10, 40));
  });

  test("lists enumerate each entry", () => {
    const after = Date.UTC(2026, 0, 15, 0, 0);
    const hits = Cron.occurrences("5,20 14 * * *", after, after + 24 * 60 * 60 * 1000, UTC);
    expect(hits).toEqual([Date.UTC(2026, 0, 15, 14, 5), Date.UTC(2026, 0, 15, 14, 20)]);
  });
});

describe("CronParseError", () => {
  test("six fields is a fields error", () => {
    expect(errorCode(() => Cron.next("* * * * * *", 0, UTC))).toBe("fields");
  });

  test("out-of-range minute is a range error", () => {
    expect(errorCode(() => Cron.next("60 * * * *", 0, UTC))).toBe("range");
  });

  test("zero step is a step error", () => {
    expect(errorCode(() => Cron.next("*/0 * * * *", 0, UTC))).toBe("step");
  });

  test("garbage token is a field error carrying the field index", () => {
    try {
      Cron.next("* * * bogus *", 0, UTC);
      throw new CronParseError("field", -99, "test must not reach here");
    } catch (error) {
      expect(error).toBeInstanceOf(CronParseError);
      if (error instanceof CronParseError) {
        expect(error.code).toBe("field");
        expect(error.field).toBe(3);
        expect(error.input).toBe("* * * bogus *");
      }
    }
  });

  test("unknown zone is a zone error from occurrences too", () => {
    expect(errorCode(() => Cron.next("* * * * *", 0, "Not/AZone"))).toBe("zone");
    expect(errorCode(() => Cron.occurrences("* * * * *", 0, 1, "Not/AZone"))).toBe("zone");
  });

  test("Feb 30 never matches within 366 days: unreachable", () => {
    expect(errorCode(() => Cron.next("0 0 30 2 *", Date.UTC(2026, 0, 1), UTC))).toBe("unreachable");
  });
});
