import { Delegation } from "@openomni/protocol";

/**
 * Who is asking for work to be delegated. The Resident is the only originator
 * that may commission independent work; a Worker may only open a same-domain
 * inline child (docs/core-model.md — "A Worker cannot spawn another Worker
 * under any trust tier; it may use a same-domain, context-sharing child").
 *
 * `depth` is how many inline children already stand between the Resident and
 * this originator. It exists because the Worker rule alone permits an endless
 * inline chain, and a deadline bounds wall-clock, not fan-out.
 */
export interface DelegationOrigin {
  readonly role: "resident" | "worker";
  readonly depth: number;
}

export interface Admitted {
  readonly ok: true;
  readonly request: Delegation.Request;
  readonly transport: Delegation.Transport;
  /** The origin an inline child of this delegation will itself present. */
  readonly childOrigin: DelegationOrigin;
}

export interface Refused {
  readonly ok: false;
  readonly reason: string;
}

export interface AdmissionLimits {
  /** How deep inline chains may go. 0 means a Worker may not delegate at all. */
  readonly maxInlineDepth: number;
}

/**
 * An address says WHO, never HOW (protocol delegation/schema.ts). Resolving
 * the wire is admission's job, and this is the only place it happens.
 */
function transportFor(address: Delegation.WorkerAddress): Delegation.Transport {
  if (address.kind === "actor") return "channel";
  return address.scope === "inline" ? "inline" : "process";
}

/**
 * The single owner of "may this originator delegate this, and over what
 * wire". Pure: every fact it judges is an argument. Refusals are returned,
 * not thrown, because a refused delegation is an ordinary answer to the
 * asking agent rather than a fault in the host.
 */
export function admit(
  candidate: unknown,
  origin: DelegationOrigin,
  now: number,
  limits: AdmissionLimits,
): Admitted | Refused {
  const parsed = Delegation.Request.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `invalid delegation request: ${issue?.message ?? "unknown"}` };
  }
  const request = parsed.data;

  // The schema proves the deadline is a positive instant; only here, holding a
  // clock, can we know it has not already passed.
  if (request.deadline <= now) {
    return { ok: false, reason: "deadline has already passed" };
  }

  const transport = transportFor(request.address);

  if (origin.role === "worker") {
    if (transport !== "inline") {
      return {
        ok: false,
        reason: "a worker may only delegate to a same-domain inline child; ask the Resident for independent work",
      };
    }
    if (origin.depth >= limits.maxInlineDepth) {
      return {
        ok: false,
        reason: `inline delegation is capped at depth ${limits.maxInlineDepth}`,
      };
    }
  }

  return {
    ok: true,
    request,
    transport,
    childOrigin: { role: "worker", depth: origin.depth + 1 },
  };
}
