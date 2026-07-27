import { afterEach, expect, test } from "bun:test";
import { IngressEngine } from "../../src/ingress/engine";
import { SessionBridge } from "../../src/ingress/session-bridge";
import type {
  MessagingLedgerService,
  MessagingLedgerTransition,
} from "../../src/ingress/session-resolver";

afterEach(() => {
  IngressEngine.clearMessagingLedgerService();
});

test("SessionBridge preserves authenticated transcript order and content", async () => {
  const service: MessagingLedgerService = {
    async execute() {
      throw new Error("unexpected transition");
    },
    async query(request) {
      expect(request).toEqual({ kind: "transcript", sessionId: "session-1" });
      return {
        kind: "transcript",
        messages: [
          { role: "user", parts: [{ type: "text", text: "Hello" }] },
          { role: "assistant", parts: [{ type: "text", text: "Hi there!" }] },
          {
            role: "user",
            parts: [
              { type: "metadata", text: "not transcript content" },
              { type: "text", text: "How are you?" },
            ],
          },
          { role: "assistant", parts: [{ type: "text", text: "I'm good!" }] },
        ],
      };
    },
  };
  IngressEngine.setMessagingLedgerService(service);

  await expect(SessionBridge.buildDirectMessages("session-1")).resolves.toEqual([
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there!" },
    { role: "user", content: "How are you?" },
    { role: "assistant", content: "I'm good!" },
  ]);
});

test("SessionBridge returns an empty authenticated transcript unchanged", async () => {
  const service: MessagingLedgerService = {
    async execute() {
      throw new Error("unexpected transition");
    },
    async query() {
      return { kind: "transcript", messages: [] };
    },
  };
  IngressEngine.setMessagingLedgerService(service);

  await expect(SessionBridge.buildDirectMessages("session-empty")).resolves.toEqual([]);
});

test("SessionBridge gives marker-looking user content no hidden semantics", async () => {
  const service: MessagingLedgerService = {
    async execute() {
      throw new Error("unexpected transition");
    },
    async query() {
      return {
        kind: "transcript",
        messages: [
          {
            role: "user",
            parts: [{ type: "text", text: "__OPENOMNI_PLANID__: ordinary request" }],
          },
        ],
      };
    },
  };
  IngressEngine.setMessagingLedgerService(service);

  await expect(SessionBridge.buildDirectMessages("session-marker")).resolves.toEqual([
    { role: "user", content: "__OPENOMNI_PLANID__: ordinary request" },
  ]);
});

test("SessionBridge commits direct results through the messaging ledger", async () => {
  let captured: MessagingLedgerTransition | undefined;
  const service: MessagingLedgerService = {
    async execute(command) {
      captured = command;
      return { status: "committed" };
    },
    async query() {
      throw new Error("unexpected query");
    },
  };
  IngressEngine.setMessagingLedgerService(service);

  await SessionBridge.storeDirectResult("session-result", "Here is the requested result.", {
    provider: "anthropic",
    id: "claude-3-haiku",
  });

  expect(captured).toEqual({
    kind: "MS-06",
    sessionId: "session-result",
    messageId: expect.any(String),
    partId: expect.any(String),
    role: "assistant",
    text: "Here is the requested result.",
    model: { provider: "anthropic", id: "claude-3-haiku" },
    agent: "session-bridge",
    recordedAt: expect.any(Number),
  });
});
