import { describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseJournalCursor,
  parseWaitReadyArgs,
  runWaitReady,
  watchForEvent,
} from "../../src/manual/wait-ready";

async function* fromLines(lines: string[], delayMs = 0): AsyncGenerator<string> {
  for (const line of lines) {
    if (delayMs > 0) await Bun.sleep(delayMs);
    yield line;
  }
  // A live follower never ends on its own; emulate by parking forever.
  await new Promise(() => undefined);
}

describe("parseWaitReadyArgs", () => {
  it("parses the documented flags", () => {
    expect(
      parseWaitReadyArgs([
        "--service",
        "openomni",
        "--event",
        "OpenOmni ready",
        "--timeout-ms",
        "60000",
        "--json",
        "--announce",
        "/tmp/marker",
      ]),
    ).toEqual({
      source: { type: "service", unit: "openomni" },
      event: "OpenOmni ready",
      timeoutMs: 60_000,
      json: true,
      announce: "/tmp/marker",
    });
  });

  it("fails closed on ambiguous or missing sources, events, and timeouts", () => {
    expect(() => parseWaitReadyArgs(["--event", "x", "--timeout-ms", "1000"])).toThrow(
      /exactly one of/,
    );
    expect(() =>
      parseWaitReadyArgs(["--service", "a", "--log", "b", "--event", "x", "--timeout-ms", "1000"]),
    ).toThrow(/exactly one of/);
    expect(() => parseWaitReadyArgs(["--log", "f", "--timeout-ms", "1000"])).toThrow(/--event/);
    expect(() =>
      parseWaitReadyArgs(["--log", "f", "--event", "x", "--timeout-ms", "nope"]),
    ).toThrow(/--timeout-ms/);
  });
});

describe("parseJournalCursor", () => {
  it("extracts the cursor journalctl --show-cursor prints, and reports absence honestly", () => {
    expect(
      parseJournalCursor("-- No entries --\n-- cursor: s=abc123;i=42;b=deadbeef;m=1;t=2;x=3\n"),
    ).toBe("s=abc123;i=42;b=deadbeef;m=1;t=2;x=3");
    expect(parseJournalCursor("-- No entries --\n")).toBeUndefined();
    expect(parseJournalCursor("")).toBeUndefined();
  });
});

describe("watchForEvent", () => {
  it("observes only the exact event and reports elapsed time", async () => {
    const result = await watchForEvent({
      lines: fromLines(["boot line", "almost ready", "OpenOmni ready", "late line"]),
      event: "OpenOmni ready",
      timeoutMs: 5000,
    });
    expect(result.observed).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("times out with observed:false when the event never arrives", async () => {
    const result = await watchForEvent({
      lines: fromLines(["noise", "more noise"], 10),
      event: "OpenOmni ready",
      timeoutMs: 100,
    });
    expect(result.observed).toBe(false);
  });

  it("fires onSubscribed before any line is consumed", async () => {
    const order: string[] = [];
    async function* trackedLines(): AsyncGenerator<string> {
      order.push("first-read");
      yield "OpenOmni ready";
    }
    await watchForEvent({
      lines: trackedLines(),
      event: "OpenOmni ready",
      timeoutMs: 1000,
      onSubscribed: () => order.push("subscribed"),
    });
    expect(order).toEqual(["subscribed", "first-read"]);
  });
});

describe("runWaitReady (log source, real producer)", () => {
  it("announces after attach, observes an appended event, and terminates its producer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openomni-wait-ready-"));
    const logFile = join(dir, "unit.log");
    const marker = join(dir, "subscribed.marker");
    writeFileSync(logFile, "pre-existing line\n");
    try {
      const run = runWaitReady({
        source: { type: "log", file: logFile },
        event: "OpenOmni ready",
        timeoutMs: 10_000,
        json: true,
        announce: marker,
      });
      // Subscribe-then-produce ordering: wait for the announce marker before
      // appending the event, exactly how the Manual QA scripts consume it.
      const deadline = Date.now() + 5000;
      while (!existsSync(marker) && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      expect(existsSync(marker)).toBe(true);
      appendFileSync(logFile, "OpenOmni ready\n");
      const result = await run;
      expect(result.observed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits with observed:false on timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openomni-wait-ready-"));
    const logFile = join(dir, "unit.log");
    writeFileSync(logFile, "");
    try {
      const result = await runWaitReady({
        source: { type: "log", file: logFile },
        event: "never happens",
        timeoutMs: 300,
        json: false,
      });
      expect(result.observed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
