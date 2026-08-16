import { describe, test, expect } from "bun:test";
import { LineDecoder } from "../src/framing";
import { IpcProtocolError } from "../src/errors";

const FRAME_LIMIT_BYTES = 16 * 1024 * 1024;

describe("LineDecoder", () => {
  test("decodes complete lines", () => {
    const dec = new LineDecoder();
    const results = dec.push('{"a":1}\n{"b":2}\n');
    expect(results).toEqual({ frames: [{ a: 1 }, { b: 2 }], malformed: [] });
  });

  test("buffers partial lines across pushes", () => {
    const dec = new LineDecoder();
    expect(dec.push('{"a":')).toEqual({ frames: [], malformed: [] });
    expect(dec.push("1}\n")).toEqual({ frames: [{ a: 1 }], malformed: [] });
  });

  test("handles Uint8Array input", () => {
    const dec = new LineDecoder();
    const chunk = new TextEncoder().encode('{"ok":true}\n');
    expect(dec.push(chunk)).toEqual({ frames: [{ ok: true }], malformed: [] });
  });

  test("preserves multibyte UTF-8 characters split across Uint8Array chunks", () => {
    const dec = new LineDecoder();
    const encoded = new TextEncoder().encode('{"text":"😀"}\n');
    const emojiStart = encoded.findIndex((byte) => byte === 0xf0);
    const split = emojiStart + 2;

    expect(dec.push(encoded.slice(0, split))).toEqual({ frames: [], malformed: [] });
    expect(dec.push(encoded.slice(split))).toEqual({ frames: [{ text: "😀" }], malformed: [] });
  });

  test("resets pending streaming decoder state before string chunks", () => {
    const dec = new LineDecoder();
    const encoder = new TextEncoder();
    const prefix = encoder.encode('{"text":"');
    const firstEmojiBytes = new Uint8Array(prefix.length + 2);
    firstEmojiBytes.set(prefix);
    firstEmojiBytes.set([0xf0, 0x9f], prefix.length);

    expect(dec.push(firstEmojiBytes)).toEqual({ frames: [], malformed: [] });
    expect(dec.push('fallback"}\n')).toEqual({ frames: [{ text: "fallback" }], malformed: [] });
    expect(dec.push(encoder.encode('{"ok":true}\n'))).toEqual({
      frames: [{ ok: true }],
      malformed: [],
    });
  });

  test("keeps string chunks composable after Uint8Array frames", () => {
    const dec = new LineDecoder();
    const encoder = new TextEncoder();

    expect(dec.push(encoder.encode('{"a":1}\n'))).toEqual({ frames: [{ a: 1 }], malformed: [] });
    expect(dec.push('{"b":')).toEqual({ frames: [], malformed: [] });
    expect(dec.push("2}\n")).toEqual({ frames: [{ b: 2 }], malformed: [] });
  });

  test("throws IpcProtocolError when buffer exceeds MAX_FRAME_BYTES", () => {
    const dec = new LineDecoder();
    // push slightly over the cap without a newline
    const oversized = "x".repeat(FRAME_LIMIT_BYTES + 1);
    expect(() => dec.push(oversized)).toThrow(IpcProtocolError);
  });

  test("resets buffer after oversized rejection", () => {
    const dec = new LineDecoder();
    const oversized = "x".repeat(FRAME_LIMIT_BYTES + 1);
    try {
      dec.push(oversized);
    } catch {
      // expected
    }
    // buffer should be cleared — next valid push works normally
    const results = dec.push('{"recovered":true}\n');
    expect(results).toEqual({ frames: [{ recovered: true }], malformed: [] });
  });

  test("resets streaming decoder state after oversized Uint8Array rejection", () => {
    const dec = new LineDecoder();
    const encoder = new TextEncoder();
    const prefix = encoder.encode("x".repeat(FRAME_LIMIT_BYTES + 1));
    const oversizedWithPartialUtf8 = new Uint8Array(prefix.length + 2);
    oversizedWithPartialUtf8.set(prefix);
    oversizedWithPartialUtf8.set([0xf0, 0x9f], prefix.length);

    expect(() => dec.push(oversizedWithPartialUtf8)).toThrow(IpcProtocolError);
    expect(dec.push(encoder.encode('{"ok":true}\n'))).toEqual({
      frames: [{ ok: true }],
      malformed: [],
    });
  });

  test("resets buffer after completed oversized frame rejection", () => {
    const dec = new LineDecoder();
    const oversizedLine = `${JSON.stringify({ data: "y".repeat(FRAME_LIMIT_BYTES) })}\npartial`;

    expect(() => dec.push(oversizedLine)).toThrow(IpcProtocolError);
    expect(dec.push('{"ok":true}\n')).toEqual({ frames: [{ ok: true }], malformed: [] });
  });

  test("allows frames just under the cap", () => {
    const dec = new LineDecoder();
    // a partial buffer right at the limit should not throw
    const justUnder = "x".repeat(FRAME_LIMIT_BYTES);
    expect(() => dec.push(justUnder)).not.toThrow();
  });

  test("rejects completed frame exceeding MAX_FRAME_BYTES", () => {
    const dec = new LineDecoder();
    const payload = JSON.stringify({ data: "y".repeat(FRAME_LIMIT_BYTES) });
    expect(() => dec.push(`${payload}\n`)).toThrow(IpcProtocolError);
  });

  test("accepts completed frame at exactly MAX_FRAME_BYTES", () => {
    const dec = new LineDecoder();
    // build a JSON line whose total length equals MAX_FRAME_BYTES
    const overhead = '{"d":""}';
    const filler = "z".repeat(FRAME_LIMIT_BYTES - overhead.length);
    const line = `{"d":"${filler}"}`;
    expect(line).toHaveLength(FRAME_LIMIT_BYTES);
    const results = dec.push(`${line}\n`);
    expect(results.frames).toHaveLength(1);
    expect(results.malformed).toEqual([]);
  });

  test("reset clears the buffer", () => {
    const dec = new LineDecoder();
    dec.push("partial");
    dec.reset();
    const results = dec.push('{"fresh":true}\n');
    expect(results).toEqual({ frames: [{ fresh: true }], malformed: [] });
  });

  test("reports a malformed line without throwing and delivers all siblings", () => {
    const dec = new LineDecoder();
    const results = dec.push('{"a":1}\n{not json}\n{"b":2}\n');
    expect(results.frames).toEqual([{ a: 1 }, { b: 2 }]);
    expect(results.malformed).toEqual(["{not json}"]);
  });

  test("reports every malformed line in a chunk, in order", () => {
    const dec = new LineDecoder();
    const results = dec.push('garbage-1\n{"ok":true}\ngarbage-2\n');
    expect(results.frames).toEqual([{ ok: true }]);
    expect(results.malformed).toEqual(["garbage-1", "garbage-2"]);
  });

  test("truncates each malformed report entry to 64 chars", () => {
    const dec = new LineDecoder();
    const junk = `not-json-${"x".repeat(200)}`;
    const results = dec.push(`${junk}\n`);
    expect(results.frames).toEqual([]);
    expect(results.malformed).toHaveLength(1);
    expect(results.malformed[0]).toHaveLength(64);
    expect(junk.startsWith(results.malformed[0] ?? "")).toBe(true);
  });

  test("never re-queues a malformed line — the next push starts clean", () => {
    const dec = new LineDecoder();
    expect(dec.push("{broken\n")).toEqual({ frames: [], malformed: ["{broken"] });
    expect(dec.push('{"next":1}\n')).toEqual({ frames: [{ next: 1 }], malformed: [] });
  });
});
