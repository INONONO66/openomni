import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test";
import { Session } from "@openomni/session";
import { StreamingBuffer } from "../../src/cache/streaming-buffer";
import { sessionCache } from "../../src/cache/session-cache";

describe("StreamingBuffer", () => {
  let addPartSpy: ReturnType<typeof spyOn>;
  let setStreamingSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    addPartSpy = spyOn(Session, "addPart").mockImplementation(() => {});
    setStreamingSpy = spyOn(sessionCache, "setStreaming").mockImplementation(() => {});
  });

  afterEach(() => {
    addPartSpy.mockRestore();
    setStreamingSpy.mockRestore();
  });

  test("append accumulates in memory without DB writes", () => {
    const buffer = new StreamingBuffer("s1", "m1", "p1");
    buffer.append("Hello");
    buffer.append(" world");

    expect(buffer.currentText).toBe("Hello world");
    expect(addPartSpy).not.toHaveBeenCalled();
  });

  test("complete flushes remaining text and clears interval", () => {
    const buffer = new StreamingBuffer("s1", "m1", "p1");
    buffer.append("Hello");
    buffer.startFlushInterval();
    buffer.complete();

    expect(addPartSpy).toHaveBeenCalledTimes(1);
    expect(addPartSpy).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ id: "p1", type: "text", text: "Hello" }),
    );
    expect(setStreamingSpy).toHaveBeenCalledWith("s1", false);
  });

  test("complete skips flush when buffer is empty", () => {
    const buffer = new StreamingBuffer("s1", "m1", "p1");
    buffer.complete();

    expect(addPartSpy).not.toHaveBeenCalled();
    expect(setStreamingSpy).toHaveBeenCalledWith("s1", false);
  });

  test("complete does not double-flush unchanged content", () => {
    const buffer = new StreamingBuffer("s1", "m1", "p1", { intervalMs: 10 });
    buffer.append("text");
    buffer.startFlushInterval();

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        buffer.complete();
        expect(addPartSpy).toHaveBeenCalledTimes(1);
        resolve();
      }, 30);
    });
  });

  test("reset clears buffer and flush tracking", () => {
    const buffer = new StreamingBuffer("s1", "m1", "p1");
    buffer.append("Hello");
    expect(buffer.currentText).toBe("Hello");

    buffer.reset();
    expect(buffer.currentText).toBe("");

    buffer.complete();
    expect(addPartSpy).not.toHaveBeenCalled();
  });

  test("flush interval writes accumulated text to storage", () => {
    const buffer = new StreamingBuffer("s1", "m1", "p1", { intervalMs: 50 });
    buffer.append("token1");
    buffer.startFlushInterval();

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        try {
          expect(addPartSpy).toHaveBeenCalledTimes(1);
          expect(addPartSpy).toHaveBeenCalledWith(
            "m1",
            expect.objectContaining({ type: "text", text: "token1" }),
          );
        } finally {
          buffer.complete();
        }
        resolve();
      }, 80);
    });
  });

  test("flush interval batches multiple appends into one write", () => {
    const buffer = new StreamingBuffer("s1", "m1", "p1", { intervalMs: 50 });
    buffer.startFlushInterval();

    buffer.append("a");
    buffer.append("b");
    buffer.append("c");

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        try {
          expect(addPartSpy).toHaveBeenCalledTimes(1);
          expect(addPartSpy).toHaveBeenCalledWith("m1", expect.objectContaining({ text: "abc" }));
        } finally {
          buffer.complete();
        }
        resolve();
      }, 80);
    });
  });
});
