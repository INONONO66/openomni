import { Actor, type Storage as ProtocolStorage } from "@openomni/protocol";
import { requireSubAdapter, withStoreTimestamps } from "../storage/timestamped-store";

export type BlacklistStore = ReturnType<typeof createBlacklistStore>;

/** Raw blacklist fact storage over one catalog handle. Active-pattern matching belongs to channels. */
export function createBlacklistStore(source: {
  readonly blacklist?: ProtocolStorage.BlacklistSubAdapter;
}) {
  function requireAdapter(): ProtocolStorage.BlacklistSubAdapter {
    return requireSubAdapter(source.blacklist, "Storage adapter does not implement blacklist");
  }

  return {
    put(input: Actor.BlacklistEntry): Actor.BlacklistEntry {
      const store = requireAdapter();
      const entry = Actor.BlacklistEntry.parse(withStoreTimestamps(input, store.get(input.id)));
      store.set(entry);
      return entry;
    },

    get(id: string): Actor.BlacklistEntry | undefined {
      return requireAdapter().get(id);
    },

    list(): Actor.BlacklistEntry[] {
      return requireAdapter().list();
    },

    remove(id: string): boolean {
      return requireAdapter().remove(id);
    },
  };
}
