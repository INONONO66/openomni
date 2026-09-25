import { ChannelInstanceStore, Storage } from "@openomni/ledger";
import { putChannelCredential } from "./channel-credential";
import { replaceEnvironment } from "./environment";

/** Seed the same declaration and sealed credential consumed by real app boot. */
export function declareChannel(
  dbPath: string,
  provider: "telegram" | "github",
  credentials: Record<string, string>,
): () => void {
  const key = new Uint8Array(32).fill(7);
  Storage.initialize({ dbPath });
  try {
    const credentialRef = `secret:${provider}`;
    putChannelCredential(credentialRef, JSON.stringify(credentials), key, 1);
    ChannelInstanceStore.put({
      id: `channel:${provider}:main`, provider, enabled: true, settings: {}, credentialRef,
      revision: 0, createdBy: "owner", updatedAt: 1,
    });
  } finally {
    Storage.reset();
  }
  return replaceEnvironment({ OPENOMNI_VAULT_KEY: Buffer.from(key).toString("base64") });
}
