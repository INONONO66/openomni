import { prepareRegistrationBoundary } from "./registration-validation";
import type {
  CanonicalPolicyRegistrationGeneric,
  GenericPolicyContext,
  PolicyPointId,
} from "./types";

export { PolicyRegistrationError } from "./registration-validation";

function matchesScope<TCtx extends GenericPolicyContext>(
  registration: CanonicalPolicyRegistrationGeneric<TCtx>,
  agentType: string | undefined,
): boolean {
  const allowed = registration.scope?.agentType;
  if (allowed === undefined || allowed.length === 0) return true;
  if (!agentType) return false;
  return allowed.includes(agentType);
}

export interface PolicyRegistrationStore<TCtx extends GenericPolicyContext> {
  register(registration: CanonicalPolicyRegistrationGeneric<TCtx>): void;
  selectPoint(
    pointId: PolicyPointId,
    agentType?: string,
  ): CanonicalPolicyRegistrationGeneric<TCtx>[];
}

export function createPolicyRegistrationStore<
  TCtx extends GenericPolicyContext,
>(): PolicyRegistrationStore<TCtx> {
  const pointRegistrations: CanonicalPolicyRegistrationGeneric<TCtx>[] = [];

  return {
    register(registration) {
      pointRegistrations.push(prepareRegistrationBoundary<TCtx>(registration));
    },
    selectPoint(pointId, agentType) {
      // Stable selection: ascending priority, registration order breaks ties.
      return pointRegistrations
        .map((registration, index) => ({ registration, index }))
        .filter(
          ({ registration }) =>
            registration.pointIds.includes(pointId) && matchesScope(registration, agentType),
        )
        .sort(
          (left, right) =>
            left.registration.priority - right.registration.priority || left.index - right.index,
        )
        .map(({ registration }) => registration);
    },
  };
}
