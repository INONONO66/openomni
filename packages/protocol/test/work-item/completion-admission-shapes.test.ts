import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { WorkItem } from "../../src/work-item/index.js";

/**
 * Characterization of the completion-admission schema surfaces that
 * duplicate a field map or a refinement today (slop-audit duplication #12
 * `completion-admission.ts:316-322 <-> :496-502`; semantic-audit SYNTHESIS
 * section 1.2 "Completion request/admission identity header" and "Ledger head
 * adjacency"). Consolidating those into one private owner must not change:
 *
 *   - which keys each schema accepts and rejects (`.strict()` is load-bearing);
 *   - the ISSUE PATH and MESSAGE of every refinement, including the order in
 *     which the fact-collection refinements report;
 *   - the head-adjacency rule spelled identically at two sites.
 *
 * Zod field factoring can silently reorder issues or move a path; this file
 * is the pin that makes such a drift fail loudly.
 */

const T0 = 1_700_000_000_000;

function issues(result: z.SafeParseReturnType<unknown, unknown>) {
  if (result.success) throw new Error("expected a parse failure, but parsing succeeded");
  return result.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

function baseRequest() {
  return {
    version: 1 as const,
    id: "req-1",
    origin: "worker" as const,
    workItemHash: "wi-hash-1",
    contractRevision: "contract-1",
    basisRef: "basis-1",
    expectedHead: 3,
    claims: [],
    observations: [],
    results: [],
    invalidations: [],
    verificationErrors: [],
    effects: [],
  };
}

function claim(id: string) {
  return {
    id,
    criterionId: "crit-1",
    statement: "the thing was done",
    observationIds: [],
    basisRef: "basis-1",
    createdAt: T0,
  };
}

function observation(id: string) {
  return {
    id,
    producer: "worker-1",
    subjectRef: "subject-1",
    basisRef: "basis-1",
    artifactRefs: [],
    ancestryRefs: [],
    observedAt: T0,
  };
}

function criterion(id: string) {
  return { id, revision: 1, statement: "the criterion", required: true };
}

describe("CompletionRequest field map and refinements", () => {
  test("accepts the minimal request and every fact collection defaults to empty arrays", () => {
    const parsed = WorkItem.CompletionRequest.parse(baseRequest());
    expect(parsed.claims).toEqual([]);
    expect(parsed.observations).toEqual([]);
    expect(parsed.results).toEqual([]);
    expect(parsed.invalidations).toEqual([]);
    expect(parsed.verificationErrors).toEqual([]);
    expect(parsed.effects).toEqual([]);
    expect(parsed.expectedHead).toBe(3);
  });

  test("is strict: an unknown key is rejected with the unrecognized-keys path", () => {
    const result = WorkItem.CompletionRequest.safeParse({
      ...baseRequest(),
      recordedHead: 4,
    });
    expect(result.success).toBe(false);
    expect(issues(result).some((issue) => /[Uu]nrecognized key/.test(issue.message))).toBe(true);
  });

  test("duplicate fact ids report at [collection, index, 'id'] with the collection name", () => {
    const result = WorkItem.CompletionRequest.safeParse({
      ...baseRequest(),
      claims: [claim("dup-1"), claim("dup-1")],
    });
    expect(issues(result)).toEqual([
      { path: "claims.1.id", message: "duplicate completion fact id: dup-1" },
    ]);
  });

  test("each fact collection reports duplicates under its OWN name, in schema order", () => {
    const result = WorkItem.CompletionRequest.safeParse({
      ...baseRequest(),
      claims: [claim("d-a"), claim("d-a")],
      observations: [observation("d-b"), observation("d-b")],
    });
    expect(issues(result)).toEqual([
      { path: "claims.1.id", message: "duplicate completion fact id: d-a" },
      { path: "observations.1.id", message: "duplicate completion fact id: d-b" },
    ]);
  });

  test("a missing identity-header field reports at its own path", () => {
    const { workItemHash: _omitted, ...withoutHash } = baseRequest();
    expect(issues(WorkItem.CompletionRequest.safeParse(withoutHash))).toEqual([
      { path: "workItemHash", message: expect.any(String) },
    ]);
  });
});

describe("CompletionFacts shares the fact-collection map without sharing its extras", () => {
  function baseFacts() {
    return {
      version: 1 as const,
      revision: 0,
      criteria: [],
      claims: [],
      observations: [],
      results: [],
      invalidations: [],
      verificationErrors: [],
      effects: [],
      requestReservations: [],
      admissions: [],
    };
  }

  test("accepts the minimal facts snapshot", () => {
    const parsed = WorkItem.CompletionFacts.parse(baseFacts());
    expect(parsed.revision).toBe(0);
    expect(parsed.criteria).toEqual([]);
    expect(parsed.admissions).toEqual([]);
  });

  test("reports duplicates for the collections a request does NOT carry", () => {
    const result = WorkItem.CompletionFacts.safeParse({
      ...baseFacts(),
      criteria: [criterion("c-1"), criterion("c-1")],
    });
    expect(issues(result)).toEqual([
      { path: "criteria.1.id", message: "duplicate completion fact id: c-1" },
    ]);
  });

  test("rejects the request-only identity header (facts is a snapshot, not a request)", () => {
    const result = WorkItem.CompletionFacts.safeParse({
      ...baseFacts(),
      workItemHash: "wi-hash-1",
    });
    expect(result.success).toBe(false);
    expect(issues(result).some((issue) => /[Uu]nrecognized key/.test(issue.message))).toBe(true);
  });
});

describe("ledger head adjacency is one rule spelled at every head-bearing site", () => {
  function baseReservation() {
    return {
      version: 1 as const,
      id: "res-1",
      requestId: "req-1",
      requestRoot: "root-1",
      envelopeDigest: "digest-1",
      expectedHead: 3,
      recordedHead: 4,
      createdAt: T0,
    };
  }

  test("a reservation whose recordedHead does not follow expectedHead is rejected", () => {
    expect(
      issues(
        WorkItem.CompletionRequestReservation.safeParse({
          ...baseReservation(),
          recordedHead: 9,
        }),
      ),
    ).toEqual([
      { path: "recordedHead", message: "recordedHead must immediately follow expectedHead" },
    ]);
  });

  test("the adjacent reservation parses and defaults fence to 0", () => {
    const parsed = WorkItem.CompletionRequestReservation.parse(baseReservation());
    expect(parsed.recordedHead).toBe(parsed.expectedHead + 1);
    expect(parsed.fence).toBe(0);
  });

  test("an admission carries the identical head-adjacency message and path", () => {
    const admission = {
      version: 1 as const,
      id: "adm-1",
      requestId: "req-1",
      workItemHash: "wi-hash-1",
      origin: "worker" as const,
      contractRevision: "contract-1",
      basisRef: "basis-1",
      requestRoot: "root-1",
      proposedFactIds: {
        claims: [],
        observations: [],
        results: [],
        invalidations: [],
        verificationErrors: [],
        effects: [],
      },
      effectiveResultIds: [],
      unresolvedCriterionIds: [],
      decision: "admit" as const,
      reasonCodes: [],
      residualRisks: [],
      policyRef: "policy-1",
      expectedHead: 3,
      recordedHead: 9,
      completionReportRef: "report-1",
      createdAt: T0,
    };
    const reported = issues(WorkItem.CompletionAdmission.safeParse(admission));
    expect(reported).toContainEqual({
      path: "recordedHead",
      message: "recordedHead must immediately follow expectedHead",
    });
  });
});
