import { settlementToAttemptOutcome as settlementToAttemptOutcomeFold } from "./attempt-linkage.js";
import { Events as EventDescriptors } from "./events.js";
import * as Schema from "./schema.js";

/**
 * Delegation domain (docs/machines-and-delegation.md): the uniform contract
 * for commissioning work — internal loops and external actors through ONE
 * address vocabulary. Contracts only: admission, transport drivers, and
 * settlement authority live in the kernel's DelegationKernel.
 */
export namespace Delegation {
  export const WorkerAddress = Schema.WorkerAddress;
  export type WorkerAddress = Schema.WorkerAddress;

  export const Operation = Schema.Operation;
  export type Operation = Schema.Operation;

  export const Transport = Schema.Transport;
  export type Transport = Schema.Transport;

  export const Origin = Schema.Origin;
  export type Origin = Schema.Origin;

  export const Request = Schema.Request;
  export type Request = Schema.Request;

  export const Handle = Schema.Handle;
  export type Handle = Schema.Handle;

  export const Settled = Schema.Settled;
  export type Settled = Schema.Settled;

  export const SettledStatus = Schema.SettledStatus;
  export type SettledStatus = Schema.SettledStatus;

  export const Record = Schema.Record;
  export type Record = Schema.Record;

  export const Events = EventDescriptors;

  export const settlementToAttemptOutcome = settlementToAttemptOutcomeFold;
}
