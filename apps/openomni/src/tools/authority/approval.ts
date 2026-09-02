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

const REQUEST_WIRE_PROJECTION: Record<string, unknown> = {
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
      throw new ToolRefused("approval_request", error instanceof Error ? error.message : String(error));
    }
  };
}

function executeApprovalDecide(port: ApprovalPort, now: () => number = Date.now) {
  return async (input: z.output<typeof DECIDE_INPUT>) => {
    try {
      const outcome = port.decide(input.approvalId, input.decision, newTraceId(), now());
      return { approvalId: input.approvalId, state: outcome.record.state, decidedBy: outcome.record.decidedBy, unchanged: outcome.kind === "unchanged" };
    } catch (error) {
      throw new ToolRefused("approval_decide", error instanceof Error ? error.message : String(error));
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
      throw new ToolRefused("contact_promote", typeof subject === "string" ? subject : "subject mismatch");
    }
    try {
      const identity = port.promote(subject.actorId);
      return { id: identity.id, trustTier: identity.trustTier };
    } catch (error) {
      throw new ToolRefused("contact_promote", error instanceof Error ? error.message : String(error));
    }
  };
}

function executeEndpointMerge(port: ApprovalPort, now: () => number = Date.now) {
  return async (input: z.output<typeof ACT_INPUT>) => {
    const subject = approvedSubject(port, input.approvalId, "endpoint_merge", now());
    if (typeof subject === "string" || subject.kind !== "endpoint_merge") {
      throw new ToolRefused("endpoint_merge", typeof subject === "string" ? subject : "subject mismatch");
    }
    // Anti-TOCTOU: the merge executes ONLY the move the Owner saw — if the
    // endpoint changed hands since the request, the act refuses.
    const endpoint = port.getEndpoint(subject.endpointId);
    if (endpoint === undefined || endpoint.actorId !== subject.fromActorId) {
      throw new ToolRefused("endpoint_merge", `endpoint ${subject.endpointId} no longer belongs to ${subject.fromActorId}`);
    }
    try {
      const merged = port.mergeEndpoint(subject.endpointId, subject.toActorId);
      return { id: merged.id, actorId: merged.actorId };
    } catch (error) {
      throw new ToolRefused("endpoint_merge", error instanceof Error ? error.message : String(error));
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

const common = { category: "authority" as const, safe: false, execution: { kind: "host" } as const, placement: "host" as const, visibility: { model: ["resident"], cell: ["resident"] } as const };
const RequestOutput = z.object({ id: z.string(), subject: z.custom<Approval.Subject>(), deadline: z.number() }).strict();
const DecideOutput = z.object({ approvalId: z.string(), state: z.string(), decidedBy: z.string().nullable().optional(), unchanged: z.boolean() }).strict();
const PromoteOutput = z.object({ id: z.string(), trustTier: z.string() }).strict();
const MergeOutput = z.object({ id: z.string(), actorId: z.string() }).strict();
export const approvalRequestTool = defineTool({ ...common, name: "approval_request", description: "Open a deadline-bound Owner-approval request for a contact promotion or a cross-channel endpoint merge. Unanswered requests read as refused after the deadline.", input: REQUEST_INPUT, output: RequestOutput, wireProjection: REQUEST_WIRE_PROJECTION, bind: (ports) => ports.approvals === undefined ? undefined : executeApprovalRequest(ports.approvals), render: (_args, value) => `approval ${value.id} pending: ${describeSubject(value.subject)} — unanswered after ${value.deadline} reads as refused` });
export const approvalDecideTool = defineTool({ ...common, name: "approval_decide", description: "Record the Owner's answer to a pending approval request. Only usable when the Owner has answered in this session; answers past the deadline record the deadline's refusal.", input: DECIDE_INPUT, output: DecideOutput, bind: (ports) => ports.approvals === undefined ? undefined : executeApprovalDecide(ports.approvals), render: (_args, value) => value.unchanged ? `approval ${value.approvalId} was already ${value.state} (${value.decidedBy ?? "unknown"})` : `approval ${value.approvalId} ${value.state} by ${value.decidedBy ?? "owner"}` });
export const contactPromoteTool = defineTool({ ...common, name: "contact_promote", description: "Register a provisional contact. Requires an approved, unexpired contact_promotion approval naming that contact.", input: ACT_INPUT, output: PromoteOutput, bind: (ports) => ports.approvals === undefined ? undefined : executeContactPromote(ports.approvals), render: (_args, value) => `contact ${value.id} registered (tier ${value.trustTier})` });
export const endpointMergeTool = defineTool({ ...common, name: "endpoint_merge", description: "Move an endpoint onto another identity (cross-channel merge). Requires an approved, unexpired endpoint_merge approval naming exactly that move.", input: ACT_INPUT, output: MergeOutput, bind: (ports) => ports.approvals === undefined ? undefined : executeEndpointMerge(ports.approvals), render: (_args, value) => `endpoint ${value.id} merged into ${value.actorId}` });

function refusalText(name: string, error: unknown): string { return error instanceof ToolRefused ? error.message : `${name} refused: ${error instanceof Error ? error.message : String(error)}`; }
export function approvalRequestToolExecutor(port: ApprovalPort, now: () => number = Date.now) { return async (raw: unknown): Promise<string> => { try { const args = REQUEST_INPUT.parse(raw); return approvalRequestTool.render(args, await executeApprovalRequest(port, now)(args)); } catch (error) { return refusalText("approval_request", error); } }; }
export function approvalDecideToolExecutor(port: ApprovalPort, now: () => number = Date.now) { return async (raw: unknown): Promise<string> => { try { const args = DECIDE_INPUT.parse(raw); return approvalDecideTool.render(args, await executeApprovalDecide(port, now)(args)); } catch (error) { return refusalText("approval_decide", error); } }; }
export function contactPromoteToolExecutor(port: ApprovalPort, now: () => number = Date.now) { return async (raw: unknown): Promise<string> => { try { const args = ACT_INPUT.parse(raw); return contactPromoteTool.render(args, await executeContactPromote(port, now)(args)); } catch (error) { return refusalText("contact_promote", error); } }; }
export function endpointMergeToolExecutor(port: ApprovalPort, now: () => number = Date.now) { return async (raw: unknown): Promise<string> => { try { const args = ACT_INPUT.parse(raw); return endpointMergeTool.render(args, await executeEndpointMerge(port, now)(args)); } catch (error) { return refusalText("endpoint_merge", error); } }; }
