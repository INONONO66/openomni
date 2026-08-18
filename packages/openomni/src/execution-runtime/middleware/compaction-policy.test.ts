import { describe, expect, it } from "bun:test";
import { PolicyDecision } from "@openomni/protocol";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { withReplacementPersistence } from "./compaction-policy.js";

/**
 * #722 re-review finding 3: every skip branch of the replacement
 * persistence is VISIBLE. The store-failure and session-mismatch branches
 * are pinned in middleware.test.ts through the real seam; the parse-failure
 * branch cannot be reached through the core (it always emits valid
 * messages), so it is pinned here against a hostile registration.
 */
describe("withReplacementPersistence", () => {
  it("warns visibly when effect messages fail to parse (no silent resumability loss)", async () => {
    const warns: Array<{ component: string; msg: string }> = [];
    const unsubscribe = Bus.subscribe(Operational.Warn, (event) => {
      warns.push(event as unknown as { component: string; msg: string });
    });
    try {
      const hostile = {
        name: "builtin:compaction",
        kind: "point" as const,
        pointIds: ["run.completion.pre"] as const,
        effectCapabilities: { "run.completion.pre": ["run.replace_messages"] as const },
        priority: 900,
        fn: async () =>
          PolicyDecision.allow({
            policyId: "builtin.compaction",
            effects: [{ type: "run.replace_messages" as const, messages: [{ garbage: true }] }],
          }),
      };
      const wrapped = withReplacementPersistence(
        {
          kind: "factory",
          name: "builtin:compaction",
          create: () => hostile,
        } as unknown as Parameters<typeof withReplacementPersistence>[0],
        Bus,
      ).create();
      const decision = await wrapped.fn({
        pointId: "run.completion.pre",
        sessionId: "s-parse",
        traceContext: { traceId: "t-parse" },
      } as never);
      await Bun.sleep(0);

      // Fail-open: the decision still flows...
      expect(decision.effects).toHaveLength(1);
      // ...and the degradation is on the record.
      expect(
        warns.some(
          (w) =>
            w.component === "compaction-replacement-persistence" &&
            w.msg.includes("failed to parse"),
        ),
      ).toBe(true);
    } finally {
      unsubscribe();
    }
  });
});
