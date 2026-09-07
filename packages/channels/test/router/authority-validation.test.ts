import { beforeEach, expect, test } from "bun:test";
import { ChannelGrantStore } from "@openomni/ledger";
import { applyChannelGrantTreatment } from "../../src/router/authority";
import {
  commits,
  kernelRouter,
  makeInboundEvent,
  ownerFacts,
  ownerSender,
  resetRouterState,
  routingDecisions,
} from "./_router-fixture";

beforeEach(resetRouterState);

const grant = {
  id: "grant",
  surface: "discord",
  kind: "trusted_channel",
  defaultTier: "observer",
  createdBy: "owner",
} as const;

test("channel default tier is projected only for an actor without canonical standing", () => {
  const treated = applyChannelGrantTreatment(
    makeInboundEvent({ meta: { actor: { role: "user", id: "guest" } } }),
    grant,
    "full_access",
  );
  expect(treated.meta).toMatchObject({
    actor: { role: "user", trustTier: "observer" },
    channelGrantId: "grant",
    inboundTreatment: "full_access",
  });
  const canonical = applyChannelGrantTreatment(
    makeInboundEvent({ meta: { actor: { actorId: "manager", trustTier: "manager" } } }),
    grant,
    "full_access",
  );
  expect(canonical.meta?.actor?.trustTier).toBe("manager");
});

test("observer channel default is a routing fact, not authority to create top-level work", async () => {
  ChannelGrantStore.put(grant);
  expect(await kernelRouter().ingest(ownerSender, ownerFacts)).toEqual({
    status: "blocked_pre",
    reasonCode: "message.external.grant_tier",
  });
  expect(routingDecisions()[0]).toMatchObject({
    stage: "surface_default",
    outcome: "route",
    trustTier: "observer",
  });
  expect(routingDecisions()[0]?.factsUsed).toContain("channel.default-tier:observer");
  expect(commits).toEqual([]);
});
