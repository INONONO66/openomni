import { z } from "zod";
import { PolicyPointContractModule } from "./point-contract.js";
import {
  policyPointInputSchemas,
  type PolicyPointInputMap as PolicyPointInputMapType,
} from "./point-input-schemas.js";
import { PolicyPointRegistryModule } from "./point-registry.js";
import { policyKernelVersion } from "./version.js";

export namespace PolicyPointModule {
  const resolvePolicyPoints = (
    timing: PolicyPointContractModule.Timing,
    context?: { readonly resourceKind?: string },
  ): string[] => {
    const pointIds = PolicyPointRegistryModule.policyPointMigrationMapping[timing];
    const resourceKind = context?.resourceKind;

    if (resourceKind === undefined) return [...pointIds];

    return pointIds.filter((pointId) =>
      PolicyPointRegistryModule.PolicyPointRegistry[pointId].resourceKinds.includes(resourceKind),
    );
  };

  export const PolicyPoint = Object.assign(PolicyPointContractModule.policyPoint, {
    version: policyKernelVersion,
    Id: PolicyPointContractModule.PolicyPointId,
    Contract: PolicyPointContractModule.PolicyPointContract,
    RegistrySchema: z.record(
      PolicyPointContractModule.PolicyPointId,
      PolicyPointContractModule.PolicyPointContract,
    ),
    Registry: PolicyPointRegistryModule.PolicyPointRegistry,
    InputSchemas: policyPointInputSchemas,
    MigrationMapping: PolicyPointRegistryModule.policyPointMigrationMapping,
    resolve: resolvePolicyPoints,
  });
  Object.defineProperties(PolicyPoint, {
    Registry: {
      configurable: false,
      writable: false,
    },
    InputSchemas: {
      configurable: false,
      writable: false,
    },
  });

  export type PolicyPoint = z.infer<typeof PolicyPointContractModule.policyPoint> & {
    MigrationMapping: Record<
      PolicyPointContractModule.Timing,
      PolicyPointContractModule.RegisteredPolicyPointId[]
    >;
    resolve: typeof PolicyPoint.resolve;
  };

  export type PolicyPointInputMap = PolicyPointInputMapType;
}
