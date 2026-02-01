import { describe, it, expect } from "bun:test"
import { generatePKCE, generateState } from "../../src/oauth"

describe("PKCE", () => {
  it("generatePKCE() returns { verifier, challenge } with correct types", async () => {
    const result = await generatePKCE()
    expect(result).toHaveProperty("verifier")
    expect(result).toHaveProperty("challenge")
    expect(typeof result.verifier).toBe("string")
    expect(typeof result.challenge).toBe("string")
  })

  it("verifier is 43 chars from URL-safe alphabet (A-Z, a-z, 0-9, -, _, ~)", async () => {
    const result = await generatePKCE()
    const { verifier } = result
    expect(verifier.length).toBe(43)
    // Check all characters are from URL-safe alphabet
    const urlSafeRegex = /^[A-Za-z0-9\-._~]+$/
    expect(urlSafeRegex.test(verifier)).toBe(true)
  })

  it("challenge is base64url encoded (no +, /, = padding)", async () => {
    const result = await generatePKCE()
    const { challenge } = result
    // Should not contain +, /, or = characters
    expect(challenge).not.toMatch(/\+/)
    expect(challenge).not.toMatch(/\//)
    expect(challenge).not.toMatch(/=/)
    // Should be valid base64url characters
    const base64UrlRegex = /^[A-Za-z0-9\-_]+$/
    expect(base64UrlRegex.test(challenge)).toBe(true)
  })

  it("challenge is SHA-256 hash of verifier", async () => {
    const result = await generatePKCE()
    const { verifier, challenge } = result

    // Recompute the challenge from verifier
    const encoder = new TextEncoder()
    const data = encoder.encode(verifier)
    const hash = await crypto.subtle.digest("SHA-256", data)
    const bytes = new Uint8Array(hash)
    const binary = String.fromCharCode(...bytes)
    const expectedChallenge = btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")

    expect(challenge).toBe(expectedChallenge)
  })

  it("generateState() returns base64url string (32 bytes)", () => {
    const state = generateState()
    // Should be base64url encoded
    const base64UrlRegex = /^[A-Za-z0-9\-_]+$/
    expect(base64UrlRegex.test(state)).toBe(true)
    // 32 bytes = 256 bits, base64url encoded = ~43 characters
    expect(state.length).toBeGreaterThan(40)
    expect(state.length).toBeLessThan(50)
  })
})
