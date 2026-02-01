import { AuthError, TokenRefreshError } from "../error"

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const ISSUER = "https://auth.openai.com"
export const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
export const OAUTH_PORT = 1455
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000

interface PkceCodes {
  verifier: string
  challenge: string
}

export interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

interface DeviceAuthResponse {
  device_auth_id: string
  user_code: string
  interval: string
}

let oauthServer: ReturnType<typeof Bun.serve> | undefined
let pendingOAuth:
  | {
      pkce: PkceCodes
      state: string
      resolve: (tokens: TokenResponse) => void
      reject: (error: Error) => void
    }
  | undefined

export function buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode",
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  pkce: PkceCodes,
): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) {
    throw new TokenRefreshError({ message: `Token exchange failed: ${response.status}`, status: response.status })
  }
  return response.json() as Promise<TokenResponse>
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new TokenRefreshError({ message: `Token refresh failed: ${response.status}`, status: response.status })
  }
  return response.json() as Promise<TokenResponse>
}

export function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token) as IdTokenClaims | undefined
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token) as IdTokenClaims | undefined
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
  return undefined
}

export async function startOAuthServer(): Promise<{ port: number; redirectUri: string }> {
  if (oauthServer) {
    return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
  }

  try {
    oauthServer = Bun.serve({
      port: OAUTH_PORT,
      fetch(req) {
        const url = new URL(req.url)

        if (url.pathname === "/auth/callback") {
          const code = url.searchParams.get("code")
          const state = url.searchParams.get("state")
          const error = url.searchParams.get("error")
          const errorDescription = url.searchParams.get("error_description")

          if (error) {
            const errorMsg = errorDescription || error
            pendingOAuth?.reject(new Error(errorMsg))
            pendingOAuth = undefined
            return new Response(`<html><body>Error: ${errorMsg}</body></html>`, {
              headers: { "Content-Type": "text/html" },
            })
          }

          if (!code) {
            const errorMsg = "Missing authorization code"
            pendingOAuth?.reject(new Error(errorMsg))
            pendingOAuth = undefined
            return new Response(`<html><body>Error: ${errorMsg}</body></html>`, {
              status: 400,
              headers: { "Content-Type": "text/html" },
            })
          }

          if (!pendingOAuth || state !== pendingOAuth.state) {
            const errorMsg = "Invalid state - potential CSRF attack"
            pendingOAuth?.reject(new Error(errorMsg))
            pendingOAuth = undefined
            return new Response(`<html><body>Error: ${errorMsg}</body></html>`, {
              status: 400,
              headers: { "Content-Type": "text/html" },
            })
          }

          const current = pendingOAuth
          pendingOAuth = undefined

          exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}/auth/callback`, current.pkce)
            .then((tokens) => current.resolve(tokens))
            .catch((err) => current.reject(err))

          return new Response("<html><body>Success! You can close this tab.</body></html>", {
            headers: { "Content-Type": "text/html" },
          })
        }

        if (url.pathname === "/cancel") {
          pendingOAuth?.reject(new Error("Login cancelled"))
          pendingOAuth = undefined
          return new Response("Login cancelled", { status: 200 })
        }

        return new Response("Not found", { status: 404 })
      },
    })
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "EADDRINUSE") {
      return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
    }
    throw err
  }

  return { port: OAUTH_PORT, redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
}

export function stopOAuthServer(): void {
  if (oauthServer) {
    oauthServer.stop()
    oauthServer = undefined
  }
}

export function waitForOAuthCallback(pkce: PkceCodes, state: string): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingOAuth) {
        pendingOAuth = undefined
        reject(new Error("OAuth callback timeout - authorization took too long"))
      }
    }, 5 * 60 * 1000)

    pendingOAuth = {
      pkce,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout)
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    }
  })
}

export async function initiateDeviceAuth(): Promise<DeviceAuthResponse> {
  const response = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  })

  if (!response.ok) {
    throw new AuthError({ message: "Failed to initiate device authorization", provider: "openai" })
  }

  return response.json() as Promise<DeviceAuthResponse>
}

export async function pollDeviceAuth(
  deviceAuthId: string,
  userCode: string,
  intervalMs: number = 5000,
): Promise<TokenResponse> {
  while (true) {
    const response = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode,
      }),
    })

    if (response.ok) {
      const data = (await response.json()) as {
        authorization_code: string
        code_verifier: string
      }

      const tokenResponse = await fetch(`${ISSUER}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: data.authorization_code,
          redirect_uri: `${ISSUER}/deviceauth/callback`,
          client_id: CLIENT_ID,
          code_verifier: data.code_verifier,
        }).toString(),
      })

      if (!tokenResponse.ok) {
        throw new TokenRefreshError({ message: `Token exchange failed: ${tokenResponse.status}`, status: tokenResponse.status })
      }

      return tokenResponse.json() as Promise<TokenResponse>
    }

    if (response.status !== 403 && response.status !== 404) {
      throw new AuthError({ message: `Device auth polling failed: ${response.status}`, provider: "openai" })
    }

    await Bun.sleep(intervalMs)
  }
}
