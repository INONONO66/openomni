import { afterEach, beforeEach, expect, test } from "bun:test";
import { ActorRegistry, Storage, WaitStore } from "@openomni/ledger";
import { type Gateway, type Inbox, Ingress } from "@openomni/protocol";
import { createGatewayRouter } from "../../src/router";
import { IngressRoutingError } from "../../src/router/routing-resolution";
import { WaitService } from "../../src/router/wait";

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  ActorRegistry.registerIdentity({
    id: "responder",
    kind: "human",
    trustTier: "assigned_worker",
  });
  ActorRegistry.registerEndpoint({
    id: "telegram:seller",
    actorId: "responder",
    channel: "telegram",
    externalId: "seller",
  });
});
afterEach(() => Storage.reset());

test.each([
  "report_result",
  "ask_clarification",
  "invalid",
] as const)("raw Wait reply preserves the requested %s action", async (action) => {
  // Given a durable Wait accepting only report_result.
  WaitService.open(
    {
      id: "wait-raw-action",
      ownerRef: { kind: "session", id: "wait-owner" },
      originMessageId: "outbound",
      correlation: { channelId: "dm", tokenHash: "token" },
      allowedActions: ["report_result"],
      expectedResponders: ["responder"],
      resolutionPolicy: "first_reply",
      expiresAt: Number.MAX_SAFE_INTEGER,
      followUpWindow: 0,
    },
    "trace-test",
  );
  const commits: Inbox.Commit[] = [];
  const decisions: Ingress.RoutingDecisionPayload[] = [];
  const router = createGatewayRouter({
    sink: (event, data) => {
      if (event.name === Ingress.Events.RoutingDecision.name) {
        decisions.push(Ingress.Events.RoutingDecision.schema.parse(data));
      }
    },
    inbox: {
      commit: (row) => {
        commits.push(row);
        return { ...row, status: "pending", consumedBy: null, consumedAt: null, ordinal: 1 };
      },
    },
    prepare: (_sender, _message, target) => ({
      target,
      message: {
        sender: "external",
        addressee: "bot",
        identity: true,
        grantTier: true,
        egressBudget: true,
        eventIdUnique: true,
        replyCorrelation: true,
      },
    }),
    run: async (_sender, request, body) => ({
      terminal: "executed",
      matchedRuleIds: [],
      value: await body({
        action: {
          id: "source",
          sessionId: "wait-owner",
          parentId: null,
          kind: "message",
          intent: { encodingVersion: 1, value: { value: request.intent } },
          effect: { encodingVersion: 1, value: {} },
          irreversible: true,
          ordinal: 1,
          ts: 1,
        },
        revision: 1,
      }),
    }),
  });
  const facts: Gateway.IngressFacts = {
    eventId: "reply",
    surface: "telegram",
    channelId: "dm",
    addressees: [],
    dm: true,
    reply: { chain: [], tokenHash: "token" },
    payload: { action, output: "answer" },
    render: "answer",
  };

  // When a driver submits raw facts through the current public seam.
  let outcome: Gateway.IngestResult | IngressRoutingError | undefined;
  try {
    outcome = await router.ingest(
      { kind: "external", surface: "telegram", externalId: "seller" },
      facts,
    );
  } catch (error) {
    if (!(error instanceof IngressRoutingError)) throw error;
    outcome = error;
  }

  // Then only the allowed action can resolve the Wait and commit a prompt.
  if (action === "report_result") {
    expect(outcome).toMatchObject({
      status: "executed",
      handle: { target: "wait-owner" },
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.content).toBe("answer");
    expect(WaitStore.get("wait-raw-action")?.status).toBe("resolved");
  } else {
    expect(decisions[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "block",
      factsUsed: ["wait:wait:wait-raw-action", `wait.action:${action}`, "wait.action:disallowed"],
    });
    expect(outcome).toBeInstanceOf(IngressRoutingError);
    if (!(outcome instanceof IngressRoutingError)) throw new Error("expected routing rejection");
    expect(outcome.code).toBe("route_blocked");
    expect(commits).toHaveLength(0);
    expect(WaitStore.get("wait-raw-action")).toMatchObject({ status: "open", replies: [] });
  }
});
