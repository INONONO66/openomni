import type { DelegationWake } from "./kernel";

/**
 * Owner-session wake delivery with a pre-target queue. Boot recovery runs
 * before the composition root can bind the Resident's deliver chain, so a
 * rescan wake arrives while no delivery target exists; those wakes wait here
 * and flush when arm() binds the real delivery.
 *
 * Failure handling is reject-only on purpose: the kernel's deliverWake is the
 * single owner of wake-failure reporting — publishing an error event here
 * would double-report every failed wake.
 */
export function createWakeDeliveryQueue(): {
  /** Kernel wake option: direct once armed, queued (as a promise) before. */
  readonly deliver: (wake: DelegationWake) => void | Promise<void>;
  /** Binds the real delivery and flushes every queued wake through it. */
  readonly arm: (target: (wake: DelegationWake) => Promise<void>) => void;
  /** Wakes still waiting for a target (boot observability and tests). */
  readonly pendingCount: () => number;
} {
  let target: ((wake: DelegationWake) => Promise<void>) | undefined;
  const pending: Array<{
    readonly wake: DelegationWake;
    readonly resolve: () => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  return {
    deliver(wake) {
      if (target === undefined) {
        return new Promise<void>((resolve, reject) => {
          pending.push({ wake, resolve, reject });
        });
      }
      return target(wake);
    },
    arm(bound) {
      target = bound;
      for (const entry of pending.splice(0)) {
        void bound(entry.wake).then(entry.resolve, entry.reject);
      }
    },
    pendingCount: () => pending.length,
  };
}
