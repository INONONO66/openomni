import * as anthropicOAuth from "../oauth/anthropic";
import * as openaiOAuth from "../oauth/openai";
import { generatePKCE, generateState } from "../oauth/pkce";
import { Auth } from "./storage";

export type OAuthMethod = {
  id: string;
  label: string;
  hint: string;
  run: (callbacks: AuthCallbacks) => Promise<void>;
};

export type AuthCallbacks = {
  showUrl: (url: string) => void;
  getInput: (message: string) => Promise<string>;
  showMessage: (message: string) => void;
  showProgress: (message: string) => void;
  stopProgress: (message: string) => void;
  updateProgress: (message: string) => void;
};

export type AuthProvider = {
  id: string;
  name: string;
  hint?: string;
  methods: OAuthMethod[];
};

function createAnthropicOAuthMethod(
  id: "max" | "console",
  label: string,
  hint: string,
): OAuthMethod {
  return {
    id,
    label,
    hint,
    async run(cb) {
      const { url, verifier } = await anthropicOAuth.authorize(id);
      cb.showUrl(url);
      const code = await cb.getInput("Paste the authorization code");
      cb.showProgress("Exchanging code for tokens...");
      const tokenResult = await anthropicOAuth.exchange(code, verifier);
      if (tokenResult.type === "failed") {
        cb.stopProgress("Token exchange failed");
        return;
      }
      cb.updateProgress("Creating API key...");
      const apiKeyResult = await anthropicOAuth.createApiKey(
        tokenResult.access,
      );
      if (apiKeyResult.type === "failed") {
        await Auth.set("anthropic", {
          type: "oauth",
          access: tokenResult.access,
          refresh: tokenResult.refresh,
          expires: tokenResult.expires,
        });
        cb.stopProgress("Saved OAuth tokens (API key creation unavailable)");
        return;
      }
      await Auth.set("anthropic", { type: "api", key: apiKeyResult.key });
      cb.stopProgress("Login successful");
    },
  };
}

const anthropicProvider: AuthProvider = {
  id: "anthropic",
  name: "Anthropic",
  hint: "Claude Max or Console",
  methods: [
    createAnthropicOAuthMethod("max", "Max", "claude.ai Pro/Max subscription"),
    createAnthropicOAuthMethod(
      "console",
      "Console",
      "console.anthropic.com API",
    ),
  ],
};

const openaiProvider: AuthProvider = {
  id: "openai",
  name: "OpenAI",
  hint: "ChatGPT Plus/Pro or API key",
  methods: [
    {
      id: "browser",
      label: "Browser",
      hint: "Opens browser, auto-callback via local server",
      async run(cb) {
        const pkce = await generatePKCE();
        const state = generateState();
        cb.showProgress("Starting local OAuth server...");
        const { redirectUri } = await openaiOAuth.startOAuthServer();
        cb.stopProgress("OAuth server ready");
        const url = openaiOAuth.buildAuthorizeUrl(redirectUri, pkce, state);
        cb.showUrl(url);
        cb.showProgress("Waiting for authorization...");
        try {
          const tokens = await openaiOAuth.waitForOAuthCallback(pkce, state);
          const accountId = openaiOAuth.extractAccountId(tokens);
          await Auth.set("openai", {
            type: "oauth",
            access: tokens.access_token,
            refresh: tokens.refresh_token,
            expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
            accountId,
          });
          cb.stopProgress("Login successful");
        } catch (err) {
          cb.stopProgress(
            `Login failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          openaiOAuth.stopOAuthServer();
        }
      },
    },
    {
      id: "device",
      label: "Device code",
      hint: "For headless/remote servers",
      async run(cb) {
        cb.showProgress("Initiating device authorization...");
        const device = await openaiOAuth.initiateDeviceAuth();
        cb.stopProgress("Device code ready");
        cb.showMessage("Go to: https://auth.openai.com/activate");
        cb.showMessage(`Enter code: ${device.user_code}`);
        cb.showProgress("Waiting for authorization...");
        try {
          const tokens = await openaiOAuth.pollDeviceAuth(
            device.device_auth_id,
            device.user_code,
            parseInt(device.interval) * 1000 || 5000,
          );
          const accountId = openaiOAuth.extractAccountId(tokens);
          await Auth.set("openai", {
            type: "oauth",
            access: tokens.access_token,
            refresh: tokens.refresh_token,
            expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
            accountId,
          });
          cb.stopProgress("Login successful");
        } catch (err) {
          cb.stopProgress(
            `Login failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    },
  ],
};

const registry: AuthProvider[] = [anthropicProvider, openaiProvider];

export function getAuthProviders(): AuthProvider[] {
  return registry;
}

export function getAuthProvider(id: string): AuthProvider | undefined {
  return registry.find((p) => p.id === id);
}
