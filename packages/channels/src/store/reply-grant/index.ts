import type { Storage as ProtocolStorage } from "@openomni/protocol";
import { requireSubAdapter } from "../storage/timestamped-store";

/** Channels owns normalization; this store persists only the current projection. */
export function createReplyGrantStore(source: {
  readonly replyGrant?: ProtocolStorage.ReplyGrantSubAdapter;
}) {
  function requireAdapter(): ProtocolStorage.ReplyGrantSubAdapter {
    return requireSubAdapter(source.replyGrant, "Storage adapter does not implement reply grants");
  }

  return {
    claim: ((grant, bound) =>
      requireAdapter().claim(grant, bound)) satisfies ProtocolStorage.ReplyGrantSubAdapter["claim"],

    listLive: ((at) =>
      requireAdapter().listLive(at)) satisfies ProtocolStorage.ReplyGrantSubAdapter["listLive"],
  };
}
