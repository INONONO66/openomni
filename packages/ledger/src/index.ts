import { computeActionHash, GENESIS_PREV_HASH } from "./storage/l0-hash";
import { commitSession, insertSession, selectSession } from "./storage/sqlite-l0-write";

export { initialize, replaceFileAtomically, SqliteStorageAdapter, Storage } from "./storage";
export { DecisionFacts } from "./storage/decision-fact-port";
export * as SessionHandleStore from "./session/kernel.js";
export { SurfaceKey } from "./surface-key";
export { ActorRegistry } from "./actor/index.js";
export { BlacklistStore } from "./blacklist/index.js";
export { ChannelGrantStore } from "./channel-grant/index.js";
export { ReplyGrantStore } from "./reply-grant/index.js";
export { PersonStore, ChannelInstanceStore, SecretStore, Vault } from "./provisioning/index.js";
export { EgressBudgetStore } from "./egress/index.js";
export * from "./errors";
export {
  LedgerWrites,
  type AlarmWriteAdapter,
  type InboxWriteAdapter,
  type SessionWriteAdapter,
  type CommitReceipt,
  type LeaseReceipt,
} from "./services";
export { LedgerLive, LedgerStorageLive } from "./layers";

/** Narrow l0 write-kernel surface (W5.2 review F6): fenced chain commits plus
 * the hash identity needed to verify them, without deep package imports. */
export const L0Write = {
  commitSession,
  insertSession,
  selectSession,
  GENESIS_PREV_HASH,
  computeActionHash,
} as const;
