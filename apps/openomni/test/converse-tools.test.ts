import { describe, expect, it } from "bun:test";
import type { Conversation } from "@openomni/protocol";
import type { ConversePort, LeasePort } from "../src/tools/mutation/converse";
import { dispatchModelTool } from "./helpers/tool-dispatch";

const RESIDENT = { role: "resident", depth: 0, sessionId: "session-origin" } as const;
function recordingPort(): ConversePort & { opened: Conversation.Create[]; closed: string[] } {
  const opened: Conversation.Create[] = [];
  const closed: string[] = [];
  return {
    opened,
    closed,
    open: (input) => {
      opened.push(input);
      return { ...input, revision: 0, status: "open", outboundSpent: 0, inboundCount: 0 } as never;
    },
    get: () => undefined,
    close: (id) => {
      closed.push(id);
      return { kind: "closed", record: { id } } as never;
    },
    closeLeases: () => 0,
  };
}
const leases = {} as LeasePort;

describe("converse tool", () => {
  it("opens and closes through op-dispatched input", async () => {
    const conversations = recordingPort();
    const run = dispatchModelTool("converse", { conversations, leases }, RESIDENT, () => 1_000);
    expect(
      (
        await run({
          op: "open",
          args: { contactId: "alice", endpointId: "ws:alice", timeoutMs: 5_000 },
        })
      ).isError,
    ).toBeUndefined();
    expect(conversations.opened[0]).toMatchObject({
      contactId: "alice",
      policy: { expiresAt: 6_000 },
    });
    expect(
      (await run({ op: "close", args: { conversationId: "conv:1" } })).isError,
    ).toBeUndefined();
    expect(conversations.closed).toEqual(["conv:1"]);
  });
  it("rejects missing operation fields before touching ports", async () => {
    const conversations = recordingPort();
    const result = await dispatchModelTool(
      "converse",
      { conversations, leases },
      RESIDENT,
    )({ op: "open", args: { contactId: "alice" } });
    expect(result).toMatchObject({ isError: true, errorClass: "invalid_input" });
    expect(conversations.opened).toHaveLength(0);
  });
});
