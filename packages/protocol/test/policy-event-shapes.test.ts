import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { Policy } from "../src/policy/index.js";

/**
 * Characterization of the policy decision-event field maps that duplicate
 * each other today (slop-audit duplication #4 `event/policy.ts:57-62 <->
 * :81-86`; semantic-audit SYNTHESIS section 1.2 "Policy verdict event core").
 * Four descriptors restate `actor`/`action`/`resource` and three of them
 * restate `verdict`/`reason`.
 *
 * The do-not-touch ledger (SYNTHESIS section 2, "Event-family bases") allows
 * a LOCAL base+extend inside one family but forbids a universal BaseEvent.
 * Consolidating within this file must therefore preserve, per descriptor:
 *
 *   - the exact accepted key set, including which events carry `actionId`
 *     vs `policyId` vs neither, and which merge the audit context;
 *   - the verdict vocabulary per event (`ActionRequested` has none;
 *     `DecisionComposed` uses EffectiveVerdict; the other two inline the
 *     same three literals);
 *   - passthrough vs strict behavior for unknown keys;
 *   - each descriptor's name and visibility.
 */

const base = { traceId: "trace-1", sessionId: "ses-1", time: 1_700_000_000_000 };
const actor = { userId: "user-1", role: "admin" };

function issues(result: z.ZodSafeParseResult<unknown>) {
  if (result.success) throw new Error("expected a parse failure, but parsing succeeded");
  return result.error.issues.map((issue) => ({
    path: issue.path.join("."),
    code: issue.code,
  }));
}

describe("policy decision-event field maps", () => {
  test("descriptor names and visibilities are unchanged", () => {
    expect([
      [Policy.Events.ActionRequested.name, Policy.Events.ActionRequested.visibility],
      [Policy.Events.Evaluated.name, Policy.Events.Evaluated.visibility],
      [Policy.Events.DecisionComposed.name, Policy.Events.DecisionComposed.visibility],
      [Policy.Events.ActionBlocked.name, Policy.Events.ActionBlocked.visibility],
    ]).toEqual([
      ["policy.action.requested", "ephemeral"],
      ["policy.evaluated", "llm_reason"],
      ["policy.decision.composed", "llm_reason"],
      ["policy.action.blocked", "llm_reason"],
    ]);
  });

  test("every descriptor requires the shared trace/session/time base", () => {
    for (const descriptor of [
      Policy.Events.ActionRequested,
      Policy.Events.Evaluated,
      Policy.Events.DecisionComposed,
      Policy.Events.ActionBlocked,
    ]) {
      const reported = issues(
        descriptor.schema.safeParse({ actor, action: "a", resource: "r", reason: "why" }),
      );
      const paths = reported.map((issue) => issue.path);
      expect(paths).toContain("traceId");
      expect(paths).toContain("sessionId");
      expect(paths).toContain("time");
    }
  });

  test("runId is optional on the shared base and survives parsing", () => {
    const parsed = Policy.Events.ActionRequested.schema.parse({
      ...base,
      runId: "run-1",
      actionId: "act-1",
      actor,
      action: "tool.execute",
      resource: "tool:shell",
    });
    expect(parsed.runId).toBe("run-1");
    // Absent runId is accepted, not defaulted.
    const withoutRun = Policy.Events.ActionRequested.schema.parse({
      ...base,
      actionId: "act-1",
      actor,
      action: "tool.execute",
      resource: "tool:shell",
    });
    expect("runId" in withoutRun).toBe(false);
  });

  test("the identity slot differs per event: actionId vs policyId vs neither", () => {
    // ActionRequested and ActionBlocked require actionId.
    expect(
      issues(
        Policy.Events.ActionRequested.schema.safeParse({
          ...base,
          actor,
          action: "a",
          resource: "r",
        }),
      ).map((issue) => issue.path),
    ).toEqual(["actionId"]);
    expect(
      issues(
        Policy.Events.ActionBlocked.schema.safeParse({
          ...base,
          actor,
          action: "a",
          resource: "r",
          verdict: "deny",
          reason: "why",
        }),
      ).map((issue) => issue.path),
    ).toEqual(["actionId"]);

    // Evaluated requires policyId instead.
    expect(
      issues(
        Policy.Events.Evaluated.schema.safeParse({
          ...base,
          actor,
          action: "a",
          resource: "r",
          verdict: "allow",
          reason: "why",
        }),
      ).map((issue) => issue.path),
    ).toEqual(["policyId"]);

    // DecisionComposed carries no per-action or per-policy id at all.
    expect(
      Policy.Events.DecisionComposed.schema.safeParse({
        ...base,
        actor,
        action: "a",
        resource: "r",
        verdict: "allow",
        reason: "merged",
      }).success,
    ).toBe(true);
  });

  test("verdict vocabulary is the same three literals on every verdict-bearing event", () => {
    for (const descriptor of [
      Policy.Events.Evaluated,
      Policy.Events.DecisionComposed,
      Policy.Events.ActionBlocked,
    ]) {
      for (const verdict of ["allow", "deny", "pending"] as const) {
        const payload = {
          ...base,
          actor,
          action: "a",
          resource: "r",
          verdict,
          reason: "why",
          ...(descriptor === Policy.Events.Evaluated ? { policyId: "p-1" } : {}),
          ...(descriptor === Policy.Events.ActionBlocked ? { actionId: "act-1" } : {}),
        };
        expect(descriptor.schema.safeParse(payload).success).toBe(true);
      }
      // Anything outside the vocabulary is rejected at the verdict path.
      const rejected = issues(
        descriptor.schema.safeParse({
          ...base,
          actor,
          action: "a",
          resource: "r",
          verdict: "maybe",
          reason: "why",
          policyId: "p-1",
          actionId: "act-1",
        }),
      );
      expect(rejected.map((issue) => issue.path)).toContain("verdict");
    }
  });

  test("only Evaluated and DecisionComposed accept the audit context", () => {
    const auditContext = {
      reasonCodes: ["allowlist_match"],
      factsUsed: ["actor.role=admin"],
      durationMs: 3,
      pointId: "tool.native.pre",
      pointVersion: 1,
    };
    expect(
      Policy.Events.Evaluated.schema.parse({
        ...base,
        policyId: "p-1",
        actor,
        action: "a",
        resource: "r",
        verdict: "allow",
        reason: "why",
        ...auditContext,
      }).pointId,
    ).toBe("tool.native.pre");
    expect(
      Policy.Events.DecisionComposed.schema.parse({
        ...base,
        actor,
        action: "a",
        resource: "r",
        verdict: "allow",
        reason: "merged",
        ...auditContext,
      }).reasonCodes,
    ).toEqual(["allowlist_match"]);
  });

  test("ActionRequested and ActionBlocked STRIP the audit context they do not declare", () => {
    // The over-consolidation failure mode: merging PolicyAuditContext into
    // every descriptor because three of them share verdict/reason. These two
    // are not audit-context carriers. Policy events are non-strict, so the
    // observable difference is retention, not rejection — an audit key must
    // not survive parsing on a non-carrier.
    const auditKeys = { pointId: "tool.native.pre", reasonCodes: ["allowlist_match"] };

    const requested = Policy.Events.ActionRequested.schema.parse({
      ...base,
      actionId: "act-1",
      actor,
      action: "a",
      resource: "r",
      ...auditKeys,
    });
    expect(Object.keys(requested).sort()).toEqual([
      "action",
      "actionId",
      "actor",
      "resource",
      "sessionId",
      "time",
      "traceId",
    ]);

    const blocked = Policy.Events.ActionBlocked.schema.parse({
      ...base,
      actionId: "act-1",
      actor,
      action: "a",
      resource: "r",
      verdict: "deny",
      reason: "why",
      ...auditKeys,
    });
    expect(Object.keys(blocked).sort()).toEqual([
      "action",
      "actionId",
      "actor",
      "reason",
      "resource",
      "sessionId",
      "time",
      "traceId",
      "verdict",
    ]);
  });

  test("beforeSideEffect belongs to Evaluated alone", () => {
    const parsed = Policy.Events.Evaluated.schema.parse({
      ...base,
      policyId: "p-1",
      actor,
      action: "a",
      resource: "r",
      verdict: "pending",
      reason: "sanitizing",
      beforeSideEffect: { originalInput: "dangerous" },
    });
    expect(parsed.beforeSideEffect).toEqual({ originalInput: "dangerous" });
  });

  test("context belongs to ActionRequested alone", () => {
    const parsed = Policy.Events.ActionRequested.schema.parse({
      ...base,
      actionId: "act-1",
      actor,
      action: "a",
      resource: "r",
      context: { toolName: "bash" },
    });
    expect(parsed.context).toEqual({ toolName: "bash" });
  });

  test("actor is an open record on every event (policy carries caller-shaped actors)", () => {
    const parsed = Policy.Events.ActionBlocked.schema.parse({
      ...base,
      actionId: "act-1",
      actor: { anything: { nested: true }, userId: "u" },
      action: "a",
      resource: "r",
      verdict: "deny",
      reason: "why",
    });
    expect(parsed.actor).toEqual({ anything: { nested: true }, userId: "u" });
  });
});
