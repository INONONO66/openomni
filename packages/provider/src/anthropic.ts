import { createAnthropic } from "@ai-sdk/anthropic"
import type { Auth } from "@openomni/auth"

const REFRESH_URL = "https://console.anthropic.com/v1/oauth/token"
const CLIENT_ID = "9d1c250a-e61b-44e8-ab96-aa70e6e435cb"
const REQUIRED_BETAS = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"]

export type TokenRefreshCallback = (access: string, refresh: string, expires: number) => void

export function createOAuthFetch(
  auth: Extract<Auth.Info, { type: "oauth" }>,
  onTokenRefresh?: TokenRefreshCallback,
) {
  let currentAccess = auth.access
  let currentRefresh = auth.refresh
  let currentExpires = auth.expires
  let pendingRefresh: Promise<void> | null = null

  async function refreshToken() {
    const response = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: currentRefresh,
        client_id: CLIENT_ID,
      }),
    })
    if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`)
    const json = (await response.json()) as { access_token: string; refresh_token: string; expires_in: number }
    currentAccess = json.access_token
    currentRefresh = json.refresh_token
    currentExpires = Date.now() + json.expires_in * 1000
    onTokenRefresh?.(currentAccess, currentRefresh, currentExpires)
  }

  async function ensureValidToken() {
    if (currentAccess && currentExpires > Date.now()) return
    if (!pendingRefresh) {
      pendingRefresh = refreshToken().finally(() => {
        pendingRefresh = null
      })
    }
    await pendingRefresh
  }

  return async function oauthFetch(input: string | Request | URL, init?: RequestInit) {
    await ensureValidToken()

    const requestHeaders = new Headers()
    if (init?.headers) {
      const h = init.headers
      if (h instanceof Headers) {
        h.forEach((v, k) => requestHeaders.set(k, v))
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) requestHeaders.set(k, String(v))
      } else {
        for (const [k, v] of Object.entries(h)) {
          if (v !== undefined) requestHeaders.set(k, String(v))
        }
      }
    }

    const incomingBetas = (requestHeaders.get("anthropic-beta") || "")
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean)
    const mergedBetas = [...new Set([...REQUIRED_BETAS, ...incomingBetas])].join(",")

    requestHeaders.set("authorization", `Bearer ${currentAccess}`)
    requestHeaders.set("anthropic-beta", mergedBetas)
    requestHeaders.delete("x-api-key")

    return fetch(input, { ...init, headers: requestHeaders })
  }
}

export interface AnthropicModel {
  id: string
  name: string
  capabilities: {
    vision: boolean
    thinking: boolean
    tools: boolean
  }
}

export const ANTHROPIC_MODELS: AnthropicModel[] = [
  {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    capabilities: { vision: true, thinking: true, tools: true },
  },
  {
    id: "claude-opus-4-20250514",
    name: "Claude Opus 4",
    capabilities: { vision: true, thinking: true, tools: true },
  },
  {
    id: "claude-haiku-3-5-20241022",
    name: "Claude Haiku 3.5",
    capabilities: { vision: true, thinking: false, tools: true },
  },
]

export function getAnthropicModels(): AnthropicModel[] {
  return ANTHROPIC_MODELS
}

export function createAnthropicProvider(auth: Auth.Info, onTokenRefresh?: TokenRefreshCallback) {
  if (auth.type === "api") {
    return createAnthropic({ apiKey: auth.key })
  }

  const customFetch = createOAuthFetch(auth, onTokenRefresh)
  const provider = createAnthropic({ apiKey: "", fetch: customFetch as any })

  ;(provider as any).options = { fetch: customFetch }
  return provider
}
