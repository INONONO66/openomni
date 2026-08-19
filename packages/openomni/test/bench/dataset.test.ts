import { describe, expect, it } from "bun:test";
import {
  buildConversation,
  parseSessionDate,
  type LocomoConversation,
} from "../../bench/compaction/dataset";

/**
 * The session-date parser feeds the whole time-carriage path (#737): a parse
 * failure silently degrades a turn to synthetic time, which the pipeline
 * would render as 1970 — so the shapes LoCoMo actually ships are pinned.
 */
describe("bench dataset session dates", () => {
  it("parses the LoCoMo header shape into UTC epoch ms", () => {
    expect(parseSessionDate("1:56 pm on 8 May, 2023")).toBe(Date.UTC(2023, 4, 8, 13, 56));
    expect(parseSessionDate("10:05 am on 25 December, 2022")).toBe(Date.UTC(2022, 11, 25, 10, 5));
    // Date-only falls back to noon; 12 am/pm do not double-count.
    expect(parseSessionDate("8 May, 2023")).toBe(Date.UTC(2023, 4, 8, 12, 0));
    expect(parseSessionDate("12:30 am on 1 January, 2024")).toBe(Date.UTC(2024, 0, 1, 0, 30));
    expect(parseSessionDate("12:30 pm on 1 January, 2024")).toBe(Date.UTC(2024, 0, 1, 12, 30));
  });

  it("refuses shapes it does not understand instead of guessing", () => {
    expect(parseSessionDate("sometime last week")).toBeUndefined();
    expect(parseSessionDate("8 Floreal, 2023")).toBeUndefined();
  });

  it("stamps every turn's info.time from its session date", () => {
    const conv = {
      sample_id: "t",
      qa: [],
      conversation: {
        speaker_a: "A",
        speaker_b: "B",
        session_1_date_time: "1:56 pm on 8 May, 2023",
        session_1: [
          { speaker: "A", dia_id: "D1:1", text: "hello" },
          { speaker: "B", dia_id: "D1:2", text: "hi" },
        ],
      },
    } as unknown as LocomoConversation;
    const built = buildConversation(conv, "s");
    const base = Date.UTC(2023, 4, 8, 13, 56);
    // +index keeps ordering strict; the date (all the marker renders) is unchanged.
    for (const message of built.messages) {
      expect(Math.abs(message.info.time.created - base)).toBeLessThan(1000);
    }
  });
});
