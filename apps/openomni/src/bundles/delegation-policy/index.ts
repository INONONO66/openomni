import { Bundle, type Core } from "@openomni/agent";
import {
  canonicalDigest,
  Inbox,
  SessionTransition,
  type LedgerAction,
  type LedgerSession,
  type PlainValue,
} from "@openomni/protocol";
import { Effect } from "effect";
import { z } from "zod";
import { ActionCapabilitySeam } from "../seams";

/**
 * The `delegation-policy` bundle (#1258): the caps on child-session creation
 * as consulted guard rows at `tool.pre`, the `delegation.deadline` alarm
 * purpose, and the parentReply fold (every child terminal becomes one
 * outbound message to its parent). It requires the action capability, so
 * turning `action` off cascades delegation policy off with it.
 */

/** The default caps; the rows carry them as `how.params`, so policy data stays in rows. */
export const DEFAULT_DELEGATION_CAPS = Object.freeze({ maxDepth: 3, maxActiveChildren: 4 });

/** Catalog reads the guards consult per decision; `undefined` denies (fail closed). */
export interface DelegationReads {
  /** Parent-link depth of the session (root = 0). */
  depth(sessionId: string): number | undefined;
  /** Count of this session's live (non-closed) children. */
  activeChildren(sessionId: string): number | undefined;
}

function record(value: PlainValue): Readonly<Record<string, PlainValue>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

/** True when the decided tool args create a child session. */
function createsChild(value: PlainValue): boolean {
  const to = record(record(value)?.to ?? null);
  return to?.kind === "new_session";
}

function limitParam(params: PlainValue, fallback: number): number {
  const limit = record(params)?.limit;
  return typeof limit === "number" ? limit : fallback;
}

type GuardResult = ReturnType<Core.NamedGuard["decide"]>;

const skipped = (cap: string): GuardResult => ({
  verdict: "allow",
  payload: { cap, skipped: true },
});

function capVerdict(
  cap: string,
  limit: number,
  observed: number | undefined,
): GuardResult {
  if (observed === undefined)
    return { verdict: "deny", payload: { cap, limit, reason: "catalog read unavailable" } };
  const verdict = observed < limit ? "allow" : "deny";
  return { verdict, payload: { cap, limit, observed } };
}

/** Caps how deep the delegation tree may grow: a session at depth >= limit spawns nothing. */
export function spawnDepthGuard(reads: DelegationReads): { decide: Core.NamedGuard["decide"] } {
  return {
    decide: ({ value, params, when }) => {
      if (!createsChild(value)) return skipped("spawn_depth");
      const sessionId = typeof when.sessionId === "string" ? when.sessionId : undefined;
      const depth = sessionId === undefined ? undefined : reads.depth(sessionId);
      return capVerdict("spawn_depth", limitParam(params, DEFAULT_DELEGATION_CAPS.maxDepth), depth);
    },
  };
}

/** Caps concurrent live children per parent. */
export function spawnChildrenGuard(reads: DelegationReads): { decide: Core.NamedGuard["decide"] } {
  return {
    decide: ({ value, params, when }) => {
      if (!createsChild(value)) return skipped("spawn_children");
      const sessionId = typeof when.sessionId === "string" ? when.sessionId : undefined;
      const children = sessionId === undefined ? undefined : reads.activeChildren(sessionId);
      return capVerdict(
        "spawn_children",
        limitParam(params, DEFAULT_DELEGATION_CAPS.maxActiveChildren),
        children,
      );
    },
  };
}

/** A child is only created with an explicit positive spend cap on the send. */
export function spendCapGuard(): { decide: Core.NamedGuard["decide"] } {
  return {
    decide: ({ value }): GuardResult => {
      if (!createsChild(value)) return skipped("spend_cap");
      const cap = record(value)?.spend_cap;
      if (typeof cap === "number" && cap > 0)
        return { verdict: "allow", payload: { cap: "spend_cap", granted: cap } };
      return {
        verdict: "deny",
        payload: { cap: "spend_cap", reason: "new session requires spend_cap" },
      };
    },
  };
}

/** The three cap rows at `tool.pre`, matching the one send door. */
export function delegationRows(): readonly Bundle.BundleGateRow[] {
  return [
    {
      id: "delegation-policy/tool.pre#1",
      on: "tool.pre",
      when: { op: "send_message" },
      do: "gate",
      how: {
        ref: "delegation-policy/spawn-depth",
        params: { limit: DEFAULT_DELEGATION_CAPS.maxDepth },
      },
      order: 910,
    },
    {
      id: "delegation-policy/tool.pre#2",
      on: "tool.pre",
      when: { op: "send_message" },
      do: "gate",
      how: {
        ref: "delegation-policy/spawn-children",
        params: { limit: DEFAULT_DELEGATION_CAPS.maxActiveChildren },
      },
      order: 911,
    },
    {
      id: "delegation-policy/tool.pre#3",
      on: "tool.pre",
      when: { op: "send_message" },
      do: "gate",
      how: { ref: "delegation-policy/spend-cap" },
      order: 912,
    },
  ];
}

// ─── delegation.deadline ───

export const DELEGATION_DEADLINE = "delegation.deadline";

/** Armed alongside a `to.new` send carrying `deadline_ms`. */
const DeadlinePayload = z
  .object({
    /** The child session the deadline bounds. */
    child: z.string().min(1),
    /** The contact name shown to the parent (`session:<id>` for children). */
    contact: z.string().min(1),
  })
  .strict();

/** Composition wires this to the entity deliver door: `signal{control: cancel}` to the child. */
export interface DelegationDeadlineDeps {
  cancel(input: {
    readonly child: string;
    readonly occurrenceId: string;
  }): Effect.Effect<void, { readonly reason: string }>;
}

/**
 * On fire: cancel the silent child through the injected outbound door, then
 * prompt the parent with the expiry fact — no reply counts as unknown, and
 * the parent decides what happens next.
 */
function deadlineWake(deps: DelegationDeadlineDeps): Bundle.AlarmPurposeHandler {
  return ({ fired, ctx }) =>
    Effect.gen(function* () {
      const payload = yield* Effect.try({
        try: () => DeadlinePayload.parse(JSON.parse(fired.payload)),
        catch: () => new Bundle.AlarmWakeError({ purpose: fired.purpose, reason: "payload" }),
      });
      yield* deps.cancel({ child: payload.child, occurrenceId: fired.occurrenceId }).pipe(
        Effect.mapError(
          (refused) =>
            new Bundle.AlarmWakeError({ purpose: fired.purpose, reason: refused.reason }),
        ),
      );
      yield* ctx.prompt({
        content: JSON.stringify({
          kind: DELEGATION_DEADLINE,
          contact: payload.contact,
          child: payload.child,
          firedAt: fired.fireAt,
          note: "deadline expired with no reply; the child was cancelled",
        }),
        payload: { child: payload.child, contact: payload.contact },
      });
      return "delivered" as const;
    });
}

/** The purpose declaration for the live alarm capability composition. */
export function delegationPurposes(deps: DelegationDeadlineDeps): Bundle.AlarmBundlePurposes {
  return {
    bundle: "delegation-policy",
    purposes: [{ name: DELEGATION_DEADLINE, handler: deadlineWake(deps) }],
  };
}

// ─── parent reply ───

/**
 * A child seals its own obligation; only the receiving executor changes the
 * parent. Moved verbatim from the former composition module (#1258): the reply
 * fold is delegation policy, so the bundle owns it.
 */
export function parentReply(
  kernel: Core.SessionKernel,
  row: LedgerSession.Row,
  terminal: LedgerAction.Append,
  result: Core.SessionRunnerResult,
): SessionTransition.OutboundMessage | undefined {
  if (row.parentId === null || result.kind === "waiting") return undefined;
  const original = kernel
    .inputMessages(row.id)
    .map((item) => Inbox.MessageOrigin.safeParse(item.origin.value))
    .find((origin) => origin.success && origin.data.senderSessionId === row.parentId);
  if (original === undefined || !original.success) return undefined;
  const message = {
    messageId: `${terminal.id}:reply`,
    sourceSessionId: row.id,
    sourceActionId: terminal.id,
    destinationSessionId: row.parentId,
    requestId: original.data.sourceActionId,
    replyTo: original.data.replyTo ?? original.data.messageId,
    terminal: result.kind === "result" ? ("completed" as const) : result.kind,
    content: result.text ?? "",
  };
  return SessionTransition.OutboundMessage.parse({ ...message, digest: canonicalDigest(message) });
}

/**
 * Catalog-backed reads over the ledger's session rows (parent links = depth,
 * children = live rows). `isActiveChild` is the composition-bound liveness
 * fact (#1258 M-4): a child counts against `spawn_children` only while it
 * still has work in flight — an open turn or an undelivered inbox message.
 * When the read is absent or throws, the child counts (conservative: the cap
 * stays tight rather than leaking).
 */
export function catalogDelegationReads(
  listSessions: () => readonly { readonly id: string; readonly parentId: string | null }[],
  isActiveChild?: (childId: string) => boolean,
): DelegationReads {
  const active = (childId: string): boolean => {
    if (isActiveChild === undefined) return true;
    try {
      return isActiveChild(childId);
    } catch {
      return true;
    }
  };
  return {
    depth: (id) => {
      const rows = listSessions();
      if (!rows.some((row) => row.id === id)) return undefined;
      let depth = 0;
      let parent = rows.find((row) => row.id === id)?.parentId ?? null;
      while (parent !== null) {
        depth += 1;
        parent = rows.find((row) => row.id === parent)?.parentId ?? null;
      }
      return depth;
    },
    activeChildren: (id) => {
      const rows = listSessions();
      if (!rows.some((row) => row.id === id)) return undefined;
      return rows.filter((row) => row.parentId === id && active(row.id)).length;
    },
  };
}

/** Fail-closed defaults when composition has not bound the catalog reads yet. */
const UNBOUND_READS: DelegationReads = {
  depth: () => undefined,
  activeChildren: () => undefined,
};

/**
 * The bundle contract (#1255 `Bundle.define`): three guard rows, their guard
 * handlers, and the deadline purpose. The contract's handler and purpose
 * faces are declarations with fail-closed doors; composition rebinds them —
 * `generation-layers` binds the guards to the live catalog reads and the
 * watch plane binds the deadline cancel door — the same pattern as bundle
 * tool faces deferring to the ported catalog definitions.
 */
export function delegationPolicyBundle(): Bundle.BundleContract<
  "delegation-policy",
  object,
  Bundle.AlarmPurposeHandler
> {
  return Bundle.define({
    name: "delegation-policy",
    requires: [ActionCapabilitySeam, Bundle.AlarmSeam],
    rows: delegationRows(),
    handlers: {
      "delegation-policy/spawn-depth": spawnDepthGuard(UNBOUND_READS),
      "delegation-policy/spawn-children": spawnChildrenGuard(UNBOUND_READS),
      "delegation-policy/spend-cap": spendCapGuard(),
    },
    purposes: {
      [DELEGATION_DEADLINE]: deadlineWake({
        cancel: () => Effect.fail({ reason: "outbound cancel door is not composed" }),
      }),
    },
  });
}

/** The live guard handlers composition binds over the contract's fail-closed faces. */
export function delegationGuardHandlers(
  reads: DelegationReads,
): Readonly<Record<string, { decide: Core.NamedGuard["decide"] }>> {
  return {
    "delegation-policy/spawn-depth": spawnDepthGuard(reads),
    "delegation-policy/spawn-children": spawnChildrenGuard(reads),
    "delegation-policy/spend-cap": spendCapGuard(),
  };
}
