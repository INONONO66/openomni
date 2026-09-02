import { newTraceId } from "@openomni/telemetry";
import type { ActorRegistry, ApprovalStore } from "@openomni/ledger";
import type { Approval } from "@openomni/protocol";
import { z } from "zod";
import { defineTool, ToolRefused } from "../core/define";

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

function executeApprovalRequest(port: ApprovalPort, now: () => number = Date.now) {
  return async (input: z.output<typeof REQUEST_INPUT>) => {
    const subject = subjectOf(port, input);
    if (typeof subject === "string") {
      throw new ToolRefused("approval_request", subject);
    }
    const at = now();
    try {
      const record = port.request(
        {
          id: `approval:${crypto.randomUUID()}`,
          subject,
          deadline: at + input.timeoutMs,
        },
        REQUEST_BOUND,
        // The tool call IS the trace origin (D11).
        newTraceId(),
        at,
      );
      return { id: record.id, subject: record.subject, deadline: record.deadline };
    } catch (error) {
      throw new ToolRefused(
        "approval_request",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}

function executeApprovalDecide(port: ApprovalPort, now: () => number = Date.now) {
  return async (input: z.output<typeof DECIDE_INPUT>) => {
    try {
      const outcome = port.decide(input.approvalId, input.decision, newTraceId(), now());
      return {
        approvalId: input.approvalId,
        state: outcome.record.state,
        decidedBy: outcome.record.decidedBy,
        unchanged: outcome.kind === "unchanged",
      };
    } catch (error) {
      throw new ToolRefused(
        "approval_decide",
        error instanceof Error ? error.message : String(error),
      );
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

function executeContactPromote(port: ApprovalPort, now: () => number = Date.now) {
  return async (input: z.output<typeof ACT_INPUT>) => {
    const subject = approvedSubject(port, input.approvalId, "contact_promotion", now());
    if (typeof subject === "string" || subject.kind !== "contact_promotion") {
      throw new ToolRefused(
        "contact_promote",
        typeof subject === "string" ? subject : "subject mismatch",
      );
    }
    try {
      const identity = port.promote(subject.actorId);
      return { id: identity.id, trustTier: identity.trustTier };
    } catch (error) {
      throw new ToolRefused(
        "contact_promote",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}

function executeEndpointMerge(port: ApprovalPort, now: () => number = Date.now) {
  return async (input: z.output<typeof ACT_INPUT>) => {
    const subject = approvedSubject(port, input.approvalId, "endpoint_merge", now());
    if (typeof subject === "string" || subject.kind !== "endpoint_merge") {
      throw new ToolRefused(
        "endpoint_merge",
        typeof subject === "string" ? subject : "subject mismatch",
      );
    }
    // Anti-TOCTOU: the merge executes ONLY the move the Owner saw — if the
    // endpoint changed hands since the request, the act refuses.
    const endpoint = port.getEndpoint(subject.endpointId);
    if (endpoint === undefined || endpoint.actorId !== subject.fromActorId) {
      throw new ToolRefused(
        "endpoint_merge",
        `endpoint ${subject.endpointId} no longer belongs to ${subject.fromActorId}`,
      );
    }
    try {
      const merged = port.mergeEndpoint(subject.endpointId, subject.toActorId);
      return { id: merged.id, actorId: merged.actorId };
    } catch (error) {
      throw new ToolRefused(
        "endpoint_merge",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}

function describeSubject(subject: Approval.Subject): string {
  if (subject.kind === "contact_promotion") return `promote contact ${subject.actorId}`;
  if (subject.kind === "person_mutation") {
    // Opened by person_declare (the guarded act pins its own manifest digest).
    return `apply Person manifest ${subject.personId} (digest ${subject.manifestDigest.slice(0, 12)}…)`;
  }
  return `merge endpoint ${subject.endpointId} from ${subject.fromActorId} into ${subject.toActorId}`;
}

const ApprovalInput = z
  .object({
    op: z.union([
      z.literal("request"),
      z.literal("decide"),
      z.literal("contact_promote"),
      z.literal("endpoint_merge"),
    ]),
    args: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((value, ctx) => {
    const schema =
      value.op === "request" ? REQUEST_INPUT : value.op === "decide" ? DECIDE_INPUT : ACT_INPUT;
    const parsed = schema.safeParse(value.args);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({ ...issue, path: ["args", ...issue.path] });
  });
const ApprovalOutput = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null,
);

export function createApprovalTool(port: ApprovalPort) {
  const request = executeApprovalRequest(port);
  const decide = executeApprovalDecide(port);
  const promote = executeContactPromote(port);
  const merge = executeEndpointMerge(port);
  return defineTool({
    name: "approval",
    category: "authority",
    description:
      "Request or decide Owner approval, then promote a contact or merge an endpoint with that approval. Use op=request|decide|contact_promote|endpoint_merge.",
    input: ApprovalInput,
    output: ApprovalOutput,
    visibility: { model: ["resident"], cell: ["resident"] },
    execute: async (input) => {
      if (input.op === "request") return request(input.args as z.output<typeof REQUEST_INPUT>);
      if (input.op === "decide") return decide(input.args as z.output<typeof DECIDE_INPUT>);
      if (input.op === "contact_promote") return promote(input.args as z.output<typeof ACT_INPUT>);
      return merge(input.args as z.output<typeof ACT_INPUT>);
    },
    render: (args, value) => {
      if (args.op === "request")
        return `approval ${String(value.id)} pending: ${describeSubject(value.subject as Approval.Subject)} — unanswered after ${String(value.deadline)} reads as refused`;
      if (args.op === "decide")
        return value.unchanged
          ? `approval ${String(value.approvalId)} was already ${String(value.state)} (${String(value.decidedBy ?? "unknown")})`
          : `approval ${String(value.approvalId)} ${String(value.state)} by ${String(value.decidedBy ?? "owner")}`;
      if (args.op === "contact_promote")
        return `contact ${String(value.id)} registered (tier ${String(value.trustTier)})`;
      return `endpoint ${String(value.id)} merged into ${String(value.actorId)}`;
    },
  });
}
