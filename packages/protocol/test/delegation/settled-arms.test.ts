import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { Delegation } from "../../src/delegation/index.js";

/**
 * Characterization of the `Delegation.Settled` discriminated union arms.
 *
 * Duplication #18 (`delegation/schema.ts` — the `cancelled` and
 * `delivery_failed` arms are byte-identical apart from their status literal)
 * is deliberately LEFT UNCONSOLIDATED, and this file is why.
 *
 * `JSON.stringify` of a parsed `Settled` is not formatting — it is DATA:
 *
 *   - `packages/ledger/src/storage/sqlite-delegation-adapter.ts:55` persists
 *     it as the delegation row's `data` column;
 *   - `apps/openomni/src/delegation/kernel.ts:134` uses it as the settlement
 *     IDENTITY key that wakes a settlement waiter.
 *
 * Zod emits object keys in shape-declaration order, so hoisting the shared
 * `delegationId`/`at` stamp into one spread reorders every arm that has
 * fields BETWEEN them (base emits `status, delegationId, <evidence>, at`).
 * A differential over this file's fixtures showed 14/18 cases changing bytes.
 * An order-preserving factoring would need the two-field stamp split into two
 * one-field maps sitting on opposite sides of each arm's evidence, which is
 * strictly worse than the duplication it removes.
 *
 * So this file pins BOTH layers:
 *
 *   - the vocabulary: every status literal stays its own arm, each keeps its
 *     OWN required-field set and `.strict()`, and `SettledStatus` keeps
 *     exactly the arm discriminants in arm order (SYNTHESIS section 2,
 *     "Domain terminal vocabularies", forbids a universal terminal enum);
 *   - the BYTES: exact `JSON.stringify` output per arm, so any future
 *     refactor that reorders emission fails here instead of silently
 *     rewriting persisted rows and settlement identities.
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

  test("every arm's JSON bytes are exact, and input key order cannot change them", () => {
    // Base emission order per arm: status, delegationId, <arm evidence>, at.
    // These literals are the persisted `data` column and the settlement
    // identity key — they are a compatibility surface, not a style choice.
    const expected: [Record<string, unknown>, string][] = [
      [
        { status: "completed", delegationId: "del-1", output: "done", at: T0 },
        '{"status":"completed","delegationId":"del-1","output":"done","at":1700000000000}',
      ],
      [
        { status: "completed", delegationId: "del-1", output: "done", at: T0, usage: { tokens: 12 } },
        '{"status":"completed","delegationId":"del-1","output":"done","at":1700000000000,"usage":{"tokens":12}}',
      ],
      [
        { status: "failed", delegationId: "del-1", error: "boom", at: T0 },
        '{"status":"failed","delegationId":"del-1","error":"boom","at":1700000000000}',
      ],
      [
        { status: "cancelled", delegationId: "del-1", reason: "owner stopped", at: T0 },
        '{"status":"cancelled","delegationId":"del-1","reason":"owner stopped","at":1700000000000}',
      ],
      [
        { status: "delivery_failed", delegationId: "del-1", reason: "unreachable", at: T0 },
        '{"status":"delivery_failed","delegationId":"del-1","reason":"unreachable","at":1700000000000}',
      ],
      [
        { status: "no_response", delegationId: "del-1", deadline: T0 - 1_000, at: T0 },
        '{"status":"no_response","delegationId":"del-1","deadline":1699999999000,"at":1700000000000}',
      ],
      [
        { status: "interrupted", delegationId: "del-1", at: T0 },
        '{"status":"interrupted","delegationId":"del-1","at":1700000000000}',
      ],
      [
        { status: "sent", delegationId: "del-1", at: T0 },
        '{"status":"sent","delegationId":"del-1","at":1700000000000}',
      ],
    ];

    for (const [input, bytes] of expected) {
      expect(JSON.stringify(Delegation.Settled.parse(input))).toBe(bytes);
      // The SCHEMA fixes emission order, not the caller: a row read back with
      // its keys in any order must re-serialize to the same bytes, or the
      // settlement identity key would depend on who built the object.
      const shuffled = Object.fromEntries(Object.entries(input).reverse());
      expect(JSON.stringify(Delegation.Settled.parse(shuffled))).toBe(bytes);
    }
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
    const completed = Delegation.Settled.parse({
      status: "completed",
      delegationId: "del-1",
      output: "done",
      at: T0,
      usage: { tokens: 12 },
    });
    if (completed.status !== "completed") throw new Error("completed arm did not parse as itself");
    expect(completed.usage).toEqual({ tokens: 12 });
    expect(completed.output).toBe("done");

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
