import { Engagement } from "@openomni/protocol";
import { z } from "zod";
import { defineTool, errorResult, fromError, successResult } from "../../define.js";
import type { NativeTool, ToolExecutionContext } from "../../types.js";

/**
 * Engagement tools (#709, gateway stage 4 — docs/gateway-design.md §5): the
 * brain-side surface of the durable delegation machine. Delegation category,
 * so the depth gate keeps them resident-only (the message.send precedent).
 *
 * Division of labor (design non-goal §10 — no content FSM): the LLM DECLARES
 * moves — term crossings, deliberation steps, completion — and the MACHINE
 * enforces legal edges, records every transition (user_audit + ledger fact),
 * and forces the approval stop when a crossing is reported. Whether a term
 * WAS crossed, whether a price is fair, how to negotiate: never evaluated
 * here.
 *
 * Approval gate (exact semantics): the transition to `acting` from
 * `awaiting_user_approval` passes `ownerApproved` to the fold ONLY when the
 * TRIGGERING DELIVERY's perimeter trust verdict (`actorContext.trustTier`,
 * threaded as the executor-owned implicit `actorTrustTier`) is `owner` or
 * `co_owner` — the Owner said yes in-channel. Wait resumptions, anonymous
 * admissions, and internal runs carry no tier and therefore can never
 * approve; the fold rejects `approval_required`.
 */

export interface EngagementPort {
  open(input: Engagement.Create, traceId: string, at?: number): Engagement.Record;
  transition(id: string, input: Engagement.TransitionInput, traceId: string): Engagement.Outcome;
  get(id: string): Engagement.Record | undefined;
  list(filter?: { ownerSessionId?: string; states?: Engagement.State[] }): Engagement.Record[];
  readonly activeStates: readonly Engagement.State[];
}

export type EngagementToolsOptions = Readonly<{
  /** The ledger EngagementStore, injected by the composition root (brain sole writer). */
  engagements: EngagementPort;
  /** Injected clock — the machine never reads the wall clock internally. */
  now?: () => number;
}>;

const APPROVER_TIERS: ReadonlySet<string> = new Set(["owner", "co_owner"]);

function renderRecord(record: Engagement.Record): Record<string, unknown> {
  return {
    id: record.id,
    title: record.title,
    state: record.state,
    terms: record.terms,
    openWaitIds: record.openWaitIds,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
  };
}

/** Rejections are RESULTS the agent reasons about, never thrown errors (the denial convention). */
function renderOutcome(outcome: Engagement.Outcome): Record<string, unknown> {
  switch (outcome.kind) {
    case "transitioned":
      return {
        kind: "transitioned",
        from: outcome.from,
        to: outcome.to,
        engagement: renderRecord(outcome.record),
      };
    case "forced_approval":
      return {
        kind: "forced_approval",
        from: outcome.from,
        requested: outcome.requested,
        note: "the reported term crossing forced awaiting_user_approval — the Owner must approve in-channel before acting",
        engagement: renderRecord(outcome.record),
      };
    case "expired":
      return { kind: "expired", from: outcome.from, engagement: renderRecord(outcome.record) };
    case "rejected":
      return { kind: "rejected", code: outcome.code, engagement: renderRecord(outcome.record) };
  }
}

// ---------------------------------------------------------------------------
// engagement.open
// ---------------------------------------------------------------------------

const OpenInputSchema = z
  .object({
    title: z.string().min(1),
    terms: Engagement.Terms.optional(),
    /** Executor-injected calling session (implicit input — never model-supplied). */
    sessionId: z.string().min(1).optional(),
  })
  .strict();

const openInputSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: 'The delegation, one line (e.g. "sell bike, floor 50000").',
    },
    terms: {
      type: "object",
      description:
        "Delegation terms, recorded verbatim. The machine acts only on `deadline` (expiry); " +
        "judging spendCeiling/autoApprove against reality is YOUR job — report crossings via " +
        "engagement.transition termCrossed.",
      properties: {
        spendCeiling: { type: "number", description: "Money ceiling (Owner term, recorded)." },
        autoApprove: {
          type: "string",
          description: "Owner criteria text under which acting needs no fresh approval.",
        },
        deadline: {
          type: "number",
          description: "Epoch ms — the machine expires the engagement after it.",
        },
        speakTriggers: {
          type: "array",
          items: { type: "string" },
          description: "When the resident may speak unprompted (default: silent observation).",
        },
      },
      additionalProperties: false,
    },
    sessionId: { type: "string" },
  },
  required: ["title"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// engagement.transition
// ---------------------------------------------------------------------------

const TransitionInputSchema = z
  .object({
    id: z.string().min(1),
    to: Engagement.State,
    reason: z.string().min(1),
    termCrossed: z.boolean().optional(),
    waitIds: z.array(z.string().min(1)).optional(),
    /** Executor-injected calling session (implicit input — never model-supplied). */
    sessionId: z.string().min(1).optional(),
    /** Executor-injected perimeter trust verdict of the triggering delivery (implicit input). */
    actorTrustTier: z.string().min(1).optional(),
  })
  .strict();

const transitionInputSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Engagement id." },
    to: {
      enum: [
        "awaiting_external",
        "deliberating",
        "awaiting_user_approval",
        "acting",
        "done",
        "aborted",
      ],
      description:
        "Requested target state. Legal edges only: planning→awaiting_external|deliberating; " +
        "awaiting_external→deliberating; deliberating→awaiting_external|awaiting_user_approval|acting; " +
        "awaiting_user_approval→acting|deliberating; acting→done; aborted from any live state. " +
        "acting from awaiting_user_approval requires the current delivery to come from the Owner.",
    },
    reason: { type: "string", description: "The declared move — recorded on the audit event." },
    termCrossed: {
      type: "boolean",
      description:
        "Report a delegation-term crossing (price below floor, ceiling exceeded, criteria unmet). " +
        "True FORCES awaiting_user_approval regardless of the requested target.",
    },
    waitIds: {
      type: "array",
      items: { type: "string" },
      description: "Open wait ids to record (required when entering awaiting_external).",
    },
    sessionId: { type: "string" },
    actorTrustTier: { type: "string" },
  },
  required: ["id", "to", "reason"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// engagement.list
// ---------------------------------------------------------------------------

const ListInputSchema = z
  .object({
    /** Executor-injected calling session (implicit input — never model-supplied). */
    sessionId: z.string().min(1).optional(),
  })
  .strict();

const listInputSchema = {
  type: "object",
  properties: {
    sessionId: { type: "string" },
  },
  required: [],
  additionalProperties: false,
};

function requireTraceId(context: ToolExecutionContext | undefined): string | undefined {
  const traceId = context?.traceContext?.traceId;
  return traceId !== undefined && traceId.length > 0 ? traceId : undefined;
}

export function createEngagementTools(options: EngagementToolsOptions): NativeTool[] {
  const now = options.now ?? Date.now;

  const open = defineTool<z.infer<typeof OpenInputSchema>>({
    name: "engagement.open",
    description:
      "Open a durable engagement (one delegation) for this session: the machine records the " +
      "title and terms verbatim, starts in `planning`, and audits every later transition. " +
      "Terms are the Owner's words — judging them stays with you; the machine only enforces " +
      "legal state edges and the deadline.",
    inputSchema: openInputSchema,
    source: "agent",
    riskTier: 1,
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    implicitInputs: { sessionId: "sessionId" },
    async execute(call, context?: ToolExecutionContext) {
      const parsed = OpenInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return errorResult(
          call,
          `Invalid input: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        );
      }
      const traceId = requireTraceId(context);
      if (traceId === undefined) {
        return errorResult(call, "engagement.open requires the run trace context");
      }
      if (parsed.data.sessionId === undefined) {
        return errorResult(
          call,
          "engagement.open requires the calling session context — the executor injects it",
        );
      }
      try {
        const record = options.engagements.open(
          {
            id: crypto.randomUUID(),
            ownerSessionId: parsed.data.sessionId,
            title: parsed.data.title,
            terms: parsed.data.terms ?? {},
          },
          traceId,
          now(),
        );
        return successResult(call, JSON.stringify(renderRecord(record)));
      } catch (error) {
        return fromError(call, error);
      }
    },
  });

  const transition = defineTool<z.infer<typeof TransitionInputSchema>>({
    name: "engagement.transition",
    description:
      "Declare an engagement state move. The machine enforces legal edges only and records " +
      "the transition (Owner-auditable). Report term crossings with termCrossed=true — that " +
      "FORCES awaiting_user_approval. Moving awaiting_user_approval→acting succeeds only when " +
      "the message you are currently handling came from the Owner (in-channel approval); " +
      "illegal or unapproved moves come back as `rejected` results to reason about.",
    inputSchema: transitionInputSchema,
    source: "agent",
    riskTier: 1,
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    implicitInputs: { sessionId: "sessionId", actorTrustTier: "actorTrustTier" },
    async execute(call, context?: ToolExecutionContext) {
      const parsed = TransitionInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return errorResult(
          call,
          `Invalid input: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        );
      }
      const traceId = requireTraceId(context);
      if (traceId === undefined) {
        return errorResult(call, "engagement.transition requires the run trace context");
      }
      if (parsed.data.sessionId === undefined) {
        return errorResult(
          call,
          "engagement.transition requires the calling session context — the executor injects it",
        );
      }
      const record = options.engagements.get(parsed.data.id);
      if (record === undefined) {
        return errorResult(call, `engagement not found: ${parsed.data.id}`);
      }
      // Session ownership: an engagement is owned by ONE session; a run in
      // another session may not move it (the correlation bridge is ids on
      // contracts, never cross-session writes).
      if (record.ownerSessionId !== parsed.data.sessionId) {
        return errorResult(
          call,
          `engagement ${parsed.data.id} belongs to another session — transitions are owner-session only`,
        );
      }
      // THE approval gate (#709): ownerApproved is asserted iff the
      // triggering delivery's perimeter verdict is owner/co_owner. The fold
      // demands the assertion on the awaiting_user_approval → acting edge.
      const ownerApproved = APPROVER_TIERS.has(parsed.data.actorTrustTier ?? "");
      try {
        const outcome = options.engagements.transition(
          parsed.data.id,
          {
            to: parsed.data.to,
            at: now(),
            reason: parsed.data.reason,
            ...(parsed.data.termCrossed === undefined
              ? {}
              : { termCrossed: parsed.data.termCrossed }),
            ...(parsed.data.waitIds === undefined ? {} : { waitIds: parsed.data.waitIds }),
            ownerApproved,
          },
          traceId,
        );
        return successResult(call, JSON.stringify(renderOutcome(outcome)));
      } catch (error) {
        return fromError(call, error);
      }
    },
  });

  const list = defineTool<z.infer<typeof ListInputSchema>>({
    name: "engagement.list",
    description:
      "List this session's active engagements (id, title, state, terms, open waits) — the " +
      "machine-recorded delegation state, the same slice hydrated into your run context.",
    inputSchema: listInputSchema,
    source: "agent",
    riskTier: 0,
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    implicitInputs: { sessionId: "sessionId" },
    async execute(call, _context?: ToolExecutionContext) {
      const parsed = ListInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return errorResult(
          call,
          `Invalid input: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
        );
      }
      if (parsed.data.sessionId === undefined) {
        return errorResult(
          call,
          "engagement.list requires the calling session context — the executor injects it",
        );
      }
      try {
        const records = options.engagements.list({
          ownerSessionId: parsed.data.sessionId,
          states: [...options.engagements.activeStates],
        });
        return successResult(call, JSON.stringify(records.map(renderRecord)));
      } catch (error) {
        return fromError(call, error);
      }
    },
  });

  // Delegation category: the depth gate strips these from child agents
  // (catalog step 4) — only the depth-0 resident manages delegations.
  return [open, transition, list].map((tool) => ({ ...tool, category: "delegation" as const }));
}
