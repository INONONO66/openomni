import { describe, expect, test } from "bun:test";
import { Delegation } from "../../src/delegation/index.js";

const askCore = {
  address: { kind: "core", scope: "inline" },
  mode: "ask",
  payload: { text: "summarize the build log" },
  deadline: 1_700_000_000_000,
} satisfies Delegation.Request;

const assignActor = {
  address: { kind: "actor", actorId: "claude-code@macbook" },
  mode: "assign",
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

describe("Delegation.Request mode rules", () => {
  test("core+ask and actor+assign are admitted", () => {
    expect(Delegation.Request.safeParse(askCore).success).toBe(true);
    expect(Delegation.Request.safeParse(assignActor).success).toBe(true);
  });

  test("actor+ask is refused — actor addresses accept assign only", () => {
    expect(requestIssueAt({ ...askCore, address: { kind: "actor", actorId: "kim" } }, "mode")).toBe(
      "actor addresses accept assign only",
    );
  });

  test("assign without acceptance criteria is refused", () => {
    expect(requestIssueAt({ ...assignActor, acceptanceCriteria: undefined }, "acceptanceCriteria")).toBe(
      "assign requires at least one acceptance criterion",
    );
    expect(requestIssueAt({ ...assignActor, acceptanceCriteria: [] }, "acceptanceCriteria")).toBe(
      "assign requires at least one acceptance criterion",
    );
  });

  test("ask carrying acceptance criteria is refused — ask is a question, not a contract", () => {
    expect(requestIssueAt({ ...askCore, acceptanceCriteria: ["answered"] }, "acceptanceCriteria")).toBe(
      "ask carries no acceptance criteria",
    );
  });

  test("deadline is required and positive — no unbounded delegation exists", () => {
    const { deadline: _deadline, ...withoutDeadline } = askCore;
    const missing = Delegation.Request.safeParse(withoutDeadline);
    expect(missing.success).toBe(false);
    if (!missing.success) {
      const issue = missing.error.issues.find((candidate) => candidate.path.join(".") === "deadline");
      expect(issue?.message).toBe("Required");
    }
    expect(requestIssueAt({ ...askCore, deadline: 0 }, "deadline")).toBe(
      "Number must be greater than 0",
    );
  });

  test("unknown fields are refused", () => {
    const result = Delegation.Request.safeParse({ ...askCore, transport: "inline" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
      expect(result.error.issues[0]?.message).toBe("Unrecognized key(s) in object: 'transport'");
      expect(result.error.issues[0]?.path).toEqual([]);
    }
  });
});

describe("Delegation.Settled terminal vocabulary", () => {
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
      expect(crossed.error.issues[0]?.message).toBe("Unrecognized key(s) in object: 'deadline'");
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
    ] as const) {
      const result = Delegation.Settled.safeParse({ status, delegationId: "d", at: 1 });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find(
          (candidate) => candidate.path.join(".") === evidenceField,
        );
        expect(issue?.message).toBe("Required");
      }
    }
  });
});

describe("Delegation.Handle", () => {
  test("resolves onto one of the three transports and refuses anything else", () => {
    expect(
      Delegation.Handle.safeParse({
        delegationId: "d-1",
        address: { kind: "core", scope: "independent" },
        transport: "process",
        workItemId: "wi-1",
      }).success,
    ).toBe(true);
    const bogus = Delegation.Handle.safeParse({
      delegationId: "d-1",
      address: { kind: "core", scope: "inline" },
      transport: "carrier-pigeon",
    });
    expect(bogus.success).toBe(false);
    if (!bogus.success) {
      expect(bogus.error.issues[0]?.path.join(".")).toBe("transport");
      expect(bogus.error.issues[0]?.message).toBe(
        "Invalid enum value. Expected 'inline' | 'process' | 'channel', received 'carrier-pigeon'",
      );
    }
  });
});
