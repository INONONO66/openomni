import { z } from "zod";
import { generatePKCE } from "./pkce";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";
const CREATE_API_KEY_URL = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key";

const TokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
});

const ApiKeyResponse = z.object({
  raw_key: z.string(),
});

type OAuthResult =
  | { type: "success"; access: string; refresh: string; expires: number }
  | { type: "failed" };

type ApiKeyResult = { type: "success"; key: string } | { type: "failed" };

export async function authorize(
  mode: "max" | "console",
): Promise<{ url: string; verifier: string }> {
  const pkce = await generatePKCE();
  const domain = mode === "console" ? "console.anthropic.com" : "claude.ai";
  const url = new URL(`https://${domain}/oauth/authorize`);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);
  return { url: url.toString(), verifier: pkce.verifier };
}

export async function exchange(code: string, verifier: string): Promise<OAuthResult> {
  const splits = code.split("#");
  const result = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: splits[0],
      state: splits[1],
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!result.ok) return { type: "failed" };
  const json = TokenResponse.parse(await result.json());
  return {
    type: "success",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

export async function refreshToken(token: string): Promise<OAuthResult> {
  const result = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: token,
      client_id: CLIENT_ID,
    }),
  });
  if (!result.ok) return { type: "failed" };
  const json = TokenResponse.parse(await result.json());
  return {
    type: "success",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

export async function createApiKey(accessToken: string): Promise<ApiKeyResult> {
  const result = await fetch(CREATE_API_KEY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!result.ok) return { type: "failed" };
  const json = ApiKeyResponse.parse(await result.json());
  return { type: "success", key: json.raw_key };
}
