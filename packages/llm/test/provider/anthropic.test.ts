import { describe, test, expect, mock, afterEach } from "bun:test"
import { createAnthropicProvider, getAnthropicModels } from "../../src/provider"
import type { Auth } from "../../src/auth"

const originalFetch = globalThis.fetch

describe("createAnthropicProvider", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("api key auth returns provider with apiKey", () => {
    const auth: Auth.Info = { type: "api", key: "sk-xxx" }
    const provider = createAnthropicProvider(auth)
    expect(provider).toBeDefined()
    expect(typeof provider).toBe("function")
  })

  test("oauth auth creates provider with custom fetch that injects Bearer token", async () => {
    const auth: Auth.Info = {
      type: "oauth",
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 60_000,
    }

    let capturedHeaders: Headers | undefined
    globalThis.fetch = mock(async (_input: any, init: any) => {
      capturedHeaders = new Headers(init?.headers)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as any

    const provider = createAnthropicProvider(auth)
    const options = (provider as any)._options ?? (provider as any).options
    expect(options?.fetch).toBeDefined()

    await options.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    })

    expect(capturedHeaders?.get("authorization")).toBe("Bearer tok")
  })

  test("custom fetch adds anthropic-beta header with required values", async () => {
    const auth: Auth.Info = {
      type: "oauth",
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 60_000,
    }

    let capturedHeaders: Headers | undefined
    globalThis.fetch = mock(async (_input: any, init: any) => {
      capturedHeaders = new Headers(init?.headers)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as any

    const provider = createAnthropicProvider(auth)
    const options = (provider as any)._options ?? (provider as any).options
    await options.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "anthropic-beta": "existing-beta-123" },
      body: JSON.stringify({}),
    })

    const beta = capturedHeaders?.get("anthropic-beta") ?? ""
    expect(beta).toContain("oauth-2025-04-20")
    expect(beta).toContain("interleaved-thinking-2025-05-14")
    expect(beta).toContain("existing-beta-123")
  })

  test("custom fetch refreshes token when expired", async () => {
    const auth: Auth.Info = {
      type: "oauth",
      access: "expired-tok",
      refresh: "ref",
      expires: Date.now() - 1000,
    }

    let refreshCalled = false
    let capturedAuthHeader: string | null = null

    globalThis.fetch = mock(async (input: any, init: any) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("oauth/token")) {
        refreshCalled = true
        return new Response(
          JSON.stringify({
            access_token: "new-tok",
            refresh_token: "new-ref",
            expires_in: 3600,
          }),
          { status: 200 },
        )
      }
      capturedAuthHeader = new Headers(init?.headers).get("authorization")
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as any

    const onTokenRefresh = mock((_access: string, _refresh: string, _expires: number) => {})

    const provider = createAnthropicProvider(auth, onTokenRefresh)
    const options = (provider as any)._options ?? (provider as any).options
    await options.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({}),
    })

    expect(refreshCalled).toBe(true)
    expect(capturedAuthHeader).toBe("Bearer new-tok")
    expect(onTokenRefresh).toHaveBeenCalledWith("new-tok", "new-ref", expect.any(Number))
  })

  test("concurrent requests share single token refresh (promise dedup)", async () => {
    const auth: Auth.Info = {
      type: "oauth",
      access: "expired-tok",
      refresh: "ref",
      expires: Date.now() - 1000,
    }

    let refreshCount = 0

    globalThis.fetch = mock(async (input: any, _init: any) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("oauth/token")) {
        refreshCount++
        await new Promise((r) => setTimeout(r, 50))
        return new Response(
          JSON.stringify({
            access_token: "new-tok",
            refresh_token: "new-ref",
            expires_in: 3600,
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as any

    const provider = createAnthropicProvider(auth)
    const options = (provider as any)._options ?? (provider as any).options

    await Promise.all([
      options.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
      options.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
      options.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
    ])

    expect(refreshCount).toBe(1)
  })
})

describe("getAnthropicModels", () => {
  test("returns hardcoded model list with capabilities", () => {
    const models = getAnthropicModels()
    expect(Array.isArray(models)).toBe(true)
    expect(models.length).toBeGreaterThanOrEqual(3)

    const ids = models.map((m) => m.id)
    expect(ids).toContain("claude-sonnet-4-20250514")
    expect(ids).toContain("claude-opus-4-20250514")
    expect(ids).toContain("claude-haiku-3-5-20241022")

    const sonnet = models.find((m) => m.id === "claude-sonnet-4-20250514")!
    expect(sonnet.name).toBeDefined()
    expect(sonnet.capabilities).toBeDefined()
    expect(sonnet.capabilities.vision).toBe(true)
  })
})
