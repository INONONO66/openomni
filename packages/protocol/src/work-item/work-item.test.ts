import { describe, expect, test } from "bun:test";
import { WorkItem } from "./index.js";

const baseItem = {
  hash: "wi_000000000001",
  revision: 0,
  name: "Implement WorkItem namespace",
  sourceMessageId: "msg_1",
  sourceChannel: "discord",
  attempt: 1,
  timestamps: {
    created: 1,
    updated: 1,
  },
  relations: {
    childHashes: [],
    dependsOn: [],
  },
  intent: "build",
  goal: "add work item contracts",
  blockers: [],
  evidence: [],
  constraints: [],
  acceptanceCriteria: ["add work item contracts"],
  changedFiles: [],
  completionContract: {
    version: 1 as const,
    revision: "contract:v1",
    basisRef: "basis:v1",
  },
  completionFacts: {
    ...WorkItem.emptyCompletionFacts(),
    criteria: [
      {
        id: WorkItem.criterionId("wi_000000000001", 0, "add work item contracts"),
        revision: 1,
        statement: "add work item contracts",
        required: true,
      },
    ],
  },
};

const validCompletionReport = {
  summary: "Implemented the requested schema delta.",
  claims: [
    {
      statement: "Focused protocol tests passed.",
      evidenceIds: ["ev_test_protocol"],
    },
  ],
  caveats: ["Runtime evidence gate remains pending."],
  followUps: ["Wire completion-report verification gate."],
};

describe("WorkItem.Info", () => {
  test("parses valid data", () => {
    const item = WorkItem.Info.parse(baseItem);

    expect(item.hash).toBe(baseItem.hash);
    expect(item.relations.childHashes).toEqual([]);
    expect(item.relations.dependsOn).toEqual([]);
  });

  test("requires current WorkItems to carry non-empty stable completion criteria", () => {
    const currentCompletion = {
      completionContract: {
        version: 1 as const,
        revision: "contract:v1",
        basisRef: "basis:v1",
      },
      completionFacts: {
        ...WorkItem.emptyCompletionFacts(),
        criteria: [
          {
            id: WorkItem.criterionId(baseItem.hash, 0, "Protocol contracts are implemented"),
            revision: 1,
            statement: "Protocol contracts are implemented",
            required: true,
          },
        ],
      },
    };

    const item = WorkItem.Info.parse({
      ...baseItem,
      acceptanceCriteria: ["Protocol contracts are implemented"],
      ...currentCompletion,
    });
    const missingAcceptanceCriteria = WorkItem.Info.safeParse({
      ...baseItem,
      ...currentCompletion,
    });
    const missingStableCriteria = WorkItem.Info.safeParse({
      ...baseItem,
      acceptanceCriteria: ["Protocol contracts are implemented"],
      completionContract: currentCompletion.completionContract,
      completionFacts: WorkItem.emptyCompletionFacts(),
    });

    expect(item.completionFacts.criteria[0]?.id).toBe(
      WorkItem.criterionId(baseItem.hash, 0, "Protocol contracts are implemented"),
    );
    expect({
      missingAcceptanceCriteria: missingAcceptanceCriteria.success,
      missingStableCriteria: missingStableCriteria.success,
    }).toEqual({ missingAcceptanceCriteria: false, missingStableCriteria: false });
  });

  test("rejects forged, reordered, mismatched, and optional persisted acceptance criteria", () => {
    const first = "first acceptance criterion";
    const second = "second acceptance criterion";
    const criteria = [first, second].map((statement, index) => ({
      id: WorkItem.criterionId(baseItem.hash, index, statement),
      revision: 1,
      statement,
      required: true,
    }));
    const current = {
      ...baseItem,
      acceptanceCriteria: [first, second],
      completionFacts: { ...WorkItem.emptyCompletionFacts(), criteria },
    };
    const [firstCriterion, secondCriterion] = criteria;
    if (!firstCriterion || !secondCriterion) throw new Error("missing fixture criteria");

    const candidates = [
      {
        ...current,
        completionFacts: {
          ...current.completionFacts,
          criteria: [{ ...firstCriterion, id: "criterion:forged" }, secondCriterion],
        },
      },
      {
        ...current,
        completionFacts: {
          ...current.completionFacts,
          criteria: [secondCriterion, firstCriterion],
        },
      },
      {
        ...current,
        acceptanceCriteria: ["mismatched acceptance criterion", second],
      },
      {
        ...current,
        completionFacts: {
          ...current.completionFacts,
          criteria: [{ ...firstCriterion, required: false }, secondCriterion],
        },
      },
    ];

    expect(WorkItem.Info.safeParse(current).success).toBe(true);
    expect(candidates.map((candidate) => WorkItem.Info.safeParse(candidate).success)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  test("parses ADR-011 ledger routing, completion report, retry, and outcome fields", () => {
    const item = WorkItem.Info.parse({
      ...baseItem,
      originSessionId: "session_owner",
      workSessionId: "session_worker",
      workerRunId: "wr_1",
      executorKind: "connector_endpoint",
      maxAttempts: 2,
      outcome: "adopted",
      completionReport: validCompletionReport,
      evidence: [
        {
          id: "ev_read_back",
          kind: "verification",
          description: "Fetched published URL and found expected text.",
          passed: true,
          createdAt: 2,
          readBack: {
            kind: "url_fetch",
            target: "https://example.com/post",
            passed: true,
            observedAt: 2,
            statusCode: 200,
            matchedText: "published headline",
          },
        },
      ],
    });

    expect(item.originSessionId).toBe("session_owner");
    expect(item.workSessionId).toBe("session_worker");
    expect(item.workerRunId).toBe("wr_1");
    expect(item.executorKind).toBe("connector_endpoint");
    expect(item.maxAttempts).toBe(2);
    expect(item.outcome).toBe("adopted");
    expect(item.completionReport?.claims[0]?.evidenceIds).toEqual(["ev_test_protocol"]);
    expect(item.evidence[0]?.readBack?.kind).toBe("url_fetch");
  });

  test("parses read-back verification check variants", () => {
    expect(
      WorkItem.ReadBackCheck.parse({
        kind: "url_fetch",
        target: "https://example.com/post",
        passed: true,
        observedAt: 2,
        statusCode: 200,
        matchedText: "published headline",
      }),
    ).toMatchObject({ kind: "url_fetch", passed: true });

    expect(
      WorkItem.ReadBackCheck.parse({
        kind: "api_query",
        target: "calendar:event/123",
        passed: true,
        observedAt: 3,
        method: "GET",
        statusCode: 200,
        responseDigest: "sha256:abc123",
      }),
    ).toMatchObject({ kind: "api_query", method: "GET" });

    expect(
      WorkItem.ReadBackCheck.parse({
        kind: "citation_match",
        target: "https://example.com/source",
        passed: true,
        observedAt: 4,
        quotedText: "source sentence",
        matchedText: "source sentence",
      }),
    ).toMatchObject({ kind: "citation_match", quotedText: "source sentence" });
  });

  test("rejects invalid data", () => {
    expect(() =>
      WorkItem.Info.parse({
        ...baseItem,
        sourceMessageId: undefined,
      }),
    ).toThrow();
  });

  test("rejects invalid ADR-011 schema delta values", () => {
    for (const field of ["originSessionId", "workSessionId", "workerRunId"] as const) {
      expect(() =>
        WorkItem.Info.parse({
          ...baseItem,
          [field]: "",
        }),
      ).toThrow();
    }

    expect(() =>
      WorkItem.Info.parse({
        ...baseItem,
        executorKind: "spreadsheet_macro",
      }),
    ).toThrow();

    expect(() =>
      WorkItem.Info.parse({
        ...baseItem,
        outcome: "self_reported_success",
      }),
    ).toThrow();

    expect(() =>
      WorkItem.Info.parse({
        ...baseItem,
        maxAttempts: 0,
      }),
    ).toThrow();

    expect(() =>
      WorkItem.ReadBackCheck.parse({
        kind: "url_fetch",
        target: "",
        passed: true,
        observedAt: 2,
      }),
    ).toThrow();

    expect(() =>
      WorkItem.ReadBackCheck.parse({
        kind: "citation_match",
        target: "https://example.com/source",
        passed: true,
        observedAt: 4,
        statusCode: 404,
        quotedText: "source sentence",
        matchedText: "source sentence",
      }),
    ).toThrow();

    expect(() =>
      WorkItem.ReadBackCheck.parse({
        kind: "citation_match",
        target: "https://example.com/source",
        passed: true,
        observedAt: 4,
        quotedText: "",
      }),
    ).toThrow();

    expect(() =>
      WorkItem.ReadBackCheck.parse({
        kind: "url_fetch",
        target: "https://example.com/post",
        passed: true,
        observedAt: 2,
        statusCode: 404,
      }),
    ).toThrow();

    expect(() =>
      WorkItem.ReadBackCheck.parse({
        kind: "citation_match",
        target: "https://example.com/source",
        passed: true,
        observedAt: 4,
        quotedText: "source sentence",
      }),
    ).toThrow();

    expect(() =>
      WorkItem.Evidence.parse({
        id: "ev_read_back",
        kind: "verification",
        description: "read-back result",
        passed: true,
        createdAt: 4,
        readBack: {
          kind: "url_fetch",
          target: "https://example.com/post",
          passed: false,
          observedAt: 4,
          statusCode: 404,
        },
      }),
    ).toThrow();
  });

  test("rejects malformed read-back request targets without throwing from safeParse", () => {
    for (const target of [
      "not a url",
      "ftp://example.com/post",
      "file:///tmp/post",
      "javascript:alert(1)",
    ]) {
      const result = WorkItem.ReadBackRequest.safeParse({
        kind: "url_fetch",
        target,
      });

      expect(result.success).toBe(false);
    }

    expect(
      WorkItem.ReadBackRequest.safeParse({
        kind: "url_fetch",
        target: "https://example.com/post",
      }).success,
    ).toBe(true);
  });

  test("rejects invalid completion report constraints", () => {
    expect(() =>
      WorkItem.CompletionReport.parse({
        ...validCompletionReport,
        summary: "",
      }),
    ).toThrow();

    expect(() =>
      WorkItem.CompletionReport.parse({
        ...validCompletionReport,
        claims: [],
      }),
    ).toThrow();

    expect(() =>
      WorkItem.CompletionReport.parse({
        ...validCompletionReport,
        caveats: [""],
      }),
    ).toThrow();

    expect(() =>
      WorkItem.CompletionReport.parse({
        ...validCompletionReport,
        followUps: [""],
      }),
    ).toThrow();

    expect(() =>
      WorkItem.CompletionReport.parse({
        ...validCompletionReport,
        claims: [
          {
            statement: "",
            evidenceIds: ["ev_test_protocol"],
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      WorkItem.CompletionReport.parse({
        ...validCompletionReport,
        claims: [
          {
            statement: "Tests passed.",
            evidenceIds: [],
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      WorkItem.CompletionReport.parse({
        ...validCompletionReport,
        claims: [
          {
            statement: "Tests passed.",
            evidenceIds: [""],
          },
        ],
      }),
    ).toThrow();
  });

  test("parses all executorKind and outcome literals", () => {
    const executorKinds = [
      "internal_chat_agent",
      "connector_endpoint",
      "external_api",
      "a2a",
      "human_channel",
    ] as const;
    const outcomes = ["adopted", "corrected", "redone", "ignored"] as const;

    for (const executorKind of executorKinds) {
      expect(WorkItem.ExecutorKind.parse(executorKind)).toBe(executorKind);
    }
    for (const outcome of outcomes) {
      expect(WorkItem.Outcome.parse(outcome)).toBe(outcome);
    }

    expect(() => WorkItem.ExecutorKind.parse("spreadsheet_macro")).toThrow();
    expect(() => WorkItem.Outcome.parse("self_reported_success")).toThrow();
  });
});

describe("WorkItem.deriveStatus", () => {
  test("returns cancelled when cancelled timestamp is set", () => {
    expect(
      WorkItem.deriveStatus({
        ...WorkItem.Info.parse(baseItem),
        timestamps: {
          ...baseItem.timestamps,
          cancelled: 4,
        },
      }),
    ).toBe("cancelled");
  });

  test("returns failed when failed timestamp is set", () => {
    expect(
      WorkItem.deriveStatus({
        ...WorkItem.Info.parse(baseItem),
        timestamps: {
          ...baseItem.timestamps,
          failed: 4,
        },
      }),
    ).toBe("failed");
  });

  test("returns completed when completed timestamp is set", () => {
    expect(
      WorkItem.deriveStatus({
        ...WorkItem.Info.parse(baseItem),
        timestamps: {
          ...baseItem.timestamps,
          completed: 4,
        },
      }),
    ).toBe("completed");
  });

  test("returns blocked when blocker is unresolved", () => {
    expect(
      WorkItem.deriveStatus({
        ...WorkItem.Info.parse(baseItem),
        blockers: [
          {
            id: "blk_1",
            description: "Waiting on dependency",
            kind: "dependency",
            createdAt: 2,
          },
        ],
      }),
    ).toBe("blocked");
  });

  test("returns running when started timestamp is set and no blockers exist", () => {
    expect(
      WorkItem.deriveStatus({
        ...WorkItem.Info.parse(baseItem),
        timestamps: {
          ...baseItem.timestamps,
          started: 3,
        },
      }),
    ).toBe("running");
  });

  test("returns pending when nothing is set", () => {
    expect(WorkItem.deriveStatus(WorkItem.Info.parse(baseItem))).toBe("pending");
  });

  test("prioritizes cancelled over completed", () => {
    expect(
      WorkItem.deriveStatus({
        ...WorkItem.Info.parse(baseItem),
        timestamps: {
          ...baseItem.timestamps,
          cancelled: 5,
          completed: 4,
        },
      }),
    ).toBe("cancelled");
  });
});

describe("WorkItem.generateHash", () => {
  test("produces wi_ hashes with 12 base36 characters", () => {
    const hashes = new Set<string>();

    for (let index = 0; index < 100; index += 1) {
      const hash = WorkItem.generateHash();

      expect(hash).toMatch(/^wi_[0-9a-z]{12}$/);
      hashes.add(hash);
    }

    expect(hashes.size).toBe(100);
  });
});

describe("WorkItem.Events", () => {
  test("exposes valid BusEvent descriptors", () => {
    const events = [
      WorkItem.Events.Created,
      WorkItem.Events.Updated,
      WorkItem.Events.StatusChanged,
      WorkItem.Events.Completed,
      WorkItem.Events.Failed,
      WorkItem.Events.Removed,
    ];

    for (const event of events) {
      expect(event.name).toBeString();
      expect(event.schema).toBeTruthy();
    }
  });
});
