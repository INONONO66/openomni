import type { Auth } from "@openomni/auth"
import { createAnthropicProvider, getAnthropicModels, type AnthropicModel } from "./anthropic"
import { createOpenAIProvider, getOpenAIModels, type OPENAI_MODELS } from "./openai"

export type ProviderID = "anthropic" | "openai"

export function getProvider(providerID: string, auth: Auth.Info) {
  switch (providerID) {
    case "anthropic":
      return createAnthropicProvider(auth)
    case "openai":
      return createOpenAIProvider(auth).provider
    default:
      throw new Error(`Unknown provider: ${providerID}`)
  }
}

export function listModels(
  providerID: string,
  authType?: "oauth" | "api",
): AnthropicModel[] | typeof OPENAI_MODELS {
  switch (providerID) {
    case "anthropic":
      return getAnthropicModels()
    case "openai":
      return getOpenAIModels(authType)
    default:
      throw new Error(`Unknown provider: ${providerID}`)
  }
}

export function listProviders(): ProviderID[] {
  return ["anthropic", "openai"]
}
