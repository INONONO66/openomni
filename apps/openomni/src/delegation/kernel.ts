import type { Delegation } from "@openomni/protocol";
import { type Admitted, type AdmissionLimits, admit, type DelegationOrigin } from "./admission";

/**
 * What a driver reports when it finishes carrying a request. It never names a
 * delegationId or an instant: identity belongs to the Handle the kernel
 * issued, and the clock belongs to the kernel.
 */
export type DriverOutcome =
  | { readonly status: "completed"; readonly output: string }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "cancelled"; readonly reason: string };

/**
 * A driver carries an admitted request to a worker. It owns the wire, never
 * the rules: admission has already decided this request may travel, and the
 * kernel enforces the deadline around it.
 */
export interface DelegationDriver {
  run(admitted: Admitted, handle: Delegation.Handle, signal: AbortSignal): Promise<DriverOutcome>;
}

export interface DelegationKernelOptions {
  readonly drivers: Partial<Record<Delegation.Transport, DelegationDriver>>;
  readonly now: () => number;
  readonly newDelegationId: () => string;
  readonly limits?: AdmissionLimits;
}

type DelegationResult =
  | { readonly refused: string }
  | { readonly handle: Delegation.Handle; readonly settled: Delegation.Settled };

export interface DelegationKernel {
  delegate(candidate: unknown, origin: DelegationOrigin): Promise<DelegationResult>;
}

const DEFAULT_LIMITS: AdmissionLimits = { maxInlineDepth: 2 };

export function createDelegationKernel(options: DelegationKernelOptions): DelegationKernel {
  const limits = options.limits ?? DEFAULT_LIMITS;

  return {
    async delegate(candidate, origin) {
      const decision = admit(candidate, origin, options.now(), limits);
      if (!decision.ok) return { refused: decision.reason };

      const handle: Delegation.Handle = {
        delegationId: options.newDelegationId(),
        address: decision.request.address,
        transport: decision.transport,
      };

      const driver = options.drivers[decision.transport];
      if (driver === undefined) {
        // The request never reached a worker, which is exactly what
        // delivery_failed means — never to be read as a worker who declined.
        return {
          handle,
          settled: {
            status: "delivery_failed",
            delegationId: handle.delegationId,
            reason: `no driver for ${decision.transport} transport`,
            at: options.now(),
          },
        };
      }

      const deadline = decision.request.deadline;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expiry = new Promise<"expired">((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve("expired");
        }, Math.max(0, deadline - options.now()));
      });

      try {
        const outcome = await Promise.race([
          driver.run(decision, handle, controller.signal).catch(
            (error: unknown): DriverOutcome => ({
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
          expiry,
        ]);

        if (outcome === "expired") {
          return {
            handle,
            settled: {
              status: "no_response",
              delegationId: handle.delegationId,
              deadline,
              // Silence is only honest once the deadline it was measured
              // against has arrived; the contract refuses an earlier instant.
              at: Math.max(options.now(), deadline),
            },
          };
        }

        return { handle, settled: { ...outcome, delegationId: handle.delegationId, at: options.now() } };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
