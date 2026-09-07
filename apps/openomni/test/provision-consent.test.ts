import { afterEach, beforeEach, expect, it } from "bun:test";
import { ActorRegistry, SessionHandleStore, Storage } from "@openomni/ledger";
import { createDispatcher, eraseTool } from "@openomni/agent";
import { createProvisionTool, PROVISION_POLICY_ROWS } from "../src/tools/provision";
import { createTools } from "../src/tools/core/catalog";
import { executor } from "./helpers/executor";
import { bounded, protectedDispatch } from "./helpers/protected-dispatch";
import { provisionPort } from "./helpers/provision-port";

const PROMOTE = { op: "contact_promote", args: { actorId: "contact:mallory" } } as const;
const MERGE = {
  op: "endpoint_merge",
  args: { endpointId: "ep:mallory", toActorId: "actor:alice" },
} as const;
const provision = () => eraseTool(createProvisionTool(provisionPort()));

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

it("consent is a require_approval policy row on the two contact authority ops, nothing else", () => {
  expect(PROVISION_POLICY_ROWS.map((row) => [row.match.value, row.verdict.value])).toEqual([
    [
      { op: "provision", operation: "contact_promote" },
      { type: "require_approval", reason: "provision.contact_promote requires Owner consent" },
    ],
    [
      { op: "provision", operation: "endpoint_merge" },
      { type: "require_approval", reason: "provision.endpoint_merge requires Owner consent" },
    ],
  ]);
  expect(PROVISION_POLICY_ROWS.every((row) => row.kind === "tool" && row.phase === "pre")).toBe(
    true,
  );
});
it("the model cannot mint or decide Owner consent, and workers cannot see provision", async () => {
  const dispatcher = createDispatcher([provision()], { executor });
  for (const operation of [
    { op: "request", args: { actorId: "contact:mallory" } },
    { op: "decide", args: { approvalId: "invented", decision: "approved" } },
    { op: "contact_promote", args: { actorId: "contact:mallory", approvalId: "invented" } },
  ]) {
    expect(
      (
        await dispatcher.execute(
          { id: "forged", tool: "provision", input: { operation } },
          { sessionId: "test", turnId: "turn" },
        )
      ).errorKind,
    ).toBe("invalid_input");
  }
  expect(
    createTools(
      { provisioning: provisionPort() },
      { role: "worker", sessionId: "worker", depth: 1 },
    ).some((tool) => tool.name === "provision"),
  ).toBe(false);
  expect(ActorRegistry.getIdentity("contact:mallory")?.standing).toBe("provisional");
});
it("executes exactly the original promotion after authenticated consent", async () => {
  const f = protectedDispatch(provision(), { operation: PROMOTE });
  try {
    const request = await bounded(f.opened);
    expect(ActorRegistry.getIdentity("contact:mallory")?.standing).toBe("provisional");
    expect(request.parsedInput).toEqual({ operation: PROMOTE });
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
  const f = protectedDispatch(provision(), { operation: PROMOTE });
  try {
    expect((await f.answer("refuse")).isError).toBe(true);
    expect(ActorRegistry.getIdentity("contact:mallory")?.standing).toBe("provisional");
  } finally {
    await f.close();
  }
});
it("rejects an endpoint move after source or target changes, including same-clock edits", async () => {
  const f = protectedDispatch(provision(), { operation: MERGE });
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
  const f = protectedDispatch(provision(), { operation: MERGE });
  try {
    expect((await f.answer()).isError).toBeUndefined();
    expect(ActorRegistry.getEndpoint("ep:mallory")?.actorId).toBe("actor:alice");
  } finally {
    await f.close();
  }
});
for (const [name, operation] of [
  ["an unknown endpoint", { endpointId: "ep:ghost", toActorId: "actor:alice" }],
  ["an unknown target", { endpointId: "ep:mallory", toActorId: "actor:ghost" }],
  [
    "an endpoint already bound to its target",
    { endpointId: "ep:mallory", toActorId: "contact:mallory" },
  ],
] as const) {
  it(`consent to merge ${name} is refused by the act itself, never applied`, async () => {
    const f = protectedDispatch(eraseTool(createApprovalTool(port)), {
      operation: { op: "endpoint_merge", ...operation },
    });
    try {
      const result = await f.answer();
      expect(result.isError).toBe(true);
      expect(result.output).toContain("endpoint or target is missing, or already bound");
      expect(ActorRegistry.getEndpoint("ep:mallory")?.actorId).toBe("contact:mallory");
    } finally {
      await f.close();
    }
  });
}
it("invalidates a merge when the source identity changes without moving its endpoint", async () => {
  const f = protectedDispatch(provision(), { operation: MERGE });
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
  const result = await createDispatcher(
    [{ ...provision(), execute: async () => ({ op: "contact_promote" }) }],
    { executor },
  ).execute(
    { id: "bad-output", tool: "provision", input: { operation: PROMOTE } },
    { sessionId: "test", turnId: "turn" },
  );
  expect(result.errorKind).toBe("invalid_output");
});
it("bounds pending Owner requests across sessions without applying a ninth act", async () => {
  const pending: ReturnType<typeof protectedDispatch>[] = [];
  try {
    for (let index = 0; index < 8; index += 1) {
      const f = protectedDispatch(provision(), { operation: PROMOTE });
      pending.push(f);
      await bounded(f.opened);
    }
    const ninth = protectedDispatch(provision(), { operation: PROMOTE });
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
