import * as Fold from "./fold.js";
import * as Schema from "./schema.js";
import { Events as MachineEvents } from "./events.js";

/**
 * Machine domain (docs/machines-and-delegation.md): attached devices as the
 * OS's body. Contracts only — the daemon runtime lives in the driver-band
 * `machines` package; enrollment storage lives in the ledger.
 */
export namespace Machine {
  export const CapabilityId = Schema.CapabilityId;
  export type CapabilityId = Schema.CapabilityId;
  export const MachineId = Schema.MachineId;
  export type MachineId = Schema.MachineId;
  export const Enrollment = Schema.Enrollment;
  export type Enrollment = Schema.Enrollment;
  export const Offer = Schema.Offer;
  export type Offer = Schema.Offer;

  export const effectiveCapabilities = Fold.effectiveCapabilities;
  export type EffectiveOutcome = Fold.EffectiveOutcome;

  export const Events = MachineEvents;
}
