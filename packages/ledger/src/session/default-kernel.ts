import { Storage } from "../storage/storage.js";
import type { SessionKernelContext } from "./kernel.js";

/**
 * TEMP wave-1 adapter (W5.2 #1197, deleted with the process-global storage
 * plane): backs the module-level `SessionHandleStore` functions with the
 * `Storage` singleton so existing consumers keep their API while new code
 * builds handle-scoped kernels via `createSessionKernel`. Reads keep
 * `Storage.get()`'s fail-closed boot-order throw; writes refuse with
 * `StorageUnavailable` before storage is initialized.
 */
export const defaultKernelContext: SessionKernelContext = {
  stores: () => Storage.get(),
  writable: () => Storage.getInitializedDbPath() !== null,
};
