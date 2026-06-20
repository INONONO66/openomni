import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PolicyRegistration } from "@openomni/agent";
import { PolicyDecision, type Ingress } from "@openomni/protocol";
import { Bus, ChannelGrantStore, Storage } from "@openomni/session";
import { IngressEngine } from "../../../src/ingress/engine";

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };

function inboundDenyAll(reason: string): PolicyRegistration {
  return {
    name: "conformance:deny-all:inbound.receive",
    timing: "inbound.receive",
    priority: 0,
    failPolicy: "fail-closed",
    fn: () =>
      PolicyDecision.deny({
        policyId: "conformance.inbound.receive.deny-all",
        reasonCodes: [reason],
        effects: [{ type: "run.abort", reason }],
      }),
  };
}

function inboundEvent(): Ingress.InboundEvent {
  return {
    id: "event-no-bypass",
    surface: "tui",
    workspace: "/repo",
    mode: "direct",
    payload: "hello",
    meta: { actor: { role: "user" } },
    agent: { model },
  };
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

beforeEach(() => {
  Bus.reset();
  IngressEngine.reset();
  Storage.initialize({ dbPath: ":memory:" });
  ChannelGrantStore.put({
    id: "grant-tui",
    surface: "tui",
    kind: "trusted_channel",
    createdBy: "act_owner",
  });
});

afterEach(() => {
  Bus.reset();
  Storage.reset();
  IngressEngine.reset();
});

describe("policy no-bypass conformance — openomni governed paths", () => {
  it("blocks ingress receive before dispatching to the coordinator", async () => {
    let dispatchCalled = false;
    IngressEngine.setCoordinator({
      async dispatch(_sessionId, request) {
        dispatchCalled = true;
        return {
          runId: request.runId,
          sessionId: request.sessionId,
          status: "succeeded" as const,
          output: "should not dispatch",
          finishReason: "stop" as const,
        };
      },
    });
    IngressEngine.registerIngressPolicy(
      inboundDenyAll("ingress receive denied by conformance policy"),
    );

    const error = await catchError(IngressEngine.ingest(inboundEvent()));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("ingress receive denied by conformance policy");
    expect(dispatchCalled).toBe(false);
  });
});
