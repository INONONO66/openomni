import { Actor } from "@openomni/protocol";
import { Storage } from "../storage/storage";
import { requireSubAdapter, withStoreTimestamps } from "../storage/timestamped-store";

function requireAdapter(): NonNullable<Storage.Adapter["channelGrant"]> {
  return requireSubAdapter(
    Storage.get().channelGrant,
    "Storage adapter does not implement channel grants",
  );
}

/** Raw channel-grant fact storage. Resolution and treatment belong to channels. */
export namespace ChannelGrantStore {
  export type Grant = Actor.ChannelGrant;

  export function put(input: Grant): Grant {
    const store = requireAdapter();
    const grant = Actor.ChannelGrant.parse(withStoreTimestamps(input, store.get(input.id)));
    store.set(grant);
    return grant;
  }

  export function get(id: string): Grant | undefined {
    return requireAdapter().get(id);
  }

  export function list(): Grant[] {
    return requireAdapter().list();
  }

  export function remove(id: string): boolean {
    return requireAdapter().remove(id);
  }
}
