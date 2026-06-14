import { z } from "zod";
import { PolicyPointContractModule } from "./point-contract.js";
import { PolicyPointRegistryModule } from "./point-registry.js";
import { policyKernelVersion } from "./version.js";

type PolicyPointResolver = (
  timing: PolicyPointContractModule.Timing,
  context?: { readonly resourceKind?: string },
) => string[];

export namespace PolicyPointModule {
  const resolvePolicyPoints: PolicyPointResolver = (timing, context) => {
    const pointIds = PolicyPointRegistryModule.policyPointMigrationMapping[timing];
    const resourceKind = context?.resourceKind;

    if (resourceKind === undefined) return [...pointIds];

    return pointIds.filter((pointId) =>
      PolicyPointRegistryModule.PolicyPointRegistry[pointId].resourceKinds.includes(resourceKind),
    );
  };

  // Preserve the original augmented Zod schema contract while moving registry data out of the facade.
  export const PolicyPoint = Object.assign(PolicyPointContractModule.policyPoint, {
    version: policyKernelVersion,
    Id: PolicyPointContractModule.PolicyPointId,
    Contract: PolicyPointContractModule.PolicyPointContract,
    RegistrySchema: z.record(
      PolicyPointContractModule.PolicyPointId,
      PolicyPointContractModule.PolicyPointContract,
    ),
    Registry: PolicyPointRegistryModule.PolicyPointRegistry,
    MigrationMapping: PolicyPointRegistryModule.policyPointMigrationMapping,
    resolve: resolvePolicyPoints,
  });

  export type PolicyPoint = z.infer<typeof PolicyPointContractModule.policyPoint> & {
    MigrationMapping: Record<
      PolicyPointContractModule.Timing,
      PolicyPointContractModule.RegisteredPolicyPointId[]
    >;
    resolve: typeof PolicyPoint.resolve;
  };
}
