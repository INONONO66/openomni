import { afterEach, beforeEach, expect, test } from "bun:test";
import { Bus } from "@openomni/agent";
import { ActorRegistry, PersonStore, Storage } from "@openomni/ledger";
import { Tool } from "@openomni/protocol";
import { createApprovalTool } from "../src/tools/authority/approval";
import { protectedDispatch } from "./helpers/protected-dispatch";

beforeEach(() => { Storage.initialize({ dbPath: ":memory:" }); Bus.reset(); });
afterEach(() => { Storage.reset(); Bus.reset(); });

test("an endpoint changed at body entry cannot spend consent for its old binding", async () => {
  for (const id of ["source", "target", "new-owner"]) ActorRegistry.registerIdentity({ id, kind: "human", trustTier: "collaborator" });
  ActorRegistry.registerEndpoint({ id: "endpoint", actorId: "source", channel: "ws", externalId: "peer" });
  const observations = {
    publish(event: { readonly name: string }) {
      if (event.name === Tool.Events.Started.name) {
        ActorRegistry.registerEndpoint({ id: "endpoint", actorId: "new-owner", channel: "ws", externalId: "peer" });
      }
    },
  };
  const running = protectedDispatch(createApprovalTool(ActorRegistry), {
    operation: { op: "endpoint_merge", endpointId: "endpoint", toActorId: "target" },
  }, observations);
  try {
    const result = await running.answer();
    expect(result.isError).toBe(true);
    expect(ActorRegistry.getEndpoint("endpoint")?.actorId).toBe("new-owner");
    expect(PersonStore.list()).toEqual([]);
  } finally { await running.close(); }
});
