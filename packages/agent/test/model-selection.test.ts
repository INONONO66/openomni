import { expect, test } from "bun:test";
import { LedgerAction, type PlainObject } from "@openomni/protocol";
import { pinnedModelSelection } from "../src/model-selection";

function action(
  id: string,
  kind: LedgerAction.Kind,
  parentId: string | null,
  intent: PlainObject,
): LedgerAction.Node {
  return LedgerAction.Node.parse({
    id,
    parentId,
    sessionId: "session",
    kind,
    ts: 1,
    ordinal: 1,
    intent: { encodingVersion: 1, value: intent },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
    irreversible: true,
  });
}

const llm = (id: string, parentId: string) =>
  action(id, "llm", parentId, { phase: "intent", op: "chat", value: {} });
const attempt = (id: string, parentId: string, provider: string, model: string) =>
  action(id, "attempt", parentId, {
    phase: "intent",
    op: "chat",
    value: { attempt: 1, provider, model },
  });

test("the last provider attempt of an earlier turn pins the selection", () => {
  const actions = [
    llm("llm-1", "turn-1"),
    attempt("a", "llm-1", "anthropic", "primary"),
    attempt("b", "llm-1", "openai", "fallback"),
    action("r", "attempt", "b", { phase: "result", op: "chat", value: { model: "x" } }),
  ];
  expect(pinnedModelSelection(actions, "turn-2")).toEqual({ provider: "openai", id: "fallback" });
});

test("this turn's own attempts, including those under its resume actions, are not a pin", () => {
  const actions = [
    llm("llm-1", "turn-1"),
    attempt("a", "llm-1", "openai", "fallback"),
    action("resume", "turn", "turn-2", { phase: "resume", turnId: "turn-2", resultId: "x" }),
    llm("llm-2", "turn-2"),
    attempt("b", "llm-2", "anthropic", "primary"),
    llm("llm-3", "resume"),
    attempt("c", "llm-3", "anthropic", "primary"),
  ];
  expect(pinnedModelSelection(actions, "turn-2")).toEqual({ provider: "openai", id: "fallback" });
  expect(pinnedModelSelection(actions.slice(2), "turn-2")).toBeUndefined();
});

test("non-chat attempts and malformed intents never pin", () => {
  const actions = [
    llm("llm-1", "turn-1"),
    action("other", "attempt", "llm-1", {
      phase: "intent",
      op: "summarize",
      value: { provider: "openai", model: "fallback" },
    }),
    action("odd", "attempt", "llm-1", { phase: "intent", op: "chat", value: { provider: 1 } }),
  ];
  expect(pinnedModelSelection(actions, "turn-2")).toBeUndefined();
  expect(pinnedModelSelection([], "turn-2")).toBeUndefined();
});
