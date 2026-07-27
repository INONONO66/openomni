import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Execution, type Ledger } from "@openomni/protocol";
import { nativeTransitionById } from "../../src/ledger/native-transitions.js";
import type { ProductionStructuralCompositionV1 } from "../../src/ledger/production/adapters.js";
import {
  IllegalDispatchTransitionError,
  emptyDispatchProjection,
  reduceDispatch,
  type DispatchProjectionV1,
} from "../../src/ledger/reducers/dispatch.js";
import {
  crossOwnerDestinationRequestId,
  IllegalRouteDispatchTransitionError,
  prepareRouteDispatchTransition,
  type RouteDispatchProjectionV1,
} from "../../src/ledger/transitions/route-dispatch.js";

const digest = "a".repeat(64);
const owner = { version: "ledger-owner-v1", ownerKey: "session:source" } as const;
const destinationOwner = { version: "ledger-owner-v1", ownerKey: "work:destination" } as const;
const blob = {
  version: "content-blob-ref-v1" as const,
  digest,
  byteLength: 1,
  mediaType: "application/json",
};
const model = { provider: "provider", id: "model" } as const;
const runBinding = {
  version: "run-binding-v1" as const,
  workItemId: "work-1",
  attemptId: "attempt-1",
  sessionId: "session-1",
  runId: "run-1",
};
const attempt = {
  version: "attempt-ref-v1" as const,
  workItemId: "work-1",
  attemptId: "attempt-1",
  attemptSeq: 1,
};

const head = (target: Ledger.OwnerV1, ownerSeq = 0): Ledger.HeadV1 => ({
  version: "ledger-head-v1",
  owner: target,
  ownerSeq,
  eventHash: ownerSeq === 0 ? "GENESIS_V1" : "b".repeat(64),
});
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

const ids = [
  ...Array.from({ length: 17 }, (_, index) => `RT-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 24 }, (_, index) => `DP-${String(index + 1).padStart(2, "0")}`),
  "XD-01",
  "XD-02",
  "XD-03",
] as const;

function command(id: string, subjectId = `dispatch-${id}`): Execution.KernelTransitionCommandV1 {
  const row = nativeTransitionById(id);
  const common = { subjectId, occurredAtDbMs: 10 };
  const factsByFamily = {
    SS: {
      ...common,
      sessionId: "session-1",
      parentSessionId: null,
      model,
      sessionSnapshotRef: blob,
    },
    SF: {
      ...common,
      sessionId: "session-1",
      surfaceId: "surface-1",
      surfaceKind: "direct",
      endpointId: "endpoint-1",
      surfaceSnapshotRef: blob,
    },
    MS: {
      ...common,
      sessionId: "session-1",
      surfaceId: "surface-1",
      messageId: "message-1",
      partId: null,
      role: "user" as const,
      status: "complete",
      model: null,
      messageSnapshotRef: blob,
      partSnapshotRef: null,
    },
    RT: {
      ...common,
      sessionId: "session-1",
      surfaceId: "surface-1",
      messageId: "message-1",
      routeId: `route-${id}`,
      routeDecision: "deliver",
      authoritySnapshotRef: blob,
      routeSnapshotRef: blob,
    },
    DP: {
      ...common,
      dispatchId: subjectId,
      routeId: `route-${id}`,
      sourceSessionId: "session-1",
      sourceOwner: owner,
      destinationOwner,
      dispatchDecision: "deliver",
      settlement: id === "XD-03" ? ("definite_failed" as const) : ("pending" as const),
      dispatchSnapshotRef: blob,
      destinationReceiptRef: id === "XD-02" ? blob : null,
      definiteFailureProofRef: id === "XD-03" ? { ...blob, digest: "d".repeat(64) } : null,
    },
    WI: {
      ...common,
      workItemId: "work-1",
      sessionId: "session-1",
      workSnapshotRef: blob,
    },
    CP: {
      ...common,
      workItemId: "work-1",
      candidateId: blob.digest,
      runBinding,
      runBindingRef: blob,
      completionSnapshotRef: blob,
      candidateArtifactRef: blob,
      verdictArtifactRef: null,
      admissionDecisionArtifactRef: null,
      verdictArtifactRefs: [],
    },
    AT: {
      ...common,
      attempt,
      runBinding,
      model,
      environmentRef: {
        version: "llm-environment-v1" as const,
        catalogSchemaVersion: 1,
        catalogSource: "bundled" as const,
        catalogSourceVersion: "v1",
        catalogDigest: digest,
        modelDigest: digest,
        endpoint: {
          version: "llm-endpoint-ref-v1" as const,
          kind: "default" as const,
          valueRef: "default",
          endpointDigest: digest,
        },
        credential: {
          version: "credential-source-ref-v1" as const,
          providerId: "provider",
          authType: "api" as const,
          credentialId: "credential-1",
          rotationId: "rotation-1",
          sourceKind: "default_file" as const,
          sourcePathDigest: digest,
          credentialDigest: digest,
        },
        sdkPackage: "sdk",
        adapterVersion: "v1",
        environmentDigest: digest,
      },
      environmentSnapshotRef: blob,
      attemptSnapshotRef: blob,
    },
    WT: {
      ...common,
      waitEvent: {
        version: "wait.cancelled.v1" as const,
        waitId: "wait-1",
        ownerRef: {
          version: "wait-owner-ref-v1" as const,
          kind: "session" as const,
          id: "session-1",
        },
        cancelledAtDbMs: 10,
        reason: "cancelled",
      },
      waitSnapshotRef: blob,
    },
    GR: {
      ...common,
      grantId: "grant-1",
      attempt,
      granteeId: "actor-1",
      grantScopeRef: blob,
      grantSnapshotRef: blob,
    },
    SC: {
      ...common,
      scheduleId: "schedule-1",
      generation: 1,
      nextFireRef: digest,
      settlementRef: digest,
      scheduleSnapshotRef: blob,
    },
    EF: {
      ...common,
      effect: { version: "effect-ref-v1" as const, effectId: "effect-1", idempotencyKey: "key-1" },
      attempt,
      effectScope: {
        version: "effect-scope-v1" as const,
        workspace: {
          canonicalizerVersion: "workspace-v1" as const,
          workspaceId: `w1:${digest}`,
          canonicalBytesDigest: digest,
        },
        resources: [
          {
            version: "resource-scope-v1" as const,
            kind: "workspace" as const,
            target: "**" as const,
          },
        ],
        resolver: { id: "resolver", version: "v1", inputDigest: digest },
        containment: "filesystem-canonicalized" as const,
        mutationClass: "mutating" as const,
      },
      effectScopeRef: blob,
      settlement: "pending" as const,
      effectSettlementRef: blob,
    },
  } as const;
  const facts = Object.fromEntries(
    Execution.NativeTransitionFactFamiliesV1[id as Execution.NativeTransitionIdV1].map((family) => [
      family,
      factsByFamily[family],
    ]),
  );
  const commandOwner = owner;
  return Execution.KernelTransitionCommandV1.parse({
    version: "kernel-transition-command-v1",
    transitionId: id,
    command: row.command,
    requestId: `request-${id}`,
    requestHash: digest,
    identity,
    expectedHead: head(commandOwner),
    payload: {
      version: "native-transition-payload-v1",
      transitionId: id,
      command: row.command,
      owner: commandOwner,
      facts,
    },
  });
}

function event(
  eventType: Ledger.NativeEventTypeV1,
  subjectId = "dispatch-1",
  eventId = `${eventType}:1`,
): Ledger.EventV1 {
  return {
    version: "ledger-event-v1",
    eventId,
    eventType,
    eventVersion: 1,
    owner,
    payload: {
      version: "native-event-payload-v1",
      eventType,
      subjectId,
      occurredAtDbMs: 10,
      dispatchId: subjectId,
      routeId: "route-1",
      sourceSessionId: "session-1",
      sourceOwner: owner,
      destinationOwner,
      dispatchDecision: "deliver",
      settlement:
        eventType === "dispatch.failed.v1"
          ? "definite_failed"
          : eventType === "dispatch.delivered.v1"
            ? "delivered"
            : "pending",
      dispatchSnapshotRef: {
        version: "content-blob-ref-v1",
        digest,
        byteLength: 1,
        mediaType: "application/json",
      },
      destinationReceiptRef: eventType === "dispatch.delivered.v1" ? blob : null,
      definiteFailureProofRef:
        eventType === "dispatch.failed.v1" ? { ...blob, digest: "d".repeat(64) } : null,
    },
    provenance: {
      version: "native-event-provenance-v1",
      principalId: identity.principalId,
      requestId: "request-1",
    },
  };
}

function foldDispatch(...eventTypes: Ledger.NativeEventTypeV1[]): DispatchProjectionV1 {
  return eventTypes.reduce(
    (projection, eventType, index) =>
      reduceDispatch(projection, event(eventType, "dispatch-1", `${eventType}:${index}`)),
    emptyDispatchProjection(),
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new TypeError("Receipt canonical JSON cannot encode undefined");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function destinationReceipt(
  overrides: Partial<Omit<Ledger.AppendReceiptV1, "receiptHash">> = {},
  receiptHash?: string,
): Ledger.AppendReceiptV1 {
  const requestId = crossOwnerDestinationRequestId({
    sourceOwnerKey: owner.ownerKey,
    dispatchId: "dispatch-1",
  });
  const receiptWithoutHash = {
    version: "ledger-append-receipt-v1" as const,
    requestId,
    requestHash: "b".repeat(64),
    principalId: identity.principalId,
    owner: destinationOwner,
    previousHead: head(destinationOwner),
    head: {
      version: "ledger-head-v1" as const,
      owner: destinationOwner,
      ownerSeq: 2,
      eventHash: "c".repeat(64),
    },
    firstLedgerSeq: 1,
    lastLedgerSeq: 2,
    eventIds: [`${requestId}:XD-01:1`, `${requestId}:XD-01:2`],
    ...overrides,
  };
  return {
    ...receiptWithoutHash,
    receiptHash:
      receiptHash ?? createHash("sha256").update(canonicalJson(receiptWithoutHash)).digest("hex"),
  };
}

function definiteFailure(
  overrides: Partial<{
    sourceOwnerKey: string;
    dispatchId: string;
    destinationOwnerKey: string;
    destinationRequestId: string;
    destinationHead: Ledger.HeadV1;
    destinationState: "absent";
    failureClass: "destination_append_definite_no_materialization";
  }> = {},
): NonNullable<RouteDispatchProjectionV1["definiteFailure"]> {
  return {
    ref: { ...blob, digest: "d".repeat(64) },
    proof: {
      version: "definite-dispatch-failure-proof-v1",
      sourceOwnerKey: owner.ownerKey,
      dispatchId: "dispatch-1",
      destinationOwnerKey: destinationOwner.ownerKey,
      destinationRequestId: crossOwnerDestinationRequestId({
        sourceOwnerKey: owner.ownerKey,
        dispatchId: "dispatch-1",
      }),
      destinationHead: head(destinationOwner),
      destinationState: "absent",
      failureClass: "destination_append_definite_no_materialization",
      ...overrides,
    },
  };
}

function projectionFor(id: string): RouteDispatchProjectionV1 {
  const base: RouteDispatchProjectionV1 = {
    routeDecisions: new Set(),
    dispatch: emptyDispatchProjection(),
    effectIntents: new Set(),
  };
  if (id === "XD-01") {
    return {
      ...base,
      dispatch: foldDispatch("dispatch.pending.v1"),
      destinationHead: head(destinationOwner),
      destinationDispatch: emptyDispatchProjection(),
    };
  }
  if (id === "XD-02") {
    return {
      ...base,
      dispatch: foldDispatch("dispatch.pending.v1"),
      destinationReceipt: destinationReceipt(),
    };
  }
  if (id === "XD-03") {
    return {
      ...base,
      dispatch: foldDispatch("dispatch.pending.v1"),
      destinationHead: head(destinationOwner),
      destinationDispatch: emptyDispatchProjection(),
      definiteFailure: definiteFailure(),
    };
  }
  const row = nativeTransitionById(id);
  return row.emission.kind === "cross-owner"
    ? { ...base, destinationHead: head(destinationOwner) }
    : base;
}

function expectedTypes(id: string): readonly string[] {
  const emission = nativeTransitionById(id).emission;
  if (id === "XD-01") {
    if (emission.kind !== "cross-owner") throw new Error("bad fixture");
    return emission.destinationEventTypes;
  }
  if (emission.kind === "batch") return emission.eventTypes;
  if (emission.kind === "conditional-batch") return emission.sourceRunEventTypes;
  if (emission.kind === "cross-owner") return emission.sourceEventTypes;
  return [];
}

describe("K4 route and dispatch transition families", () => {
  test("prepares every RT-01..17, DP-01..24, and XD-01..03 operation exactly", () => {
    expect(ids).toHaveLength(44);
    for (const id of ids) {
      const prepared = prepareRouteDispatchTransition(
        command(id, id.startsWith("XD-") ? "dispatch-1" : undefined),
        projectionFor(id),
      );
      expect(prepared.eventTypes, id).toEqual(expectedTypes(id));
      expect(
        prepared.append.batch.events.map(({ eventType }) => eventType),
        id,
      ).toEqual(expectedTypes(id));
      expect(
        prepared.append.batch.events.every(
          ({ owner: eventOwner }) => eventOwner.ownerKey === prepared.owner.ownerKey,
        ),
        id,
      ).toBe(true);
    }
  });

  test("is deterministic and keeps each prepared append single-owner", () => {
    for (const id of ids) {
      const input = command(id, id.startsWith("XD-") ? "dispatch-1" : undefined);
      const projection = projectionFor(id);
      const first = prepareRouteDispatchTransition(input, projection);
      const second = prepareRouteDispatchTransition(input, projection);
      expect(second, id).toEqual(first);
      expect(Object.isFrozen(first), id).toBe(true);
      expect(Object.isFrozen(first.events), id).toBe(true);
      expect(
        new Set(first.events.map(({ owner: eventOwner }) => eventOwner.ownerKey)).size,
        id,
      ).toBe(1);
    }
  });

  test("prepares cross-owner source, destination, and settlement as separate durable phases", () => {
    const source = prepareRouteDispatchTransition(command("DP-12"), {
      routeDecisions: new Set(),
      dispatch: emptyDispatchProjection(),
      effectIntents: new Set(),
      destinationHead: head(destinationOwner),
    });
    expect(source.phase).toBe("source");
    expect(source.owner).toEqual(owner);
    expect(source.eventTypes).toEqual(["dispatch.decision.v1", "dispatch.pending.v1"]);

    const destination = prepareRouteDispatchTransition(
      command("XD-01", "dispatch-1"),
      projectionFor("XD-01"),
    );
    expect(destination.phase).toBe("destination");
    expect(destination.owner).toEqual(destinationOwner);
    expect(destination.eventTypes).toEqual(["dispatch.received.v1", "effect.intent.v1"]);

    const settlement = prepareRouteDispatchTransition(
      command("XD-02", "dispatch-1"),
      projectionFor("XD-02"),
    );
    expect(settlement.phase).toBe("settlement");
    expect(settlement.owner).toEqual(owner);
    expect(settlement.eventTypes).toEqual(["dispatch.delivered.v1"]);

    const failure = prepareRouteDispatchTransition(
      command("XD-03", "dispatch-1"),
      projectionFor("XD-03"),
    );
    expect(failure.phase).toBe("settlement");
    expect(failure.owner).toEqual(owner);
    expect(failure.eventTypes).toEqual(["dispatch.failed.v1"]);
    expect(failure.events[0]?.payload.settlement).toBe("definite_failed");
    expect(failure.evidenceRefs).toEqual([definiteFailure().ref]);
    expect(() =>
      prepareRouteDispatchTransition(command("XD-03", "dispatch-1"), {
        ...projectionFor("XD-03"),
        dispatch: foldDispatch("dispatch.pending.v1", "dispatch.failed.v1"),
      }),
    ).toThrow("source_pending_required");
  });

  test("keeps definite no-materialization an explicit strict rejected-result classification", () => {
    expect(
      Execution.KernelTransitionResultV1.parse({
        version: "kernel-transition-result-v1",
        status: "rejected",
        code: "transition_forbidden",
        definiteFailureClass: "destination_append_definite_no_materialization",
      }),
    ).toEqual({
      version: "kernel-transition-result-v1",
      status: "rejected",
      code: "transition_forbidden",
      definiteFailureClass: "destination_append_definite_no_materialization",
    });
    expect(() =>
      Execution.KernelTransitionResultV1.parse({
        version: "kernel-transition-result-v1",
        status: "rejected",
        code: "transition_forbidden",
        definiteFailureClass: "timeout",
      }),
    ).toThrow();
    expect(() =>
      Execution.KernelTransitionResultV1.parse({
        version: "kernel-transition-result-v1",
        status: "rejected",
        code: "transition_forbidden",
        timeoutDefinite: true,
      }),
    ).toThrow();
  });

  test("keeps the production composition limited to structural services and closed queries", () => {
    const keys: Readonly<Record<keyof ProductionStructuralCompositionV1, true>> = {
      queries: true,
      structural: true,
    };
    expect(Object.keys(keys).sort()).toEqual(["queries", "structural"]);
  });

  test("binds XD-01 delivery and XD-02 settlement to one semantic destination receipt", () => {
    const deliveryCommand = {
      ...command("XD-01", "dispatch-1"),
      requestHash: "b".repeat(64),
    } as Execution.KernelTransitionCommandV1;
    const settlementCommand = command("XD-02", "dispatch-1");
    const delivery = prepareRouteDispatchTransition(deliveryCommand, projectionFor("XD-01"));
    const settlement = prepareRouteDispatchTransition(settlementCommand, {
      ...projectionFor("XD-02"),
      destinationReceipt: destinationReceipt(),
    });

    expect(delivery.append.requestId).toBe(
      crossOwnerDestinationRequestId({
        sourceOwnerKey: owner.ownerKey,
        dispatchId: "dispatch-1",
      }),
    );
    expect(delivery.append.requestHash).not.toBe(settlement.append.requestHash);
    expect(settlement.phase).toBe("settlement");
    expect(settlement.append.requestId).toBe(`${settlementCommand.requestId}:settlement`);
    expect(() =>
      prepareRouteDispatchTransition(settlementCommand, {
        routeDecisions: new Set(),
        dispatch: foldDispatch("dispatch.pending.v1", "dispatch.delivered.v1"),
        effectIntents: new Set(),
        destinationReceipt: destinationReceipt(),
      }),
    ).toThrow("source_pending_required");
  });

  test("rejects destination receipts with the wrong request, owner, principal, events, or receipt hash", () => {
    const settlementCommand = command("XD-02", "dispatch-1");
    const base = projectionFor("XD-02");
    const rejects = (receipt: Ledger.AppendReceiptV1, reason: string) =>
      expect(() =>
        prepareRouteDispatchTransition(settlementCommand, {
          ...base,
          destinationReceipt: receipt,
        }),
      ).toThrow(reason);

    rejects(
      destinationReceipt({ requestId: "wrong-request" }),
      "destination_receipt_request_mismatch",
    );
    rejects(destinationReceipt({ owner }), "destination_receipt_owner_mismatch");
    rejects(
      destinationReceipt({ principalId: "wrong-principal" }),
      "destination_receipt_principal_mismatch",
    );
    rejects(
      destinationReceipt({ eventIds: ["wrong-event", "wrong-event-2"] }),
      "destination_receipt_events_mismatch",
    );
    rejects(destinationReceipt({}, "f".repeat(64)), "destination_receipt_hash_mismatch");
  });

  test("keeps settlement pending when no durable destination receipt exists", () => {
    expect(() =>
      prepareRouteDispatchTransition(command("XD-02", "dispatch-1"), {
        routeDecisions: new Set(),
        dispatch: foldDispatch("dispatch.pending.v1"),
        effectIntents: new Set(),
      }),
    ).toThrow("destination_receipt_required");
  });

  test("folds legal source and destination lifecycles into projection-sufficient state", () => {
    const source = foldDispatch(
      "dispatch.decision.v1",
      "dispatch.pending.v1",
      "dispatch.delivered.v1",
    );
    expect(source.records.get("dispatch-1")).toMatchObject({
      status: "delivered",
      decisionEventId: "dispatch.decision.v1:0",
      pendingEventId: "dispatch.pending.v1:1",
      settlementEventId: "dispatch.delivered.v1:2",
      snapshotRef: digest,
    });
    expect(foldDispatch("dispatch.received.v1").records.get("dispatch-1")).toMatchObject({
      status: "received",
      receivedEventId: "dispatch.received.v1:0",
    });
    expect(
      foldDispatch("dispatch.pending.v1", "dispatch.failed.v1").records.get("dispatch-1")?.status,
    ).toBe("failed");
  });

  test("rejects exact illegal dispatch reducer edges", () => {
    const illegal: ReadonlyArray<readonly [Ledger.NativeEventTypeV1[], Ledger.NativeEventTypeV1]> =
      [
        [[], "dispatch.delivered.v1"],
        [[], "dispatch.failed.v1"],
        [["dispatch.decision.v1"], "dispatch.received.v1"],
        [["dispatch.pending.v1"], "dispatch.pending.v1"],
        [["dispatch.received.v1"], "dispatch.delivered.v1"],
        [["dispatch.delivered.v1"], "dispatch.decision.v1"],
        [["dispatch.failed.v1"], "dispatch.pending.v1"],
      ];
    for (const [prior, next] of illegal) {
      expect(() => reduceDispatch(foldDispatch(...prior), event(next))).toThrow(
        IllegalDispatchTransitionError,
      );
    }
  });

  test("rejects forged closed-catalog facts from authoritative empty history", () => {
    const bad: ReadonlyArray<readonly [Execution.KernelTransitionCommandV1, string]> = [
      [command("RT-12"), "route_identity_mismatch"],
      [command("DP-05"), "work_identity_mismatch"],
      [command("DP-07"), "attempt_binding_mismatch"],
    ];
    for (const [input, reason] of bad) {
      expect(() =>
        prepareRouteDispatchTransition(input, {
          routeDecisions: new Set(),
          dispatch: emptyDispatchProjection(),
          effectIntents: new Set(),
          ownerEvents: [],
        }),
      ).toThrow(reason);
    }
  });
  test("rejects duplicate route/dispatch/effect intent before preparation", () => {
    expect(() =>
      prepareRouteDispatchTransition(command("RT-01", "route-1"), {
        routeDecisions: new Set(["route-1"]),
        dispatch: emptyDispatchProjection(),
        effectIntents: new Set(),
      }),
    ).toThrow("route_already_decided");

    expect(() =>
      prepareRouteDispatchTransition(command("DP-01", "dispatch-1"), {
        routeDecisions: new Set(),
        dispatch: foldDispatch("dispatch.decision.v1"),
        effectIntents: new Set(),
      }),
    ).toThrow("dispatch_already_exists");

    expect(() =>
      prepareRouteDispatchTransition(command("DP-19", "effect-1"), {
        routeDecisions: new Set(),
        dispatch: emptyDispatchProjection(),
        effectIntents: new Set(["effect-1"]),
      }),
    ).toThrow("effect_already_pending");
  });

  test("fails closed on every missing or contradictory cross-owner proof", () => {
    const pending = foldDispatch("dispatch.pending.v1");
    const base = {
      routeDecisions: new Set<string>(),
      dispatch: pending,
      effectIntents: new Set<string>(),
    };

    expect(() => prepareRouteDispatchTransition(command("XD-01", "dispatch-1"), base)).toThrow(
      "destination_head_required",
    );
    expect(() =>
      prepareRouteDispatchTransition(command("XD-01", "dispatch-1"), {
        ...base,
        destinationHead: head(owner),
      }),
    ).toThrow("cross_owner_destination_required");
    expect(() => prepareRouteDispatchTransition(command("XD-02", "dispatch-1"), base)).toThrow(
      "destination_receipt_required",
    );
    expect(() => prepareRouteDispatchTransition(command("XD-03", "dispatch-1"), base)).toThrow(
      "definite_failure_proof_required",
    );
    expect(() =>
      prepareRouteDispatchTransition(command("XD-03", "dispatch-1"), {
        ...base,
        destinationReceipt: destinationReceipt(),
      }),
    ).toThrow("destination_already_committed");

    const xd03 = command("XD-03", "dispatch-1");
    const failureBase = projectionFor("XD-03");
    expect(() =>
      prepareRouteDispatchTransition(xd03, {
        ...failureBase,
        definiteFailure: definiteFailure({ dispatchId: "other-dispatch" }),
      }),
    ).toThrow("definite_failure_proof_identity_mismatch");
    expect(() =>
      prepareRouteDispatchTransition(xd03, {
        ...failureBase,
        definiteFailure: definiteFailure({
          destinationHead: { ...head(destinationOwner), ownerSeq: 1 },
        }),
      }),
    ).toThrow("definite_failure_proof_head_mismatch");
    expect(() =>
      prepareRouteDispatchTransition(xd03, {
        ...failureBase,
        definiteFailure: {
          ...definiteFailure(),
          proof: {
            ...definiteFailure().proof,
            destinationState: "unknown",
          } as unknown as NonNullable<RouteDispatchProjectionV1["definiteFailure"]>["proof"],
        },
      }),
    ).toThrow("definite_failure_proof_ambiguous");
    expect(() =>
      prepareRouteDispatchTransition(xd03, {
        ...failureBase,
        definiteFailure: {
          ...definiteFailure(),
          proof: {
            ...definiteFailure().proof,
            failureClass: "timeout",
          } as unknown as NonNullable<RouteDispatchProjectionV1["definiteFailure"]>["proof"],
        },
      }),
    ).toThrow("definite_failure_class_ambiguous");

    expect(() =>
      prepareRouteDispatchTransition(command("XD-01", "dispatch-1"), {
        ...projectionFor("XD-01"),
        destinationDispatch: foldDispatch("dispatch.received.v1"),
      }),
    ).toThrow(IllegalRouteDispatchTransitionError);
  });
});
