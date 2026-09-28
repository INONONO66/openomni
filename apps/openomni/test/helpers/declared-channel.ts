import { createAppLedger } from "../../src/composition/cluster-runtime";
import { putChannelCredential } from "./channel-credential";
import { replaceEnvironment } from "./environment";

/** Seed the same declaration and sealed credential consumed by real app boot. */
export function declareChannel(
  catalogPath: string,
  provider: "telegram" | "github",
  credentials: Record<string, string>,
): () => void {
  const key = new Uint8Array(32).fill(7);
  const plane = createAppLedger({ catalogPath });
  try {
    const credentialRef = `secret:${provider}`;
    putChannelCredential(plane.stores.secrets, credentialRef, JSON.stringify(credentials), key, 1);
    plane.stores.instances.put({
      id: `channel:${provider}:main`, provider, enabled: true, settings: {}, credentialRef,
      revision: 0, createdBy: "owner", updatedAt: 1,
    });
  } finally {
    plane.close();
  }
  return replaceEnvironment({ OPENOMNI_VAULT_KEY: Buffer.from(key).toString("base64") });
}
