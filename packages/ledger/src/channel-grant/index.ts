import { Actor, type Storage as ProtocolStorage } from "@openomni/protocol";
import { requireSubAdapter, withStoreTimestamps } from "../storage/timestamped-store";

export type ChannelGrantStore = ReturnType<typeof createChannelGrantStore>;

/** Raw channel-grant fact storage over one catalog handle. Resolution and treatment belong to channels. */
export function createChannelGrantStore(source: {
  readonly channelGrant?: ProtocolStorage.ChannelGrantSubAdapter;
}) {
  function requireAdapter(): ProtocolStorage.ChannelGrantSubAdapter {
    return requireSubAdapter(
      source.channelGrant,
      "Storage adapter does not implement channel grants",
    );
  }

  return {
    put(input: Actor.ChannelGrant): Actor.ChannelGrant {
      const store = requireAdapter();
      const grant = Actor.ChannelGrant.parse(withStoreTimestamps(input, store.get(input.id)));
      store.set(grant);
      return grant;
    },

    get(id: string): Actor.ChannelGrant | undefined {
      return requireAdapter().get(id);
    },

    list(): Actor.ChannelGrant[] {
      return requireAdapter().list();
    },

    remove(id: string): boolean {
      return requireAdapter().remove(id);
    },
  };
}
