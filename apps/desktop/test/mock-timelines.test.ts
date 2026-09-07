import { describe, expect, test } from "bun:test";
import { isToolUIPart, safeValidateUIMessages } from "ai";
import type { UIMessage } from "ai";
import { timelines } from "../src/renderer/mock/timelines";

test("mock timelines contain valid SDK messages and tool states", async () => {
  const messages: UIMessage[] = Object.values(timelines).flat();

  expect(messages.length).toBeGreaterThan(0);
  const result = await safeValidateUIMessages({ messages });
  if (!result.success) throw result.error;
  expect(result.data).toHaveLength(messages.length);
});

describe("timeline scenarios", () => {
  test("retain metadata, epoch data, approvals, and structured code payloads", () => {
    const messages = Object.values(timelines).flat();
    expect(messages.some((message) => message.metadata !== undefined)).toBe(true);
    expect(
      messages.some((message) => message.parts.some((part) => part.type === "data-epoch")),
    ).toBe(true);
    expect(
      messages.some((message) =>
        message.parts.some(
          (part) => part.type === "dynamic-tool" && part.state === "approval-requested",
        ),
      ),
    ).toBe(true);
    const codePart = messages
      .flatMap((message) => message.parts)
      .find((part) => "toolCallId" in part && part.toolCallId === "tool7");
    if (
      codePart === undefined ||
      !isToolUIPart(codePart) ||
      codePart.state !== "output-available" ||
      !isRecord(codePart.output) ||
      !isRecord(codePart.output.code) ||
      !Array.isArray(codePart.output.code.lines)
    ) {
      throw new Error("structured edit fixture is not a valid available tool output");
    }
    expect(codePart.output.code).toMatchObject({ language: "rust", startLine: 138 });
    expect(codePart.output.code.lines).toContainEqual({
      mark: "add",
      text: "  let lease = self.lease.acquire().await?;",
    });
  });
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
