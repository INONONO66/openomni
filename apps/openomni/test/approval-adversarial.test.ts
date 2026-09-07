import { afterEach, beforeEach, expect, it } from "bun:test";
import { ActorRegistry, SessionHandleStore, Storage } from "@openomni/ledger";
import { createDispatcher, eraseTool } from "@openomni/agent";
import { createApprovalTool, type ApprovalPort } from "../src/tools/authority/approval";
import { createTools } from "../src/tools/core/catalog";
import { executor } from "./helpers/executor";
import { bounded, protectedDispatch } from "./helpers/protected-dispatch";

const port: ApprovalPort = ActorRegistry;
beforeEach(() => {
  Storage.initialize({ dbPath: ":memory:" });
  ActorRegistry.mintProvisional(
    { id: "contact:mallory", kind: "unknown", trustTier: "observer", standing: "provisional" },
    { id: "ep:mallory", channel: "whatsapp", externalId: "mallory" },
  );
  ActorRegistry.registerIdentity({ id: "actor:alice", kind: "human", trustTier: "collaborator" });
  ActorRegistry.registerIdentity({ id: "actor:bob", kind: "human", trustTier: "observer" });
});
afterEach(() => Storage.reset());

it("the model cannot mint or decide Owner consent, and workers cannot see the authority tool", async () => {
  const tool = eraseTool(createApprovalTool(port));
  const dispatcher = createDispatcher([tool], { executor });
  for (const operation of [
    { op: "request", actorId: "contact:mallory" },
    { op: "decide", approvalId: "invented", decision: "approved" },
    { op: "contact_promote", approvalId: "invented" },
  ]) {
    expect(
      (
        await dispatcher.execute(
          { id: "forged", tool: "approval", input: { operation } },
          { sessionId: "test", turnId: "turn" },
        )
      ).errorKind,
    ).toBe("invalid_input");
  }
  expect(
    createTools({ approvals: port }, { role: "worker", sessionId: "worker", depth: 1 }).some(
      (tool) => tool.name === "approval",
    ),
  ).toBe(false);
  expect(ActorRegistry.getIdentity("contact:mallory")?.standing).toBe("provisional");
});
it("executes exactly the original promotion after authenticated consent", async () => {
  const f = protectedDispatch(eraseTool(createApprovalTool(port)), {
    operation: { op: "contact_promote", actorId: "contact:mallory" },
  });
  try {
    const request = await bounded(f.opened);
    expect(ActorRegistry.getIdentity("contact:mallory")?.standing).toBe("provisional");
    expect(request.parsedInput).toEqual({
      operation: { op: "contact_promote", actorId: "contact:mallory" },
    });
    expect((await f.answer()).isError).toBeUndefined();
    expect(ActorRegistry.getIdentity("contact:mallory")?.standing).toBe("registered");
    expect(SessionHandleStore.requestById(request.requestId)?.state).toBe("resolved");
    expect(
      f.ledger.actions?.().filter((action) => action.id === `${request.requestId}:application`),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});
it("Owner refusal never promotes a provisional contact", async () => {
  const f = protectedDispatch(eraseTool(createApprovalTool(port)), {
    operation: { op: "contact_promote", actorId: "contact:mallory" },
  });
  try {
    expect((await f.answer("refuse")).isError).toBe(true);
    expect(ActorRegistry.getIdentity("contact:mallory")?.standing).toBe("provisional");
  } finally {
    await f.close();
  }
});
it("rejects an endpoint move after source or target changes, including same-clock edits", async () => {
  const f = protectedDispatch(eraseTool(createApprovalTool(port)), {
    operation: { op: "endpoint_merge", endpointId: "ep:mallory", toActorId: "actor:alice" },
  });
  try {
    await bounded(f.opened);
    ActorRegistry.mergeEndpoint("ep:mallory", "actor:bob");
    await expect(f.answer()).rejects.toMatchObject({ code: "stale_approval" });
    expect(ActorRegistry.getEndpoint("ep:mallory")?.actorId).toBe("actor:bob");
  } finally {
    await f.close();
  }
});
it("merges only the approved endpoint into the exact target", async () => {
  const f = protectedDispatch(eraseTool(createApprovalTool(port)), {
    operation: { op: "endpoint_merge", endpointId: "ep:mallory", toActorId: "actor:alice" },
  });
  try {
    expect((await f.answer()).isError).toBeUndefined();
    expect(ActorRegistry.getEndpoint("ep:mallory")?.actorId).toBe("actor:alice");
  } finally {
    await f.close();
  }
});
it("invalidates a merge when the source identity changes without moving its endpoint", async () => {
  const f = protectedDispatch(eraseTool(createApprovalTool(port)), {
    operation: { op: "endpoint_merge", endpointId: "ep:mallory", toActorId: "actor:alice" },
  });
  try {
    await bounded(f.opened);
    const source = ActorRegistry.getIdentity("contact:mallory");
    if (source === undefined) throw new Error("missing source identity");
    ActorRegistry.registerIdentity({ ...source, trustTier: "manager" });
    await expect(f.answer()).rejects.toMatchObject({ code: "stale_approval" });
    expect(ActorRegistry.getEndpoint("ep:mallory")?.actorId).toBe("contact:mallory");
  } finally {
    await f.close();
  }
});
it("refuses malformed output at the real dispatcher boundary", async () => {
  const tool = eraseTool(createApprovalTool(port));
  const result = await createDispatcher(
    [{ ...tool, execute: async () => ({ op: "contact_promote" }) }],
    { executor },
  ).execute(
    {
      id: "bad-output",
      tool: "approval",
      input: { operation: { op: "contact_promote", actorId: "contact:mallory" } },
    },
    { sessionId: "test", turnId: "turn" },
  );
  expect(result.errorKind).toBe("invalid_output");
});
it("bounds pending Owner requests across sessions without applying a ninth act", async () => {
  const pending: ReturnType<typeof protectedDispatch>[] = [];
  try {
    for (let index = 0; index < 8; index += 1) {
      const f = protectedDispatch(eraseTool(createApprovalTool(port)), {
        operation: { op: "contact_promote", actorId: "contact:mallory" },
      });
      pending.push(f);
      await bounded(f.opened);
    }
    const ninth = protectedDispatch(eraseTool(createApprovalTool(port)), {
      operation: { op: "contact_promote", actorId: "contact:mallory" },
    });
    pending.push(ninth);
    expect((await bounded(ninth.running)).errorKind).toBe("precondition_failed");
    expect(
      SessionHandleStore.requestRows().filter((request) => request.state === "open"),
    ).toHaveLength(8);
    expect(ActorRegistry.getIdentity("contact:mallory")?.standing).toBe("provisional");
  } finally {
    await Promise.all(pending.map((f) => f.close()));
  }
});
