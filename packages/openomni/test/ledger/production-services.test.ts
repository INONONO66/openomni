import { describe, expect, test } from "bun:test";
import { Execution } from "@openomni/protocol";
import { Ledger as SessionLedger } from "@openomni/session";
import type { MessagingLedgerTransition } from "../../src/ingress/session-resolver.js";
import {
  createProductionKernelServices,
  createProductionSnapshotBlob,
} from "../../src/ledger/production-services.js";
import { createProductionKernelStructuralPorts } from "../../src/ledger/production/adapters.js";
import {
  createMessagingAccessServices,
  type BlocklistProjectionV1,
  type MessagingAccessProjectionReaderV1,
  type MessagingProjectionV1,
  type SessionProjectionV1,
} from "../../src/ledger/production/messaging-access.js";

const digest = "a".repeat(64);
const surfaceKey = "discord:owner:direct";

function residentEffectScope(): Execution.EffectScopeV1 {
  return Execution.EffectScopeV1.parse({
    version: "effect-scope-v1",
    workspace: {
      canonicalizerVersion: "workspace-v1",
      workspaceId: `w1:${digest}`,
      canonicalBytesDigest: digest,
    },
    resources: [
      {
        version: "resource-scope-v1",
        kind: "registered",
        variant: "resident_run.v1",
        targetDigest: digest,
      },
    ],
    resolver: { id: "test", version: "1", inputDigest: digest },
    containment: "none",
    mutationClass: "mutating",
  });
}

const projectionSource = Object.freeze({
  ownerKey: "configuration:test",
  sourceEventId: "event-1",
  sourceOwnerSeq: 1,
  sourceLedgerSeq: 1,
  sourceOwnerHash: digest,
  asOfLedgerSeq: 1,
});

function messagingServices(
  overrides: Partial<MessagingAccessProjectionReaderV1>,
): ReturnType<typeof createMessagingAccessServices> {
  const projections: MessagingAccessProjectionReaderV1 = {
    session: async () => undefined,
    surfaceBinding: async () => undefined,
    messagesBySession: async () => [],
    actorIdentity: async () => undefined,
    actorEndpoint: async () => undefined,
    blocklistEntries: async () => [],
    channelGrant: async () => undefined,
    attemptByRunId: async () => undefined,
    workerAttemptGrants: async () => [],
    effect: async () => undefined,
    ...overrides,
  };
  return createMessagingAccessServices({
    transitions: { commit: async () => ({ status: "committed", receiptId: "receipt-1" }) },
    projections,
    snapshot: (family, state) =>
      createProductionSnapshotBlob({ version: `${family}-projection-state-v1`, state }),
    residentEffectScope,
  });
}

function command(
  sessionId: string,
  requestId: string,
): Extract<MessagingLedgerTransition, { kind: "RT-12" }> {
  return {
    kind: "RT-12",
    requestId,
    surfaceKey,
    sessionId,
    event: {
      id: `inbound:${requestId}`,
      surface: "discord",
      payload: { text: requestId },
      mode: "direct",
      agent: { model: { provider: "test", id: "model" } },
    },
    messageId: `message:${requestId}`,
    partId: `part:${requestId}`,
    effectId: `effect:${requestId}`,
    text: requestId,
    title: requestId,
    model: { providerID: "test", modelID: "model" },
    recordedAt: 1,
  };
}

function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

describe("production messaging surface claims", () => {
  test("atomically rejects one of two stale concurrent RT-12 claims", async () => {
    const runtime = SessionLedger.openLedgerRuntime({ dbPath: ":memory:" });
    const structural = createProductionKernelStructuralPorts(runtime, {
      identity: {
        runtimeId: "runtime",
        workerId: "resident",
        generation: 1,
        principalId: "owner",
      },
      clock: { now: () => 1 },
      incidentSink: { report: () => undefined },
    });
    const originalProjections = structural.structural.messagingAccess.projections;
    let surfaceReads = 0;
    let releaseReads: (() => void) | undefined;
    const bothRead = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const projections = {
      ...originalProjections,
      async surfaceBinding(key: string) {
        const observed = await originalProjections.surfaceBinding(key);
        surfaceReads += 1;
        if (surfaceReads === 2) requireValue(releaseReads, "read barrier release is missing")();
        await bothRead;
        return observed;
      },
    };
    const messaging = createMessagingAccessServices({
      transitions: structural.structural.messagingAccess.transitions,
      projections,
      snapshot: (family, state) =>
        createProductionSnapshotBlob({ version: `${family}-projection-state-v1`, state }),
      residentEffectScope,
    }).messaging;
    const claims = [command("session-a", "request-a"), command("session-b", "request-b")];

    try {
      const results = await Promise.all(claims.map((claim) => messaging.execute(claim)));
      const winnerIndex = results.findIndex((result) => result.status === "committed");
      const loserIndex = winnerIndex === 0 ? 1 : 0;
      const winner = requireValue(claims[winnerIndex], "winning claim is missing");
      const loser = requireValue(claims[loserIndex], "losing claim is missing");

      expect(results.filter((result) => result.status === "committed")).toHaveLength(1);
      expect(results[loserIndex]).toEqual({ status: "rejected", code: "head_conflict" });
      expect(await messaging.query({ kind: "surface", surfaceKey })).toEqual({
        kind: "surface",
        sessionId: winner.sessionId,
      });
      expect(await messaging.query({ kind: "session", sessionId: loser.sessionId })).toEqual({
        kind: "session",
        session: null,
      });
      expect(
        await runtime.query((query) =>
          query
            .eventsByLedgerSequence({ throughLedgerSeq: 100 })
            .filter((envelope) => envelope.event.owner.ownerKey === `session:${loser.sessionId}`),
        ),
      ).toEqual([]);

      expect(await messaging.execute(winner)).toMatchObject({ status: "committed" });
      expect(
        await runtime.query((query) => query.eventsByLedgerSequence({ throughLedgerSeq: 100 })),
      ).toHaveLength(7);
    } finally {
      await runtime.close();
    }
  });

  test("effect settlement returns only its settlement result, not a fabricated ingress receipt", async () => {
    const runtime = SessionLedger.openLedgerRuntime({ dbPath: ":memory:" });
    const structural = createProductionKernelStructuralPorts(runtime, {
      identity: {
        runtimeId: "runtime",
        workerId: "resident",
        generation: 1,
        principalId: "owner",
      },
      clock: { now: () => 1 },
      incidentSink: { report: () => undefined },
    });
    const messaging = createMessagingAccessServices({
      transitions: structural.structural.messagingAccess.transitions,
      projections: structural.structural.messagingAccess.projections,
      snapshot: (family, state) =>
        createProductionSnapshotBlob({ version: `${family}-projection-state-v1`, state }),
      residentEffectScope,
    }).messaging;
    const ingress = command("session-settlement", "request-settlement");

    try {
      expect(await messaging.execute(ingress)).toMatchObject({ status: "committed" });
      const result = await messaging.execute({
        kind: "EF-01",
        requestId: "settlement-request",
        sessionId: ingress.sessionId,
        effectId: ingress.effectId,
        sourceRef: ingress.event.id,
        settledAt: 2,
        outcome: {
          status: "confirmed",
          result: {
            mode: "direct",
            target: { kind: "resident" },
            sessionId: ingress.sessionId,
            result: { output: "done", finishReason: "stop" },
          },
        },
      });

      expect(result).toEqual({ status: "committed" });
      expect(JSON.stringify(result)).not.toContain("settlement");
    } finally {
      await runtime.close();
    }
  });

  test("rejects forged self-consistent links and incorrect canonical event hashes", async () => {
    const runtime = SessionLedger.openLedgerRuntime({ dbPath: ":memory:" });
    const structural = createProductionKernelStructuralPorts(runtime, {
      identity: {
        runtimeId: "runtime",
        workerId: "resident",
        generation: 1,
        principalId: "owner",
      },
      clock: { now: () => 1 },
      incidentSink: { report: () => undefined },
    });
    const messaging = createMessagingAccessServices({
      transitions: structural.structural.messagingAccess.transitions,
      projections: structural.structural.messagingAccess.projections,
      snapshot: (family, state) =>
        createProductionSnapshotBlob({ version: `${family}-projection-state-v1`, state }),
      residentEffectScope,
    }).messaging;
    const ingress = command("session-integrity", "request-integrity");

    try {
      expect(await messaging.execute(ingress)).toMatchObject({ status: "committed" });
      const events = await structural.structural.views.sessionEvents(ingress.sessionId);
      const forgedHash = "b".repeat(64);
      const forged = events.map((envelope, index) => ({
        ...envelope,
        ...(index === 0 ? { eventHash: forgedHash } : {}),
        ...(index === 1 ? { previousEventHash: forgedHash } : {}),
      }));
      const services = createProductionKernelServices({
        ...structural.structural,
        views: {
          ...structural.structural.views,
          sessionEvents: async () => forged,
        },
        config: {
          model: { provider: "test", id: "model" },
          modelEnvironment: {} as Execution.LLMEnvironmentV1,
          workspaceIdentity: {
            canonicalRoot: "/workspace",
            workspaceId: `w1:${digest}`,
          },
        } as never,
        clock: { now: () => 1 },
        incidents: { report: () => undefined },
        host: { observe: async () => undefined },
      });

      await expect(services.observabilityQueries.session(ingress.sessionId)).resolves.toMatchObject(
        {
          chainIntegrity: { valid: false, eventCount: events.length },
        },
      );
    } finally {
      await runtime.close();
    }
  });
});

describe("production messaging projection reads", () => {
  test("returns every canonical transcript message and part", async () => {
    const rows: readonly MessagingProjectionV1[] = [
      {
        ...projectionSource,
        ownerKey: "session:session-1",
        messageId: "message-1",
        sessionId: "session-1",
        state: {
          id: "message-1",
          sessionId: "session-1",
          role: "user",
          parts: [
            { type: "text", text: "hello" },
            { type: "artifact", text: "artifact-1" },
          ],
        },
      },
    ];
    const { messaging } = messagingServices({ messagesBySession: async () => rows });

    await expect(messaging.query({ kind: "transcript", sessionId: "session-1" })).resolves.toEqual({
      kind: "transcript",
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "hello" },
            { type: "artifact", text: "artifact-1" },
          ],
        },
      ],
    });
  });

  test("fails closed on every malformed transcript row and part", async () => {
    const malformedStates = [
      { role: "system", parts: [] },
      { role: "user", parts: "not-an-array" },
      { role: "assistant", parts: [null] },
      { role: "assistant", parts: [{}] },
      { role: "assistant", parts: [{ type: "text", text: 1 }] },
    ];

    for (const [index, state] of malformedStates.entries()) {
      const rows: readonly MessagingProjectionV1[] = [
        {
          ...projectionSource,
          ownerKey: "session:session-1",
          messageId: `message-${index}`,
          sessionId: "session-1",
          state: { id: `message-${index}`, sessionId: "session-1", ...state },
        },
      ];
      const { messaging } = messagingServices({ messagesBySession: async () => rows });
      await expect(
        messaging.query({ kind: "transcript", sessionId: "session-1" }),
      ).rejects.toMatchObject({ code: "messaging_projection_invalid" });
    }
  });

  test("rejects transcript rows bound to another session", async () => {
    const row: MessagingProjectionV1 = {
      ...projectionSource,
      ownerKey: "session:session-other",
      messageId: "message-cross-session",
      sessionId: "session-other",
      state: {
        id: "message-cross-session",
        sessionId: "session-other",
        role: "assistant",
        parts: [{ type: "text", text: "not yours" }],
      },
    };
    const { messaging } = messagingServices({ messagesBySession: async () => [row] });
    await expect(
      messaging.query({ kind: "transcript", sessionId: "session-1" }),
    ).rejects.toMatchObject({ code: "messaging_projection_invalid" });
  });

  test("accepts only the canonical nested session snapshot bound to the requested session", async () => {
    const sessionState = {
      id: "session-1",
      title: "Session",
      model: { providerID: "test", modelID: "model" },
      time: { created: 1, updated: 2 },
    };
    const row = (
      state: unknown,
      sessionId = "session-1",
      ownerKey = `session:${sessionId}`,
    ): SessionProjectionV1 => ({
      ...projectionSource,
      ownerKey,
      sessionId,
      state,
    });
    const canonical = messagingServices({
      session: async () => row(sessionState),
    });
    await expect(
      canonical.messaging.query({ kind: "session", sessionId: "session-1" }),
    ).resolves.toMatchObject({
      session: { id: "session-1", title: "Session" },
    });

    for (const malformed of [
      row({ version: "session-projection-state-v1", state: sessionState }),
      row({ ...sessionState, id: "session-other" }),
      row(sessionState, "session-other"),
      row(sessionState, "session-1", "session:other"),
      row({ ...sessionState, time: null }),
    ]) {
      const services = messagingServices({ session: async () => malformed });
      await expect(
        services.messaging.query({ kind: "session", sessionId: "session-1" }),
      ).rejects.toMatchObject({ code: "messaging_projection_invalid" });
    }
  });

  test("accepts only canonical nested blacklist entries bound to their projection id", async () => {
    const entry = {
      id: "blacklist-1",
      kind: "actor" as const,
      value: "actor-1",
      createdBy: "owner",
    };
    const query = {
      kind: "authority.blacklist_match" as const,
      actorId: "actor-1",
      candidates: ["actor-1"],
    };
    const row = (state: unknown, blacklistId = entry.id): BlocklistProjectionV1 => ({
      ...projectionSource,
      ownerKey: `blacklist:${blacklistId}`,
      blacklistId,
      state,
    });

    const canonical = messagingServices({ blocklistEntries: async () => [row({ entry })] });
    await expect(canonical.authority.query(query)).resolves.toMatchObject({ entry });

    const flatLegacy = messagingServices({ blocklistEntries: async () => [row(entry)] });
    await expect(flatLegacy.authority.query(query)).resolves.toMatchObject({ entry: null });

    const mismatched = messagingServices({
      blocklistEntries: async () => [row({ entry }, "different-blacklist-id")],
    });
    await expect(mismatched.authority.query(query)).resolves.toMatchObject({ entry: null });
  });
});
