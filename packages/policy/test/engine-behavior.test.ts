import { describe, expect, it, mock } from "bun:test";
import { Operational, Policy, PolicyDecision } from "@openomni/protocol";
import { createPolicyEngine } from "../src/engine/dispatch";

const PolicyEngine = { create: createPolicyEngine };
import {
  allow,
  atPoint,
  registerAt,
  runContext,
  toolPreContext,
  turnPostContext,
  turnPreContext,
} from "./point-test-fixtures";

async function withinTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("expected observer signal")), 1_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function systemToolDescriptor(name: string): Policy.Resource.Descriptor {
  return {
    id: `tool:${name}`,
    kind: "tool",
    labels: ["source:system"],
    capabilities: ["tool.execute"],
    effects: ["external.read"],
    source: { type: "system" },
  };
}

function auditedObserver(onDecision: (decision: Policy.PolicyDecision) => void | Promise<void>) {
  const events: Array<{ name: string; data: unknown }> = [];
  const engine = PolicyEngine.create({
    clock: Date.now,
    traceContext: { traceId: "trace-observer", sessionId: "session-observer" },
    onDecision,
    auditEmit: (event, data) => events.push({ name: event.name, data }),
  });
  registerAt(engine, "run.turn.post", {
    name: "observer",
    priority: 0,
    fn: () => allow("observer"),
  });
  return { engine, events };
}

describe("PolicyEngine behavior", () => {
  it("dispatches one registration at every declared point", async () => {
    const fn = mock(() => allow("multi"));
    const engine = PolicyEngine.create({ clock: Date.now });
    engine.add({
      kind: "point",
      name: "multi",
      pointIds: ["run.turn.pre", "run.turn.post"],
      effectCapabilities: { "run.turn.pre": [], "run.turn.post": [] },
      priority: 0,
      fn,
    });

    await engine.dispatchPoint("run.turn.pre", turnPreContext());
    await engine.dispatchPoint("run.turn.post", turnPostContext());
    await engine.dispatchPoint("run.error.error", {
      ...runContext(),
      errorCode: "boom",
      errorPhase: "turn",
    });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("merges and preserves prompt effects in policy order", async () => {
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(engine, "prompt.context.pre", {
      name: "prompt-a",
      priority: 100,
      effects: ["prompt.replace", "prompt.append_context"],
      fn: () =>
        PolicyDecision.allow({
          policyId: "prompt-a",
          effects: [
            { type: "prompt.replace", prompt: "PROMPT_A" },
            { type: "prompt.append_context", context: "append-a" },
          ],
        }),
    });
    registerAt(engine, "prompt.context.pre", {
      name: "prompt-b",
      priority: 200,
      effects: ["prompt.append_context", "prompt.inject_message"],
      fn: () =>
        PolicyDecision.allow({
          policyId: "prompt-b",
          effects: [
            { type: "prompt.append_context", context: "append-b" },
            { type: "prompt.inject_message", message: "message-b" },
          ],
        }),
    });

    const result = await engine.dispatchPoint("prompt.context.pre", turnPreContext());

    expect(result.verdict).toBe("allow");
    expect(result.effects).toEqual([
      { type: "prompt.replace", prompt: "PROMPT_A" },
      { type: "prompt.append_context", context: "append-a" },
      { type: "prompt.append_context", context: "append-b" },
      { type: "prompt.inject_message", message: "message-b" },
    ]);
  });

  it("allows deny decisions without reason codes", async () => {
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(engine, "run.turn.pre", {
      name: "missing-reason",
      priority: 0,
      fn: () => PolicyDecision.deny({ policyId: "missing-reason" }),
    });

    const decision = await engine.dispatchPoint("run.turn.pre", turnPreContext());

    expect(decision.verdict).toBe("deny");
    expect(decision.reasonCodes).toEqual([]);
  });

  it("isolates synchronous onDecision errors and emits their audit warning", async () => {
    const { engine, events } = auditedObserver(() => {
      throw new Error("observer failed");
    });

    const decision = await engine.dispatchPoint("run.turn.post", turnPostContext());

    expect(decision.verdict).toBe("allow");
    expect(events.find(({ name }) => name === Operational.Events.Warn.name)?.data).toMatchObject({
      component: "agent.policy",
      msg: "onDecision observer error",
      context: { timing: "turn.finish", policyId: "observer", error: "Error: observer failed" },
    });
  });

  it("isolates asynchronous onDecision rejections", async () => {
    let resolveWarning!: (data: unknown) => void;
    const warning = new Promise<unknown>((resolve) => {
      resolveWarning = resolve;
    });
    const engine = PolicyEngine.create({
      clock: Date.now,
      traceContext: { traceId: "trace-async", sessionId: "session-async" },
      onDecision: async () => {
        throw new Error("async observer failed");
      },
      auditEmit: (event, data) => {
        if (event.name === Operational.Events.Warn.name) resolveWarning(data);
      },
    });
    registerAt(engine, "run.turn.post", {
      name: "async-observer",
      priority: 0,
      fn: () => allow("async-observer"),
    });

    const decision = await engine.dispatchPoint("run.turn.post", turnPostContext());
    const emitted = await withinTimeout(warning);

    expect(decision.verdict).toBe("allow");
    expect(emitted).toMatchObject({
      msg: "onDecision observer error",
      context: { policyId: "async-observer", error: "Error: async observer failed" },
    });
  });

  it("does not wait for asynchronous onDecision observers", async () => {
    let observerStarted = false;
    let release!: () => void;
    const { engine } = auditedObserver(async () => {
      observerStarted = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const decision = await engine.dispatchPoint("run.turn.post", turnPostContext());

    expect(decision.verdict).toBe("allow");
    expect(observerStarted).toBe(true);
    release();
  });

  it("does not add run.abort to a post-boundary denial", async () => {
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(engine, "run.lifecycle.post", {
      name: "deny-finish",
      priority: 0,
      effects: ["audit.annotate"],
      fn: () =>
        PolicyDecision.deny({
          policyId: "deny-finish",
          reasonCodes: ["blocked"],
          effects: [{ type: "audit.annotate", annotation: "blocked", severity: "error" }],
        }),
    });

    const decision = await engine.dispatchPoint("run.lifecycle.post", {
      ...runContext(),
      runOutcome: { type: "stop" },
    });

    expect(decision.verdict).toBe("deny");
    expect(decision.effects.some((effect) => effect.type === "run.abort")).toBe(false);
  });

  it("passes the exact resource descriptor snapshot to middleware", async () => {
    const descriptor = systemToolDescriptor("shell");
    let received: unknown;
    const engine = PolicyEngine.create({ clock: Date.now });
    registerAt(engine, "tool.native.pre", {
      name: "resource-observer",
      priority: 0,
      fn: (ctx) => {
        received = ctx.resourceDescriptor;
        return allow("resource-observer");
      },
    });

    const decision = await engine.dispatchPoint("tool.native.pre", {
      ...toolPreContext(),
      resourceDescriptor: descriptor,
    });

    expect(received).toEqual(descriptor);
    expect(decision).toMatchObject({
      policyId: "agent.policy.composed",
      verdict: "allow",
      effects: [],
      reasonCodes: [],
    });
    expect(typeof decision.durationMs).toBe("number");
  });

  it("continues after an allow without middleware policy metadata", async () => {
    const after = mock(() => allow("after"));
    const engine = PolicyEngine.create({ clock: Date.now });
    engine.add(
      atPoint("tool.native.pre", {
        name: "missing-policy-id",
        priority: 0,
        fn: () => allow(),
      }),
    );
    registerAt(engine, "tool.native.pre", { name: "after", priority: 1, fn: after });

    const decision = await engine.dispatchPoint("tool.native.pre", toolPreContext());

    expect(decision.verdict).toBe("allow");
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("stops after deny while emitting evaluated and composed audit records", async () => {
    const events: string[] = [];
    const after = mock(() => allow("after"));
    const engine = PolicyEngine.create({
      clock: Date.now,
      traceContext: { traceId: "trace-deny", sessionId: "session-deny" },
      auditEmit: (event) => events.push(event.name),
    });
    registerAt(engine, "tool.native.pre", {
      name: "deny-first",
      priority: 0,
      effects: ["audit.annotate"],
      fn: () =>
        PolicyDecision.deny({
          policyId: "deny-first",
          reasonCodes: ["blocked"],
          effects: [{ type: "audit.annotate", annotation: "blocked", severity: "error" }],
        }),
    });
    registerAt(engine, "tool.native.pre", { name: "after", priority: 1, fn: after });

    const decision = await engine.dispatchPoint("tool.native.pre", toolPreContext());

    expect(decision.verdict).toBe("deny");
    expect(after).toHaveBeenCalledTimes(0);
    expect(events.filter((name) => name === Policy.Events.Evaluated.name)).toHaveLength(1);
    expect(events.filter((name) => name === Policy.Events.DecisionComposed.name)).toHaveLength(1);
  });
});
