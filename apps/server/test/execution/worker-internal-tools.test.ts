import { describe, expect, it } from "bun:test";

import type { Tool } from "@openomni/protocol";
import { WorkerInternalTools } from "../../src/execution/worker-internal-tools";

function createCall(id: string, tool: string, input: Tool.Call["input"] = {}): Tool.Call {
  return { id, tool, input };
}

function getTool(
  tools: ReturnType<typeof WorkerInternalTools.create>,
  name: string,
): ReturnType<typeof WorkerInternalTools.create>[number] {
  const tool = tools.find((candidate) => candidate.spec.name === name);
  if (!tool) {
    throw new Error(`Expected worker internal tool ${name}`);
  }
  return tool;
}

describe("worker internal tools", () => {
  it("does not expose ask_main after migration to inbound_message", () => {
    const tools = WorkerInternalTools.create({
      readInbox: () => [],
    });

    expect(tools.map((tool) => tool.spec.name)).toEqual(["check_inbox"]);
  });

  it("check_inbox drains queued messages for the active run", async () => {
    const inbox = ["hello", "world"];
    const tools = WorkerInternalTools.create({
      readInbox: () => inbox.splice(0),
    });

    const result = await getTool(tools, "check_inbox").execute(createCall("call-4", "check_inbox"));

    expect(result).toMatchObject({
      toolCallId: "call-4",
      output: JSON.stringify({ messages: ["hello", "world"], count: 2 }),
    });
    expect(inbox).toEqual([]);
  });
});
