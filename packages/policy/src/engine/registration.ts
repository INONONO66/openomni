import type { Policy } from "@openomni/protocol";
import { prepareRegistrationBoundary } from "./registration-validation";
import { timingForPolicyPoint } from "./points";
import type {
  CanonicalPolicyRegistrationGeneric,
  GenericPolicyContext,
  PolicyEngineRegistrationGeneric,
  PolicyPointId,
  PolicyRegistrationGeneric,
} from "./types";

export { PolicyRegistrationError } from "./registration-validation";

function matchesScope<TCtx extends GenericPolicyContext>(
  registration: PolicyEngineRegistrationGeneric<TCtx>,
  agentType: string | undefined,
): boolean {
  const allowed = registration.scope?.agentType;
  if (allowed === undefined || allowed.length === 0) return true;
  if (!agentType) return false;
  return allowed.includes(agentType);
}

function matchesTiming<TCtx extends GenericPolicyContext>(
  registration: PolicyRegistrationGeneric<TCtx>,
  timing: Policy.Timing,
): boolean {
  return Array.isArray(registration.timing)
    ? registration.timing.includes(timing)
    : registration.timing === timing;
}

export interface PolicyRegistrationStore<TCtx extends GenericPolicyContext> {
  register(registration: PolicyEngineRegistrationGeneric<TCtx>): void;
  selectLegacy(
    timing: Policy.Timing,
    agentType: string | undefined,
  ): PolicyRegistrationGeneric<TCtx>[];
  selectPoint(
    pointId: PolicyPointId,
    agentType?: string,
  ): CanonicalPolicyRegistrationGeneric<TCtx>[];
  selectLegacyCompatible(
    timing: Policy.Timing,
    agentType: string | undefined,
    pointId: PolicyPointId,
  ): PolicyEngineRegistrationGeneric<TCtx>[];
  selectPointCompatible(
    pointId: PolicyPointId,
    agentType?: string,
  ): PolicyEngineRegistrationGeneric<TCtx>[];
}

export function createPolicyRegistrationStore<
  TCtx extends GenericPolicyContext,
>(): PolicyRegistrationStore<TCtx> {
  const legacyRegistrations: PolicyRegistrationGeneric<TCtx>[] = [];
  const pointRegistrations: CanonicalPolicyRegistrationGeneric<TCtx>[] = [];
  const registrationOrder = new Map<PolicyEngineRegistrationGeneric<TCtx>, number>();
  let nextRegistrationOrder = 0;

  function sorted<T extends PolicyEngineRegistrationGeneric<TCtx>>(
    registrations: readonly T[],
  ): T[] {
    return registrations
      .map((registration, index) => ({ index, registration }))
      .sort((left, right) => {
        const priorityOrder = left.registration.priority - right.registration.priority;
        if (priorityOrder !== 0 && !Number.isNaN(priorityOrder)) return priorityOrder;
        const leftOrder = registrationOrder.get(left.registration) ?? left.index;
        const rightOrder = registrationOrder.get(right.registration) ?? right.index;
        return leftOrder - rightOrder;
      })
      .map(({ registration }) => registration);
  }

  const matchingLegacy = (timing: Policy.Timing, agentType: string | undefined) =>
    legacyRegistrations.filter(
      (registration) =>
        matchesTiming(registration, timing) && matchesScope(registration, agentType),
    );
  const matchingPoints = (pointId: PolicyPointId, agentType: string | undefined) =>
    pointRegistrations.filter(
      (registration) =>
        registration.pointIds.includes(pointId) && matchesScope(registration, agentType),
    );

  return {
    register(registration) {
      const prepared = prepareRegistrationBoundary<TCtx>(registration);
      registrationOrder.set(prepared.registration, nextRegistrationOrder);
      nextRegistrationOrder += 1;
      if (prepared.kind === "point") pointRegistrations.push(prepared.registration);
      else legacyRegistrations.push(prepared.registration);
    },
    selectLegacy(timing, agentType) {
      return sorted(matchingLegacy(timing, agentType));
    },
    selectPoint(pointId, agentType) {
      return sorted(matchingPoints(pointId, agentType));
    },
    selectLegacyCompatible(timing, agentType, pointId) {
      return sorted([...matchingLegacy(timing, agentType), ...matchingPoints(pointId, agentType)]);
    },
    selectPointCompatible(pointId, agentType) {
      const timing = timingForPolicyPoint(pointId);
      return sorted([...matchingPoints(pointId, agentType), ...matchingLegacy(timing, agentType)]);
    },
  };
}
