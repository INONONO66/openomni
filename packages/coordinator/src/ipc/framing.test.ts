import { describe, test, expect } from "bun:test";
import { LineDecoder } from "./framing";
import { IpcProtocolError } from "./errors";

const FRAME_LIMIT_BYTES = 16 * 1024 * 1024;

describe("LineDecoder", () => {
  test("decodes complete lines", () => {
    const dec = new LineDecoder();
    const results = dec.push('{"a":1}\n{"b":2}\n');
    expect(results).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("buffers partial lines across pushes", () => {
    const dec = new LineDecoder();
    expect(dec.push('{"a":')).toEqual([]);
    expect(dec.push("1}\n")).toEqual([{ a: 1 }]);
  });

  test("handles Uint8Array input", () => {
    const dec = new LineDecoder();
    const chunk = new TextEncoder().encode('{"ok":true}\n');
    expect(dec.push(chunk)).toEqual([{ ok: true }]);
  });

  test("preserves multibyte UTF-8 characters split across Uint8Array chunks", () => {
    const dec = new LineDecoder();
    const encoded = new TextEncoder().encode('{"text":"😀"}\n');
    const emojiStart = encoded.findIndex((byte) => byte === 0xf0);
    const split = emojiStart + 2;

    expect(dec.push(encoded.slice(0, split))).toEqual([]);
    expect(dec.push(encoded.slice(split))).toEqual([{ text: "😀" }]);
  });

  test("resets pending streaming decoder state before string chunks", () => {
    const dec = new LineDecoder();
    const encoder = new TextEncoder();
    const prefix = encoder.encode('{"text":"');
    const firstEmojiBytes = new Uint8Array(prefix.length + 2);
    firstEmojiBytes.set(prefix);
    firstEmojiBytes.set([0xf0, 0x9f], prefix.length);

    expect(dec.push(firstEmojiBytes)).toEqual([]);
    expect(dec.push('fallback"}\n')).toEqual([{ text: "fallback" }]);
    expect(dec.push(encoder.encode('{"ok":true}\n'))).toEqual([{ ok: true }]);
  });

  test("keeps string chunks composable after Uint8Array frames", () => {
    const dec = new LineDecoder();
    const encoder = new TextEncoder();

    expect(dec.push(encoder.encode('{"a":1}\n'))).toEqual([{ a: 1 }]);
    expect(dec.push('{"b":')).toEqual([]);
    expect(dec.push("2}\n")).toEqual([{ b: 2 }]);
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
    expect(results).toEqual([{ recovered: true }]);
  });

  test("resets streaming decoder state after oversized Uint8Array rejection", () => {
    const dec = new LineDecoder();
    const encoder = new TextEncoder();
    const prefix = encoder.encode("x".repeat(FRAME_LIMIT_BYTES + 1));
    const oversizedWithPartialUtf8 = new Uint8Array(prefix.length + 2);
    oversizedWithPartialUtf8.set(prefix);
    oversizedWithPartialUtf8.set([0xf0, 0x9f], prefix.length);

    expect(() => dec.push(oversizedWithPartialUtf8)).toThrow(IpcProtocolError);
    expect(dec.push(encoder.encode('{"ok":true}\n'))).toEqual([{ ok: true }]);
  });

  test("resets buffer after completed oversized frame rejection", () => {
    const dec = new LineDecoder();
    const oversizedLine = `${JSON.stringify({ data: "y".repeat(FRAME_LIMIT_BYTES) })}\npartial`;

    expect(() => dec.push(oversizedLine)).toThrow(IpcProtocolError);
    expect(dec.push('{"ok":true}\n')).toEqual([{ ok: true }]);
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
    expect(results).toHaveLength(1);
  });

  test("reset clears the buffer", () => {
    const dec = new LineDecoder();
    dec.push("partial");
    dec.reset();
    const results = dec.push('{"fresh":true}\n');
    expect(results).toEqual([{ fresh: true }]);
  });
});
