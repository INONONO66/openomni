import { prepareRegistrationBoundary } from "./registration-validation";
import type {
  RuntimePolicyRegistrationGeneric,
  GenericPolicyContext,
  PolicyEngineMiddlewareGeneric,
  PolicyPointId,
} from "./types";

export { PolicyRegistrationError } from "./registration-validation";

const NO_REGISTRATIONS: readonly never[] = Object.freeze([]);

/**
 * Scoping remains fail-open by omission as pinned by #806: a scoped
 * registration does not run when `agentType` is absent or different. The
 * containment boundary is selection itself: a skipped registration is never
 * invoked, so none of its verdict, effects, or identity can leak into the
 * decision, while unscoped registrations remain selected and authoritative.
 * Scope only policies whose absence is acceptable; unconditional guards must
 * register unscoped.
 */
function matchesScope<TCtx extends GenericPolicyContext>(
  registration: RuntimePolicyRegistrationGeneric<TCtx>,
  agentType: string | undefined,
): boolean {
  const allowed = registration.scope?.agentType;
  if (allowed === undefined) return true;
  // Unreachable via register() — `empty_scope_agent_type` rejects [] at the
  // boundary — kept fail-closed so an empty list can never mean "everyone".
  if (allowed.length === 0) return false;
  if (!agentType) return false;
  return allowed.includes(agentType);
}

function isAgentTypeScoped<TCtx extends GenericPolicyContext>(
  registration: RuntimePolicyRegistrationGeneric<TCtx>,
): boolean {
  return (registration.scope?.agentType?.length ?? 0) > 0;
}

export interface PolicyRegistrationStore<TCtx extends GenericPolicyContext> {
  register(registration: PolicyEngineMiddlewareGeneric<TCtx>): void;
  selectPoint(
    pointId: PolicyPointId,
    agentType?: string,
  ): readonly RuntimePolicyRegistrationGeneric<TCtx>[];
}

/**
 * Registrations are fixed at composition time and selected on every dispatch,
 * so ordering is computed once per point in `register()` instead of being
 * re-derived per call. A point with no registration returns a shared frozen
 * empty array — the signal the dispatcher uses to skip context materialization.
 */
export function createPolicyRegistrationStore<
  TCtx extends GenericPolicyContext,
>(): PolicyRegistrationStore<TCtx> {
  interface Entry {
    readonly registration: RuntimePolicyRegistrationGeneric<TCtx>;
    readonly order: number;
  }

  const entriesByPoint = new Map<PolicyPointId, Entry[]>();
  const selectionByPoint = new Map<
    PolicyPointId,
    readonly RuntimePolicyRegistrationGeneric<TCtx>[]
  >();
  const agentTypeScopedPoints = new Set<PolicyPointId>();
  let registrationCount = 0;

  return {
    register(registration) {
      const prepared = prepareRegistrationBoundary<TCtx>(registration);
      const order = registrationCount;
      registrationCount += 1;

      for (const pointId of prepared.pointIds) {
        const entries = entriesByPoint.get(pointId) ?? [];
        entries.push({ registration: prepared, order });
        // Stable selection: ascending priority, registration order breaks ties.
        entries.sort(
          (left, right) =>
            left.registration.priority - right.registration.priority || left.order - right.order,
        );
        entriesByPoint.set(pointId, entries);
        // Frozen because it is shared with every dispatch at this point; TS
        // `readonly` alone would let a caller mutate the store's own array.
        selectionByPoint.set(pointId, Object.freeze(entries.map((entry) => entry.registration)));
        if (isAgentTypeScoped(prepared)) agentTypeScopedPoints.add(pointId);
      }
    },

    selectPoint(pointId, agentType) {
      const selection = selectionByPoint.get(pointId);
      if (selection === undefined) return NO_REGISTRATIONS;
      // Only points carrying an agentType-scoped registration need the
      // per-dispatch filter; every other point reuses the precomputed order.
      if (!agentTypeScopedPoints.has(pointId)) return selection;
      return selection.filter((registration) => matchesScope(registration, agentType));
    },
  };
}
