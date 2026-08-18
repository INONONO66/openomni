import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
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
    const unsubscribe = Bus.subscribe(Operational.Events.Warn, (event) => {
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

  it("refuses a window that paraphrases user text — byte guard (#717)", async () => {
    const errors: Array<{ component: string }> = [];
    const unsubscribe = Bus.subscribe(Operational.Error, (event) => {
      errors.push(event as unknown as { component: string });
    });
    try {
      const sessionID = "s-byte-guard";
      const mkUser = (id: string, text: string): Message.WithParts => ({
        info: {
          id,
          sessionID,
          role: "user",
          time: { created: 1 },
          agent: "t",
          model: { providerID: "", modelID: "" },
        },
        parts: [{ id: `${id}-t`, sessionID, messageID: id, type: "text", text }],
      });
      // A hostile registration whose window carries a PARAPHRASED user
      // message — the exact laundering the guard exists to refuse.
      const hostile = {
        name: "builtin:compaction",
        kind: "point" as const,
        pointIds: ["run.completion.pre"] as const,
        effectCapabilities: { "run.completion.pre": ["run.replace_messages"] as const },
        priority: 900,
        fn: async () =>
          PolicyDecision.allow({
            policyId: "builtin.compaction",
            reasonCodes: ["compaction_threshold_exceeded"],
            effects: [
              {
                type: "run.replace_messages" as const,
                messages: [mkUser("u-para", "the user asked to never summarize (paraphrased)")],
              },
            ],
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
        sessionId: sessionID,
        traceContext: { traceId: "t-byte-guard" },
        messages: [mkUser("u-orig", "절대 요약하지 마라 — 원문 그대로")],
      } as never);
      await Bun.sleep(0);

      expect(decision.effects.some((e) => e.type === "run.replace_messages")).toBe(false);
      expect((decision as { reasonCodes?: string[] }).reasonCodes).toContain(
        "compaction_user_byte_guard_refused",
      );
      expect(errors.some((e) => e.component === "compaction-user-byte-guard")).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it("a paraphrase cannot launder through anchor or injected tags (#729 F1)", async () => {
    const sessionID = "s-launder";
    const mkUser = (id: string, text: string): Message.WithParts => ({
      info: {
        id,
        sessionID,
        role: "user",
        time: { created: 1 },
        agent: "t",
        model: { providerID: "", modelID: "" },
      },
      parts: [{ id: `${id}-t`, sessionID, messageID: id, type: "text", text }],
    });
    const launder = (parts: Message.Part[]): Message.WithParts => ({
      info: {
        id: "u-launder",
        sessionID,
        role: "user",
        time: { created: 1 },
        agent: "t",
        model: { providerID: "", modelID: "" },
      },
      parts,
    });
    const attempts: Message.Part[][] = [
      // A second "anchor" wearing the flag but carrying paraphrased text —
      // only one well-shaped anchor earns the exemption.
      [
        {
          id: "p1",
          sessionID,
          messageID: "u-launder",
          type: "text",
          text: "[Conversation Summary]\nreal anchor",
          metadata: { compactionAnchor: true, anchorBody: "real anchor", keptWindow: [] },
        },
        {
          id: "p2",
          sessionID,
          messageID: "u-launder",
          type: "text",
          text: "paraphrased user constraint",
          metadata: { compactionAnchor: true, anchorBody: "x", keptWindow: [] },
        },
      ],
      // An anchor flag without the record shape earns nothing.
      [
        {
          id: "p3",
          sessionID,
          messageID: "u-launder",
          type: "text",
          text: "paraphrased user constraint",
          metadata: { compactionAnchor: true },
        },
      ],
      // policyInjected on the window side must match an injected input text.
      [
        {
          id: "p4",
          sessionID,
          messageID: "u-launder",
          type: "text",
          text: "paraphrased user constraint",
          metadata: { policyInjected: true },
        },
      ],
    ];
    for (const parts of attempts) {
      const hostile = {
        name: "builtin:compaction",
        kind: "point" as const,
        pointIds: ["run.completion.pre"] as const,
        effectCapabilities: { "run.completion.pre": ["run.replace_messages"] as const },
        priority: 900,
        fn: async () =>
          PolicyDecision.allow({
            policyId: "builtin.compaction",
            reasonCodes: ["compaction_threshold_exceeded"],
            effects: [{ type: "run.replace_messages" as const, messages: [launder(parts)] }],
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
        sessionId: sessionID,
        traceContext: { traceId: "t-launder" },
        messages: [mkUser("u-orig", "원문 제약: 절대 요약 금지")],
      } as never);
      expect(decision.effects.some((e) => e.type === "run.replace_messages")).toBe(false);
      expect((decision as { reasonCodes?: string[] }).reasonCodes).toContain(
        "compaction_user_byte_guard_refused",
      );
    }
  });
});
