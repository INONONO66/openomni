import { describe, expect, it } from "bun:test";
import { BlacklistStore } from "@openomni/ledger";
import {
  deliveries,
  getRouter,
  makeEvent,
  registerOwnerEndpoint,
  setupIngressActorResolverTest,
} from "./_actor-resolver-fixture";

setupIngressActorResolverTest();

describe("Ingress blacklist", () => {
  it("blocks registered blacklisted actors before resident execution", async () => {
    registerOwnerEndpoint("guild");
    BlacklistStore.put({
      id: "bl-owner",
      kind: "actor",
      value: "act_owner",
      reason: "blocked actor",
      createdBy: "act_owner",
    });
    const router = getRouter();

    const result = await router.ingest(makeEvent("user-1"));

    expect(result).toMatchObject({
      kind: "dropped",
      reason: "Inbound principal matched the blacklist",
    });
    expect(deliveries).toHaveLength(0);
  });

  it("blocks blacklisted channels before resident execution", async () => {
    BlacklistStore.put({
      id: "bl-channel",
      kind: "channel",
      value: "discord:guild:dev",
      createdBy: "act_owner",
    });
    const router = getRouter();

    const result = await router.ingest(makeEvent("unknown-user"));

    expect(result).toMatchObject({
      kind: "dropped",
      reason: "Inbound principal matched the blacklist",
    });
    expect(deliveries).toHaveLength(0);
  });
});
