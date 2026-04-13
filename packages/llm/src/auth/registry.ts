import { authorize, exchange, createApiKey } from "../oauth/anthropic";
import * as openaiOAuth from "../oauth/openai";
import { generatePKCE, generateState } from "../oauth/pkce";
import { parseCallbackWithStateValidation } from "../oauth/callback-parser";
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

const anthropicProvider: AuthProvider = {
  id: "anthropic",
  name: "Anthropic",
  hint: "Claude Max, Console, CLIProxy, or API key",
  methods: [
    {
      id: "oauth-max",
      label: "Claude Pro/Max",
      hint: "Sign in with your Claude.ai Pro or Max subscription",
      async run(cb) {
        const result = await authorize("max");
        cb.showUrl(result.url);
        const input = await cb.getInput("Paste the authorization code or callback URL:");
        const parsed = parseCallbackWithStateValidation(input, result.verifier);
        if (!parsed) {
          cb.showMessage("Invalid or mismatched authorization code — login cancelled");
          return;
        }
        cb.showProgress("Exchanging code for tokens...");
        const tokens = await exchange(`${parsed.code}#${parsed.state}`, result.verifier);
        cb.stopProgress("");
        if (tokens.type === "failed") {
          cb.showMessage("Token exchange failed — please try again");
          return;
        }
        await Auth.set("anthropic", {
          type: "oauth",
          access: tokens.access,
          refresh: tokens.refresh,
          expires: tokens.expires,
        });
        cb.showMessage("Signed in with Claude Pro/Max");
      },
    },
    {
      id: "oauth-console",
      label: "Create an API Key",
      hint: "Create an Anthropic API key via OAuth (console.anthropic.com)",
      async run(cb) {
        const result = await authorize("console");
        cb.showUrl(result.url);
        const input = await cb.getInput("Paste the authorization code or callback URL:");
        const parsed = parseCallbackWithStateValidation(input, result.verifier);
        if (!parsed) {
          cb.showMessage("Invalid or mismatched authorization code — login cancelled");
          return;
        }
        cb.showProgress("Creating API key...");
        const tokens = await exchange(`${parsed.code}#${parsed.state}`, result.verifier);
        if (tokens.type === "failed") {
          cb.stopProgress("");
          cb.showMessage("Token exchange failed — please try again");
          return;
        }
        const apiKeyResult = await createApiKey(tokens.access);
        cb.stopProgress("");
        if (apiKeyResult.type === "failed") {
          // Fall back to OAuth tokens if API key creation isn't available
          await Auth.set("anthropic", {
            type: "oauth",
            access: tokens.access,
            refresh: tokens.refresh,
            expires: tokens.expires,
          });
          cb.showMessage("Saved OAuth tokens (API key creation unavailable)");
          return;
        }
        await Auth.set("anthropic", { type: "api", key: apiKeyResult.key });
        cb.showMessage("API key created and saved");
      },
    },
    {
      id: "proxy",
      label: "CLIProxy",
      hint: "Connect via CLIProxyAPI (localhost proxy)",
      async run(cb) {
        const baseURL = await cb.getInput("CLIProxy URL (default: http://localhost:8317/v1)");
        const url = baseURL.trim() || "http://localhost:8317/v1";
        const apiKeyInput = await cb.getInput("CLIProxy API key (leave empty if none)");
        const apiKey = apiKeyInput.trim() || undefined;
        await Auth.set("anthropic", { type: "proxy", baseURL: url, ...(apiKey && { apiKey }) });
        cb.showMessage("Connected via CLIProxy");
      },
    },
    {
      id: "api",
      label: "API key",
      hint: "Use direct Anthropic API key",
      async run(cb) {
        const key = (await cb.getInput("Anthropic API key")).trim();
        if (!key) {
          cb.showMessage("No API key provided — skipped");
          return;
        }
        await Auth.set("anthropic", { type: "api", key });
        cb.showMessage("API key saved");
      },
    },
  ],
};

const openaiProvider: AuthProvider = {
  id: "openai",
  name: "OpenAI",
  hint: "OAuth, CLIProxy, or API key",
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
          cb.stopProgress(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
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
          cb.stopProgress(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
    {
      id: "proxy",
      label: "CLIProxy",
      hint: "Connect via CLIProxyAPI (localhost proxy)",
      async run(cb) {
        const baseURL = await cb.getInput("CLIProxy URL (default: http://localhost:8317/v1)");
        const url = baseURL.trim() || "http://localhost:8317/v1";
        const apiKeyInput = await cb.getInput("CLIProxy API key (leave empty if none)");
        const apiKey = apiKeyInput.trim() || undefined;
        await Auth.set("openai", { type: "proxy", baseURL: url, ...(apiKey && { apiKey }) });
        cb.showMessage("Connected via CLIProxy");
      },
    },
    {
      id: "api",
      label: "API key",
      hint: "Use direct OpenAI API key",
      async run(cb) {
        const key = (await cb.getInput("OpenAI API key")).trim();
        if (!key) {
          cb.showMessage("No API key provided — skipped");
          return;
        }
        await Auth.set("openai", { type: "api", key });
        cb.showMessage("API key saved");
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
