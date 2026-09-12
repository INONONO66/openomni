import { SecretStore, Vault } from "@openomni/ledger";

export function putChannelCredential(id: string, plaintext: string, key: Uint8Array, at: number) {
  const envelope = Vault.seal(new TextEncoder().encode(plaintext), Vault.kekOf(key));
  SecretStore.put({
    id,
    ciphertext: envelope.ciphertext,
    wrappedDek: envelope.wrappedDek,
    kekId: envelope.kekId,
    purpose: "channel_credential",
    createdAt: at,
  });
  return envelope;
}
