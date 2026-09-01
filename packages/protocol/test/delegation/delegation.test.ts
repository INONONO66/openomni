import { describe, expect, test } from "bun:test";
import { Delegation } from "../../src/delegation/index.js";

const askCoreInline = {
  address: { kind: "core", scope: "inline" },
  operation: "ask",
  payload: { text: "summarize the build log" },
  deadline: 1_700_000_000_000,
} satisfies Delegation.Request;

const assignActor = {
  address: { kind: "actor", actorId: "claude-code@macbook" },
  operation: "assign",
  payload: { text: "fix the flaky migration test" },
  acceptanceCriteria: ["bun test packages/ledger green in CI"],
  deadline: 1_700_000_000_000,
} satisfies Delegation.Request;

/** Exact issue message at an exact path — never a substring probe. */
function requestIssueAt(input: unknown, path: string): string | undefined {
  const result = Delegation.Request.safeParse(input);
  expect(result.success).toBe(false);
  if (result.success) throw new Error("expected rejection");
  return result.error.issues.find((issue) => issue.path.join(".") === path)?.message;
}

function recordIssueAt(input: unknown, path: string): string | undefined {
  const result = Delegation.Record.safeParse(input);
  expect(result.success).toBe(false);
  if (result.success) throw new Error("expected rejection");
  return result.error.issues.find((issue) => issue.path.join(".") === path)?.message;
}

const ORIGIN = {
  role: "resident",
  depth: 0,
  sessionId: "session-origin",
} satisfies Delegation.Origin;

const OPEN_RECORD = {
  delegationId: "d-1",
  operation: "ask",
  address: { kind: "core", scope: "independent" },
  transport: "process",
  deadline: 1_700_000_000_000,
  rootDelegationId: "d-1",
  origin: ORIGIN,
  instruction: "summarize the build log",
  status: "open",
  createdAt: 1_699_000_000_000,
} satisfies Delegation.Record;

describe("Delegation.Request operation/address matrix", () => {
  test("the six admitted combinations parse", () => {
    const admitted: Delegation.Request[] = [
      {
        address: { kind: "actor", actorId: "kim" },
        operation: "notify",
        payload: { text: "build finished" },
        deadline: 1_700_000_000_000,
      },
      askCoreInline,
      {
        address: { kind: "core", scope: "independent" },
        operation: "ask",
        payload: { text: "what broke" },
        deadline: 1_700_000_000_000,
      },
      {
        address: { kind: "actor", actorId: "kim" },
        operation: "ask",
        payload: { text: "can you take this" },
        deadline: 1_700_000_000_000,
      },
      {
        address: { kind: "core", scope: "independent" },
        operation: "assign",
        payload: { text: "fix the flaky test" },
        acceptanceCriteria: ["green in CI"],
        deadline: 1_700_000_000_000,
      },
      assignActor,
    ];
    for (const request of admitted) {
      expect(Delegation.Request.safeParse(request).success).toBe(true);
    }
  });

  test("notify reaches actor addresses only — a core notify is refused", () => {
    expect(requestIssueAt({ ...askCoreInline, operation: "notify" }, "operation")).toBe(
      "notify reaches actor addresses only",
    );
  });

  test("assign never runs inline — inline is a volatile in-turn helper for ask only", () => {
    expect(
      requestIssueAt(
        { ...askCoreInline, operation: "assign", acceptanceCriteria: ["done"] },
        "address",
      ),
    ).toBe("assign never runs inline; inline is a volatile in-turn helper for ask only");
  });

  test("assign without acceptance criteria is refused", () => {
    expect(requestIssueAt({ ...assignActor, acceptanceCriteria: undefined }, "acceptanceCriteria")).toBe(
      "assign requires at least one acceptance criterion",
    );
    expect(requestIssueAt({ ...assignActor, acceptanceCriteria: [] }, "acceptanceCriteria")).toBe(
      "assign requires at least one acceptance criterion",
    );
  });

  test("notify and ask carry no acceptance criteria — only assign is a contract", () => {
    expect(
      requestIssueAt(
        { ...askCoreInline, operation: "notify", address: { kind: "actor", actorId: "kim" }, acceptanceCriteria: ["x"] },
        "acceptanceCriteria",
      ),
    ).toBe("notify carries no acceptance criteria");
    expect(
      requestIssueAt({ ...askCoreInline, acceptanceCriteria: ["answered"] }, "acceptanceCriteria"),
    ).toBe("ask carries no acceptance criteria");
  });

  test("the retired mode field is an unrecognized key — operation replaced it", () => {
    const { operation: _operation, ...withoutOperation } = askCoreInline;
    const result = Delegation.Request.safeParse({ ...withoutOperation, mode: "ask" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognized = result.error.issues.find((issue) => issue.code === "unrecognized_keys");
      expect(unrecognized?.message).toBe("Unrecognized key: \"mode\"");
      const missing = result.error.issues.find((issue) => issue.path.join(".") === "operation");
      expect(missing?.message).toBe('Invalid option: expected one of "notify"|"ask"|"assign"');
    }
  });

  test("deadline is required and positive — no unbounded delegation exists", () => {
    const { deadline: _deadline, ...withoutDeadline } = askCoreInline;
    const missing = Delegation.Request.safeParse(withoutDeadline);
    expect(missing.success).toBe(false);
    if (!missing.success) {
      const issue = missing.error.issues.find((candidate) => candidate.path.join(".") === "deadline");
      expect(issue?.message).toBe("Invalid input: expected number, received undefined");
    }
    expect(requestIssueAt({ ...askCoreInline, deadline: 0 }, "deadline")).toBe(
      "Too small: expected number to be >0",
    );
  });

  test("unknown fields are refused", () => {
    const result = Delegation.Request.safeParse({ ...askCoreInline, transport: "inline" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
      expect(result.error.issues[0]?.message).toBe("Unrecognized key: \"transport\"");
      expect(result.error.issues[0]?.path).toEqual([]);
    }
  });
});

describe("Delegation.Settled terminal vocabulary", () => {
  test("interrupted and sent are terminals with their own shapes", () => {
    expect(
      Delegation.Settled.safeParse({ status: "interrupted", delegationId: "d-1", at: 3 }).success,
    ).toBe(true);
    expect(
      Delegation.Settled.safeParse({ status: "sent", delegationId: "d-1", at: 3 }).success,
    ).toBe(true);
  });

  test("delivery_failed carries reason; a deadline field there is refused", () => {
    expect(
      Delegation.Settled.safeParse({
        status: "delivery_failed",
        delegationId: "d-1",
        reason: "slack channel archived",
        at: 3,
      }).success,
    ).toBe(true);
    const crossed = Delegation.Settled.safeParse({
      status: "delivery_failed",
      delegationId: "d-1",
      reason: "x",
      deadline: 2,
      at: 3,
    });
    expect(crossed.success).toBe(false);
    if (!crossed.success) {
      expect(crossed.error.issues[0]?.code).toBe("unrecognized_keys");
      expect(crossed.error.issues[0]?.message).toBe("Unrecognized key: \"deadline\"");
      expect(crossed.error.issues[0]?.path).toEqual([]);
    }
  });

  test("no_response settles only at or after its deadline", () => {
    expect(
      Delegation.Settled.safeParse({
        status: "no_response",
        delegationId: "d-1",
        deadline: 2,
        at: 2,
      }).success,
    ).toBe(true);
    const early = Delegation.Settled.safeParse({
      status: "no_response",
      delegationId: "d-1",
      deadline: 200,
      at: 100,
    });
    expect(early.success).toBe(false);
    if (!early.success) {
      expect(early.error.issues[0]?.message).toBe("no_response cannot settle before its deadline");
      expect(early.error.issues[0]?.path.join(".")).toBe("at");
    }
  });

  test("every terminal requires its own evidence field", () => {
    for (const [status, evidenceField] of [
      ["completed", "output"],
      ["failed", "error"],
      ["cancelled", "reason"],
      ["delivery_failed", "reason"],
    ] as const) {
      const result = Delegation.Settled.safeParse({ status, delegationId: "d", at: 1 });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find(
          (candidate) => candidate.path.join(".") === evidenceField,
        );
        expect(issue?.message).toBe("Invalid input: expected string, received undefined");
      }
    }
  });
});

describe("Delegation.Handle returned at admission", () => {
  const handle = {
    delegationId: "d-1",
    operation: "assign",
    address: { kind: "actor", actorId: "kim" },
    transport: "channel",
    deadline: 1_700_000_000_000,
    waitId: "w-1",
    parentDelegationId: "d-0",
    rootDelegationId: "d-0",
  } satisfies Delegation.Handle;

  test("the full admission-time shape parses, including lineage and the linked Wait", () => {
    expect(Delegation.Handle.safeParse(handle).success).toBe(true);
  });

  test("operation, deadline, and rootDelegationId are required — a handle names its tree", () => {
    const missingMessage = {
      operation: 'Invalid option: expected one of "notify"|"ask"|"assign"',
      deadline: "Invalid input: expected number, received undefined",
      rootDelegationId: "Invalid input: expected string, received undefined",
    } as const;
    for (const field of ["operation", "deadline", "rootDelegationId"] as const) {
      const { [field]: _omitted, ...without } = handle;
      const result = Delegation.Handle.safeParse(without);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((candidate) => candidate.path.join(".") === field);
        expect(issue?.message).toBe(missingMessage[field]);
      }
    }
  });

  test("resolves onto one of the three transports and refuses anything else", () => {
    const bogus = Delegation.Handle.safeParse({ ...handle, transport: "carrier-pigeon" });
    expect(bogus.success).toBe(false);
    if (!bogus.success) {
      expect(bogus.error.issues[0]?.path.join(".")).toBe("transport");
      expect(bogus.error.issues[0]?.message).toBe(
        'Invalid option: expected one of "inline"|"process"|"channel"',
      );
    }
  });
});

describe("Delegation.Origin lineage", () => {
  test("a root origin carries no lineage fields", () => {
    expect(Delegation.Origin.safeParse(ORIGIN).success).toBe(true);
  });

  test("a child origin names its parent and root delegations", () => {
    expect(
      Delegation.Origin.safeParse({
        ...ORIGIN,
        role: "worker",
        depth: 1,
        parentDelegationId: "d-1",
        rootDelegationId: "d-0",
      }).success,
    ).toBe(true);
  });
});

describe("Delegation.Record durable shape", () => {
  test("an open record parses; status open forbids a settlement", () => {
    expect(Delegation.Record.safeParse(OPEN_RECORD).success).toBe(true);
    expect(
      recordIssueAt(
        {
          ...OPEN_RECORD,
          settled: { status: "completed", delegationId: "d-1", output: "done", at: 1 },
          settledAt: 1,
        },
        "settled",
      ),
    ).toBe("an open record carries no settlement");
  });

  test("status settled requires the settlement payload and settledAt", () => {
    expect(
      Delegation.Record.safeParse({
        ...OPEN_RECORD,
        status: "settled",
        settled: { status: "completed", delegationId: "d-1", output: "done", at: 5 },
        settledAt: 5,
      }).success,
    ).toBe(true);
    expect(recordIssueAt({ ...OPEN_RECORD, status: "settled" }, "settled")).toBe(
      "a settled record carries its settlement payload and settledAt",
    );
  });

  test("an open record cannot carry a wake receipt", () => {
    expect(recordIssueAt({ ...OPEN_RECORD, wokenAt: 5 }, "wokenAt")).toBe(
      "an open record carries no wake receipt",
    );
  });

  test("wokenAt is a wall-clock instant — negatives refused", () => {
    expect(
      Delegation.Record.safeParse({
        ...OPEN_RECORD,
        status: "settled",
        settled: { status: "completed", delegationId: "d-1", output: "done", at: 5 },
        settledAt: 5,
        wokenAt: -1,
      }).success,
    ).toBe(false);
    expect(
      Delegation.Record.safeParse({
        ...OPEN_RECORD,
        status: "settled",
        settled: { status: "completed", delegationId: "d-1", output: "done", at: 5 },
        settledAt: 5,
        wokenAt: 6,
      }).success,
    ).toBe(true);
  });

  test("sent is terminal for notify only — pinned where operation meets settlement", () => {
    const sentRecord = {
      ...OPEN_RECORD,
      operation: "notify",
      address: { kind: "actor", actorId: "kim" },
      transport: "channel",
      status: "settled",
      settled: { status: "sent", delegationId: "d-1", at: 5 },
      settledAt: 5,
    };
    expect(Delegation.Record.safeParse(sentRecord).success).toBe(true);
    expect(
      recordIssueAt({ ...sentRecord, operation: "ask" }, "settled.status"),
    ).toBe("sent is terminal for notify only");
  });

  test("the settlement payload must belong to the record that carries it", () => {
    expect(
      recordIssueAt(
        {
          ...OPEN_RECORD,
          status: "settled",
          settled: { status: "completed", delegationId: "d-OTHER", output: "done", at: 5 },
          settledAt: 5,
        },
        "settled",
      ),
    ).toBe("settlement payload belongs to a different delegation");
  });
});

describe("Delegation.Events lifecycle descriptors", () => {
  test("admitted, delivered, settled are the lifecycle; requested is gone", () => {
    const names = Object.values(Delegation.Events).map((descriptor) => descriptor.name);
    expect(names).toEqual(["delegation.admitted", "delegation.delivered", "delegation.settled"]);
    expect(names).not.toContain("delegation.requested");
  });

  test("admitted carries the operation and the tree root; settled carries the terminal status", () => {
    const admitted = Delegation.Events.Admitted.schema.safeParse({
      delegationId: "d-1",
      traceId: "t-1",
      time: 1,
      operation: "assign",
      addressKind: "actor",
      transport: "channel",
      deadline: 1_700_000_000_000,
      rootDelegationId: "d-0",
    });
    expect(admitted.success).toBe(true);
    expect(
      Delegation.Events.Settled.schema.safeParse({
        delegationId: "d-1",
        traceId: "t-1",
        time: 1,
        status: "interrupted",
      }).success,
    ).toBe(true);
    const retiredMode = Delegation.Events.Admitted.schema.safeParse({
      delegationId: "d-1",
      traceId: "t-1",
      time: 1,
      mode: "ask",
      addressKind: "core",
      transport: "inline",
    });
    expect(retiredMode.success).toBe(false);
  });
});
