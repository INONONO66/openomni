import { afterEach, beforeEach, expect, test } from "bun:test";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { canonicalDigest, type LedgerAction } from "@openomni/protocol";
import { createSessionRequests } from "../src/session-requests";

beforeEach(() => {
  Storage.initialize({ dbPath: ":memory:" });
  SessionHandleStore.materialize({ id: "source", parentId: null, role: "resident", tools: [],
    system: { preset: "", blocks: [] }, policyGeneration: 0, actionId: "configure", at: 1 });
  const actions = Storage.get().actions;
  if (actions === undefined) throw new Error("missing action adapter");
  for (const id of ["first", "second"]) {
    actions.append({ id, sessionId: "source", parentId: "configure", kind: "message",
      intent: { encodingVersion: 1, value: { phase: "intent", value: { messageId: id }, effectHash: canonicalDigest({}) } },
      effect: { encodingVersion: 1, value: { phase: "pending" } }, irreversible: true, ts: 1,
    }, SessionHandleStore.row("source").revision);
  }
});
afterEach(() => Storage.reset());

const opening = (requestId: string) => ({ requestId, sessionId: "source", expectedResponders: ["peer"],
  correlation: {}, allowedActions: ["report_result" as const], resolution: "first" as const,
  threshold: 1, deadline: 200, at: 100 });

test("gateway request port commits physical bindings and receiving intake under a released owner lease", async () => {
  const received: string[] = [];
  const port = createSessionRequests({ clock: () => 100, observations: { publish: () => undefined },
    onInboxCommitted: (ids) => {
      expect(SessionHandleStore.row("source").leaseOwner).toBeNull();
      received.push(...ids);
    },
  });
  const opened = await port.open(opening("first"));
  const request = await port.receipt({ inputId: "physical", requestId: opened.requestId, sessionId: "source",
    sourceActionId: opened.requestId, externalMessageId: "platform", value: "unknown", at: 100 });
  expect(request.correlation.replyToMessageId).toBe("platform");
  expect(request.state).toBe("open");
  const input = { inputId: "answer", requestId: request.requestId, sessionId: "source", receivedAt: 100,
    principal: { kind: "actor" as const, principalId: "peer", evidenceId: "platform-answer" },
    bindingDigest: request.bindingDigest, inputHash: request.inputHash, effectHash: request.effectHash,
    generation: request.generation, toolsHash: request.toolsHash, domainRevisions: {},
    decision: "reply" as const, allowedAction: "report_result" as const, content: "answer",
  };
  expect(await port.answer(input)).toBe("resolved");
  const before = SessionHandleStore.tree("source");
  expect(await port.answer({ ...input, receivedAt: 150 })).toBe("resolved");
  expect(SessionHandleStore.tree("source")).toEqual(before);
  expect(received).toEqual(["source"]);
  expect(SessionHandleStore.inboxRows("source")).toHaveLength(1);
  expect(port.list()[0]?.state).toBe("resolved");
});

test("gateway timeout resolves the original action without creating conversational input", async () => {
  let now = 100;
  const port = createSessionRequests({ clock: () => now, observations: { publish: () => undefined } });
  await port.open(opening("first"));
  await port.expire(199);
  expect(port.list()[0]?.state).toBe("open");
  now = 200;
  await port.expire(now);
  expect(port.list()[0]?.state).toBe("expired");
  expect(SessionHandleStore.inboxRows("source")).toEqual([]);
  const before = SessionHandleStore.tree("source");
  await port.expire(now);
  expect(SessionHandleStore.tree("source")).toEqual(before);
});

test("request opening uses its original turn generation, never a later catalog", async () => {
  const generation = SessionHandleStore.latestGeneration(SessionHandleStore.tree("source"));
  const append = (action: LedgerAction.Append) => {
    if (Storage.get().actions?.append(action, SessionHandleStore.row("source").revision) === undefined) throw new Error("fixture append failed");
  };
  append({ id: "turn", parentId: "configure", sessionId: "source", kind: "turn", ts: 2, irreversible: true,
    intent: { encodingVersion: 1, value: { phase: "intent", resultId: "result", inboxIds: [], resumeCount: 0,
      boundaryActionId: "configure", toolsGeneration: generation.generation, toolsHash: generation.toolsHash,
      systemHash: generation.systemHash, policyGeneration: generation.policyGeneration } },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
  });
  for (const id of ["pinned", "stale", "missing-turn"]) append({
    id, sessionId: "source", parentId: "turn", kind: "message", ts: 3, irreversible: true,
    intent: { encodingVersion: 1, value: { phase: "intent", turnId: id === "missing-turn" ? "absent" : "turn", callId: "call", value: {}, effectHash: canonicalDigest({}) } },
    effect: { encodingVersion: 1, value: { phase: "pending" } },
  });
  const port = createSessionRequests({ clock: () => 100, observations: { publish: () => undefined } });
  expect(await port.open(opening("pinned"))).toMatchObject({ turnId: "turn", callId: "call", toolsGeneration: 1 });
  await expect(port.open(opening("missing-turn"))).rejects.toThrow("original request generation is unavailable");
  const row = SessionHandleStore.row("source");
  const lease = SessionHandleStore.acquireLease({ sessionId: "source", owner: "configure", expectedFence: row.leaseFence, now: 100, expiresAt: 200 });
  if (!lease.ok) throw new Error("configuration lease refused");
  const next = { ...generation, generation: 2, revertTo: 1 };
  expect(SessionHandleStore.commit({ sessionId: "source", owner: "configure", fence: lease.fence, now: 100,
    expectedRevision: row.revision, actions: [SessionHandleStore.configureAction({ id: "next", sessionId: "source", parentId: "configure", operation: "tools.add", snapshot: next, at: 100 })],
    consumeInboxIds: [], state: "idle", releaseLease: true,
    generation: { toolsGeneration: 2, systemHash: next.systemHash, policyGeneration: next.policyGeneration },
  }).ok).toBe(true);
  await expect(port.open(opening("stale"))).rejects.toThrow("request open refused");
});

test("gateway port refuses missing original actions and mismatched physical receipts", async () => {
  const port = createSessionRequests({ clock: () => 100, observations: { publish: () => undefined } });
  await expect(port.open(opening("missing"))).rejects.toThrow("original invocation missing");
  await port.open(opening("first"));
  const before = SessionHandleStore.tree("source");
  await expect(port.receipt({ inputId: "bad", requestId: "first", sessionId: "source", sourceActionId: "second",
    value: "accepted", at: 100 })).rejects.toThrow("request receipt refused");
  expect(SessionHandleStore.tree("source")).toEqual(before);
});
