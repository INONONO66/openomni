import type { Policy } from "@openomni/protocol";
import { prepareRegistrationBoundary } from "./registration-validation";
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

function byPriority<T extends { readonly priority: number }>(registrations: readonly T[]): T[] {
  return registrations
    .map((registration, index) => ({ index, registration }))
    .sort(
      (left, right) =>
        left.registration.priority - right.registration.priority || left.index - right.index,
    )
    .map(({ registration }) => registration);
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
}

export function createPolicyRegistrationStore<
  TCtx extends GenericPolicyContext,
>(): PolicyRegistrationStore<TCtx> {
  const legacyRegistrations: PolicyRegistrationGeneric<TCtx>[] = [];
  const pointRegistrations: CanonicalPolicyRegistrationGeneric<TCtx>[] = [];

  return {
    register(registration) {
      const prepared = prepareRegistrationBoundary<TCtx>(registration);
      if (prepared.kind === "point") pointRegistrations.push(prepared.registration);
      else legacyRegistrations.push(prepared.registration);
    },
    selectLegacy(timing, agentType) {
      const selected: PolicyRegistrationGeneric<TCtx>[] = [];
      for (const registration of legacyRegistrations) {
        if (matchesTiming(registration, timing) && matchesScope(registration, agentType)) {
          selected.push(registration);
        }
      }
      return byPriority(selected);
    },
    selectPoint(pointId, agentType) {
      const selected: CanonicalPolicyRegistrationGeneric<TCtx>[] = [];
      for (const registration of pointRegistrations) {
        if (registration.pointIds.includes(pointId) && matchesScope(registration, agentType)) {
          selected.push(registration);
        }
      }
      return byPriority(selected);
    },
  };
}
