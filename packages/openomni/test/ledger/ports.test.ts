import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Execution, type Ledger } from "@openomni/protocol";
import {
  WorkerIdentityMismatchError,
  WorkerTransitionForbiddenError,
  assertAuthenticatedWorkerIdentity,
  bindAuthenticatedWorkerKernelPort,
  type AuthenticatedWorkerIdentityV1,
  type KernelQueryPortV1,
  type KernelQueryResultV1,
  type KernelQueryV1,
  type KernelTransitionCommandV1,
  type KernelTransitionPortV1,
} from "../../src/ledger/index.js";
import { parseDefiniteDispatchFailureProofBlob } from "../../src/ledger/production/messaging-access.js";

const identity: AuthenticatedWorkerIdentityV1 = {
  version: "authenticated-worker-identity-v1",
  runtimeId: "runtime-1",
  workerId: "worker-1",
  generation: 3,
  principalId: "principal-1",
  sessionId: "session-1",
  runId: "run-1",
  attemptId: "attempt-1",
};

const head: Ledger.HeadV1 = {
  version: "ledger-head-v1",
  owner: { version: "ledger-owner-v1", ownerKey: "attempt:attempt-1" },
  ownerSeq: 0,
  eventHash: "GENESIS_V1",
};

const attempt: Ledger.AttemptRefV1 = {
  version: "attempt-ref-v1",
  workItemId: "work-1",
  attemptId: identity.attemptId,
  attemptSeq: 1,
};

const digest = "a".repeat(64);
const blob = {
  version: "content-blob-ref-v1" as const,
  digest,
  byteLength: 1,
  mediaType: "application/json",
};
const contentRef = (character: string) => ({ ...blob, digest: character.repeat(64) });
const candidateArtifactRef = contentRef("b");
const model = { provider: "provider", id: "model" } as const;
const runBinding = {
  version: "run-binding-v1" as const,
  workItemId: attempt.workItemId,
  attemptId: attempt.attemptId,
  sessionId: identity.sessionId,
  runId: identity.runId,
};

function at03Payload() {
  const common = { subjectId: identity.attemptId, occurredAtDbMs: 10 };
  const payload = {
    version: "native-transition-payload-v1" as const,
    transitionId: "AT-03" as const,
    command: "kernel.attempt.confirm_running.v1" as const,
    owner: head.owner,
    facts: {
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
      EF: {
        ...common,
        subjectId: "effect-1",
        effect: {
          version: "effect-ref-v1" as const,
          effectId: "effect-1",
          idempotencyKey: "effect-key-1",
        },
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
    },
  };
  Execution.NativeTransitionPayloadSchemasV1["AT-03"].parse(payload);
  return payload;
}

const target = {
  owner: head.owner,
  attempt,
  waitIds: ["wait-1"],
  effects: [
    {
      effect: at03Payload().facts.EF.effect,
      effectScope: at03Payload().facts.EF.effectScope,
    },
  ],
} as const;

describe("kernel Ledger ports", () => {
  test("rejects every authenticated worker identity mismatch", () => {
    for (const field of [
      "runtimeId",
      "workerId",
      "generation",
      "principalId",
      "sessionId",
      "runId",
      "attemptId",
    ] as const) {
      const claimed = {
        ...identity,
        [field]: field === "generation" ? 4 : "forged",
      } as AuthenticatedWorkerIdentityV1;
      expect(() => assertAuthenticatedWorkerIdentity(identity, claimed)).toThrow(
        WorkerIdentityMismatchError,
      );
    }
  });

  test("diagnoses an authenticated identity version mismatch", () => {
    const claimed = {
      ...identity,
      version: "authenticated-worker-identity-v0",
    } as unknown as AuthenticatedWorkerIdentityV1;

    try {
      assertAuthenticatedWorkerIdentity(identity, claimed);
      throw new Error("expected identity mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerIdentityMismatchError);
      expect((error as WorkerIdentityMismatchError).field).toBe("version");
      expect((error as Error).message).toBe("authenticated worker identity mismatch: version");
    }
  });

  test("binds IPC identity, forwards allowed query results, and denies mismatches", async () => {
    let transitionIdentity: AuthenticatedWorkerIdentityV1 | undefined;
    const queryRequests: KernelQueryV1[] = [];
    const transcriptResult: KernelQueryResultV1 = {
      version: "kernel-query-result-v1",
      kind: "authenticated_transcript",
      events: [],
    };
    const attemptResult: KernelQueryResultV1 = {
      version: "kernel-query-result-v1",
      kind: "authenticated_attempt",
      attempt,
      events: [],
    };
    const waitResult: KernelQueryResultV1 = {
      version: "kernel-query-result-v1",
      kind: "authenticated_wait",
      wait: {
        version: "wait.resolved.v1",
        waitId: "wait-1",
        ownerRef: {
          version: "wait-owner-ref-v1",
          kind: "session",
          id: identity.sessionId,
        },
        responseEventIds: ["response-1"],
        quorum: { version: "wait-quorum-v1", required: 1, total: 1 },
        partial: false,
        resolvedAtDbMs: 1,
      },
    };
    const transitions: KernelTransitionPortV1 = {
      async execute(command) {
        transitionIdentity = command.identity;
        return {
          version: "kernel-transition-result-v1",
          status: "rejected",
          code: "transition_forbidden",
        };
      },
    };
    const queries: KernelQueryPortV1 = {
      async query(request) {
        queryRequests.push(request);
        switch (request.kind) {
          case "authenticated_transcript":
            return transcriptResult;
          case "authenticated_attempt":
            return attemptResult;
          case "authenticated_wait":
            return waitResult;
        }
      },
    };
    const bound = bindAuthenticatedWorkerKernelPort(identity, target, transitions, queries);

    await bound.execute({
      version: "kernel-transition-command-v1",
      transitionId: "AT-03",
      command: "kernel.attempt.confirm_running.v1",
      requestId: "request-1",
      requestHash: "a".repeat(64),
      expectedHead: head,
      payload: at03Payload(),
    });
    expect(transitionIdentity).toEqual(identity);

    const forwardedTranscript = await bound.query({
      version: "kernel-query-v1",
      kind: "authenticated_transcript",
      sessionId: identity.sessionId,
      afterOwnerSeq: 7,
    });
    expect(forwardedTranscript).toBe(transcriptResult);
    expect(queryRequests).toEqual([
      {
        version: "kernel-query-v1",
        kind: "authenticated_transcript",
        identity,
        sessionId: identity.sessionId,
        afterOwnerSeq: 7,
      },
    ]);

    const forwardedAttempt = await bound.query({
      version: "kernel-query-v1",
      kind: "authenticated_attempt",
      attempt,
    });
    expect(forwardedAttempt).toBe(attemptResult);
    expect(queryRequests).toEqual([
      {
        version: "kernel-query-v1",
        kind: "authenticated_transcript",
        identity,
        sessionId: identity.sessionId,
        afterOwnerSeq: 7,
      },
      {
        version: "kernel-query-v1",
        kind: "authenticated_attempt",
        identity,
        attempt,
      },
    ]);

    const forwardedWait = await bound.query({
      version: "kernel-query-v1",
      kind: "authenticated_wait",
      waitId: "wait-1",
    });
    expect(forwardedWait).toBe(waitResult);
    expect(queryRequests[2]).toEqual({
      version: "kernel-query-v1",
      kind: "authenticated_wait",
      identity,
      waitId: "wait-1",
    });

    try {
      bound.query({
        version: "kernel-query-v1",
        kind: "authenticated_transcript",
        sessionId: "other",
      });
      throw new Error("expected session identity mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerIdentityMismatchError);
      expect((error as WorkerIdentityMismatchError).field).toBe("sessionId");
    }
    try {
      bound.query({
        version: "kernel-query-v1",
        kind: "authenticated_attempt",
        attempt: { ...attempt, attemptId: "other" },
      });
      throw new Error("expected attempt identity mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerIdentityMismatchError);
      expect((error as WorkerIdentityMismatchError).field).toBe("attemptId");
    }
    expect(queryRequests).toHaveLength(3);
  });

  test("forged caller identity never reaches transition or query delegation", async () => {
    const forgedIdentity = { ...identity, principalId: "principal-forged" };
    let delegatedTransition: KernelTransitionCommandV1 | undefined;
    let delegatedQuery: KernelQueryV1 | undefined;
    const bound = bindAuthenticatedWorkerKernelPort(
      identity,
      target,
      {
        async execute(command) {
          delegatedTransition = command;
          return {
            version: "kernel-transition-result-v1",
            status: "rejected",
            code: "transition_forbidden",
          };
        },
      },
      {
        async query(request) {
          delegatedQuery = request;
          return {
            version: "kernel-query-result-v1",
            kind: "authenticated_transcript",
            events: [],
          };
        },
      },
    );

    await bound.execute({
      version: "kernel-transition-command-v1",
      transitionId: "AT-03",
      command: "kernel.attempt.confirm_running.v1",
      requestId: "request-forged",
      requestHash: "a".repeat(64),
      expectedHead: head,
      payload: at03Payload(),
      identity: forgedIdentity,
    } as Parameters<typeof bound.execute>[0]);
    expect(delegatedTransition?.identity).toEqual(identity);

    await bound.query({
      version: "kernel-query-v1",
      kind: "authenticated_wait",
      waitId: "wait-1",
      identity: forgedIdentity,
    } as Parameters<typeof bound.query>[0]);
    expect(delegatedQuery?.identity).toEqual(identity);
  });

  test("denies every forged server-bound ledger target before generic delegation", () => {
    let transitionCalls = 0;
    let queryCalls = 0;
    const bound = bindAuthenticatedWorkerKernelPort(
      identity,
      target,
      {
        async execute() {
          transitionCalls += 1;
          return {
            version: "kernel-transition-result-v1",
            status: "rejected",
            code: "transition_forbidden",
          };
        },
      },
      {
        async query() {
          queryCalls += 1;
          return {
            version: "kernel-query-result-v1",
            kind: "authenticated_transcript",
            events: [],
          };
        },
      },
    );
    const base = {
      version: "kernel-transition-command-v1",
      transitionId: "AT-03",
      command: "kernel.attempt.confirm_running.v1",
      requestId: "request-bound-target",
      requestHash: "a".repeat(64),
      expectedHead: head,
      payload: at03Payload(),
    } as const;

    const forgedOwner = { version: "ledger-owner-v1", ownerKey: "attempt:other" } as const;
    const forgeries = [
      {
        field: "owner",
        command: {
          ...base,
          expectedHead: { ...head, owner: forgedOwner },
          payload: { ...base.payload, owner: forgedOwner },
        },
      },
      {
        field: "workItemId",
        command: {
          ...base,
          payload: {
            ...base.payload,
            facts: {
              ...base.payload.facts,
              AT: {
                ...base.payload.facts.AT,
                attempt: { ...attempt, workItemId: "work-forged" },
              },
            },
          },
        },
      },
      {
        field: "attemptId",
        command: {
          ...base,
          payload: {
            ...base.payload,
            facts: {
              ...base.payload.facts,
              AT: {
                ...base.payload.facts.AT,
                attempt: { ...attempt, attemptId: "attempt-forged" },
              },
            },
          },
        },
      },
      {
        field: "attemptSeq",
        command: {
          ...base,
          payload: {
            ...base.payload,
            facts: {
              ...base.payload.facts,
              AT: {
                ...base.payload.facts.AT,
                attempt: { ...attempt, attemptSeq: 2 },
              },
            },
          },
        },
      },
      {
        field: "attemptId",
        command: {
          ...base,
          payload: {
            ...base.payload,
            facts: {
              ...base.payload.facts,
              AT: { ...base.payload.facts.AT, subjectId: "attempt-forged" },
            },
          },
        },
      },
    ] as const;

    for (const forgery of forgeries) {
      try {
        bound.execute(forgery.command);
        throw new Error("expected target mismatch");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkerIdentityMismatchError);
        expect((error as WorkerIdentityMismatchError).field).toBe(forgery.field);
      }
    }
    try {
      bound.query({
        version: "kernel-query-v1",
        kind: "authenticated_wait",
        waitId: "wait-forged",
      });
      throw new Error("expected Wait target mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerIdentityMismatchError);
      expect((error as WorkerIdentityMismatchError).field).toBe("waitId");
    }
    expect(transitionCalls).toBe(0);
    expect(queryCalls).toBe(0);
  });
  test("allows exact Worker AT/WI/CP/WT commands and rejects non-Worker operations", async () => {
    const delegated: string[] = [];
    const bound = bindAuthenticatedWorkerKernelPort(
      identity,
      target,
      {
        async execute(command) {
          delegated.push(command.transitionId);
          return {
            version: "kernel-transition-result-v1",
            status: "rejected",
            code: "transition_forbidden",
          };
        },
      },
      {
        async query() {
          return {
            version: "kernel-query-result-v1",
            kind: "authenticated_transcript",
            events: [],
          };
        },
      },
    );
    const command = (transitionId: string, name: string, payload: unknown) =>
      ({
        version: "kernel-transition-command-v1",
        transitionId,
        command: name,
        requestId: `request-${transitionId}`,
        requestHash: digest,
        expectedHead: head,
        payload,
      }) as Parameters<typeof bound.execute>[0];
    const common = { occurredAtDbMs: 10 };
    const allowed = [
      command("AT-03", "kernel.attempt.confirm_running.v1", at03Payload()),
      command("WI-06", "kernel.work.record_evidence.v1", {
        version: "native-transition-payload-v1",
        transitionId: "WI-06",
        command: "kernel.work.record_evidence.v1",
        owner: head.owner,
        facts: {
          WI: {
            ...common,
            subjectId: attempt.workItemId,
            workItemId: attempt.workItemId,
            sessionId: identity.sessionId,
            workSnapshotRef: blob,
          },
        },
      }),
      command("CP-01", "kernel.completion.submit_candidate.v1", {
        version: "native-transition-payload-v1",
        transitionId: "CP-01",
        command: "kernel.completion.submit_candidate.v1",
        owner: head.owner,
        facts: {
          CP: {
            ...common,
            subjectId: attempt.workItemId,
            workItemId: attempt.workItemId,
            candidateId: candidateArtifactRef.digest,
            runBinding,
            runBindingRef: contentRef("e"),
            completionSnapshotRef: contentRef("f"),
            candidateArtifactRef,
            verdictArtifactRef: null,
            admissionDecisionArtifactRef: null,
            verdictArtifactRefs: [],
          },
        },
      }),
      command("WT-08", "kernel.wait.cancel.v1", {
        version: "native-transition-payload-v1",
        transitionId: "WT-08",
        command: "kernel.wait.cancel.v1",
        owner: head.owner,
        facts: {
          WT: {
            ...common,
            subjectId: "wait-1",
            waitEvent: {
              version: "wait.cancelled.v1",
              waitId: "wait-1",
              ownerRef: { version: "wait-owner-ref-v1", kind: "workItem", id: attempt.workItemId },
              cancelledAtDbMs: 10,
              reason: "worker stopped",
            },
            waitSnapshotRef: blob,
          },
        },
      }),
    ];
    const cpFacts = (
      allowed[2]?.payload as {
        facts: {
          CP: {
            candidateArtifactRef: { digest: string };
            completionSnapshotRef: { digest: string };
          };
        };
      }
    ).facts.CP;
    expect(cpFacts.candidateArtifactRef.digest).not.toBe(cpFacts.completionSnapshotRef.digest);
    for (const request of allowed) await bound.execute(request);
    expect(delegated).toEqual(["AT-03", "WI-06", "CP-01", "WT-08"]);

    const denied = [
      command("DP-05", "kernel.dispatch.spawn_worker.v1", {
        version: "native-transition-payload-v1",
        transitionId: "DP-05",
        command: "kernel.dispatch.spawn_worker.v1",
        owner: head.owner,
        facts: {
          DP: {
            ...common,
            subjectId: "dispatch-1",
            dispatchId: "dispatch-1",
            routeId: "route-1",
            sourceSessionId: identity.sessionId,
            sourceOwner: head.owner,
            destinationOwner: head.owner,
            dispatchDecision: "accepted",
            settlement: "pending",
            dispatchSnapshotRef: blob,
            destinationReceiptRef: null,
            definiteFailureProofRef: null,
          },
          WI: {
            ...common,
            subjectId: attempt.workItemId,
            workItemId: attempt.workItemId,
            sessionId: identity.sessionId,
            workSnapshotRef: blob,
          },
          AT: at03Payload().facts.AT,
          EF: at03Payload().facts.EF,
        },
      }),
      command("AF-01", "artifact.put_and_reference.v1", {
        version: "configuration-operation-payload-v1",
        operationId: "AF-01",
        command: "artifact.put_and_reference.v1",
        owner: head.owner,
        subjectId: "artifact-1",
        recordVersion: 1,
        occurredAtDbMs: 10,
        configurationSnapshotRef: blob,
        artifactId: "artifact-1",
        contentRef: blob,
        title: "artifact",
      }),
      command("GR-01", "kernel.grant.create.v1", {
        version: "native-transition-payload-v1",
        transitionId: "GR-01",
        command: "kernel.grant.create.v1",
        owner: head.owner,
        facts: {
          GR: {
            ...common,
            subjectId: "grant-1",
            grantId: "grant-1",
            attempt,
            granteeId: identity.principalId,
            grantScopeRef: blob,
            grantSnapshotRef: blob,
          },
        },
      }),
      command("WI-01", "kernel.work.create.v1", {
        version: "native-transition-payload-v1",
        transitionId: "WI-01",
        command: "kernel.work.create.v1",
        owner: head.owner,
        facts: {
          WI: {
            ...common,
            subjectId: attempt.workItemId,
            workItemId: attempt.workItemId,
            sessionId: identity.sessionId,
            workSnapshotRef: blob,
          },
        },
      }),
      command("SC-01", "kernel.schedule.initialize_or_advance.v1", {
        version: "native-transition-payload-v1",
        transitionId: "SC-01",
        command: "kernel.schedule.initialize_or_advance.v1",
        owner: head.owner,
        facts: {
          SC: {
            ...common,
            subjectId: "schedule-1",
            scheduleId: "schedule-1",
            generation: identity.generation,
            nextFireRef: digest,
            settlementRef: null,
            scheduleSnapshotRef: blob,
          },
        },
      }),
    ];
    for (const request of denied) {
      expect(() => bound.execute(request)).toThrow(WorkerTransitionForbiddenError);
    }
    expect(delegated).toEqual(["AT-03", "WI-06", "CP-01", "WT-08"]);
  });

  test("rejects mixed-family foreign Work, Attempt, run, and effect claims", () => {
    let calls = 0;
    const bound = bindAuthenticatedWorkerKernelPort(
      identity,
      target,
      {
        async execute() {
          calls += 1;
          return {
            version: "kernel-transition-result-v1",
            status: "rejected",
            code: "transition_forbidden",
          };
        },
      },
      {
        async query() {
          return {
            version: "kernel-query-result-v1",
            kind: "authenticated_transcript",
            events: [],
          };
        },
      },
    );
    const base = {
      version: "kernel-transition-command-v1",
      transitionId: "AT-03",
      command: "kernel.attempt.confirm_running.v1",
      requestId: "mixed-foreign",
      requestHash: digest,
      expectedHead: head,
      payload: at03Payload(),
    } as const;
    const mutations = [
      {
        field: "workItemId",
        family: "AT",
        key: "attempt",
        value: { ...attempt, workItemId: "foreign" },
      },
      {
        field: "runId",
        family: "AT",
        key: "runBinding",
        value: { ...runBinding, runId: "foreign" },
      },
      {
        field: "attemptId",
        family: "EF",
        key: "attempt",
        value: { ...attempt, attemptId: "foreign" },
      },
      {
        field: "effectId",
        family: "EF",
        key: "effect",
        value: { ...base.payload.facts.EF.effect, effectId: "foreign" },
      },
    ] as const;
    for (const mutation of mutations) {
      const family = base.payload.facts[mutation.family];
      const request = {
        ...base,
        payload: {
          ...base.payload,
          facts: {
            ...base.payload.facts,
            [mutation.family]: { ...family, [mutation.key]: mutation.value },
          },
        },
      };
      try {
        bound.execute(request);
        throw new Error("expected nested authority mismatch");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkerIdentityMismatchError);
        expect((error as WorkerIdentityMismatchError).field).toBe(mutation.field);
      }
    }
    expect(() =>
      bound.execute({
        version: "kernel-transition-command-v1",
        transitionId: "WT-08",
        command: "kernel.wait.cancel.v1",
        requestId: "foreign-wait",
        requestHash: digest,
        expectedHead: head,
        payload: {
          version: "native-transition-payload-v1",
          transitionId: "WT-08",
          command: "kernel.wait.cancel.v1",
          owner: head.owner,
          facts: {
            WT: {
              subjectId: "wait-1",
              occurredAtDbMs: 10,
              waitEvent: {
                version: "wait.cancelled.v1",
                waitId: "foreign-wait",
                ownerRef: {
                  version: "wait-owner-ref-v1",
                  kind: "workItem",
                  id: attempt.workItemId,
                },
                cancelledAtDbMs: 10,
                reason: "forged",
              },
              waitSnapshotRef: blob,
            },
          },
        },
      }),
    ).toThrow(WorkerIdentityMismatchError);
    expect(calls).toBe(0);
  });

  test("worker face exposes neither raw database nor generic append", () => {
    const bound = bindAuthenticatedWorkerKernelPort(
      identity,
      target,
      {
        async execute() {
          return {
            version: "kernel-transition-result-v1",
            status: "rejected",
            code: "transition_forbidden",
          };
        },
      },
      {
        async query() {
          return {
            version: "kernel-query-result-v1",
            kind: "authenticated_transcript",
            events: [],
          };
        },
      },
    );
    expect(Object.keys(bound).sort()).toEqual(["execute", "query"]);
    expect("append" in bound).toBe(false);
    expect("appendBatch" in bound).toBe(false);
    expect("readBlob" in bound).toBe(false);
    expect("blobs" in bound).toBe(false);
    expect("database" in bound).toBe(false);
    expect("sql" in bound).toBe(false);
  });

  test("host proof blob parsing validates exact byte length and content hash", () => {
    const destinationOwner = {
      version: "ledger-owner-v1" as const,
      ownerKey: "session:destination",
    };
    const proof = {
      version: "definite-dispatch-failure-proof-v1" as const,
      sourceOwnerKey: "session:source",
      dispatchId: "dispatch-1",
      destinationOwnerKey: destinationOwner.ownerKey,
      destinationRequestId: "destination-request-1",
      destinationHead: {
        version: "ledger-head-v1" as const,
        owner: destinationOwner,
        ownerSeq: 0,
        eventHash: "GENESIS_V1" as const,
      },
      destinationState: "absent" as const,
      failureClass: "destination_append_definite_no_materialization" as const,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(proof));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const valid = {
      bytes,
      ref: {
        version: "content-blob-ref-v1" as const,
        digest,
        byteLength: bytes.byteLength,
        mediaType: "application/json",
      },
    };
    expect(parseDefiniteDispatchFailureProofBlob(valid)).toEqual(proof);
    expect(() =>
      parseDefiniteDispatchFailureProofBlob({
        ...valid,
        ref: { ...valid.ref, byteLength: bytes.byteLength + 1 },
      }),
    ).toThrow("metadata is invalid");
    expect(() =>
      parseDefiniteDispatchFailureProofBlob({
        ...valid,
        ref: { ...valid.ref, digest: "f".repeat(64) },
      }),
    ).toThrow("digest is invalid");
  });
});
