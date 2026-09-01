import { Deadline, Delegation, NamedError } from "@openomni/protocol";
import { z } from "zod";

/**
 * Who is asking for work to be delegated. The Resident is the only originator
 * that may commission independent work; a Worker may only open a same-domain
 * inline child. Lineage fields are stamped by the admission fold and are not
 * model input.
 */
export type DelegationOrigin = Delegation.Origin;

export interface Admitted {
  readonly ok: true;
  readonly delegationId: string;
  /** Correlation allocated by the kernel before an assigned worker is commissioned. */
  readonly workerRunId?: string;
  readonly request: Delegation.Request;
  readonly transport: Delegation.Transport;
  readonly effectiveDeadline: number;
  readonly parentDelegationId?: string;
  readonly rootDelegationId: string;
  /** The origin an inline child of this delegation will present. */
  readonly childOrigin: DelegationOrigin;
  /**
   * The live lease that admitted a worker's channel delegation (§3.5). The
   * driver pins every send to this lease and its conversation; an admission
   * without one never reaches a channel from a worker origin.
   */
  readonly lease?: AdmissionLease;
}

/** The durable lease fact the kernel supplies; admission performs no I/O. */
export interface AdmissionLease {
  readonly id: string;
  readonly conversationId: string;
  readonly holderDelegationId: string;
  readonly contactId: string;
}

const RefusalCode = z.enum([
  "invalid_request",
  "invalid_origin",
  "deadline_passed",
  "parent_missing",
  "parent_lineage",
  "parent_settled",
  "fanout_cap",
  "worker_transport",
  "inline_depth",
  "prepare_failed",
  "work_item_failed",
]);
type RefusalCode = z.infer<typeof RefusalCode>;

/** Typed, model-visible admission refusal. */
export const AdmissionRefusal = NamedError.create(
  "DelegationAdmissionRefusal",
  z.object({
    code: RefusalCode,
    message: z.string().min(1),
  }),
);
export type AdmissionRefusal = InstanceType<typeof AdmissionRefusal>;

export interface Refused {
  readonly ok: false;
  /** Kept as a stable rendering surface for the model-facing tool. */
  readonly reason: string;
  readonly error: AdmissionRefusal;
}

export interface AdmissionLimits {
  /** How deep inline chains may go. 0 means a Worker may not delegate. */
  readonly maxInlineDepth: number;
  /** Maximum number of open records in one delegation tree. */
  readonly maxFanout?: number;
}

/** Durable facts supplied by the kernel; the fold itself performs no I/O. */
export interface AdmissionContext {
  readonly delegationId: string;
  readonly rootDelegationId: string;
  readonly workerRunId?: string;
  readonly parent?: Pick<
    Delegation.Record,
    "delegationId" | "rootDelegationId" | "deadline" | "status"
  >;
  readonly parentMissing?: boolean;
  readonly openFanout: number;
  /** Live leases held by the requesting worker's own delegation, if any. */
  readonly leases?: readonly AdmissionLease[];
}

function refusal(code: RefusalCode, message: string): Refused {
  const error = new AdmissionRefusal({ code, message });
  return { ok: false, reason: message, error };
}

/**
 * An address says WHO, never HOW. Resolving the wire is admission's job, and
 * this is the only place that maps an address onto a transport.
 * Admission's role fold IS the commissioning authority boundary; nothing else commissions delegation.
 */
function transportFor(address: Delegation.WorkerAddress): Delegation.Transport {
  if (address.kind === "actor") return "channel";
  return address.scope === "inline" ? "inline" : "process";
}

/**
 * The single owner of "may this originator delegate this, and over what wire".
 * Every fact it judges is an argument, making this fold deterministic and
 * straightforward to replay in tests or during a later admission audit.
 */
interface ParsedAdmission {
  readonly ok: true;
  readonly request: Delegation.Request;
  readonly origin: DelegationOrigin;
}

function parseAdmission(candidate: unknown, origin: DelegationOrigin): ParsedAdmission | Refused {
  const parsed = Delegation.Request.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return refusal("invalid_request", `invalid delegation request: ${issue?.message ?? "unknown"}`);
  }

  const parsedOrigin = Delegation.Origin.safeParse(origin);
  if (!parsedOrigin.success) {
    const issue = parsedOrigin.error.issues[0];
    return refusal("invalid_origin", `invalid delegation origin: ${issue?.message ?? "unknown"}`);
  }
  return { ok: true, request: parsed.data, origin: parsedOrigin.data };
}

function validateParent(origin: DelegationOrigin, context?: AdmissionContext): Refused | undefined {
  if (
    context?.parentMissing === true ||
    (context !== undefined &&
      origin.parentDelegationId !== undefined &&
      context.parent === undefined)
  ) {
    return refusal(
      "parent_missing",
      `parent delegation ${origin.parentDelegationId} does not exist`,
    );
  }
  if (
    context?.parent !== undefined &&
    (origin.parentDelegationId !== context.parent.delegationId ||
      context.parent.rootDelegationId !== context.rootDelegationId ||
      (origin.rootDelegationId !== undefined &&
        origin.rootDelegationId !== context.rootDelegationId))
  ) {
    return refusal("parent_lineage", "delegation lineage does not match the durable parent");
  }
  if (context?.parent?.status === "settled") {
    return refusal(
      "parent_settled",
      `parent delegation ${context.parent.delegationId} is already settled`,
    );
  }
  return undefined;
}

function effectiveDeadline(
  request: Delegation.Request,
  now: number,
  context?: AdmissionContext,
): number | Refused {
  // The schema proves the requested deadline is a positive instant. Holding a
  // clock here is what lets the fold reject an already-expired request.
  if (Deadline.isExpired(now, request.deadline)) {
    return refusal("deadline_passed", "deadline has already passed");
  }

  const effective = Deadline.clampToParent(
    request.deadline,
    context?.parent?.deadline ?? request.deadline,
  );
  if (Deadline.isExpired(now, effective)) {
    return refusal("deadline_passed", "parent deadline has already passed");
  }
  return effective;
}

function validateFanout(limits: AdmissionLimits, context?: AdmissionContext): Refused | undefined {
  const maxFanout = limits.maxFanout ?? 8;
  if (context !== undefined && context.openFanout >= maxFanout) {
    return refusal(
      "fanout_cap",
      `delegation fanout is capped at ${maxFanout} open records for root ${context.rootDelegationId}`,
    );
  }
  return undefined;
}

interface WorkerTransportAdmission {
  readonly lease?: AdmissionLease;
}

function admitWorkerTransport(
  origin: DelegationOrigin,
  request: Delegation.Request,
  transport: Delegation.Transport,
  limits: AdmissionLimits,
  context?: AdmissionContext,
): WorkerTransportAdmission | Refused {
  // §3.5 lease relaxation: a worker whose OWN delegation holds a live lease
  // pinned to exactly this contact may reach the channel. The match is against
  // parentDelegationId, so an inline grandchild is refused by construction.
  const address = request.address;
  const lease =
    transport === "channel" && address.kind === "actor"
      ? context?.leases?.find(
          (candidate) =>
            candidate.holderDelegationId === origin.parentDelegationId &&
            candidate.contactId === address.actorId,
        )
      : undefined;
  if (transport !== "inline" && lease === undefined) {
    return refusal(
      "worker_transport",
      "a worker may only delegate to a same-domain inline child; ask the Resident for independent work",
    );
  }
  if (transport === "inline" && origin.depth >= limits.maxInlineDepth) {
    return refusal("inline_depth", `inline delegation is capped at depth ${limits.maxInlineDepth}`);
  }
  return lease === undefined ? {} : { lease };
}

function admittedResult(
  request: Delegation.Request,
  origin: DelegationOrigin,
  transport: Delegation.Transport,
  deadline: number,
  context: AdmissionContext | undefined,
  lease: AdmissionLease | undefined,
): Admitted {
  const delegationId = context?.delegationId ?? "delegation";
  // A root is always stamped from the newly admitted id. A child inherits the
  // durable parent's root through context; an origin cannot choose a tree to
  // evade the fanout cap.
  const rootDelegationId =
    context?.rootDelegationId ??
    (origin.parentDelegationId === undefined
      ? delegationId
      : (origin.rootDelegationId ?? delegationId));
  const childOrigin: DelegationOrigin = {
    role: "worker",
    depth: origin.depth + 1,
    sessionId: origin.sessionId,
    ...(context === undefined ? {} : { parentDelegationId: delegationId, rootDelegationId }),
  };

  return {
    ok: true,
    delegationId,
    ...(context?.workerRunId === undefined ? {} : { workerRunId: context.workerRunId }),
    request,
    transport,
    effectiveDeadline: deadline,
    ...(origin.parentDelegationId === undefined
      ? {}
      : { parentDelegationId: origin.parentDelegationId }),
    rootDelegationId,
    childOrigin,
    ...(lease === undefined ? {} : { lease }),
  };
}

export function admit(
  candidate: unknown,
  origin: DelegationOrigin,
  now: number,
  limits: AdmissionLimits,
  context?: AdmissionContext,
): Admitted | Refused {
  const parsed = parseAdmission(candidate, origin);
  if (!parsed.ok) return parsed;

  const parentRefusal = validateParent(parsed.origin, context);
  if (parentRefusal !== undefined) return parentRefusal;

  const deadline = effectiveDeadline(parsed.request, now, context);
  if (typeof deadline !== "number") return deadline;

  const fanoutRefusal = validateFanout(limits, context);
  if (fanoutRefusal !== undefined) return fanoutRefusal;

  const transport = transportFor(parsed.request.address);
  const workerAdmission =
    parsed.origin.role === "worker"
      ? admitWorkerTransport(parsed.origin, parsed.request, transport, limits, context)
      : {};
  if ("ok" in workerAdmission) return workerAdmission;

  return admittedResult(
    parsed.request,
    parsed.origin,
    transport,
    deadline,
    context,
    workerAdmission.lease,
  );
}
