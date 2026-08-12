import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Ingress } from "@openomni/protocol";
import { Bus, ChannelGrantStore, Storage } from "@openomni/session";
import { createIngressEngine } from "../../../src/ingress/engine";

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };

// An admitted event whose actor is not authorized to create top-level inbound
// work. The channel grant is a trusted_channel with no defaultTier, so routing
// does not materialize a trust tier for the actor — it reaches the authority
// check as an un-elevated principal.
function unauthorizedInboundEvent(): Ingress.InboundEvent {
  return {
    id: "event-no-bypass",
    surface: "internal",
    workspace: "/repo",
    mode: "direct",
    payload: "spawn top-level work",
    meta: { actor: { role: "sub_persona", trusted: false } },
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
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  ChannelGrantStore.put({
    id: "grant-internal",
    surface: "internal",
    kind: "trusted_channel",
    createdBy: "act_owner",
  });
});

afterEach(() => {
  Bus.reset();
  Storage.reset();
});

describe("policy no-bypass conformance — openomni governed paths", () => {
  it("blocks unauthorized ingress before dispatching to the coordinator", async () => {
    let dispatchCalled = false;
    const engine = createIngressEngine({
      coordinator: {
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
      },
    });

    const error = await catchError(engine.ingest(unauthorizedInboundEvent()));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "actor is not authorized to create top-level inbound work",
    );
    expect(dispatchCalled).toBe(false);
  });
});
