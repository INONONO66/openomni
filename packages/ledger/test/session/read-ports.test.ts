import { afterEach, beforeEach, expect, test } from "bun:test";
import type { LedgerAction, PlainValue, SessionTransition } from "@openomni/protocol";
import { SessionHandleStore, Storage } from "../../src/index";

function materialize(id: string) {
  return SessionHandleStore.materialize({
    id,
    parentId: null,
    role: "resident",
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: 0,
    actionId: `${id}:configure`,
    at: 1,
  });
}

beforeEach(() => {
  Storage.initialize({ dbPath: ":memory:" });
  materialize("source");
  materialize("other");
});
afterEach(() => Storage.reset());

function append(
  id: string,
  kind: LedgerAction.Kind,
  intent: PlainValue = null,
  effect: PlainValue = null,
  sessionId = "source",
): LedgerAction.Receipt {
  const receipt = Storage.get().actions?.append(
    {
      id,
      parentId: null,
      sessionId,
      kind,
      intent: { encodingVersion: 1, value: intent },
      effect: { encodingVersion: 1, value: effect },
      irreversible: true,
      ts: 2,
    },
    SessionHandleStore.row(sessionId).revision,
  );
  if (receipt === undefined) throw new Error("read port fixture commit failed");
  return receipt;
}

function answer(messageId: string): SessionTransition.Answer {
  return {
    inputId: "input",
    requestId: "request",
    sessionId: "source",
    receivedAt: 2,
    principal: { kind: "session", principalId: "other", evidenceId: "evidence" },
    bindingDigest: "binding",
    inputHash: "input-hash",
    effectHash: "effect-hash",
    generation: 0,
    toolsHash: "tools-hash",
    domainRevisions: {},
    decision: "reply",
    allowedAction: "report_result",
    content: "answer",
    outbound: {
      messageId,
      sourceSessionId: "other",
      sourceActionId: "terminal",
      destinationSessionId: "source",
      requestId: "request",
      replyTo: "binding",
      terminal: "completed",
      content: "answer",
      digest: "digest",
    },
  };
}

test("actionById returns the exact committed node globally or absence", () => {
  const receipt = append("target", "turn", { phase: "intent" }, { phase: "state" }, "other");
  expect(SessionHandleStore.actionById("target")).toEqual(receipt.action);
  expect(SessionHandleStore.actionById("missing")).toBeUndefined();
});

test("latestGenerationFor folds only ordered configure rows and skips malformed snapshots", () => {
  const snapshot = SessionHandleStore.generationSnapshot({
    generation: 2,
    revertTo: 1,
    tools: [],
    system: { preset: "latest", blocks: [] },
    policyGeneration: 3,
  });
  append("configured", "session.configure", null, { phase: "configured", snapshot });
  append("malformed", "session.configure", null, { phase: "configured", snapshot: null });
  append("not-configure", "turn", null, {
    phase: "configured",
    snapshot: { ...snapshot, generation: 99 },
  });
  append(
    "other-configure",
    "session.configure",
    null,
    { phase: "configured", snapshot: { ...snapshot, generation: 5 } },
    "other",
  );
  expect(SessionHandleStore.latestGenerationFor("source")).toEqual(snapshot);
  expect(() => SessionHandleStore.latestGenerationFor("missing")).toThrow(
    "session has no configured generation",
  );
});

test("policyDecisionRuleIds selects the latest exact session/hash/kind and preserves order", () => {
  append("old", "policy.decision", { inputHash: "hash", matchedRuleIds: ["old"] });
  append("current", "policy.decision", { inputHash: "hash", matchedRuleIds: ["b", "a", "b"] });
  append("other-hash", "policy.decision", { inputHash: "different", matchedRuleIds: ["wrong"] });
  append("other-kind", "message", { inputHash: "hash", matchedRuleIds: ["wrong"] });
  append(
    "other-session",
    "policy.decision",
    { inputHash: "hash", matchedRuleIds: ["wrong"] },
    null,
    "other",
  );
  expect(SessionHandleStore.policyDecisionRuleIds("source", "hash")).toEqual(["b", "a", "b"]);
  expect(SessionHandleStore.policyDecisionRuleIds("source", "missing")).toBeUndefined();
  expect(SessionHandleStore.policyDecisionRuleIds("missing", "hash")).toBeUndefined();
  append("empty", "policy.decision", { inputHash: "hash", matchedRuleIds: [] });
  expect(SessionHandleStore.policyDecisionRuleIds("source", "hash")).toEqual([]);
});

const malformedRuleIds: PlainValue[] = [null, [42], "rule"];
test.each(malformedRuleIds)("policyDecisionRuleIds rejects malformed identities: %j", (ids) => {
  append("valid", "policy.decision", { inputHash: "hash", matchedRuleIds: ["old"] });
  append("invalid", "policy.decision", { inputHash: "hash", matchedRuleIds: ids });
  expect(() => SessionHandleStore.policyDecisionRuleIds("source", "hash")).toThrow(
    "invalid message decision rule identity",
  );
});

test("policyDecisionRuleIds rejects absent identities rather than falling back", () => {
  append("absent", "policy.decision", { inputHash: "hash" });
  expect(() => SessionHandleStore.policyDecisionRuleIds("source", "hash")).toThrow(
    "invalid message decision rule identity",
  );
});

test("messageActionByPlatformId returns the first exact platform-message match", () => {
  append("wrong-kind", "turn", { value: { messageId: "platform" } });
  append("wrong-session", "message", { value: { messageId: "platform" } }, null, "other");
  append("wrong-path", "message", { messageId: "platform" });
  append("wrong-id", "message", { value: { messageId: "different" } });
  const first = append("first", "message", { value: { messageId: "platform" } });
  append("second", "message", { value: { messageId: "platform" } });
  expect(SessionHandleStore.messageActionByPlatformId("source", "platform")).toEqual(first.action);
  expect(SessionHandleStore.messageActionByPlatformId("source", "missing")).toBeUndefined();
  expect(SessionHandleStore.messageActionByPlatformId("missing", "platform")).toBeUndefined();
});

test("outboundReceipt returns prompt by id scoped to destination", () => {
  const receipt = append("prompt-id", "prompt");
  append("not-prompt", "message");
  expect(SessionHandleStore.outboundReceipt("source", "prompt-id")).toEqual(receipt);
  expect(SessionHandleStore.outboundReceipt("other", "prompt-id")).toBeUndefined();
  expect(SessionHandleStore.outboundReceipt("source", "not-prompt")).toBeUndefined();
  expect(SessionHandleStore.outboundReceipt("source", "missing")).toBeUndefined();
});

test("outboundReceipt decodes matching replies and skips invalid answers before a valid receipt", () => {
  append("wrong-session", "reply", null, { answer: answer("outbound") }, "other");
  append("wrong-kind", "turn", null, { answer: answer("outbound") });
  append("wrong-message", "reply", null, { answer: answer("different") });
  append("malformed", "reply", null, { answer: { outbound: { messageId: "outbound" } } });
  expect(SessionHandleStore.outboundReceipt("source", "outbound")).toBeUndefined();
  const receipt = append("valid", "reply", null, { answer: answer("outbound") });
  append("later", "reply", null, { answer: answer("outbound") });
  expect(SessionHandleStore.outboundReceipt("source", "outbound")).toEqual(receipt);
});

test("outboundReceipt preserves ordinal precedence across both SQL arms", () => {
  const reply = append("reply-first", "reply", null, { answer: answer("prompt-later") });
  append("prompt-later", "prompt");
  expect(SessionHandleStore.outboundReceipt("source", "prompt-later")).toEqual(reply);
  const prompt = append("prompt-first", "prompt");
  append("reply-later", "reply", null, { answer: answer("prompt-first") });
  expect(SessionHandleStore.outboundReceipt("source", "prompt-first")).toEqual(prompt);
});
