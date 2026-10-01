import { computeActionHash, GENESIS_PREV_HASH } from "./storage/l0-hash";
import { commitSession, insertSession, selectSession } from "./storage/sqlite-l0-write";

export { replaceFileAtomically } from "./storage";
// W5.2 handle-scoped stores (plan F1): opened per entity activation / composition root.
export { openCatalogStore, openSessionStore } from "./storage";
export type { ObservationFailurePort, ObservationPublishFailure } from "./storage";
export { createDecisionFactPort } from "./storage/decision-fact-port";
export * as SessionHandleStore from "./session/kernel.js";
export { createSurfaceKeyStore } from "./surface-key";
export { createActorRegistry, type ActorRegistry } from "./actor/index.js";
export { createBlacklistStore } from "./blacklist/index.js";
export { createChannelGrantStore, type ChannelGrantStore } from "./channel-grant/index.js";
export { createReplyGrantStore } from "./reply-grant/index.js";
export {
  createPersonStore,
  createChannelInstanceStore,
  createSecretStore,
  type PersonStore,
  type ChannelInstanceStore,
  type SecretStore,
  Vault,
} from "./provisioning/index.js";
export { createEgressBudgetStore } from "./egress/index.js";
export * from "./errors";
export type { AdoptReceipt, LedgerHandles, SessionWriteAdapter, CommitReceipt } from "./services";

/** Narrow l0 write-kernel surface (W5.2 review F6): fenced chain commits plus
 * the hash identity needed to verify them, without deep package imports. */
export const L0Write = {
  commitSession,
  insertSession,
  selectSession,
  GENESIS_PREV_HASH,
  computeActionHash,
} as const;
