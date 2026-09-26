import { dispatcherFixture } from "./helpers/dispatcher-fixture";
import { Effect, Fiber } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnDispatcher } from "@openomni/agent";
import type { AnyToolDefinition, LedgerAction } from "@openomni/protocol";
import { requestLedger, crashAfterRequestOpen, type RequestLedger } from "../../../packages/agent/test/helpers/effect-g1";
import { catalogLayer, executorLayer, runnerTestLayer } from "../../../packages/agent/test/helpers/service-layers";
import { compiledPolicy } from "../../../packages/agent/test/helpers/compiled-policy";
import { sessionTree } from "../../../packages/ledger/test/helpers/session-tree";
import { requestDomainRevisions } from "../src/tools/core/request-domain-revisions";
import { runEffect } from "./helpers/effect";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { ActorRegistry, SessionHandleStore, Storage } from "@openomni/ledger";
import { eraseTool } from "@openomni/agent";
import type { PlainObject } from "@openomni/protocol";
import { createProvisionTool, PROVISION_POLICY_ROWS } from "../src/tools/provision";
import { catalogDefinitions } from "../src/tools/core/catalog";
import { testToolPorts } from "./helpers/tool-ports";
import { executor } from "./helpers/executor";
import { bounded, protectedDispatch } from "./helpers/protected-dispatch";
import { provisionPort } from "./helpers/provision-port";

const PROMOTE = { op: "contact_promote", args: { actorId: "contact:mallory" } } as const;
const MERGE = {
  op: "contact_merge",
  args: { endpointId: "ep:mallory", toActorId: "actor:alice" },
} as const;
const provision = () => eraseTool(createProvisionTool(provisionPort()));
/** The provisional contact's current standing in the actor registry. */
const malloryStanding = () => ActorRegistry.getIdentity("contact:mallory")?.standing;

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
      { op: "provision", operation: "contact_merge" },
      { type: "require_approval", reason: "provision.contact_merge requires Owner consent" },
    ],
  ]);
  expect(PROVISION_POLICY_ROWS.every((row) => row.kind === "tool" && row.phase === "pre")).toBe(
    true,
  );
});
it("the model cannot mint or decide Owner consent, and workers cannot see provision", async () => {
  const dispatcher = dispatcherFixture([provision()], { executor });
  const forged: readonly PlainObject[] = [
    { op: "request", args: { actorId: "contact:mallory" } },
    { op: "decide", args: { approvalId: "invented", decision: "approved" } },
    { op: "contact_promote", args: { actorId: "contact:mallory", approvalId: "invented" } },
  ];
  for (const operation of forged) {
    expect(
      (
        await runEffect(dispatcher.execute(
          { id: "forged", tool: "provision", input: { operation } },
          { sessionId: "test", turnId: "turn" },
        ))
      ).errorKind,
    ).toBe("invalid_input");
  }
  expect(
    catalogDefinitions({ ...testToolPorts, provisioning: provisionPort() }).some(
      (tool: AnyToolDefinition) => tool.name === "provision" &&
        (tool.visibility.model.includes("worker") || tool.visibility.cell.includes("worker")),
    ),
  ).toBe(false);
  expect(malloryStanding()).toBe("provisional");
});
it("executes exactly the original promotion after authenticated consent", async () => {
  const f = protectedDispatch(provision(), { operation: PROMOTE });
  try {
    const request = await bounded(f.opened);
    expect(malloryStanding()).toBe("provisional");
    expect(request.parsedInput).toEqual({ operation: PROMOTE });
    const registered = await f.answer();
    expect(registered.isError).toBeUndefined();
    expect(registered.output).toMatch(/^contact contact:mallory registered \(tier \w+\)$/);
    expect(malloryStanding()).toBe("registered");
    expect(SessionHandleStore.requestById(request.requestId)?.state).toBe("resolved");
    expect(f.ledger.actionById?.(`${request.requestId}:application`)).toBeDefined();
  } finally {
    await f.close();
  }
});
it("Owner refusal never promotes a provisional contact", async () => {
  const f = protectedDispatch(provision(), { operation: PROMOTE });
  try {
    expect((await f.answer("refuse")).isError).toBe(true);
    expect(malloryStanding()).toBe("provisional");
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
    const merged = await f.answer();
    expect(merged.isError).toBeUndefined();
    expect(merged.output).toBe("endpoint ep:mallory merged into actor:alice");
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
    const f = protectedDispatch(provision(), {
      operation: { op: "contact_merge", args: operation },
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
  const result = await runEffect(dispatcherFixture(
    [{ ...provision(), execute: async () => ({ op: "contact_promote" }) }],
    { executor },
  ).execute(
    { id: "bad-output", tool: "provision", input: { operation: PROMOTE } },
    { sessionId: "test", turnId: "turn" },
  ));
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
    const ninthResult = await bounded(ninth.outcome);
    expect(ninthResult._tag).toBe("Left");
    expect(ninthResult._tag === "Left" && ninthResult.left).toMatchObject({ _tag: "ExecutionApprovalError", code: "stale_approval" });
    expect(
      SessionHandleStore.requestRows().filter((request) => request.state === "open"),
    ).toHaveLength(8);
    expect(malloryStanding()).toBe("provisional");
  } finally {
    await Promise.all(pending.map((f) => f.close()));
  }
});

function restartDispatcher(recording: RequestLedger, ready?: () => void) {
  return Effect.gen(function* () {
    const dispatcher: Effect.Effect.Success<ReturnType<typeof createTurnDispatcher>> = yield* createTurnDispatcher({
      ...recording.identity, actionId: recording.identity.parentActionId,
      ledger: {
        ...recording.ledger,
        requestById: (id: string) => {
          if ((dispatcher.executor.approvals?.pending().length ?? 0) > 0) ready?.();
          return recording.ledger.requestById?.(id);
        },
      },
    }, {
      authorizeApproval: () => Effect.succeed({ kind: "owner" as const, principalId: "owner", evidenceId: "authenticated" }),
    }).pipe(
      Effect.provide(catalogLayer([provision()])),
      Effect.provide(executorLayer({
        clock: recording.clock, entropy: recording.entropy, observations: { publish: () => undefined },
        policy: compiledPolicy(PROVISION_POLICY_ROWS.map((row: (typeof PROVISION_POLICY_ROWS)[number]) => ({ ...row, generation: 1 }))),
      })),
    );
    return dispatcher;
  });
}

for (const operation of [PROMOTE, MERGE]) {
  for (const decision of ["approve", "refuse"] as const) {
    it(`${operation.op} preserves Owner Wait across SQLite reopen and ${decision} settles exactly once`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "provision-restart-"));
      const dbPath = join(directory, "ledger.sqlite");
      Storage.reset();
      Storage.initialize({ dbPath });
      ActorRegistry.mintProvisional(
        { id: "contact:mallory", kind: "unknown", trustTier: "observer", standing: "provisional" },
        { id: "ep:mallory", channel: "whatsapp", externalId: "mallory" },
      );
      ActorRegistry.registerIdentity({ id: "actor:alice", kind: "human", trustTier: "collaborator" });
      try {
        await runEffect(Effect.scoped(Effect.gen(function* () {
          const initial = yield* requestLedger({ domainRevisions: requestDomainRevisions });
          const crashed = yield* restartDispatcher(crashAfterRequestOpen(initial, "provision.crash"));
          const call = { id: "original", tool: "provision", input: { operation } };
          expect(yield* Effect.either(crashed.executeWave([call], {
            sessionId: initial.identity.sessionId, turnId: initial.identity.turnId,
          }))).toMatchObject({ _tag: "Left", left: { _tag: "ForeignFailure", operation: "provision.crash" } });
          const original = SessionHandleStore.requestRows()[0];
          if (original === undefined) throw new Error("missing Owner request");
          expect(original).toMatchObject({ mode: "approval", state: "open", outcome: null,
            expectedResponders: ["owner"], parsedInput: call.input });
          expect(malloryStanding()).toBe("provisional");
          expect(ActorRegistry.getEndpoint("ep:mallory")?.actorId).toBe("contact:mallory");
          const firstStore = Storage.get();
          Storage.reset();
          Storage.initialize({ dbPath });
          expect(Storage.get()).not.toBe(firstStore);
          expect(SessionHandleStore.requestById(original.requestId)).toEqual(original);
          const ready = Promise.withResolvers<void>();
          const recovered = yield* restartDispatcher(yield* requestLedger({ domainRevisions: requestDomainRevisions }), ready.resolve);
          const recovery = recovered.executor.recover;
          if (recovery === undefined) throw new Error("missing recovery");
          const running = yield* Effect.forkScoped(recovery());
          yield* Effect.promise(() => bounded(ready.promise));
          const approvals = recovered.executor.approvals;
          const pending = approvals?.pending()[0];
          if (approvals === undefined || pending === undefined) throw new Error("missing recovered approval");
          expect(pending.durable).toEqual(original);
          yield* approvals.answer({ request: pending, decision, credential: "owner" });
          yield* Fiber.join(running);
          expect(yield* Effect.either(approvals.answer({ request: pending, decision, credential: "owner" })))
            .toMatchObject({ _tag: "Left", left: { _tag: "ExecutionApprovalError", code: "stale_approval" } });
          expect(SessionHandleStore.requestById(original.requestId)?.state).toBe(decision === "approve" ? "resolved" : "refused");
          const settled = sessionTree(initial.identity.sessionId);
          expect(settled.filter((action: LedgerAction.Node) => action.id === `${original.requestId}:application`))
            .toHaveLength(decision === "approve" ? 1 : 0);
          const result = settled.find((action: LedgerAction.Node) => {
            const value = action.effect.value;
            return action.kind === "tool" && value !== null && typeof value === "object" && !Array.isArray(value)
              && value.phase === "result" && value.callId === call.id;
          });
          expect(result?.effect.value).toMatchObject(decision === "approve"
            ? { terminal: "executed", toolResult: { toolCallId: call.id } }
            : { terminal: "blocked_pre", toolResult: { toolCallId: call.id, isError: true } });
          expect(malloryStanding()).toBe(decision === "approve" && operation.op === "contact_promote" ? "registered" : "provisional");
          expect(ActorRegistry.getEndpoint("ep:mallory")?.actorId)
            .toBe(decision === "approve" && operation.op === "contact_merge" ? "actor:alice" : "contact:mallory");
          yield* recovery();
          expect(sessionTree(initial.identity.sessionId)).toEqual(settled);
        })).pipe(Effect.provide(runnerTestLayer)));
      } finally {
        Storage.reset();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
