import { createCompactionPolicy } from "@openomni/agent";
import type { CompactionOptions, PolicyContext, PolicyRegistryInstance } from "@openomni/agent";
import type { BusEvent } from "@openomni/protocol";
import { Message } from "@openomni/protocol";
import { Session } from "@openomni/session";
import { z } from "zod";

const MessageSummarizerSchema = z.custom<
  (messages: Message.WithParts[], previousAnchor?: string) => Promise<string>
>((value) => typeof value === "function");

const CompactionConfigSchema: z.ZodType<CompactionOptions, z.ZodTypeDef, unknown> = z.object({
  contextWindowTokens: z.number().int().positive().optional(),
  thresholdRatio: z.number().gt(0).lte(1).optional(),
  reserveTokens: z.number().nonnegative().optional(),
  reserveRatio: z.number().gte(0).lte(1).optional(),
  protectRecentMessages: z.number().int().nonnegative().optional(),
  preserveUserMessageChars: z.number().int().positive().optional(),
  onSummarize: MessageSummarizerSchema.optional(),
  elideToolOutputs: z
    .object({
      minOutputChars: z.number().int().positive(),
      keepHeadChars: z.number().int().nonnegative(),
    })
    .optional(),
});

/**
 * Ordering opinion, stated where opinions live. Compaction is currently the
 * only policy at run.completion.pre, so 900 is unopposed — the high value is
 * the standing intent that any future policy at that point speaks before its
 * messages are rewritten (the engine orders ascending).
 */
export const COMPACTION_PRIORITY = 900;

/**
 * Registers the compaction strategy. The mechanism — measurement, the cut,
 * the boundary guard, the run.completion.pre seam — is the agent core's
 * (D6/D8); when to trigger and how to summarize arrive here, as config
 * hydrated from the gate-stamped policy plan.
 */
export function registerCompaction(
  registry: PolicyRegistryInstance<PolicyContext>,
  events: BusEvent.Sink,
): void {
  registry.register("builtin:compaction", (config) =>
    withReplacementPersistence(
      createCompactionPolicy({
        ...CompactionConfigSchema.parse(config),
        events,
        priority: COMPACTION_PRIORITY,
      }),
    ),
  );
}

/**
 * #702: the replacement window must survive resume. The core seam rewrites
 * only the in-run history; this wrapper persists the anchor message — whose
 * part metadata carries the ordered kept-message ids, i.e. the whole window
 * selection — into the session store BEFORE the decision returns, so the
 * record exists before the effect applies (record-before-act). Both
 * hydration readers (resident re-activation and worker resume) funnel
 * through SessionBridge.buildDirectMessages, which consumes it.
 *
 * Persistence failure is fail-open by design: the seam is fail-closed, so a
 * throw here would kill a live run over bookkeeping. The run keeps its
 * compacted window; only resumability degrades to pre-#702 behavior for
 * this cut. (Sessions outside the store — tests, ad-hoc engines — land in
 * the same branch.)
 */
export function withReplacementPersistence(
  registration: ReturnType<typeof createCompactionPolicy>,
): ReturnType<typeof createCompactionPolicy> {
  return {
    ...registration,
    fn: async (ctx) => {
      const decision = await registration.fn(ctx);
      const effect = decision.effects?.find((entry) => entry.type === "run.replace_messages");
      if (effect?.type !== "run.replace_messages") return decision;
      const parsed = Message.WithParts.array().safeParse(effect.messages);
      if (!parsed.success) return decision;
      const anchor = parsed.data.find((message) =>
        message.parts.some(
          (part) => part.type === "text" && part.metadata?.compactionAnchor === true,
        ),
      );
      if (anchor === undefined) return decision;
      try {
        Session.addMessage(anchor.info.sessionID, anchor.info);
        for (const part of anchor.parts) {
          Session.addPart(anchor.info.id, part);
        }
      } catch {
        // Fail-open: see the contract above.
      }
      return decision;
    },
  };
}
