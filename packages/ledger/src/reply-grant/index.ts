import type { Storage as ProtocolStorage } from "@openomni/protocol";
import { Storage } from "../storage/storage";
import { requireSubAdapter } from "../storage/timestamped-store";

function requireAdapter(): ProtocolStorage.ReplyGrantSubAdapter {
	return requireSubAdapter(Storage.get().replyGrant, "Storage adapter does not implement reply grants");
}

/** Channels owns normalization; this store persists only the current projection. */
export namespace ReplyGrantStore {
	export const claim: ProtocolStorage.ReplyGrantSubAdapter["claim"] = (grant, bound) =>
		requireAdapter().claim(grant, bound);

	export const listLive: ProtocolStorage.ReplyGrantSubAdapter["listLive"] = (at) =>
		requireAdapter().listLive(at);
}
