import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Ingress } from "@openomni/protocol";
import { BlacklistStore, ChannelGrantStore } from "@openomni/ledger";
import { Bus } from "../helpers/observation";
import {
  createMappedOwnerSession,
  commits,
  kernelRouter,
  ownerEvent,
  ownerFacts,
  ownerSender,
  registerOwnerDm,
  resetRouterState,
  routingDecisions,
} from "./_router-fixture";

describe("GatewayRouter kernel routing", () => {
  beforeEach(resetRouterState);
  test("mapped Owner DM commits once and returns a session receipt", async () => {
    registerOwnerDm();
    const mapped = createMappedOwnerSession();
    const result = await kernelRouter().ingest(ownerSender, ownerFacts);
    expect(result).toEqual({
      status: "executed",
      handle: { messageId: ownerEvent.id, target: mapped.id },
      delivery: { kind: "session" },
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      sessionId: mapped.id,
      kind: "prompt",
      content: ownerFacts.render,
    });
  });
  test("publishes one canonical route decision", async () => {
    registerOwnerDm();
    const mapped = createMappedOwnerSession();
    await kernelRouter().ingest(ownerSender, ownerFacts);
    expect(routingDecisions()).toHaveLength(1);
    expect(routingDecisions()[0]).toMatchObject({
      inboundId: ownerEvent.id,
      stage: "surface_default",
      outcome: "route",
      sessionId: mapped.id,
      actorId: "actor-owner",
      trustTier: "owner",
      inboundTreatment: "full_access",
    });
  });
  test("routing publication failure does not invoke inbox commit", async () => {
    registerOwnerDm();
    createMappedOwnerSession();
    const publish = Bus.publish;
    const spy = spyOn(Bus, "publish").mockImplementation((event, data) => {
      if (event === Ingress.Events.RoutingDecision) throw new Error("routing publish failed");
      publish(event, data);
    });
    try {
      await expect(kernelRouter().ingest(ownerSender, ownerFacts)).rejects.toThrow(
        "routing publish failed",
      );
      expect(commits).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
  test("reads blacklist and channel facts once", async () => {
    registerOwnerDm();
    createMappedOwnerSession();
    const blacklist = spyOn(BlacklistStore, "list");
    const channels = spyOn(ChannelGrantStore, "list");
    try {
      await kernelRouter().ingest(ownerSender, ownerFacts);
      expect(blacklist).toHaveBeenCalledTimes(1);
      expect(channels).toHaveBeenCalledTimes(1);
    } finally {
      blacklist.mockRestore();
      channels.mockRestore();
    }
  });
  test("first admission claims the physical surface for the next event", async () => {
    registerOwnerDm();
    const first = await kernelRouter().ingest(ownerSender, ownerFacts);
    const second = await kernelRouter().ingest(ownerSender, { ...ownerFacts, eventId: "second" });
    if (first.status !== "executed" || second.status !== "executed")
      throw new Error("not executed");
    expect(first.handle.target).toBe(second.handle.target);
    expect(commits).toHaveLength(2);
    expect(commits[0]?.sessionId).toBe(commits[1]?.sessionId);
  });
});
