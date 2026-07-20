import { z } from "zod";
import { PolicyPointContractModule } from "./point-contract.js";
import {
  policyPointInputSchemas,
  type PolicyPointInputMap as PolicyPointInputMapType,
} from "./point-input-schemas.js";
import { PolicyPointRegistryModule } from "./point-registry.js";
import { policyKernelVersion } from "./version.js";

export namespace PolicyPointModule {
  type Timing = PolicyPointContractModule.Timing;
  type RegisteredPolicyPointId = PolicyPointContractModule.RegisteredPolicyPointId;
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
    MigrationMapping: Readonly<Record<Timing, readonly RegisteredPolicyPointId[]>>;
  };

  export type PolicyPointInputMap = PolicyPointInputMapType;
}
