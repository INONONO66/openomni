import { describe, expect, test } from "bun:test";
import { Hashline } from "../src/hashline/index.js";

const refFor = (lines: string[], lineNumber: number): string =>
  `${lineNumber}#${Hashline.computeHash(lineNumber, lines[lineNumber - 1] ?? "")}`;

describe("Hashline.computeHash", () => {
  test("is deterministic for same input", () => {
    const first = Hashline.computeHash(3, "hello world");
    const second = Hashline.computeHash(3, "hello world");

    expect(first).toBe(second);
  });

  test("ignores whitespace", () => {
    const hasher = (input: string) => input.length;
    const withWhitespace = Hashline.computeHash(7, "  foo  ", hasher);
    const withoutWhitespace = Hashline.computeHash(7, "foo", hasher);

    expect(withWhitespace).toBe(withoutWhitespace);
  });

  test("distinguishes empty lines by line number", () => {
    expect(Hashline.computeHash(1, "")).not.toBe(Hashline.computeHash(2, ""));
  });
});

describe("Hashline.format", () => {
  test("formats aligned line numbers with hash and divider", () => {
    const text = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\n");
    const hasher = (_input: string, seed: number) => seed;

    const output = Hashline.format(text, hasher);
    const formattedLines = output.split("\n");

    expect(formattedLines[0]).toBe(" 1#PZ│ line-1");
    expect(formattedLines[9]).toBe("10#TZ│ line-10");
  });
});

describe("Hashline.formatRange", () => {
  test("returns only requested inclusive range with original line numbers", () => {
    const text = "a\nb\nc\nd";
    const hasher = (_input: string, seed: number) => seed;

    expect(Hashline.formatRange(text, 2, 3, hasher)).toBe("2#MZ│ b\n3#QZ│ c");
  });
});

describe("Hashline.validateRef", () => {
  test("returns valid true for matching ref", () => {
    const lines = ["alpha", "beta", "gamma"];
    const ref = refFor(lines, 2);

    expect(Hashline.validateRef(lines, ref)).toEqual({ valid: true });
  });

  test("returns current ref when stale", () => {
    const lines = ["alpha", "beta", "gamma"];
    const stale = refFor(lines, 2);
    lines[1] = "changed";

    const result = Hashline.validateRef(lines, stale);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.current).toBe(refFor(lines, 2));
    }
  });
});

describe("Hashline.applyEdits", () => {
  test("replaces single line", () => {
    const content = "a\nb\nc";
    const lines = content.split("\n");

    const result = Hashline.applyEdits(content, [
      { op: "replace", pos: refFor(lines, 2), lines: ["B"] },
    ]);

    expect(result).toEqual({ ok: true, content: "a\nB\nc" });
  });

  test("replaces a range", () => {
    const content = "a\nb\nc\nd";
    const lines = content.split("\n");

    const result = Hashline.applyEdits(content, [
      {
        op: "replace",
        pos: refFor(lines, 2),
        end: refFor(lines, 3),
        lines: ["X", "Y"],
      },
    ]);

    expect(result).toEqual({ ok: true, content: "a\nX\nY\nd" });
  });

  test("supports append and prepend", () => {
    const content = "a\nb\nc";
    const lines = content.split("\n");

    const result = Hashline.applyEdits(content, [
      { op: "append", pos: refFor(lines, 3), lines: ["after-c"] },
      { op: "prepend", pos: refFor(lines, 1), lines: ["before-a"] },
    ]);

    expect(result).toEqual({ ok: true, content: "before-a\na\nb\nc\nafter-c" });
  });

  test("applies edits bottom-to-top", () => {
    const content = Array.from({ length: 10 }, (_, index) => `l${index + 1}`).join("\n");
    const lines = content.split("\n");

    const result = Hashline.applyEdits(content, [
      { op: "append", pos: refFor(lines, 10), lines: ["after10"] },
      { op: "replace", pos: refFor(lines, 5), lines: ["five"] },
      { op: "prepend", pos: refFor(lines, 1), lines: ["zero"] },
    ]);

    expect(result).toEqual({
      ok: true,
      content: "zero\nl1\nl2\nl3\nl4\nfive\nl6\nl7\nl8\nl9\nl10\nafter10",
    });
  });

  test("fails atomically when any ref is stale", () => {
    const content = "a\nb\nc";
    const lines = content.split("\n");
    const stale = refFor(lines, 2);
    const changedContent = "a\nB\nc";

    const result = Hashline.applyEdits(changedContent, [
      { op: "replace", pos: stale, lines: ["x"] },
      { op: "append", pos: refFor(changedContent.split("\n"), 3), lines: ["tail"] },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
    expect(changedContent).toBe("a\nB\nc");
  });

  test("returns error on duplicate target line", () => {
    const content = "a\nb\nc";
    const lines = content.split("\n");

    const result = Hashline.applyEdits(content, [
      { op: "replace", pos: refFor(lines, 2), lines: ["x"] },
      { op: "append", pos: refFor(lines, 2), lines: ["y"] },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.includes("duplicate target line: 2"))).toBe(true);
    }
  });
});
