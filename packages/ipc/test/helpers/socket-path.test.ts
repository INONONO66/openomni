import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { socketPath } from "./socket-path";

describe("socketPath", () => {
  test("creates distinct paths within the macOS Unix socket limit", () => {
    const first = socketPath("🧪".repeat(500));
    const second = socketPath("🧪".repeat(500));

    expect(first).not.toBe(second);
    expect(first.endsWith(".sock")).toBe(true);
    expect(Buffer.byteLength(first)).toBeLessThan(104);
    expect(Buffer.byteLength(second)).toBeLessThan(104);
  });
});
