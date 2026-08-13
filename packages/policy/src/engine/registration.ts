import { prepareRegistrationBoundary } from "./registration-validation";
import type {
  CanonicalPolicyRegistrationGeneric,
  GenericPolicyContext,
  PolicyPointId,
} from "./types";

export { PolicyRegistrationError } from "./registration-validation";

const NO_REGISTRATIONS: readonly never[] = Object.freeze([]);

function matchesScope<TCtx extends GenericPolicyContext>(
  registration: CanonicalPolicyRegistrationGeneric<TCtx>,
  agentType: string | undefined,
): boolean {
  const allowed = registration.scope?.agentType;
  if (allowed === undefined || allowed.length === 0) return true;
  if (!agentType) return false;
  return allowed.includes(agentType);
}

function isAgentTypeScoped<TCtx extends GenericPolicyContext>(
  registration: CanonicalPolicyRegistrationGeneric<TCtx>,
): boolean {
  return (registration.scope?.agentType?.length ?? 0) > 0;
}

export interface PolicyRegistrationStore<TCtx extends GenericPolicyContext> {
  register(registration: CanonicalPolicyRegistrationGeneric<TCtx>): void;
  selectPoint(
    pointId: PolicyPointId,
    agentType?: string,
  ): readonly CanonicalPolicyRegistrationGeneric<TCtx>[];
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
    readonly registration: CanonicalPolicyRegistrationGeneric<TCtx>;
    readonly order: number;
  }

  const entriesByPoint = new Map<PolicyPointId, Entry[]>();
  const selectionByPoint = new Map<
    PolicyPointId,
    readonly CanonicalPolicyRegistrationGeneric<TCtx>[]
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
