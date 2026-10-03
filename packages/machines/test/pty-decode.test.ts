import { describe, expect, test } from "bun:test";
import { createControlDecoder, decodeOctalEscapes, type PtyControlEvent } from "../src/pty-decode";

const feed = (chunks: string[]): PtyControlEvent[] => {
  const decoder = createControlDecoder();
  return chunks.flatMap((chunk) => decoder.feed(Buffer.from(chunk, "utf8")));
};

describe("pty control decoder", () => {
  test("octal escapes decode to the exact original bytes", () => {
    expect(decodeOctalEscapes("plain")?.toString("utf8")).toBe("plain");
    expect([...(decodeOctalEscapes("a\\033[1mb\\015\\012") ?? Buffer.alloc(0))]).toEqual([
      0x61, 0x1b, 0x5b, 0x31, 0x6d, 0x62, 0x0d, 0x0a,
    ]);
    // The manual escapes backslash itself as \134.
    expect(decodeOctalEscapes("c:\\134tmp")?.toString("utf8")).toBe("c:\\tmp");
  });

  test("a truncated or non-octal escape is malformed, not silently dropped", () => {
    expect(decodeOctalEscapes("bad\\xff")).toBeUndefined();
    expect(decodeOctalEscapes("bad\\09")).toBeUndefined();
    expect(decodeOctalEscapes("bad\\")).toBeUndefined();
    const events = feed(["%output %3 bad\\9zz\n"]);
    expect(events).toEqual([
      { kind: "malformed", line: "%output %3 bad\\9zz", reason: "invalid octal escape in %output", paneId: "%3" },
    ]);
  });

  test("%output routes by pane id and survives chunk splits mid-line", () => {
    const events = feed(["%outp", "ut %7 hel", "lo\\015\\012\n%output %8 x\n"]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "output", paneId: "%7" });
    expect(events[0]?.kind === "output" && events[0].data.toString("utf8")).toBe("hello\r\n");
    expect(events[1]).toMatchObject({ kind: "output", paneId: "%8" });
  });

  test("a multibyte character split across chunks decodes intact", () => {
    const line = Buffer.from("%output %1 héllo\n", "utf8");
    const decoder = createControlDecoder();
    const first = decoder.feed(line.subarray(0, 13));
    const second = decoder.feed(line.subarray(13));
    expect(first).toEqual([]);
    expect(second[0]?.kind === "output" && second[0].data.toString("utf8")).toBe("héllo");
  });

  test("reply blocks collect body lines, even body lines starting with %", () => {
    const events = feed([
      "%begin 100 2 1\nfirst\n%weird body\n%end 100 2 1\n",
      "%begin 101 3 1\nboom\n%error 101 3 1\n",
    ]);
    expect(events).toEqual([
      { kind: "reply-begin" },
      { kind: "reply-body", line: "first" },
      { kind: "reply-body", line: "%weird body" },
      { kind: "reply-end", ok: true },
      { kind: "reply-begin" },
      { kind: "reply-body", line: "boom" },
      { kind: "reply-end", ok: false },
    ]);
  });

  test("%exit and unknown notifications keep framing for later records", () => {
    const events = feed(["%sessions-changed\n%output oops\n%exit\n%output %2 ok\n"]);
    expect(events[0]).toEqual({ kind: "notice", line: "%sessions-changed" });
    expect(events[1]).toMatchObject({ kind: "malformed", reason: "unparseable %output record", paneId: undefined });
    expect(events[2]).toEqual({ kind: "exit" });
    expect(events[3]).toMatchObject({ kind: "output", paneId: "%2" });
  });
});
