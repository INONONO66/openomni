import { beforeEach, describe, expect, test } from "bun:test";
import { ActorRegistry, ChannelGrantStore } from "@openomni/ledger";
import {
  commits,
  kernelRouter,
  ownerFacts,
  ownerSender,
  resetRouterState,
  routingDecisions,
} from "./_router-fixture";

beforeEach(resetRouterState);

describe("GatewayRouter access routing", () => {
  test("missing channel grant refuses before inbox commit", async () => {
    expect(await kernelRouter().ingest(ownerSender, ownerFacts)).toMatchObject({
      status: "blocked_pre",
    });
    expect(routingDecisions()[0]).toMatchObject({ stage: "channel_ceiling", outcome: "block" });
    expect(commits).toEqual([]);
  });
  test("unknown actor on a trusted channel without a default tier is refused", async () => {
    ChannelGrantStore.put({
      id: "grant",
      surface: "discord",
      kind: "trusted_channel",
      createdBy: "owner",
    });
    expect(await kernelRouter().ingest(ownerSender, ownerFacts)).toMatchObject({
      status: "blocked_pre",
    });
    expect(routingDecisions()[0]).toMatchObject({ stage: "actor_identity", outcome: "block" });
    expect(commits).toEqual([]);
  });
  test("default-tier admission never registers a new endpoint", async () => {
    ChannelGrantStore.put({
      id: "grant",
      surface: "discord",
      kind: "trusted_channel",
      defaultTier: "owner",
      createdBy: "owner",
    });
    const result = await kernelRouter().ingest(ownerSender, ownerFacts);
    expect(result.status).toBe("executed");
    expect(routingDecisions()[0]).toMatchObject({
      stage: "surface_default",
      outcome: "route",
      trustTier: "owner",
    });
    expect(commits).toHaveLength(1);
    expect(
      ActorRegistry.resolveEndpoint(
        ownerSender.surface,
        ownerSender.externalId,
        ownerFacts.workspaceId,
      ),
    ).toBeUndefined();
  });
  test.each([
    undefined,
    "full_access",
  ] as const)("broadcast treatment %s remains evidence-only", async (inboundTreatment) => {
    ChannelGrantStore.put({
      id: "grant",
      surface: "discord",
      kind: "broadcast_channel",
      defaultTier: "observer",
      createdBy: "owner",
      ...(inboundTreatment === undefined ? {} : { inboundTreatment }),
    });
    expect((await kernelRouter().ingest(ownerSender, ownerFacts)).status).toBe("executed");
    expect(routingDecisions()[0]).toMatchObject({
      outcome: "route",
      trustTier: "observer",
      inboundTreatment: "evidence_only",
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]?.content.endsWith(ownerFacts.render)).toBe(true);
    expect(commits[0]?.content).not.toBe(ownerFacts.render);
  });
  test("blocked channel refuses before inbox commit", async () => {
    ChannelGrantStore.put({
      id: "grant",
      surface: "discord",
      kind: "blocked_channel",
      createdBy: "owner",
    });
    expect(await kernelRouter().ingest(ownerSender, ownerFacts)).toMatchObject({
      status: "blocked_pre",
    });
    expect(routingDecisions()[0]).toMatchObject({
      stage: "channel_ceiling",
      outcome: "block",
      inboundTreatment: "drop",
    });
    expect(commits).toEqual([]);
  });
});
