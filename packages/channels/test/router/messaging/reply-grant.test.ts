import { describe, expect, test } from "bun:test";
import type { BusEvent, Gateway } from "@openomni/protocol";
import {
  createReplyGrantInstances,
  type ReplyGrantAdmission,
} from "../../../src/router/messaging/reply-grant.js";

/**
 * #708 reply-grant materialization mechanics (design §2b stage-0 rule):
 * Owner-written RULES materialize bounded, reply-scoped grant INSTANCES for
 * first-contact admitted actors — perimeter facts only, capped per rule.
 * Immutable routed admissions rebuild the in-memory projection after restart.
 */

const NOW = 1_700_000_000_000;

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
  const published: Array<{ name: string; data: Record<string, unknown> }> = [];
  const publish: BusEvent.Sink["publish"] = (descriptor, data) => {
    published.push({ name: descriptor.name, data: data as Record<string, unknown> });
  };
  const instances = createReplyGrantInstances({ rules: () => rules, publish });
  return { instances, published };
}

describe("reply-grant instance materialization", () => {
  test("an admitted first-contact actor on a covered surface materializes one bounded instance", () => {
    const { instances, published } = harness([rule()]);

    instances.admit(admission());

    const live = instances.list();
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
      msg: "reply-grant instance materialized",
      traceId: "trace-reply-grant",
    });
  });

  test("immutable admission replay preserves original TTL and capacity", () => {
    const replayAt = Date.now();
    const published: Array<{ name: string; data: Record<string, unknown> }> = [];
    const instances = createReplyGrantInstances({
      rules: () => [rule({ maxLiveInstances: 1 })],
      replay: () => [
        admission({ at: replayAt, sourceId: "route:first" }),
        admission({
          actorId: "actor:stranger-2",
          endpoint: { channel: "telegram", externalId: "chat-2" },
          at: replayAt + 1,
          sourceId: "route:second",
        }),
      ],
      publish: (descriptor, data) => {
        published.push({ name: descriptor.name, data: data as Record<string, unknown> });
      },
    });

    const live = instances.list();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      id: "reply-grant:rule-1:route%3Afirst",
      targetActorId: "actor:stranger-1",
      expiresAt: replayAt + 60_000,
      replyScope: { surfaceKey: "telegram:chat-1" },
    });
    expect(published).toEqual([]);
  });

  test("expired immutable admissions rematerialize no authority", () => {
    const instances = createReplyGrantInstances({
      rules: () => [rule()],
      replay: () => [admission({ at: Date.now() - 60_001, sourceId: "route:expired" })],
      publish: () => undefined,
    });

    expect(instances.list()).toEqual([]);
  });

  test("repeat contact is NOT first contact: no second instance, no expiry refresh", () => {
    const { instances } = harness([rule()]);

    instances.admit(admission());
    instances.admit(admission({ at: NOW + 10_000 }));

    const live = instances.list();
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

    expect(instances.list()).toHaveLength(1);
    const warn = published.find((event) => event.name === "operational.warn");
    expect(warn?.data).toMatchObject({
      msg: "reply-grant rule at capacity; no instance materialized",
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

    const live = instances.list();
    expect(live).toHaveLength(1);
    expect(live[0]?.targetActorId).toBe("actor:stranger-2");
  });

  test("rule scope pins: wrong surface, wrong workspace, and the persona itself materialize nothing", () => {
    const { instances } = harness([rule({ workspace: "bot-a" })]);

    instances.admit(admission({ surface: "discord", workspace: "bot-a" }));
    instances.admit(admission({ workspace: "bot-b" }));
    instances.admit(admission({ workspace: "bot-a", actorId: "actor:persona" }));

    expect(instances.list()).toHaveLength(0);

    instances.admit(admission({ workspace: "bot-a" }));
    expect(instances.list()).toHaveLength(1);
  });

  test("the same actor in a second container is a new first contact (per-container scope)", () => {
    const { instances } = harness([rule()]);

    instances.admit(admission());
    instances.admit(admission({ endpoint: { channel: "telegram", externalId: "chat-9" } }));

    const scopes = instances.list().map((instance) => instance.replyScope?.surfaceKey);
    expect(scopes.sort()).toEqual(["telegram:chat-1", "telegram:chat-9"]);
  });
});
