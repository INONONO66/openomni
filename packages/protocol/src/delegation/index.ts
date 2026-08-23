import { Events as EventDescriptors } from "./events.js";
import * as Schema from "./schema.js";

/**
 * Delegation domain (docs/machines-and-delegation.md): the uniform contract
 * for commissioning work — internal loops and external actors through ONE
 * address vocabulary. Contracts only: admission, lane drivers, and
 * settlement authority live in the kernel's DelegationKernel.
 */
export namespace Delegation {
  export const WorkerAddress = Schema.WorkerAddress;
  export type WorkerAddress = Schema.WorkerAddress;

  export const Mode = Schema.Mode;
  export type Mode = Schema.Mode;

  export const Lane = Schema.Lane;
  export type Lane = Schema.Lane;

  export const Request = Schema.Request;
  export type Request = Schema.Request;

  export const Handle = Schema.Handle;
  export type Handle = Schema.Handle;

  export const Settled = Schema.Settled;
  export type Settled = Schema.Settled;

  export const SettledStatus = Schema.SettledStatus;
  export type SettledStatus = Schema.SettledStatus;

  export const Events = EventDescriptors;
}
