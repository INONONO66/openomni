import type * as SessionHandleStore from "../store/fence";

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
