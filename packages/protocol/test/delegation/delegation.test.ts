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

function reject(input: unknown): string {
  const result = Delegation.Request.safeParse(input);
  expect(result.success).toBe(false);
  if (result.success) throw new Error("expected rejection");
  return result.error.issues.map((issue) => issue.message).join("; ");
}

describe("Delegation.Request mode rules", () => {
  test("core+ask and actor+assign parse", () => {
    expect(Delegation.Request.parse(askCore).mode).toBe("ask");
    expect(Delegation.Request.parse(assignActor).address.kind).toBe("actor");
  });

  test("actor+ask is refused — actor addresses accept assign only", () => {
    expect(
      reject({ ...askCore, address: { kind: "actor", actorId: "kim" } }),
    ).toContain("actor addresses accept assign only");
  });

  test("assign without acceptance criteria is refused", () => {
    expect(reject({ ...assignActor, acceptanceCriteria: undefined })).toContain(
      "assign requires at least one acceptance criterion",
    );
    expect(reject({ ...assignActor, acceptanceCriteria: [] })).toContain(
      "assign requires at least one acceptance criterion",
    );
  });

  test("ask carrying acceptance criteria is refused — ask is a question, not a contract", () => {
    expect(reject({ ...askCore, acceptanceCriteria: ["answered"] })).toContain(
      "ask carries no acceptance criteria",
    );
  });

  test("deadline is required and positive — no unbounded delegation exists", () => {
    const { deadline: _deadline, ...withoutDeadline } = askCore;
    expect(Delegation.Request.safeParse(withoutDeadline).success).toBe(false);
    expect(Delegation.Request.safeParse({ ...askCore, deadline: 0 }).success).toBe(false);
  });

  test("unknown fields are refused", () => {
    expect(Delegation.Request.safeParse({ ...askCore, lane: "inline" }).success).toBe(false);
  });
});

describe("Delegation.Settled terminal vocabulary", () => {
  test("delivery_failed and no_response are distinct terminals — unknown ≠ did-not-happen", () => {
    const deliveryFailed = Delegation.Settled.parse({
      status: "delivery_failed",
      delegationId: "d-1",
      reason: "slack channel archived",
      at: 3,
    });
    const noResponse = Delegation.Settled.parse({
      status: "no_response",
      delegationId: "d-1",
      deadline: 2,
      at: 3,
    });
    expect(deliveryFailed.status).not.toBe(noResponse.status);
  });

  test("every terminal carries its own evidence field", () => {
    expect(Delegation.Settled.safeParse({ status: "failed", delegationId: "d", at: 1 }).success).toBe(
      false,
    );
    expect(
      Delegation.Settled.safeParse({ status: "completed", delegationId: "d", at: 1 }).success,
    ).toBe(false);
    expect(
      Delegation.Settled.safeParse({ status: "cancelled", delegationId: "d", at: 1 }).success,
    ).toBe(false);
  });
});

describe("Delegation.Handle", () => {
  test("carries the resolved lane", () => {
    const handle = Delegation.Handle.parse({
      delegationId: "d-1",
      address: { kind: "core", scope: "independent" },
      lane: "process",
      workItemId: "wi-1",
    });
    expect(handle.lane).toBe("process");
  });

  test("rejects a lane outside the four transports", () => {
    expect(
      Delegation.Handle.safeParse({
        delegationId: "d-1",
        address: { kind: "core", scope: "inline" },
        lane: "carrier-pigeon",
      }).success,
    ).toBe(false);
  });
});
