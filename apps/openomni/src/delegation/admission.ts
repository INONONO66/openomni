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
  readonly request: Delegation.Request;
  readonly transport: Delegation.Transport;
  readonly effectiveDeadline: number;
  readonly parentDelegationId?: string;
  readonly rootDelegationId: string;
  /** The origin an inline child of this delegation will present. */
  readonly childOrigin: DelegationOrigin;
}

const RefusalCode = z.enum([
  "invalid_request",
  "invalid_origin",
  "deadline_passed",
  "parent_missing",
  "parent_lineage",
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
  readonly parent?: Pick<Delegation.Record, "delegationId" | "rootDelegationId" | "deadline" | "status">;
  readonly parentMissing?: boolean;
  readonly openFanout: number;
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
export function admit(
  candidate: unknown,
  origin: DelegationOrigin,
  now: number,
  limits: AdmissionLimits,
  context?: AdmissionContext,
): Admitted | Refused {
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
  const trustedOrigin = parsedOrigin.data;
  const request = parsed.data;

  if (context?.parentMissing === true) {
    return refusal("parent_missing", `parent delegation ${trustedOrigin.parentDelegationId} does not exist`);
  }
  if (context !== undefined && trustedOrigin.parentDelegationId !== undefined && context.parent === undefined) {
    return refusal("parent_missing", `parent delegation ${trustedOrigin.parentDelegationId} does not exist`);
  }
  if (
    context?.parent !== undefined &&
    (trustedOrigin.parentDelegationId !== context.parent.delegationId ||
      context.parent.rootDelegationId !== context.rootDelegationId ||
      (trustedOrigin.rootDelegationId !== undefined &&
        trustedOrigin.rootDelegationId !== context.rootDelegationId))
  ) {
    return refusal("parent_lineage", "delegation lineage does not match the durable parent");
  }

  // The schema proves the requested deadline is a positive instant. Holding a
  // clock here is what lets the fold reject an already-expired request.
  if (Deadline.isExpired(now, request.deadline)) {
    return refusal("deadline_passed", "deadline has already passed");
  }

  const effectiveDeadline = Deadline.clampToParent(
    request.deadline,
    context?.parent?.deadline ?? request.deadline,
  );
  if (Deadline.isExpired(now, effectiveDeadline)) {
    return refusal("deadline_passed", "parent deadline has already passed");
  }

  const maxFanout = limits.maxFanout ?? 8;
  if (context !== undefined && context.openFanout >= maxFanout) {
    return refusal(
      "fanout_cap",
      `delegation fanout is capped at ${maxFanout} open records for root ${context.rootDelegationId}`,
    );
  }

  const transport = transportFor(request.address);
  if (trustedOrigin.role === "worker") {
    if (transport !== "inline") {
      return refusal(
        "worker_transport",
        "a worker may only delegate to a same-domain inline child; ask the Resident for independent work",
      );
    }
    if (trustedOrigin.depth >= limits.maxInlineDepth) {
      return refusal("inline_depth", `inline delegation is capped at depth ${limits.maxInlineDepth}`);
    }
  }

  const delegationId = context?.delegationId ?? "delegation";
  // A root is always stamped from the newly admitted id. A child inherits the
  // durable parent's root through context; an origin cannot choose a tree to
  // evade the fanout cap.
  const rootDelegationId =
    context?.rootDelegationId ??
    (trustedOrigin.parentDelegationId === undefined
      ? delegationId
      : (trustedOrigin.rootDelegationId ?? delegationId));
  const childOrigin: DelegationOrigin = {
    role: "worker",
    depth: trustedOrigin.depth + 1,
    sessionId: trustedOrigin.sessionId,
    ...(context === undefined
      ? {}
      : {
          parentDelegationId: delegationId,
          rootDelegationId,
        }),
  };

  return {
    ok: true,
    delegationId,
    request,
    transport,
    effectiveDeadline,
    ...(trustedOrigin.parentDelegationId === undefined
      ? {}
      : { parentDelegationId: trustedOrigin.parentDelegationId }),
    rootDelegationId,
    childOrigin,
  };
}
