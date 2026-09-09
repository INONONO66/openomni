import { openRequest, requestPort } from "../helpers/requests";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ActorRegistry, Storage, SessionHandleStore } from "@openomni/ledger";
import { type Gateway, type Inbox, Ingress } from "@openomni/protocol";
import { createGatewayRouter } from "../../src/router";
import { IngressRoutingError } from "../../src/router/routing-error";

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
  ["report_result", "report_result"],
  ["ask_clarification", "ask_clarification"],
  ["invalid", "invalid"],
  [null, "invalid"],
  [0, "invalid"],
  [{ unexpected: true }, "invalid"],
] as const)("raw request reply projects %j as %s", async (action, expectedAction) => {
  // Given a durable request accepting only report_result.
  await openRequest("request-raw-action", {
    sessionId: "request-owner",
    correlation: { channelId: "dm", tokenHash: "token" },
    expectedResponders: ["responder"],
  });
  const commits: Inbox.Commit[] = [];
  const decisions: Ingress.RoutingDecisionPayload[] = [];
  const router = createGatewayRouter({
    requests: requestPort(),
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
          sessionId: "request-owner",
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

  // Then only the allowed action can resolve the request and commit a prompt.
  if (action === "report_result") {
    expect(outcome).toMatchObject({
      status: "executed",
      handle: { target: "request-owner" },
    });
    expect(commits).toHaveLength(0);
    expect(SessionHandleStore.inboxRows("request-owner")).toMatchObject([{ content: "answer" }]);
    expect(SessionHandleStore.requestById("request-raw-action")?.state).toBe("resolved");
  } else {
    expect(decisions[0]).toMatchObject({
      stage: "request_correlation",
      outcome: "block",
      factsUsed: [
        "request:request:request-raw-action",
        `request.action:${expectedAction}`,
        "request.action:disallowed",
      ],
    });
    expect(outcome).toBeInstanceOf(IngressRoutingError);
    if (!(outcome instanceof IngressRoutingError)) throw new Error("expected routing rejection");
    expect(outcome.data.code).toBe("route_blocked");
    expect(commits).toHaveLength(0);
    expect(SessionHandleStore.requestById("request-raw-action")).toMatchObject({
      state: "open",
      replies: [],
    });
  }
});
