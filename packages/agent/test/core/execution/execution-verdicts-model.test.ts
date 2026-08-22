import { describe, expect, it, mock } from "bun:test";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import {
  dispatchModelRequest,
  dispatchModelResponse,
} from "../../../src/core/execution/lifecycle-dispatch";
import { PolicyEngine } from "../../../src/core/policy";
import { atPoint, registerAt, deny } from "../../helpers/policy-decision";
import { makeAgentBase, makeConfig, makeState } from "./lifecycle-dispatch-fixture";

type DiagnosticIdentity = {
  readonly traceId?: unknown;
  readonly sessionId?: unknown;
};

describe("model execution deny verdicts", () => {
  it("fail-closes model.request deny before provider execution", async () => {
    Bus.reset();
    const fn = mock(() => deny("test.deny", "provider-blocked"));
    const engine = PolicyEngine.create();
    registerAt(engine, "connection.llm.pre", {
      name: "deny-model-request",
      effects: ["audit.annotate"],
      priority: 100,
      fn,
    });

    const result = await dispatchModelRequest(
      makeState(),
      engine,
      makeConfig(),
      makeAgentBase(),
      "test-model",
    );

    expect(result.blocked).not.toBeNull();
    expect(result.blocked?.guardAborted).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("records a diagnostic and keeps model.response deny fail-open", async () => {
    const diagnostics = observeInfoEvents();
    const engine = responseDenyEngine();

    try {
      const result = await dispatchModelResponse(
        makeState(),
        engine,
        makeConfig(),
        { outcome: { type: "stop" }, responseTokens: 0 },
        makeAgentBase(),
        "test-model",
      );
      await Promise.resolve();

      expect(result).toBeNull();
      expect(findDenyDiagnostic(diagnostics.payloads, "model.response")).toEqual({
        traceId: "trace-1",
        sessionId: "sess-1",
      });
    } finally {
      diagnostics.unsubscribe();
    }
  });
});

function responseDenyEngine(): ReturnType<typeof PolicyEngine.create> {
  const engine = PolicyEngine.create();
  engine.register(
    atPoint("connection.llm.post", {
      name: "deny-model-response",
      effects: ["audit.annotate"],
      priority: 100,
      fn: () => deny("test.deny", "after-provider"),
    }),
  );
  return engine;
}

function observeInfoEvents(): {
  readonly payloads: unknown[];
  readonly unsubscribe: () => void;
} {
  Bus.reset();
  const payloads: unknown[] = [];
  const unsubscribe = Bus.observe((event, payload) => {
    if (event.name === Operational.Events.Info.name) payloads.push(payload);
  });
  return { payloads, unsubscribe };
}

function findDenyDiagnostic(
  diagnostics: readonly unknown[],
  timing: string,
): DiagnosticIdentity | undefined {
  for (const diagnostic of diagnostics) {
    if (typeof diagnostic !== "object" || diagnostic === null) continue;
    if (
      Reflect.get(diagnostic, "component") !== "agent" ||
      Reflect.get(diagnostic, "msg") !== "agent.policy.deny.diagnostic"
    ) {
      continue;
    }
    const context = Reflect.get(diagnostic, "context");
    if (typeof context !== "object" || context === null) continue;
    if (Reflect.get(context, "timing") !== timing) continue;
    return {
      traceId: Reflect.get(diagnostic, "traceId"),
      sessionId: Reflect.get(diagnostic, "sessionId"),
    };
  }
  return undefined;
}
