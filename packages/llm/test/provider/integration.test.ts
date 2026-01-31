import { describe, expect, it } from "bun:test"
import type { Auth } from "../../src/auth"
import { getProvider, listProviders, listModels } from "../../src/provider"

describe("Provider Integration", () => {
  it("should complete full flow: create auth → create provider → get language model (Anthropic API)", () => {
    const auth: Auth.Info = {
      type: "api",
      key: "test-anthropic-key",
    }

    const provider = getProvider("anthropic", auth)
    expect(provider).toBeDefined()
    expect(provider.languageModel).toBeDefined()

    const model = provider.languageModel("claude-sonnet-4-20250514")
    expect(model).toBeDefined()
    expect(model.modelId).toBe("claude-sonnet-4-20250514")
    expect(model.provider).toBe("anthropic.messages")
  })

  it("should complete full flow: create auth → create provider → get language model (Anthropic OAuth)", () => {
    const auth: Auth.Info = {
      type: "oauth",
      access: "test-access-token",
      refresh: "test-refresh-token",
      expires: Date.now() + 3600000,
    }

    const provider = getProvider("anthropic", auth)
    expect(provider).toBeDefined()
    expect(provider.languageModel).toBeDefined()

    const model = provider.languageModel("claude-opus-4-20250514")
    expect(model).toBeDefined()
    expect(model.modelId).toBe("claude-opus-4-20250514")
    expect(model.provider).toBe("anthropic.messages")
  })

  it("should complete full flow: create auth → create provider → get language model (OpenAI API)", () => {
    const auth: Auth.Info = {
      type: "api",
      key: "test-openai-key",
    }

    const provider = getProvider("openai", auth)
    expect(provider).toBeDefined()
    expect(provider.languageModel).toBeDefined()

    const model = provider.languageModel("gpt-4o")
    expect(model).toBeDefined()
    expect(model.modelId).toBe("gpt-4o")
    expect(model.provider).toBe("openai.chat")
  })

  it("should complete full flow: create auth → create provider → get language model (OpenAI OAuth)", () => {
    const auth: Auth.Info = {
      type: "oauth",
      access: "test-access-token",
      refresh: "test-refresh-token",
      expires: Date.now() + 3600000,
      accountId: "test-account-id",
    }

    const provider = getProvider("openai", auth)
    expect(provider).toBeDefined()
    expect(provider.languageModel).toBeDefined()

    const model = provider.languageModel("gpt-5.1-codex-max")
    expect(model).toBeDefined()
    expect(model.modelId).toBe("gpt-5.1-codex-max")
    expect(model.provider).toBe("openai.chat")
  })

  it("should list all available providers", () => {
    const providers = listProviders()
    expect(providers).toEqual(["anthropic", "openai"])
  })

  it("should list models for each provider", () => {
    const anthropicModels = listModels("anthropic")
    expect(Array.isArray(anthropicModels)).toBe(true)
    expect(anthropicModels.length).toBeGreaterThan(0)

    const openaiModels = listModels("openai")
    expect(typeof openaiModels).toBe("object")
    expect(Object.keys(openaiModels).length).toBeGreaterThan(0)
  })

  it("should filter OpenAI models by auth type", () => {
    const oauthModels = listModels("openai", "oauth")
    expect(typeof oauthModels).toBe("object")
    if (!Array.isArray(oauthModels)) {
      expect(oauthModels["gpt-5.1-codex-max"]).toBeDefined()
      expect(oauthModels["gpt-4o"]).toBeUndefined()
    }

    const apiModels = listModels("openai", "api")
    expect(typeof apiModels).toBe("object")
    if (!Array.isArray(apiModels)) {
      expect(apiModels["gpt-4o"]).toBeDefined()
      expect(apiModels["gpt-5.1-codex-max"]).toBeDefined()
    }
  })
})
