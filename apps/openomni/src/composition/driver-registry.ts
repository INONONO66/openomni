/**
 * Delegation driver registry — generation pinning and draining.
 *
 * The kernel resolves `drivers[transport]` at dispatch time, which makes the
 * driver table the composition seam: this registry presents a live view whose
 * property reads always answer with the *current* registration, so a driver
 * can be replaced while the kernel keeps running.
 *
 * The generation rules are the point:
 *
 * - A dispatch that already resolved a registration completes under it. A
 *   swap never migrates, aborts, or re-routes work the old generation holds.
 * - New dispatches only ever see the newest registration. There is no window
 *   in which a disposed or replaced driver accepts new work.
 * - `drain()` resolves exactly when the last run dispatched through that
 *   registration returns — an awaitable fact, not a timing guess.
 *
 * Unregistering is registration-scoped: disposing a replaced registration
 * never evicts its successor. An empty slot is not defaulted — the kernel
 * owns the refusal (`delivery_failed: no driver for <transport> transport`),
 * which keeps exactly one judgment seat for undeliverable work.
 */

import { Delegation } from "@openomni/protocol";
import type { DelegationDriver } from "../delegation/kernel";

interface DriverRegistration {
  readonly transport: Delegation.Transport;
  /** Monotone per transport; the newest registration is the one dispatching. */
  readonly generation: number;
  /** Runs dispatched through this registration that have not yet returned. */
  inFlight(): number;
  /** Resolves when every run dispatched through this registration has returned. */
  drain(): Promise<void>;
  /**
   * Removes this registration from the live view if it is still the current
   * one. Work already dispatched through it keeps running to completion —
   * disposing revokes admission, never history.
   */
  dispose(): void;
}

interface DriverRegistry {
  /** Registers a driver, replacing (not disturbing) the previous generation. */
  register(transport: Delegation.Transport, driver: DelegationDriver): DriverRegistration;
  /** Live table for the kernel: each read resolves the current generation. */
  readonly drivers: Partial<Record<Delegation.Transport, DelegationDriver>>;
}

interface Entry {
  readonly generation: number;
  readonly wrapped: DelegationDriver;
  inFlight: number;
  drainWaiters: (() => void)[];
}

function settleDrain(entry: Entry): void {
  if (entry.inFlight === 0) {
    for (const wake of entry.drainWaiters.splice(0)) {
      wake();
    }
  }
}

/** Counts a run against its registration; the count is exact, not sampled. */
function wrap(driver: DelegationDriver, entry: () => Entry): DelegationDriver {
  const wrapped: DelegationDriver = {
    async run(admitted, handle, signal, report) {
      const owner = entry();
      owner.inFlight += 1;
      try {
        return await driver.run(admitted, handle, signal, report);
      } finally {
        owner.inFlight -= 1;
        settleDrain(owner);
      }
    },
  };
  // The kernel treats `prepare !== undefined` as a capability signal; the
  // wrapper must mirror the underlying driver's shape exactly.
  const prepare = driver.prepare?.bind(driver);
  if (prepare !== undefined) {
    return { ...wrapped, prepare };
  }
  return wrapped;
}

export function createDriverRegistry(): DriverRegistry {
  const table = new Map<Delegation.Transport, Entry>();
  const generations = new Map<Delegation.Transport, number>();

  const drivers: Partial<Record<Delegation.Transport, DelegationDriver>> = {};
  // Derived from the protocol schema so a new transport can never be
  // silently absent from the live view.
  for (const transport of Delegation.Transport.options) {
    Object.defineProperty(drivers, transport, {
      enumerable: true,
      get: () => table.get(transport)?.wrapped,
    });
  }

  return {
    drivers,
    register(transport, driver) {
      const generation = (generations.get(transport) ?? 0) + 1;
      generations.set(transport, generation);
      const entry: Entry = {
        generation,
        wrapped: wrap(driver, () => entry),
        inFlight: 0,
        drainWaiters: [],
      };
      table.set(transport, entry);
      return {
        transport,
        generation,
        inFlight: () => entry.inFlight,
        drain() {
          if (entry.inFlight === 0) {
            return Promise.resolve();
          }
          return new Promise((resolve) => entry.drainWaiters.push(resolve));
        },
        dispose() {
          if (table.get(transport) === entry) {
            table.delete(transport);
          }
        },
      };
    },
  };
}
