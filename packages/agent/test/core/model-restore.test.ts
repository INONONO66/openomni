import { describe, expect, it } from "bun:test";
import type { Sink } from "@openomni/llm";
import type { LedgerAction, Model, PlainObject, PolicyRow } from "@openomni/protocol";
import { runAgent } from "../../src/core/execution/run";
import { createAssistantMessage } from "../../src/core/message-factory";
import { createExecutor } from "../../src/executor";
import { compiledPolicy, opPhaseOf, recordingLedger } from "../helpers/compiled-policy";
import { createStopOutcome, type MockLlmFn } from "../helpers/mock-llm";
import { modelFixture } from "../helpers/model-fixture";
import { runInput } from "../helpers/run-input";

const primary = { provider: "anthropic", id: "primary-model" };
const fallback = { provider: "openai", id: "fallback-model" };

const refuseRestore: PolicyRow.Row[] = [
  {
    name: "keep-fallback",
    kind: "llm",
    phase: "pre",
    match: { encodingVersion: 1, value: { op: "restore_model_selection" } },
    verdict: { encodingVersion: 1, value: { type: "deny", reason: "fallback_pinned" } },
    priority: 500,
    generation: 1,
  },
];

function intentOf(action: LedgerAction.Append): PlainObject {
  const value = action.intent.value;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected object intent");
  return value;
}

async function turn(options: {
  pinnedModel?: Model.Ref;
  modelFallbacks?: Model.Ref[];
  rows?: PolicyRow.Row[];
}) {
  const recording = recordingLedger();
  const resolved: Model.Ref[] = [];
  const run: MockLlmFn = async (_input, sink: Sink) => {
    sink.onMessage(createAssistantMessage("done", "", "session"));
    return createStopOutcome();
  };
  const executor = createExecutor({
    policy: compiledPolicy(options.rows),
    ledger: recording.ledger,
    observations: { publish: () => undefined },
    clock: () => 1,
    entropy: recording.entropy,
    identity: {
      sessionId: "session",
      role: "resident",
      parentActionId: "turn-2",
      turnId: "turn-2",
    },
  });
  const result = await runAgent(runInput([{ role: "user", content: "go" }]), {
    executor,
    execution: executor,
    events: { publish: () => undefined },
    model: primary,
    ...(options.modelFallbacks === undefined ? {} : { modelFallbacks: options.modelFallbacks }),
    ...(options.pinnedModel === undefined ? {} : { pinnedModel: options.pinnedModel }),
    llm: {
      run: modelFixture(run),
      resolveModel: async (model: Model.Ref) => {
        resolved.push(model);
        return { id: model.id, name: model.id, providerID: model.provider };
      },
    },
  });
  const llm = recording.committed.filter((action) => action.kind === "llm");
  const decisions = recording.committed
    .filter((action) => action.kind === "policy.decision")
    .map(intentOf);
  return { result, resolved, llm, decisions, intents: llm.map(opPhaseOf) };
}

describe("restore_model_selection at the turn boundary", () => {
  it("records an executed restoration before chatting on the primary again", async () => {
    const { resolved, llm, intents } = await turn({
      pinnedModel: fallback,
      modelFallbacks: [fallback],
    });
    expect(intents).toEqual([
      "restore_model_selection:intent",
      "restore_model_selection:result",
      "chat:intent",
      "chat:result",
    ]);
    expect(intentOf(llm[0] as LedgerAction.Append)).toMatchObject({
      value: { from: fallback, to: primary },
      effect: { model: primary },
      recovery: "local_transactional",
    });
    expect(llm[1]?.effect.value).toMatchObject({ terminal: "executed" });
    expect(resolved).toEqual([primary]);
  });

  it("keeps the fallback pinned when the policy refuses the restoration", async () => {
    const { resolved, decisions, intents } = await turn({
      pinnedModel: fallback,
      modelFallbacks: [fallback],
      rows: refuseRestore,
    });
    // A refused restoration never admits an intent; the policy decision is its record.
    expect(intents).toEqual(["chat:intent", "chat:result"]);
    expect(decisions[0]).toMatchObject({
      hook: "llm.pre",
      op: "restore_model_selection",
      verdict: "deny",
      matchedRuleIds: ["keep-fallback"],
    });
    expect(resolved).toEqual([fallback]);
  });

  it("records nothing when the earlier turn was already on the primary or off the chain", async () => {
    const onPrimary = await turn({ pinnedModel: primary, modelFallbacks: [fallback] });
    expect(onPrimary.intents).toEqual(["chat:intent", "chat:result"]);
    const unconfigured = await turn({ pinnedModel: fallback });
    expect(unconfigured.intents).toEqual(["chat:intent", "chat:result"]);
    expect(unconfigured.resolved).toEqual([primary]);
  });
});
