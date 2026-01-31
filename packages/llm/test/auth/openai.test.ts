import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  parseJwtClaims,
  extractAccountId,
  startOAuthServer,
  stopOAuthServer,
  initiateDeviceAuth,
  pollDeviceAuth,
} from "../../src/auth"

const OAUTH_PORT = 1455
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"

// Helper to create a fake JWT with given claims
function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${header}.${payload}.fake-signature`
}

describe("OpenAI OAuth", () => {
  describe("buildAuthorizeUrl()", () => {
    it("returns correct URL with PKCE, state, scopes", () => {
      const pkce = { verifier: "test-verifier", challenge: "test-challenge" }
      const state = "test-state"
      const redirectUri = "http://localhost:1455/auth/callback"

      const url = buildAuthorizeUrl(redirectUri, pkce, state)

      expect(url).toStartWith(`${ISSUER}/oauth/authorize?`)
      const params = new URL(url).searchParams
      expect(params.get("response_type")).toBe("code")
      expect(params.get("client_id")).toBe(CLIENT_ID)
      expect(params.get("redirect_uri")).toBe(redirectUri)
      expect(params.get("scope")).toBe("openid profile email offline_access")
      expect(params.get("code_challenge")).toBe("test-challenge")
      expect(params.get("code_challenge_method")).toBe("S256")
      expect(params.get("state")).toBe("test-state")
    })
  })

  describe("exchangeCodeForTokens()", () => {
    it("calls token endpoint correctly", async () => {
      const mockTokens = {
        id_token: "id",
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
      }

      const originalFetch = globalThis.fetch
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        const u = url.toString()
        expect(u).toBe(`${ISSUER}/oauth/token`)
        expect(init?.method).toBe("POST")
        const body = init?.body as string
        const params = new URLSearchParams(body)
        expect(params.get("grant_type")).toBe("authorization_code")
        expect(params.get("code")).toBe("auth-code")
        expect(params.get("client_id")).toBe(CLIENT_ID)
        expect(params.get("code_verifier")).toBe("my-verifier")
        return new Response(JSON.stringify(mockTokens), { status: 200 })
      }) as typeof fetch

      try {
        const tokens = await exchangeCodeForTokens(
          "auth-code",
          "http://localhost:1455/auth/callback",
          { verifier: "my-verifier", challenge: "my-challenge" },
        )
        expect(tokens.access_token).toBe("access")
        expect(tokens.refresh_token).toBe("refresh")
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe("refreshAccessToken()", () => {
    it("refreshes correctly", async () => {
      const mockTokens = {
        id_token: "new-id",
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }

      const originalFetch = globalThis.fetch
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = init?.body as string
        const params = new URLSearchParams(body)
        expect(params.get("grant_type")).toBe("refresh_token")
        expect(params.get("refresh_token")).toBe("old-refresh")
        expect(params.get("client_id")).toBe(CLIENT_ID)
        return new Response(JSON.stringify(mockTokens), { status: 200 })
      }) as typeof fetch

      try {
        const tokens = await refreshAccessToken("old-refresh")
        expect(tokens.access_token).toBe("new-access")
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe("parseJwtClaims()", () => {
    it("extracts claims from JWT", () => {
      const claims = { sub: "user-123", email: "test@example.com" }
      const token = fakeJwt(claims)
      const result = parseJwtClaims(token)
      expect(result).toEqual(claims)
    })

    it("returns undefined for invalid JWT", () => {
      expect(parseJwtClaims("not-a-jwt")).toBeUndefined()
    })
  })

  describe("extractAccountId()", () => {
    it("extracts chatgpt_account_id from various claim structures", () => {
      // Direct claim
      expect(
        extractAccountId({
          id_token: fakeJwt({ chatgpt_account_id: "acct-1" }),
          access_token: "",
          refresh_token: "",
        }),
      ).toBe("acct-1")

      // Nested under https://api.openai.com/auth
      expect(
        extractAccountId({
          id_token: fakeJwt({
            "https://api.openai.com/auth": { chatgpt_account_id: "acct-2" },
          }),
          access_token: "",
          refresh_token: "",
        }),
      ).toBe("acct-2")

      // From organizations
      expect(
        extractAccountId({
          id_token: fakeJwt({ organizations: [{ id: "org-1" }] }),
          access_token: "",
          refresh_token: "",
        }),
      ).toBe("org-1")
    })
  })

  describe("startOAuthServer()", () => {
    afterEach(() => {
      stopOAuthServer()
    })

    it("starts Bun.serve on port 1455 and handles callback", async () => {
      const { port, redirectUri } = await startOAuthServer()
      expect(port).toBe(OAUTH_PORT)
      expect(redirectUri).toBe(`http://localhost:${OAUTH_PORT}/auth/callback`)

      // Verify server responds
      const res = await fetch(`http://localhost:${OAUTH_PORT}/health-check`)
      expect(res.status).toBe(404) // Unknown path returns 404
    })

    it("handles EADDRINUSE gracefully", async () => {
      // Start first server
      await startOAuthServer()

      // Starting again should return existing server (not throw)
      const { port } = await startOAuthServer()
      expect(port).toBe(OAUTH_PORT)
    })
  })

  describe("initiateDeviceAuth()", () => {
    it("returns user_code and device_auth_id", async () => {
      const mockResponse = {
        device_auth_id: "dev-auth-123",
        user_code: "ABCD-1234",
        interval: "5",
      }

      const originalFetch = globalThis.fetch
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        expect(url.toString()).toBe(`${ISSUER}/api/accounts/deviceauth/usercode`)
        return new Response(JSON.stringify(mockResponse), { status: 200 })
      }) as typeof fetch

      try {
        const result = await initiateDeviceAuth()
        expect(result.user_code).toBe("ABCD-1234")
        expect(result.device_auth_id).toBe("dev-auth-123")
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe("pollDeviceAuth()", () => {
    it("polls and returns tokens when ready", async () => {
      const mockTokens = {
        id_token: "dev-id",
        access_token: "dev-access",
        refresh_token: "dev-refresh",
        expires_in: 3600,
      }

      const originalFetch = globalThis.fetch
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        const u = url.toString()
        if (u.includes("/deviceauth/token")) {
          return new Response(
            JSON.stringify({
              authorization_code: "dev-code",
              code_verifier: "dev-verifier",
            }),
            { status: 200 },
          )
        }
        // Token exchange
        return new Response(JSON.stringify(mockTokens), { status: 200 })
      }) as typeof fetch

      try {
        const tokens = await pollDeviceAuth("dev-auth-123", "ABCD-1234", 100)
        expect(tokens.access_token).toBe("dev-access")
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("handles pending status (403/404) by continuing to poll", async () => {
      let callCount = 0
      const mockTokens = {
        id_token: "id",
        access_token: "access",
        refresh_token: "refresh",
      }

      const originalFetch = globalThis.fetch
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        const u = url.toString()
        if (u.includes("/deviceauth/token")) {
          callCount++
          if (callCount < 3) {
            return new Response("pending", { status: 403 })
          }
          return new Response(
            JSON.stringify({
              authorization_code: "code",
              code_verifier: "verifier",
            }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify(mockTokens), { status: 200 })
      }) as typeof fetch

      try {
        const tokens = await pollDeviceAuth("dev-auth", "CODE", 10)
        expect(tokens.access_token).toBe("access")
        expect(callCount).toBeGreaterThanOrEqual(3)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })
})
