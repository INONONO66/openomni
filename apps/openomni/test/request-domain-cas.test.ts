import { afterEach, beforeEach, expect, test } from "bun:test";
import { Bus } from "@openomni/agent";
import { Effect } from "effect";
import { runEffect } from "./helpers/effect";
import { ActorRegistry, PersonStore, Storage } from "@openomni/ledger";
import { Tool } from "@openomni/protocol";
import { createProvisionTool } from "../src/tools/provision";
import { protectedDispatch, bounded } from "./helpers/protected-dispatch";
import { provisionPort } from "./helpers/provision-port";

beforeEach(() => {
  Storage.initialize({ dbPath: ":memory:" });
  Bus.reset();
});
afterEach(() => {
  Storage.reset();
  Bus.reset();
});

test("an endpoint changed at body entry cannot spend consent for its old binding", async () => {
  for (const id of ["source", "target", "new-owner"])
    ActorRegistry.registerIdentity({ id, kind: "human", trustTier: "collaborator" });
  ActorRegistry.registerEndpoint({
    id: "endpoint",
    actorId: "source",
    channel: "ws",
    externalId: "peer",
  });
  const observations = {
    publish(event: { readonly name: string }) {
      if (event.name === Tool.Events.Started.name) {
        ActorRegistry.registerEndpoint({
          id: "endpoint",
          actorId: "new-owner",
          channel: "ws",
          externalId: "peer",
        });
      }
    },
  };
  const running = protectedDispatch(
    createProvisionTool(provisionPort()),
    {
      operation: { op: "contact_merge", args: { endpointId: "endpoint", toActorId: "target" } },
    },
    observations,
  );
  try {
    const result = await running.answer();
    expect(result.isError).toBe(true);
    expect(ActorRegistry.getEndpoint("endpoint")?.actorId).toBe("new-owner");
    expect(PersonStore.list()).toEqual([]);
  } finally {
    await running.close();
  }
});

test("a second Owner decision cannot spend the same promotion CAS", async () => {
  ActorRegistry.mintProvisional(
    { id: "contact:cas", kind: "unknown", trustTier: "observer", standing: "provisional" },
    { id: "ep:cas", channel: "ws", externalId: "cas" },
  );
  const running = protectedDispatch(createProvisionTool(provisionPort()), {
    operation: { op: "contact_promote", args: { actorId: "contact:cas" } },
  });
  try {
    await bounded(running.opened);
    const approvals = running.executor.approvals;
    const request = approvals?.pending()[0];
    if (approvals === undefined || request === undefined) throw new Error("missing Owner request");
    expect((await running.answer()).isError).toBeUndefined();
    const promoted = ActorRegistry.getIdentity("contact:cas");
    expect(promoted?.standing).toBe("registered");
    expect(await runEffect(Effect.either(approvals.answer({ request, decision: "refuse", credential: "owner-token" }))))
      .toMatchObject({ _tag: "Left", left: { _tag: "ExecutionApprovalError", code: "stale_approval" } });
    expect(ActorRegistry.getIdentity("contact:cas")).toEqual(promoted);
  } finally {
    await running.close();
  }
});
