import { afterEach, beforeEach, expect, test } from "bun:test";
import { Bus } from "@openomni/agent";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import type { SessionTransition } from "@openomni/protocol";
import { compiledPolicy } from "../../../packages/agent/test/helpers/compiled-policy";
import { commitMessageInbox } from "../src/composition/message-session";
import { dispatchOutboundMessage } from "../src/composition/terminal-message";
import { seedKernelPolicyRows } from "../src/policy-seed";

beforeEach(() => {
  Storage.initialize({ dbPath: ":memory:" });
  seedKernelPolicyRows();
  Bus.reset();
});
afterEach(() => {
  Storage.reset();
  Bus.reset();
});

function materialize(id: string) {
  SessionHandleStore.materialize({
    id,
    parentId: null,
    role: "resident",
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: SessionHandleStore.currentPolicyGeneration(),
    actionId: `${id}:config`,
    at: 100,
  });
}

const message: SessionTransition.OutboundMessage = {
  messageId: "letter",
  sourceSessionId: "child",
  sourceActionId: "terminal",
  destinationSessionId: "parent",
  requestId: "request",
  replyTo: "request",
  terminal: "completed",
  content: "CHILD_RESULT",
  digest: "digest",
};

test("the receiving consumer may only commit the exact outbound letter", async () => {
  materialize("child");
  materialize("parent");
  const dispatch = dispatchOutboundMessage(
    async () => {
      commitMessageInbox({
        id: "different-letter",
        sessionId: message.destinationSessionId,
        kind: "prompt",
        content: message.content,
        origin: { encodingVersion: 1, value: message },
        createdAt: 100,
        parentActionId: null,
      });
      return {
        status: "executed",
        handle: { messageId: "different-letter", target: "parent" },
        delivery: { kind: "session" },
      };
    },
    () => 100,
  );
  await expect(
    dispatch({ message, authority: { owner: "runner", fence: 1 }, policy: compiledPolicy() }),
  ).rejects.toThrow("outbound inbox binding mismatch");
  expect(SessionHandleStore.inboxRows("parent")).toEqual([]);
});
