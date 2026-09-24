import { afterEach, expect, test } from "bun:test";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { runAgentSync } from "./helpers/executor";
import { LedgerAction, type PlainObject } from "@openomni/protocol";
import { pinnedModelSelection } from "../src/model-selection";

afterEach(() => Storage.reset());

function selection(actions: readonly LedgerAction.Node[], turnId: string) {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  runAgentSync(SessionHandleStore.materialize({ id: "session", parentId: null, role: "resident", tools: [], system: { preset: "", blocks: [] }, policyGeneration: 1, actionId: "initial", at: 1 }));
  const adapter = Storage.get().actions;
  if (adapter === undefined) throw new Error("missing action adapter");
  for (const { ordinal, prevHash, actionHash, ...action } of actions) {
    void ordinal; void prevHash; void actionHash;
    if (action.parentId !== null && SessionHandleStore.actionById(action.parentId) === undefined) {
      expect(adapter.append({ id: action.parentId, sessionId: "session", parentId: null, kind: "turn", intent: { encodingVersion: 1, value: {} }, effect: { encodingVersion: 1, value: {} }, ts: 1, irreversible: true }, SessionHandleStore.row("session").revision)).toBeDefined();
    }
    expect(adapter.append(action, SessionHandleStore.row("session").revision)).toBeDefined();
  }
  return pinnedModelSelection("session", turnId);
}

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
    prevHash: "fixture-prev",
    actionHash: "fixture-hash",
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
  expect(selection(actions, "turn-2")).toEqual({ provider: "openai", id: "fallback" });
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
  expect(selection(actions, "turn-2")).toEqual({ provider: "openai", id: "fallback" });
  expect(selection(actions.slice(2), "turn-2")).toBeUndefined();
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
  expect(selection(actions, "turn-2")).toBeUndefined();
  expect(selection([], "turn-2")).toBeUndefined();
});
