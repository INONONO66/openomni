import { newTraceId } from "@openomni/telemetry";
import type { ActorRegistry, ApprovalStore } from "@openomni/ledger";
import type { Approval, Tool } from "@openomni/protocol";
import { z } from "zod";

/**
 * Resident-facing approval lane (#P3, docs/conversation-and-message-io.md
 * §6): contact promotion and cross-channel endpoint merging are explicit
 * Owner-consent acts, never inferred (§8.4). A request is deadline-bound and
 * volume-bounded (§8.13); the Owner answers in the resident session
 * (approval_decide records that answer); the act executors consume ONLY an
 * approved, unexpired request whose subject still matches reality.
 */

export interface ApprovalPort {
  readonly request: typeof ApprovalStore.request;
  readonly get: typeof ApprovalStore.get;
  readonly decide: typeof ApprovalStore.decide;
  readonly decision: typeof ApprovalStore.decision;
  readonly getIdentity: typeof ActorRegistry.getIdentity;
  readonly getEndpoint: typeof ActorRegistry.getEndpoint;
  readonly promote: typeof ActorRegistry.promote;
  readonly mergeEndpoint: typeof ActorRegistry.mergeEndpoint;
}

/**
 * §8.13 anti-fatigue bound: at most this many pending requests per rolling
 * window — a request storm refuses instead of burying the Owner, so refusal
 * (the timeout default) stays the cheap path.
 */
const REQUEST_BOUND = { windowMs: 3_600_000, maxPending: 8 } as const;

const REQUEST_INPUT = z.discriminatedUnion("act", [
  z
    .object({
      act: z.literal("contact_promotion"),
      actorId: z.string().min(1).describe("Provisional contact to register."),
      timeoutMs: z.number().int().positive().describe("How long the Owner has to answer."),
    })
    .strict(),
  z
    .object({
      act: z.literal("endpoint_merge"),
      endpointId: z.string().min(1).describe("Endpoint that would move."),
      toActorId: z.string().min(1).describe("Identity the endpoint would join."),
      timeoutMs: z.number().int().positive().describe("How long the Owner has to answer."),
    })
    .strict(),
]);

const DECIDE_INPUT = z
  .object({
    approvalId: z.string().min(1).describe("Pending approval request."),
    decision: z.enum(["approved", "refused"]).describe("The Owner's answer."),
  })
  .strict();

const ACT_INPUT = z
  .object({
    approvalId: z.string().min(1).describe("Approved request that authorizes this act."),
  })
  .strict();

const REQUEST_INPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["act", "timeoutMs"],
  properties: {
    act: { type: "string", enum: ["contact_promotion", "endpoint_merge"] },
    actorId: { type: "string", minLength: 1 },
    endpointId: { type: "string", minLength: 1 },
    toActorId: { type: "string", minLength: 1 },
    timeoutMs: { type: "integer", exclusiveMinimum: 0 },
  },
};

const DECIDE_INPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["approvalId", "decision"],
  properties: {
    approvalId: { type: "string", minLength: 1 },
    decision: { type: "string", enum: ["approved", "refused"] },
  },
};

const ACT_INPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["approvalId"],
  properties: {
    approvalId: { type: "string", minLength: 1 },
  },
};

export function approvalRequestToolSpec(): Tool.Spec {
  return {
    name: "approval_request",
    description:
      "Open a deadline-bound Owner-approval request for a contact promotion or a cross-channel endpoint merge. Unanswered requests read as refused after the deadline.",
    inputSchema: REQUEST_INPUT_JSON_SCHEMA,
    safe: false,
    placement: "host",
  };
}

export function approvalDecideToolSpec(): Tool.Spec {
  return {
    name: "approval_decide",
    description:
      "Record the Owner's answer to a pending approval request. Only usable when the Owner has answered in this session; answers past the deadline record the deadline's refusal.",
    inputSchema: DECIDE_INPUT_JSON_SCHEMA,
    safe: false,
    placement: "host",
  };
}

export function contactPromoteToolSpec(): Tool.Spec {
  return {
    name: "contact_promote",
    description:
      "Register a provisional contact. Requires an approved, unexpired contact_promotion approval naming that contact.",
    inputSchema: ACT_INPUT_JSON_SCHEMA,
    safe: false,
    placement: "host",
  };
}

export function endpointMergeToolSpec(): Tool.Spec {
  return {
    name: "endpoint_merge",
    description:
      "Move an endpoint onto another identity (cross-channel merge). Requires an approved, unexpired endpoint_merge approval naming exactly that move.",
    inputSchema: ACT_INPUT_JSON_SCHEMA,
    safe: false,
    placement: "host",
  };
}

function subjectOf(
  port: ApprovalPort,
  input: z.infer<typeof REQUEST_INPUT>,
): Approval.Subject | string {
  if (input.act === "contact_promotion") {
    const identity = port.getIdentity(input.actorId);
    if (identity === undefined) return `contact ${input.actorId} does not exist`;
    if (identity.standing !== "provisional") {
      return `contact ${input.actorId} is already registered`;
    }
    return { kind: "contact_promotion", actorId: input.actorId };
  }
  const endpoint = port.getEndpoint(input.endpointId);
  if (endpoint === undefined) return `endpoint ${input.endpointId} does not exist`;
  if (port.getIdentity(input.toActorId) === undefined) {
    return `contact ${input.toActorId} does not exist`;
  }
  if (endpoint.actorId === input.toActorId) {
    return `endpoint ${input.endpointId} already belongs to ${input.toActorId}`;
  }
  return {
    kind: "endpoint_merge",
    endpointId: input.endpointId,
    fromActorId: endpoint.actorId,
    toActorId: input.toActorId,
  };
}

export function approvalRequestToolExecutor(port: ApprovalPort, now: () => number = Date.now) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = REQUEST_INPUT.safeParse(rawInput);
    if (!parsed.success) {
      return `approval_request refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`;
    }
    const subject = subjectOf(port, parsed.data);
    if (typeof subject === "string") {
      return `approval_request refused: ${subject}`;
    }
    const at = now();
    try {
      const record = port.request(
        {
          id: `approval:${crypto.randomUUID()}`,
          subject,
          deadline: at + parsed.data.timeoutMs,
        },
        REQUEST_BOUND,
        // The tool call IS the trace origin (D11).
        newTraceId(),
        at,
      );
      return `approval ${record.id} pending: ${describeSubject(record.subject)} — unanswered after ${record.deadline} reads as refused`;
    } catch (error) {
      return `approval_request refused: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
}

export function approvalDecideToolExecutor(port: ApprovalPort, now: () => number = Date.now) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = DECIDE_INPUT.safeParse(rawInput);
    if (!parsed.success) {
      return `approval_decide refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`;
    }
    try {
      const outcome = port.decide(parsed.data.approvalId, parsed.data.decision, newTraceId(), now());
      if (outcome.kind === "unchanged") {
        return `approval ${parsed.data.approvalId} was already ${outcome.record.state} (${outcome.record.decidedBy ?? "unknown"})`;
      }
      return `approval ${parsed.data.approvalId} ${outcome.record.state} by ${outcome.record.decidedBy ?? "owner"}`;
    } catch (error) {
      return `approval_decide refused: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
}

/**
 * The shared act gate: the request must exist, read `approved` AT `now`
 * (a pending request past its deadline reads refused — fail-closed), and
 * carry the expected subject kind.
 */
function approvedSubject(
  port: ApprovalPort,
  approvalId: string,
  kind: Approval.Subject["kind"],
  at: number,
): Approval.Subject | string {
  const record = port.get(approvalId);
  if (record === undefined) return `approval ${approvalId} does not exist`;
  const state = port.decision(approvalId, at);
  if (state !== "approved") {
    return `approval ${approvalId} is ${state} — only an approved request authorizes this act`;
  }
  if (record.subject.kind !== kind) {
    return `approval ${approvalId} approves a ${record.subject.kind}, not a ${kind}`;
  }
  return record.subject;
}

export function contactPromoteToolExecutor(port: ApprovalPort, now: () => number = Date.now) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = ACT_INPUT.safeParse(rawInput);
    if (!parsed.success) {
      return `contact_promote refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`;
    }
    const subject = approvedSubject(port, parsed.data.approvalId, "contact_promotion", now());
    if (typeof subject === "string" || subject.kind !== "contact_promotion") {
      return `contact_promote refused: ${typeof subject === "string" ? subject : "subject mismatch"}`;
    }
    try {
      const identity = port.promote(subject.actorId);
      return `contact ${identity.id} registered (tier ${identity.trustTier})`;
    } catch (error) {
      return `contact_promote refused: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
}

export function endpointMergeToolExecutor(port: ApprovalPort, now: () => number = Date.now) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = ACT_INPUT.safeParse(rawInput);
    if (!parsed.success) {
      return `endpoint_merge refused: ${parsed.error.issues[0]?.message ?? "invalid input"}`;
    }
    const subject = approvedSubject(port, parsed.data.approvalId, "endpoint_merge", now());
    if (typeof subject === "string" || subject.kind !== "endpoint_merge") {
      return `endpoint_merge refused: ${typeof subject === "string" ? subject : "subject mismatch"}`;
    }
    // Anti-TOCTOU: the merge executes ONLY the move the Owner saw — if the
    // endpoint changed hands since the request, the act refuses.
    const endpoint = port.getEndpoint(subject.endpointId);
    if (endpoint === undefined || endpoint.actorId !== subject.fromActorId) {
      return `endpoint_merge refused: endpoint ${subject.endpointId} no longer belongs to ${subject.fromActorId}`;
    }
    try {
      const merged = port.mergeEndpoint(subject.endpointId, subject.toActorId);
      return `endpoint ${merged.id} merged into ${merged.actorId}`;
    } catch (error) {
      return `endpoint_merge refused: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
}

function describeSubject(subject: Approval.Subject): string {
  return subject.kind === "contact_promotion"
    ? `promote contact ${subject.actorId}`
    : `merge endpoint ${subject.endpointId} from ${subject.fromActorId} into ${subject.toActorId}`;
}
