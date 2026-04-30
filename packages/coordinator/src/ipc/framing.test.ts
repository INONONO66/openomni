import { describe, test, expect } from "bun:test";
import { LineDecoder, MAX_FRAME_BYTES } from "./framing";
import { IpcProtocolError } from "./errors";

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

  test("throws IpcProtocolError when buffer exceeds MAX_FRAME_BYTES", () => {
    const dec = new LineDecoder();
    // push slightly over the cap without a newline
    const oversized = "x".repeat(MAX_FRAME_BYTES + 1);
    expect(() => dec.push(oversized)).toThrow(IpcProtocolError);
  });

  test("resets buffer after oversized rejection", () => {
    const dec = new LineDecoder();
    const oversized = "x".repeat(MAX_FRAME_BYTES + 1);
    try {
      dec.push(oversized);
    } catch {
      // expected
    }
    // buffer should be cleared — next valid push works normally
    const results = dec.push('{"recovered":true}\n');
    expect(results).toEqual([{ recovered: true }]);
  });

  test("allows frames just under the cap", () => {
    const dec = new LineDecoder();
    // a partial buffer right at the limit should not throw
    const justUnder = "x".repeat(MAX_FRAME_BYTES);
    expect(() => dec.push(justUnder)).not.toThrow();
  });

  test("rejects completed frame exceeding MAX_FRAME_BYTES", () => {
    const dec = new LineDecoder();
    const payload = JSON.stringify({ data: "y".repeat(MAX_FRAME_BYTES) });
    expect(() => dec.push(`${payload}\n`)).toThrow(IpcProtocolError);
  });

  test("accepts completed frame at exactly MAX_FRAME_BYTES", () => {
    const dec = new LineDecoder();
    // build a JSON line whose total length equals MAX_FRAME_BYTES
    const overhead = '{"d":""}';
    const filler = "z".repeat(MAX_FRAME_BYTES - overhead.length);
    const line = `{"d":"${filler}"}`;
    expect(line).toHaveLength(MAX_FRAME_BYTES);
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
