import { Actor } from "@openomni/protocol";
import { Storage } from "../storage/storage";
import { requireSubAdapter, withStoreTimestamps } from "../storage/timestamped-store";

function requireAdapter(): NonNullable<Storage.Adapter["blacklist"]> {
  return requireSubAdapter(Storage.get().blacklist, "Storage adapter does not implement blacklist");
}

/** Raw blacklist fact storage. Active-pattern matching belongs to channels. */
export namespace BlacklistStore {
  export function put(input: Actor.BlacklistEntry): Actor.BlacklistEntry {
    const store = requireAdapter();
    const entry = Actor.BlacklistEntry.parse(withStoreTimestamps(input, store.get(input.id)));
    store.set(entry);
    return entry;
  }

  export function get(id: string): Actor.BlacklistEntry | undefined {
    return requireAdapter().get(id);
  }

  export function list(): Actor.BlacklistEntry[] {
    return requireAdapter().list();
  }

  export function remove(id: string): boolean {
    return requireAdapter().remove(id);
  }
}
