import { ChannelGrantStore, Storage } from "@openomni/ledger";

export function resetGrantStore(): void {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
}

export function registerChannelGrant(overrides: Partial<ChannelGrantStore.Grant> = {}): void {
  ChannelGrantStore.put({
    id: "grant",
    surface: "discord",
    kind: "trusted_channel",
    createdBy: "owner",
    ...overrides,
  });
}
