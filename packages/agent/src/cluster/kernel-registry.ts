import type { SessionHandleStore } from "@openomni/ledger";

/**
 * The handle-scoped kernel as a declaration-nameable interface: the ledger
 * alias is a `ReturnType` projection whose parameter types stay private to the
 * ledger, so exported types here must reference it through this name.
 *
 * NOTE (W5.2 #1197 plan §3): the `SessionKernelService` Context tag over this
 * shape lands together with its first production reader (the handle plane,
 * wave 3) - the boundary law refuses tags nothing reads (R9), and every
 * wave-2 consumer receives the kernel explicitly from the entity activation.
 */
export interface SessionKernel extends SessionHandleStore.SessionKernel {}

/**
 * Process-local registry mapping live entity activations to their kernel
 * handles. This is the wave-2 bridge between the entity plane (which owns the
 * open store) and legacy entry points that still look sessions up by id; it
 * dies with them when the handle plane is completed (plan wave 3).
 */
export interface SessionKernelRegistry {
  /** Registers an activation's kernel; the returned disposer only removes it while still current. */
  register(sessionId: string, kernel: SessionKernel): () => void;
  lookup(sessionId: string): SessionKernel | undefined;
}

function makeSessionKernelRegistry(): SessionKernelRegistry {
  const kernels = new Map<string, SessionKernel>();
  return {
    register(sessionId: string, kernel: SessionKernel) {
      kernels.set(sessionId, kernel);
      return () => {
        if (kernels.get(sessionId) === kernel) kernels.delete(sessionId);
      };
    },
    lookup: (sessionId: string) => kernels.get(sessionId),
  };
}

/** The process-default registry: entity activations write, legacy readers read. */
export const sessionKernels: SessionKernelRegistry = makeSessionKernelRegistry();
