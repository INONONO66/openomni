import { describe, expect, test } from "bun:test";
import { Execution, type Ledger } from "@openomni/protocol";
import {
  createKernelLedgerRuntime,
  type KernelCommittedObservationV1,
} from "../../src/ledger/runtime.js";
import type {
  AuthoritativeWriterPortV1,
  KernelOwnerEventReaderPortV1,
  KernelLedgerIncidentV1,
  KernelProjectionPortV1,
} from "../../src/ledger/ports.js";

const digest = "a".repeat(64);
const owner = { version: "ledger-owner-v1", ownerKey: "session:session-1" } as const;
const genesis = {
  version: "ledger-head-v1",
  owner,
  ownerSeq: 0,
  eventHash: "GENESIS_V1",
} as const;
const identity = {
  version: "authenticated-worker-identity-v1",
  runtimeId: "runtime-1",
  workerId: "worker-1",
  generation: 1,
  principalId: "principal-1",
  sessionId: "session-1",
  runId: "run-1",
  attemptId: "attempt-1",
} as const;
const destinationOwner = {
  version: "ledger-owner-v1",
  ownerKey: "session:destination",
} as const;

function destinationGuardCommand(): Execution.KernelTransitionCommandV1 {
  return Execution.KernelTransitionCommandV1.parse({
    version: "kernel-transition-command-v1",
    transitionId: "XD-01",
    command: "kernel.cross_owner.deliver_pending.v1",
    requestId: "request-destination",
    requestHash: digest,
    identity,
    expectedHead: genesis,
    payload: {
      version: "native-transition-payload-v1",
      transitionId: "XD-01",
      command: "kernel.cross_owner.deliver_pending.v1",
      owner,
      facts: {
        DP: {
          subjectId: "dispatch-1",
          occurredAtDbMs: 1,
          dispatchId: "dispatch-1",
          routeId: "route-1",
          sourceSessionId: "session-1",
          sourceOwner: owner,
          destinationOwner,
          dispatchDecision: "accepted",
          settlement: "pending",
          dispatchSnapshotRef: {
            version: "content-blob-ref-v1",
            digest,
            byteLength: 1,
            mediaType: "application/json",
          },
          destinationReceiptRef: null,
          definiteFailureProofRef: null,
        },
        EF: {
          subjectId: "effect-1",
          occurredAtDbMs: 1,
          effect: {
            version: "effect-ref-v1",
            effectId: "effect-1",
            idempotencyKey: "dispatch-1",
          },
          attempt: {
            version: "attempt-ref-v1",
            workItemId: "work-1",
            attemptId: "attempt-1",
            attemptSeq: 1,
          },
          effectScope: {
            version: "effect-scope-v1",
            workspace: {
              canonicalizerVersion: "workspace-v1",
              workspaceId: `w1:${digest}`,
              canonicalBytesDigest: digest,
            },
            resources: [
              {
                version: "resource-scope-v1",
                kind: "workspace",
                target: "**",
              },
            ],
            resolver: { id: "resolver", version: "v1", inputDigest: digest },
            containment: "filesystem-canonicalized",
            mutationClass: "mutating",
          },
          effectScopeRef: {
            version: "content-blob-ref-v1",
            digest,
            byteLength: 1,
            mediaType: "application/json",
          },
          settlement: "pending",
          effectSettlementRef: {
            version: "content-blob-ref-v1",
            digest,
            byteLength: 1,
            mediaType: "application/json",
          },
        },
      },
    },
  });
}

function command(): Execution.KernelTransitionCommandV1 {
  return {
    version: "kernel-transition-command-v1",
    transitionId: "SS-01",
    command: "messaging.session.open.v1",
    requestId: "request-1",
    requestHash: digest,
    identity,
    expectedHead: genesis,
    payload: {
      version: "native-transition-payload-v1",
      transitionId: "SS-01",
      command: "messaging.session.open.v1",
      owner,
      facts: {
        SS: {
          subjectId: "session-1",
          occurredAtDbMs: 1,
          sessionId: "session-1",
          parentSessionId: null,
          model: { provider: "test", id: "model" },
          sessionSnapshotRef: {
            version: "content-blob-ref-v1",
            digest,
            byteLength: 1,
            mediaType: "application/json",
          },
        },
      },
    },
  };
}

function receipt(request = command()): Ledger.AppendReceiptV1 {
  return {
    version: "ledger-append-receipt-v1",
    requestId: request.requestId,
    requestHash: request.requestHash,
    principalId: request.identity.principalId,
    owner,
    previousHead: genesis,
    head: { version: "ledger-head-v1", owner, ownerSeq: 1, eventHash: "b".repeat(64) },
    firstLedgerSeq: 1,
    lastLedgerSeq: 1,
    eventIds: [`${request.requestId}:${request.transitionId}:1`],
    receiptHash: "c".repeat(64),
  };
}

function harness(
  options: {
    head?: Ledger.HeadV1;
    failAppend?: "append" | "projection" | "timeout" | "cancelled" | "unknown";

    failObservation?: boolean;
    failIncidentSink?: boolean;
    failProjection?: boolean;
    failReadHead?: boolean;
  } = {},
) {
  const calls: Ledger.AppendBatchRequestV1[] = [];
  const observations: KernelCommittedObservationV1[] = [];
  const incidents: KernelLedgerIncidentV1[] = [];

  const writer: AuthoritativeWriterPortV1 = {
    async appendBatch(request) {
      calls.push(request);
      if (options.failAppend !== undefined) {
        const code =
          options.failAppend === "projection"
            ? "projection_failed"
            : options.failAppend === "timeout"
              ? "timeout"
              : options.failAppend === "cancelled"
                ? "cancelled"
                : options.failAppend === "unknown"
                  ? "unknown_error"
                  : "storage_unavailable";
        throw Object.assign(new Error("raw writer failure must not cross boundary"), { code });
      }

      return receipt(command());
    },
    async findReceipt() {
      return null;
    },
    async readHead(requestOwner) {
      if (options.failReadHead) throw new Error("unknown read failure");
      return options.head ?? { ...genesis, owner: requestOwner };
    },
  };
  const ownerEvents: KernelOwnerEventReaderPortV1 = {
    async readOwnerEvents() {
      return [];
    },
  };
  const projections: KernelProjectionPortV1 = {
    async query(request) {
      if (options.failProjection) throw new Error("projection secret must not cross boundary");

      if (request.kind !== "authenticated_transcript") throw new Error("not used");
      return { version: "kernel-query-result-v1", kind: request.kind, messages: [] };
    },
  };
  return {
    calls,
    observations,
    incidents,

    runtime: createKernelLedgerRuntime({
      writer,
      ownerEvents,
      projections,
      incidentSink: {
        report(incident) {
          if (options.failIncidentSink) throw new Error("incident sink secret");
          incidents.push(incident);
        },
      },

      publishObservation: (observation) => {
        if (options.failObservation) throw new Error("observer unavailable");
        observations.push(observation);
      },
    }),
  };
}

describe("KernelLedgerRuntime", () => {
  test("uses one semantic gate and one writer call, then observes the commit", async () => {
    const { runtime, calls, observations } = harness();
    const result = await runtime.execute(command());

    expect(result.status).toBe("committed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.batch.events.map((event) => event.eventType)).toEqual(["session.opened.v1"]);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.eventIds).toEqual(["request-1:SS-01:1"]);
  });

  test("keeps the committed result and reports when lossy Bus observation fails", async () => {
    const { runtime, calls, observations, incidents } = harness({ failObservation: true });
    expect(await runtime.execute(command())).toMatchObject({ status: "committed" });
    expect(calls).toHaveLength(1);
    expect(observations).toHaveLength(0);
    expect(incidents).toEqual([
      {
        version: "kernel-ledger-incident-v1",
        failureClass: "observation_publication",
        outcome: "committed",
        code: "observation_publication_failed",
        occurrence: 1,
      },
    ]);
  });

  test("unknown commands and head conflicts write and publish nothing", async () => {
    const unknown = harness();
    expect(await unknown.runtime.execute({ ...command(), transitionId: "SS-99" } as never)).toEqual(
      {
        version: "kernel-transition-result-v1",
        status: "rejected",
        code: "transition_forbidden",
      },
    );
    expect(unknown.calls).toHaveLength(0);
    expect(unknown.observations).toHaveLength(0);
    expect(unknown.incidents).toEqual([
      expect.objectContaining({ failureClass: "transition_parse", occurrence: 1 }),
    ]);

    const conflict = harness({
      head: {
        version: "ledger-head-v1",
        owner,
        ownerSeq: 1,
        eventHash: "d".repeat(64),
      },
    });
    expect(await conflict.runtime.execute(command())).toMatchObject({
      status: "rejected",
      code: "head_conflict",
    });
    expect(conflict.calls).toHaveLength(0);
    expect(conflict.observations).toHaveLength(0);
    expect(conflict.incidents).toEqual([
      expect.objectContaining({ failureClass: "transition_guard", code: "head_conflict" }),
    ]);
  });

  test("does not infer definite failure from pre-append or ambiguous XD-01 errors", async () => {
    const definite = harness();
    expect(await definite.runtime.execute(destinationGuardCommand())).toEqual({
      version: "kernel-transition-result-v1",
      status: "rejected",
      code: "transition_forbidden",
    });
    expect(definite.calls).toHaveLength(0);

    const ambiguousRead = harness({ failReadHead: true });
    expect(await ambiguousRead.runtime.execute(destinationGuardCommand())).toEqual({
      version: "kernel-transition-result-v1",
      status: "rejected",
      code: "transition_forbidden",
    });
    expect(ambiguousRead.calls).toHaveLength(0);
  });

  test("append and projection failures are typed, sanitized, and never observed as committed", async () => {
    for (const failureClass of ["append", "projection"] as const) {
      const { runtime, calls, observations, incidents } = harness({ failAppend: failureClass });
      expect(await runtime.execute(command())).toEqual({
        version: "kernel-transition-result-v1",
        status: "rejected",
        code: "transition_forbidden",
      });
      expect(calls).toHaveLength(1);
      expect(observations).toHaveLength(0);
      expect(incidents).toEqual([
        {
          version: "kernel-ledger-incident-v1",
          failureClass,
          outcome: "rejected",
          code: "transition_forbidden",
          occurrence: 1,
        },
      ]);
      expect(JSON.stringify(incidents)).not.toContain("raw writer failure");
    }
  });

  test("does not infer definite no-materialization from timeout, cancellation, or unknown append errors", async () => {
    for (const failure of ["timeout", "cancelled", "unknown"] as const) {
      const attempted = harness({ failAppend: failure });
      expect(await attempted.runtime.execute(command())).toEqual({
        version: "kernel-transition-result-v1",
        status: "rejected",
        code: "transition_forbidden",
      });
      expect(attempted.calls).toHaveLength(1);
    }
  });

  test("exposes only the closed projection query union", async () => {
    const { runtime } = harness();
    await expect(
      runtime.query({
        version: "kernel-query-v1",
        kind: "authenticated_transcript",
        identity,
        sessionId: identity.sessionId,
      }),
    ).resolves.toEqual({
      version: "kernel-query-result-v1",
      kind: "authenticated_transcript",
      messages: [],
    });
    await expect(runtime.query({ kind: "raw_sql" } as never)).rejects.toThrow();
  });

  test("reports projection failures and counts a throwing incident sink without recursion", async () => {
    const projection = harness({ failProjection: true });
    await expect(
      projection.runtime.query({
        version: "kernel-query-v1",
        kind: "authenticated_transcript",
        identity,
        sessionId: identity.sessionId,
      }),
    ).rejects.toThrow("Kernel projection failed");
    expect(projection.incidents).toEqual([
      expect.objectContaining({ failureClass: "projection", code: "projection_failed" }),
    ]);
    expect(JSON.stringify(projection.incidents)).not.toContain("projection secret");

    const trapped = harness({ failObservation: true, failIncidentSink: true });
    expect(await trapped.runtime.execute(command())).toMatchObject({ status: "committed" });
    expect(trapped.runtime.diagnosticCounters()).toEqual({
      transitionParse: 0,
      transitionGuard: 0,
      append: 0,
      projection: 0,
      observationPublication: 1,
      incidentSink: 1,
    });
  });
});
