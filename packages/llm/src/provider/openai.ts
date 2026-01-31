import type { OpenAIProviderSettings } from "@ai-sdk/openai"
import { createOpenAI } from "@ai-sdk/openai"
import { z } from "zod"
import { Auth } from "../auth/storage"
import { CODEX_API_ENDPOINT, refreshAccessToken } from "../auth/openai"

type ProviderFetch = NonNullable<OpenAIProviderSettings["fetch"]>

const OAUTH_DUMMY_KEY = "oauth-dummy-key"

export const CODEX_ALLOWED_MODELS = [
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
] as const

export const OpenAIModelEntry = z.object({
  name: z.string(),
  cost: z.object({
    input: z.number(),
    output: z.number(),
  }),
})
export type OpenAIModelEntry = z.infer<typeof OpenAIModelEntry>

export const OPENAI_MODELS: Record<string, OpenAIModelEntry> = {
  "gpt-4o": { name: "GPT-4o", cost: { input: 2.5, output: 10 } },
  "gpt-4o-mini": { name: "GPT-4o Mini", cost: { input: 0.15, output: 0.6 } },
  "gpt-4.1": { name: "GPT-4.1", cost: { input: 2, output: 8 } },
  "gpt-4.1-mini": { name: "GPT-4.1 Mini", cost: { input: 0.4, output: 1.6 } },
  "gpt-4.1-nano": { name: "GPT-4.1 Nano", cost: { input: 0.1, output: 0.4 } },
  "o3": { name: "o3", cost: { input: 10, output: 40 } },
  "o3-mini": { name: "o3-mini", cost: { input: 1.1, output: 4.4 } },
  "o4-mini": { name: "o4-mini", cost: { input: 1.1, output: 4.4 } },
  "gpt-5.1-codex-max": { name: "GPT-5.1 Codex Max", cost: { input: 0, output: 0 } },
  "gpt-5.1-codex-mini": { name: "GPT-5.1 Codex Mini", cost: { input: 0, output: 0 } },
  "gpt-5.2": { name: "GPT-5.2", cost: { input: 0, output: 0 } },
  "gpt-5.2-codex": { name: "GPT-5.2 Codex", cost: { input: 0, output: 0 } },
  "gpt-5.1-codex": { name: "GPT-5.1 Codex", cost: { input: 0, output: 0 } },
}

export function getOpenAIModels(mode?: "api" | "oauth") {
  if (mode === "oauth") {
    const allowed = new Set<string>(CODEX_ALLOWED_MODELS)
    return Object.fromEntries(
      Object.entries(OPENAI_MODELS).filter(([id]) => allowed.has(id)),
    )
  }
  return { ...OPENAI_MODELS }
}

export async function getOpenAIModelsAsync(mode?: "api" | "oauth"): Promise<Record<string, OpenAIModelEntry>> {
  let models = { ...OPENAI_MODELS }
  
  try {
    const { ModelsDev } = await import("../models")
    const providers = await ModelsDev.get()
    const openaiProvider = providers["openai"]
    
    if (openaiProvider?.models) {
      const devModels: Record<string, OpenAIModelEntry> = {}
      for (const [id, modelData] of Object.entries(openaiProvider.models)) {
        const isValidModel = typeof modelData === "object" && modelData !== null
        const name = isValidModel && "name" in modelData && typeof modelData.name === "string" ? modelData.name : id
        const cost = isValidModel && "cost" in modelData && typeof modelData.cost === "object" && modelData.cost !== null ? modelData.cost : {}
        
        devModels[id] = {
          name,
          cost: {
            input: "input" in cost && typeof cost.input === "number" ? cost.input : 0,
            output: "output" in cost && typeof cost.output === "number" ? cost.output : 0,
          },
        }
      }
      if (Object.keys(devModels).length > 0) {
        models = devModels
      }
    }
  } catch {
    // Fall through to hardcoded fallback
  }
  
  if (mode === "oauth") {
    const allowed = new Set<string>(CODEX_ALLOWED_MODELS)
    return Object.fromEntries(
      Object.entries(models).filter(([id]) => allowed.has(id)),
    )
  }
  
  return models
}

type TokenRefreshCallback = (tokens: { access: string; refresh: string; expires: number }) => void

export function createOpenAIProvider(
  auth: Auth.Info,
  onTokenRefresh?: TokenRefreshCallback,
): { provider: ReturnType<typeof createOpenAI>; customFetch?: ProviderFetch } {
  if (auth.type === "api") {
    return {
      provider: createOpenAI({ apiKey: auth.key }),
    }
  }

  let currentAccess = auth.access
  let currentRefresh = auth.refresh
  let currentExpires = auth.expires
  const accountId = auth.accountId

  let refreshPromise: Promise<void> | null = null

  async function ensureValidToken() {
    if (currentAccess && currentExpires > Date.now()) return

    if (refreshPromise) {
      await refreshPromise
      return
    }

    refreshPromise = (async () => {
      try {
        const tokens = await refreshAccessToken(currentRefresh)
        currentAccess = tokens.access_token
        currentRefresh = tokens.refresh_token
        currentExpires = Date.now() + (tokens.expires_in ?? 3600) * 1000
        onTokenRefresh?.({
          access: currentAccess,
          refresh: currentRefresh,
          expires: currentExpires,
        })
      } finally {
        refreshPromise = null
      }
    })()

    await refreshPromise
  }

  const customFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.delete("authorization")
        init.headers.delete("Authorization")
      } else if (Array.isArray(init.headers)) {
        init.headers = init.headers.filter(([key]) => key.toLowerCase() !== "authorization")
      } else {
        delete (init.headers as Record<string, string>)["authorization"]
        delete (init.headers as Record<string, string>)["Authorization"]
      }
    }

    await ensureValidToken()

    const headers = new Headers()
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => headers.set(key, value))
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) {
          if (value !== undefined) headers.set(key, String(value))
        }
      } else {
        for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
          if (value !== undefined) headers.set(key, String(value))
        }
      }
    }

    headers.set("authorization", `Bearer ${currentAccess}`)

    if (accountId) {
      headers.set("ChatGPT-Account-Id", accountId)
    }

    const parsed =
      input instanceof URL
        ? input
        : new URL(typeof input === "string" ? input : (input as Request).url)

    const url =
      parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
        ? new URL(CODEX_API_ENDPOINT)
        : parsed

    return fetch(url, { ...init, headers })
  }) as ProviderFetch

  return {
    provider: createOpenAI({ apiKey: OAUTH_DUMMY_KEY, fetch: customFetch }),
    customFetch,
  }
}
