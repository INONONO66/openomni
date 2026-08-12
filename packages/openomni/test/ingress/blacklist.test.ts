import { describe, expect, it } from "bun:test";
import { BlacklistStore } from "@openomni/session";
import {
  getIngressEngine,
  makeEvent,
  registerOwnerEndpoint,
  setupIngressActorResolverTest,
  testState,
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
    const engine = getIngressEngine();
    testState.responseQueue.push("ok");

    const result = await engine.ingest(makeEvent("user-1"));

    expect(result).toMatchObject({
      kind: "dropped",
      reason: "Inbound principal matched the blacklist",
    });
    expect(testState.llmInputs).toHaveLength(0);
  });

  it("blocks blacklisted channels before resident execution", async () => {
    BlacklistStore.put({
      id: "bl-channel",
      kind: "channel",
      value: "discord:guild:dev",
      createdBy: "act_owner",
    });
    const engine = getIngressEngine();
    testState.responseQueue.push("ok");

    const result = await engine.ingest(makeEvent("unknown-user"));

    expect(result).toMatchObject({
      kind: "dropped",
      reason: "Inbound principal matched the blacklist",
    });
    expect(testState.llmInputs).toHaveLength(0);
  });
});
