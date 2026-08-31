import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Delegation } from "../../src/delegation/index.js";

/**
 * Characterization of the `Delegation.Settled` discriminated union arms that
 * duplicate a field map today (slop-audit duplication #18
 * `delegation/schema.ts:184-192 <-> :192-200` — the `cancelled` and
 * `delivery_failed` arms are byte-identical apart from their status literal).
 *
 * Consolidating the SHAPE must not merge the TERMINAL VOCABULARY: the
 * semantic-audit do-not-touch ledger (SYNTHESIS section 2, "Domain terminal
 * vocabularies") forbids a universal terminal enum, and `SettledStatus` is
 * derived from these very discriminants. This file pins what must survive:
 *
 *   - every status literal stays its own arm, reachable by discriminant;
 *   - each arm keeps its OWN required-field set (no arm gains a sibling
 *     arm's field, no arm loses one) and stays `.strict()`;
 *   - the discriminated-union rejection path and message are unchanged;
 *   - `SettledStatus` keeps exactly the arm discriminants, in arm order.
 */

const T0 = 1_700_000_000_000;

function issues(result: z.SafeParseReturnType<unknown, unknown>) {
  if (result.success) throw new Error("expected a parse failure, but parsing succeeded");
  return result.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));
}

describe("Delegation.Settled arm vocabulary", () => {
  test("SettledStatus is exactly the union discriminants, in arm order", () => {
    expect(Delegation.SettledStatus.options).toEqual([
      "completed",
      "failed",
      "cancelled",
      "delivery_failed",
      "no_response",
      "interrupted",
      "sent",
    ]);
  });

  test("cancelled and delivery_failed are DISTINCT terminals over the same field map", () => {
    const fields = { delegationId: "del-1", reason: "owner stopped it", at: T0 };
    const cancelled = Delegation.Settled.parse({ status: "cancelled", ...fields });
    const deliveryFailed = Delegation.Settled.parse({ status: "delivery_failed", ...fields });

    expect(cancelled).toEqual({ status: "cancelled", ...fields });
    expect(deliveryFailed).toEqual({ status: "delivery_failed", ...fields });
    // Same shape, different fact: the discriminant is the only difference and
    // it must never collapse.
    expect(cancelled.status).not.toBe(deliveryFailed.status);
  });

  test("each reason-bearing terminal requires its reason at its own path", () => {
    for (const status of ["cancelled", "delivery_failed", "failed"] as const) {
      const withoutReason = { status, delegationId: "del-1", at: T0 };
      const reported = issues(Delegation.Settled.safeParse(withoutReason));
      const key = status === "failed" ? "error" : "reason";
      expect(reported).toEqual([{ path: key, message: "Required", code: "invalid_type" }]);
    }
  });

  test("an empty reason is refused on EVERY reason-bearing arm (min(1) is per-arm)", () => {
    // Each arm carries its own min(1); a factoring that keeps the field but
    // drops the constraint on one arm must fail here, not pass by sibling.
    for (const [status, key] of [
      ["cancelled", "reason"],
      ["delivery_failed", "reason"],
      ["failed", "error"],
    ] as const) {
      expect(
        issues(
          Delegation.Settled.safeParse({
            status,
            delegationId: "del-1",
            [key]: "",
            at: T0,
          }),
        ),
      ).toEqual([
        {
          path: key,
          message: "String must contain at least 1 character(s)",
          code: "too_small",
        },
      ]);
    }
  });

  test("an empty delegationId is refused on every arm", () => {
    for (const settled of [
      { status: "cancelled", reason: "r", at: T0 },
      { status: "delivery_failed", reason: "r", at: T0 },
      { status: "interrupted", at: T0 },
      { status: "sent", at: T0 },
      { status: "completed", output: "o", at: T0 },
    ] as const) {
      expect(
        issues(Delegation.Settled.safeParse({ ...settled, delegationId: "" })).map(
          (issue) => issue.path,
        ),
      ).toEqual(["delegationId"]);
    }
  });

  test("arms stay strict: a sibling arm's field is not accepted", () => {
    // `no_response` owns `deadline`; `cancelled` must not silently accept it.
    const reported = issues(
      Delegation.Settled.safeParse({
        status: "cancelled",
        delegationId: "del-1",
        reason: "stopped",
        at: T0,
        deadline: T0 + 1_000,
      }),
    );
    expect(reported).toEqual([
      {
        path: "",
        message: "Unrecognized key(s) in object: 'deadline'",
        code: "unrecognized_keys",
      },
    ]);
  });

  test("terminals that carry NO reason keep their minimal field map", () => {
    expect(Delegation.Settled.parse({ status: "interrupted", delegationId: "del-1", at: T0 })).toEqual(
      { status: "interrupted", delegationId: "del-1", at: T0 },
    );
    expect(Delegation.Settled.parse({ status: "sent", delegationId: "del-1", at: T0 })).toEqual({
      status: "sent",
      delegationId: "del-1",
      at: T0,
    });
    // Adding a reason to a reasonless terminal is a strictness failure.
    expect(
      issues(
        Delegation.Settled.safeParse({
          status: "interrupted",
          delegationId: "del-1",
          at: T0,
          reason: "nope",
        }),
      ),
    ).toEqual([
      { path: "", message: "Unrecognized key(s) in object: 'reason'", code: "unrecognized_keys" },
    ]);
  });

  test("an unknown status is rejected by the discriminator, not by a field", () => {
    const reported = issues(
      Delegation.Settled.safeParse({ status: "abandoned", delegationId: "del-1", at: T0 }),
    );
    expect(reported).toEqual([
      { path: "status", message: expect.any(String), code: "invalid_union_discriminator" },
    ]);
  });

  test("completed keeps its output and optional usage; no_response keeps its deadline rule", () => {
    expect(
      Delegation.Settled.parse({
        status: "completed",
        delegationId: "del-1",
        output: "done",
        at: T0,
        usage: { tokens: 12 },
      }).usage,
    ).toEqual({ tokens: 12 });

    // The cross-field rule lives on the union, not on any shared field map.
    expect(
      issues(
        Delegation.Settled.safeParse({
          status: "no_response",
          delegationId: "del-1",
          deadline: T0 + 1_000,
          at: T0,
        }),
      ),
    ).toEqual([
      { path: "at", message: "no_response cannot settle before its deadline", code: "custom" },
    ]);
  });
});
