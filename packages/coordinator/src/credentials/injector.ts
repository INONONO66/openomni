// Injects credentials into worker via IPC at spawn time.
// Workers never read env vars for API keys — this is the IronClaw capability injection pattern.
import { type Credentials, getCredentialsForProvider } from "./store.js";

export type CredentialInjector = {
  inject(workerId: string, provider: string): Record<string, string>;
};

export function createCredentialInjector(credentials: Credentials): CredentialInjector {
  return {
    inject(_workerId, provider) {
      return getCredentialsForProvider(credentials, provider);
    },
  };
}
