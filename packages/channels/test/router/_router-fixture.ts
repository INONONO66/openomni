import { Channel, Ingress, Gateway, type Inbox } from "@openomni/protocol";
import { compilePolicySnapshot } from "@openomni/policy";
import { ActorRegistry, ChannelGrantStore, Storage, SurfaceKey } from "@openomni/ledger";
import { Bus } from "../helpers/observation";
import { createGatewayRouter, type GatewayRouter, type GatewayRouterPorts } from "../../src/router/index.js";

export const ownerSender = { kind: "external", surface: "discord", externalId: "owner-external-id" } as const;
export const ownerFacts: Gateway.IngressFacts = {
  eventId: "inbound-owner-dm", surface: "discord", workspaceId: "owner-workspace",
  channelId: "owner-dm", addressees: [], dm: true, payload: "hello resident", render: "hello resident",
};

// The internal route record identity is scoped by the perimeter, not supplied by the driver.
export const ownerEvent = {
  id: "discord:owner-workspace:owner-dm:inbound-owner-dm", traceId: "trace-test",
  surface: "discord", workspace: "owner-workspace", channel: "owner-dm",
  userId: "owner-external-id", mode: "direct", payload: "hello resident",
  meta: { actor: { role: "user" } },
} satisfies Gateway.DeliveredEvent;

export function makeInboundEvent(overrides?: Partial<Gateway.DeliveredEvent>): Gateway.DeliveredEvent {
  return { id: "evt-1", traceId: "trace-test", surface: "test", mode: "direct", ...overrides };
}

export const commits: Inbox.Commit[] = [];
const decisions: Ingress.RoutingDecisionPayload[] = [];
let router: GatewayRouter | undefined;

export function resetStores(): void {
  Storage.reset();
  Bus.reset();
  Storage.initialize({ dbPath: ":memory:", observationSink: Bus });
}

export function resetRouterState(): void {
  resetStores();
  commits.length = 0;
  decisions.length = 0;
  router = makeRouter();
}

export function kernelRouter(): GatewayRouter {
  if (!router) throw new Error("resetRouterState() must run before kernelRouter()");
  return router;
}

// L1/executor recording ports. Routing, identity, Wait, grants and delivery remain real.
// The real compiler evaluates perimeter A rows and actor grants; app tests cover the full executor/tree.
export function makeRouter(overrides: Partial<GatewayRouterPorts> = {}): GatewayRouter {
  const policy = compilePolicySnapshot({ generation: 1, rows: [
    { generation: 1, name: "message.resident.actor_grant", kind: "message", phase: "pre", priority: 1000,
      match: { encodingVersion: 1, value: { message: Gateway.RuleTableB.parse({
        id: "message.resident.actor_grant", table: "B", sender: "session", senderRole: "resident",
        targetKind: "actor", check: { kind: "actor_send" }, effect: "deny",
      }) } }, verdict: { encodingVersion: 1, value: { type: "deny", reason: "message.resident.actor_grant" } } }, 
    { generation: 1, name: "compaction", kind: "turn", phase: "post", priority: 1000,
      match: { encodingVersion: 1, value: { op: "compaction" } }, verdict: { encodingVersion: 1, value: { type: "allow" } } },
    ...Gateway.RuleTableA.shape.check.options.map((check) => ({
      generation: 1, name: `message.external.${check}`, kind: "message", phase: "pre" as const, priority: 1000,
      match: { encodingVersion: 1 as const, value: { message: Gateway.RuleTableA.parse({
        id: `message.external.${check}`, table: "A", sender: "external", check, effect: "deny",
      }) } }, verdict: { encodingVersion: 1 as const, value: { type: "deny", reason: `message.external.${check}` } },
    })),
  ] });
  router = createGatewayRouter({
    sink: (event, data) => {
      if (event.name === Ingress.Events.RoutingDecision.name) {
        decisions.push(Ingress.Events.RoutingDecision.schema.parse(data));
      }
      Bus.publish(event, data);
    },
    inbox: { commit: (row) => {
      commits.push(row);
      return { ...row, status: "pending", consumedBy: null, consumedAt: null, ordinal: commits.length };
    } },
    prepare: (sender, send, target) => ({
      target,
      message: sender.kind === "external" ? {
        sender: "external", addressee: "bot", identity: true, grantTier: true,
        egressBudget: true, eventIdUnique: true, replyCorrelation: true,
      } : {
        sender: "session", senderRole: "resident", targetKind: send.to.kind, type: send.type,
        parentChild: true, fanout: 0, depth: 1, withinParentDeadline: true,
      },
    }),
    run: async (sender, request, body) => {
      const decision = policy.evaluate({ kind: "message", phase: "pre", op: request.op, value: request.intent, message: request.message });
      if (decision.verdict === "deny") return { terminal: "blocked_pre", matchedRuleIds: decision.matchedRuleIds, reason: decision.reason ?? "denied" };
      return { terminal: "executed", matchedRuleIds: decision.matchedRuleIds,
        value: await body({ action: {
          id: crypto.randomUUID(), sessionId: sender.kind === "session" ? sender.id : "ingress",
          parentId: null, kind: "message", intent: { encodingVersion: 1, value: { value: request.intent } },
          effect: { encodingVersion: 1, value: {} }, irreversible: true, ordinal: 1, ts: 1,
        }, revision: 1 }),
      };
    },
    ...overrides,
  });
  return router;
}

export function registerOwnerDm(): void {
  ActorRegistry.registerIdentity({ id: "actor-owner", kind: "human", trustTier: "owner" });
  ActorRegistry.registerEndpoint({
    id: "endpoint-owner-dm", actorId: "actor-owner", channel: ownerSender.surface,
    externalId: ownerSender.externalId, workspace: ownerFacts.workspaceId,
  });
  ChannelGrantStore.put({
    id: "grant-owner-dm", surface: ownerFacts.surface, workspace: ownerFacts.workspaceId,
    channel: ownerFacts.channelId, kind: "trusted_channel", createdBy: "actor-owner",
  });
}

export function createMappedOwnerSession(): { readonly id: string } {
  const id = crypto.randomUUID();
  SurfaceKey.claim(Channel.SurfaceKey.fromChannel({
    surface: ownerFacts.surface, namespace: "owner-workspace", kind: "dm", id: ownerFacts.channelId,
  }), id);
  return { id };
}

export function routingDecisions(): readonly Ingress.RoutingDecisionPayload[] {
  return decisions;
}
