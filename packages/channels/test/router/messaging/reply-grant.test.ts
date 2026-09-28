import { resetLedger } from "../../helpers/ledger";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Operational, type BusEvent, type Gateway } from "@openomni/protocol";
import {
  createReplyGrantInstances,
  replyGrantEndpointFromFacts,
} from "../../../src/router/messaging/reply-grant.js";

/**
 * #708 reply-grant materialization mechanics (design §2b stage-0 rule):
 * Owner-written RULES materialize bounded, reply-scoped grant INSTANCES for
 * first-contact admitted actors — perimeter facts only, capped per rule.
 * The current projection is durable and never reconstructed from route history.
 */

type ReplyGrantAdmission = Parameters<ReturnType<typeof createReplyGrantInstances>["admit"]>[0];

const NOW = 1_700_000_000_000;

beforeEach(() => {
  resetLedger();
});

function rule(overrides: Partial<Gateway.ReplyGrantRule> = {}): Gateway.ReplyGrantRule {
  return {
    id: "rule-1",
    senderId: "actor:persona",
    surface: "telegram",
    operations: ["awaited", "fire_and_forget"],
    instanceTtlMs: 60_000,
    maxLiveInstances: 2,
    createdBy: "owner",
    ...overrides,
  };
}

function admission(overrides: Partial<ReplyGrantAdmission> = {}): ReplyGrantAdmission {
  return {
    actorId: "actor:stranger-1",
    endpoint: { channel: "telegram", externalId: "chat-1" },
    surface: "telegram",
    traceId: "trace-reply-grant",
    at: NOW,
    ...overrides,
  };
}

function harness(rules: readonly Gateway.ReplyGrantRule[]) {
  const published: Array<{
    name: string;
    data: ReturnType<typeof Operational.Events.Info.schema.parse>;
  }> = [];
  const publish: BusEvent.Sink["publish"] = (descriptor, data) => {
    published.push({ name: descriptor.name, data: Operational.Events.Info.schema.parse(data) });
  };
  const instances = createReplyGrantInstances({
    get stores() {
      return ledger().stores;
    },
    rules: () => rules,
    publish,
  });
  return { instances, published };
}

describe("reply-grant instance materialization", () => {
  test("malformed or ambiguous route facts never reconstruct endpoint authority", () => {
    expect(replyGrantEndpointFromFacts([])).toBeUndefined();
    expect(
      replyGrantEndpointFromFacts([
        "reply_grant.endpoint.channel:telegram",
        "reply_grant.endpoint.external_id:%E0%A4%A",
      ]),
    ).toBeUndefined();
    expect(
      replyGrantEndpointFromFacts([
        "reply_grant.endpoint.channel:telegram",
        "reply_grant.endpoint.channel:discord",
        "reply_grant.endpoint.external_id:chat-1",
      ]),
    ).toBeUndefined();
  });

  test("an admitted first-contact actor on a covered surface materializes one bounded instance", () => {
    const { instances, published } = harness([rule()]);

    instances.admit(admission());

    const live = instances.list(NOW);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      senderId: "actor:persona",
      targetActorId: "actor:stranger-1",
      operations: ["awaited", "fire_and_forget"],
      expiresAt: NOW + 60_000,
      ruleId: "rule-1",
      replyScope: { surfaceKey: "telegram:chat-1" },
    });
    expect(published.map((event) => event.name)).toEqual(["operational.info"]);
    expect(published[0]?.data).toMatchObject({
      traceId: "trace-reply-grant",
    });
  });

  test("expiry is inclusive and removes authority without another admission", () => {
    const { instances } = harness([rule()]);
    instances.admit(admission());
    expect(instances.list(NOW + 60_000)).toHaveLength(1);
    expect(instances.list(NOW + 60_001)).toEqual([]);
  });

  test("repeat contact is NOT first contact: no second instance, no expiry refresh", () => {
    const { instances } = harness([rule()]);

    instances.admit(admission());
    instances.admit(admission({ at: NOW + 10_000 }));

    const live = instances.list(NOW + 10_000);
    expect(live).toHaveLength(1);
    expect(live[0]?.expiresAt).toBe(NOW + 60_000);
  });

  test("maxLiveInstances caps grant farming: at capacity no instance lands and the refusal is audited", () => {
    const { instances, published } = harness([rule({ maxLiveInstances: 1 })]);

    instances.admit(admission());
    instances.admit(
      admission({
        actorId: "actor:stranger-2",
        endpoint: { channel: "telegram", externalId: "chat-2" },
      }),
    );

    expect(instances.list(NOW)).toHaveLength(1);
    const warn = published.find((event) => event.name === "operational.warn");
    expect(warn?.data).toMatchObject({
      context: {
        ruleId: "rule-1",
        targetActorId: "actor:stranger-2",
        maxLiveInstances: 1,
      },
    });
  });

  test("expired instances free capacity — the cap counts LIVE instances", () => {
    const { instances } = harness([rule({ maxLiveInstances: 1 })]);

    instances.admit(admission());
    instances.admit(
      admission({
        actorId: "actor:stranger-2",
        endpoint: { channel: "telegram", externalId: "chat-2" },
        at: NOW + 60_001,
      }),
    );

    const live = instances.list(NOW + 60_001);
    expect(live).toHaveLength(1);
    expect(live[0]?.targetActorId).toBe("actor:stranger-2");
  });

  test("rule scope pins: wrong surface, wrong workspace, and the persona itself materialize nothing", () => {
    const { instances } = harness([rule({ workspace: "bot-a" })]);

    instances.admit(admission({ surface: "discord", workspace: "bot-a" }));
    instances.admit(admission({ workspace: "bot-b" }));
    instances.admit(admission({ workspace: "bot-a", actorId: "actor:persona" }));

    expect(instances.list(NOW)).toHaveLength(0);

    instances.admit(admission({ workspace: "bot-a" }));
    expect(instances.list(NOW)).toHaveLength(1);
  });

  test("the same actor in a second container is a new first contact (per-container scope)", () => {
    const { instances } = harness([rule()]);

    instances.admit(admission());
    instances.admit(admission({ endpoint: { channel: "telegram", externalId: "chat-9" } }));

    const scopes = instances.list(NOW).map((instance) => instance.replyScope?.surfaceKey);
    expect(scopes.sort()).toEqual(["telegram:chat-1", "telegram:chat-9"]);
  });

  test("construction never reads decision facts and every list reads the current projection", () => {
    ledger().setDecisionFacts(
      new Proxy({} as NonNullable<TestLedger["sessions"]["decisionFacts"]>, {
        get: () => {
          throw new Error("decision replay forbidden");
        },
      }),
    );
    const first = harness([rule()]);
    const second = harness([rule()]);
    first.instances.admit(admission({ sourceId: "committed:1" }));
    expect(second.instances.list(NOW)[0]?.id).toBe("reply-grant:rule-1:committed%3A1");
  });

  test("projection failures propagate without a volatile grant or success observation", () => {
    const { instances, published } = harness([rule()]);
    ledger().sessions.close();
    ledger().catalog.close();
    expect(() => instances.admit(admission())).toThrow();
    expect(() => instances.list(NOW)).toThrow();
    expect(published).toEqual([]);
  });

  test("an absent projection fails closed instead of creating memory authority", () => {
    const stores = unconfiguredChannelStores();
    const instances = createReplyGrantInstances({
      stores,
      rules: () => [rule()],
      publish: () => undefined,
    });
    expect(() => instances.admit(admission())).toThrow(
      "Storage adapter does not implement reply grants",
    );
    expect(() => instances.list(NOW)).toThrow("Storage adapter does not implement reply grants");
  });
});
