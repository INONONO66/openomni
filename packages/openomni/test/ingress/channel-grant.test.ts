import { describe, expect, it } from "bun:test";
import { Operational } from "@openomni/protocol";
import { Bus, ChannelGrantStore } from "@openomni/session";
import {
  flushBusObservers,
  getIngressEngine,
  makeEvent,
  registerOwnerEndpoint,
  setupIngressActorResolverTest,
  testState,
} from "./_actor-resolver-fixture";

setupIngressActorResolverTest();

describe("Ingress channel grants", () => {
  it("blocks inbound events when no channel grant matches", async () => {
    ChannelGrantStore.remove("grant-discord-guild-dev");
    registerOwnerEndpoint("guild");
    const engine = getIngressEngine();
    testState.responseQueue.push("ok");

    let caughtError: Error | undefined;
    try {
      await engine.ingest(makeEvent("user-1"));
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      caughtError = err;
    }

    expect(caughtError?.message).toContain("channel_grant.missing");
    expect(testState.llmInputs).toHaveLength(0);
  });

  it("drops blocked channels before resident execution", async () => {
    ChannelGrantStore.put({
      id: "grant-discord-guild-dev",
      surface: "discord",
      workspace: "guild",
      channel: "dev",
      kind: "blocked_channel",
      createdBy: "act_owner",
    });
    registerOwnerEndpoint("guild");
    const engine = getIngressEngine();
    testState.responseQueue.push("ok");

    let caughtError: Error | undefined;
    try {
      await engine.ingest(makeEvent("user-1"));
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      caughtError = err;
    }

    expect(caughtError?.message).toContain("channel_grant.blocked_channel.drop");
    expect(testState.llmInputs).toHaveLength(0);
  });

  it("allows broadcast channels as evidence-only inbound treatment", async () => {
    ChannelGrantStore.put({
      id: "grant-discord-guild-dev",
      surface: "discord",
      workspace: "guild",
      channel: "dev",
      kind: "broadcast_channel",
      defaultTier: "observer",
      createdBy: "act_owner",
    });
    testState.responseQueue.push("ok");
    const engine = getIngressEngine();
    const projectedTreatments: unknown[] = [];
    const unobserve = Bus.observe((event, data) => {
      if (event.name !== Operational.Info.name) return;
      const parsed = Operational.Info.schema.parse(data);
      const context = parsed.context;
      if (context === undefined || typeof context !== "object" || Array.isArray(context)) return;
      const audit = (context as Record<string, unknown>).audit;
      if (audit === undefined || typeof audit !== "object" || Array.isArray(audit)) return;
      const payload = (audit as Record<string, unknown>).payload;
      if (payload === undefined || typeof payload !== "object" || Array.isArray(payload)) return;
      projectedTreatments.push((payload as Record<string, unknown>).inboundTreatment);
    });

    try {
      const result = await engine.ingest(makeEvent("unknown-user"));
      await flushBusObservers();

      expect(result.mode).toBe("direct");
      expect(testState.llmInputs).toHaveLength(1);
      expect(projectedTreatments).toContain("evidence_only");
    } finally {
      unobserve();
    }
  });
});
