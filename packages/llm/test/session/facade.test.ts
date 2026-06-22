import { describe, expect, test } from "bun:test";
import { Message, Processor, Retry, Tool, toModelMessages } from "../../src/session";

describe("session compatibility facade", () => {
  test("re-exports legacy deep import members from their domain modules", () => {
    expect(Message.Info).toBeDefined();
    expect(Tool.Spec).toBeDefined();
    expect(typeof toModelMessages).toBe("function");
    expect(typeof Processor.create).toBe("function");
    expect(typeof Retry.delay).toBe("function");
  });
});
