import { describe, expect, test } from "bun:test"
import { AuthError, NamedError, ProviderError, TokenRefreshError } from "../src/error"

describe("NamedError", () => {
  test("Unknown error", () => {
    const err = new NamedError.Unknown({ message: "something went wrong" })
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(NamedError)
    expect(err.name).toBe("UnknownError")
    expect(err.data.message).toBe("something went wrong")
    expect(err.toObject()).toEqual({
      name: "UnknownError",
      data: { message: "something went wrong" },
    })
  })

  test("isInstance works", () => {
    const err = new NamedError.Unknown({ message: "test" })
    expect(NamedError.Unknown.isInstance(err)).toBe(true)
    expect(NamedError.Unknown.isInstance({ name: "UnknownError" })).toBe(true)
    expect(NamedError.Unknown.isInstance({ name: "Other" })).toBe(false)
    expect(NamedError.Unknown.isInstance(null)).toBe(false)
  })
})

describe("AuthError", () => {
  test("construction and properties", () => {
    const err = new AuthError({ message: "auth failed", provider: "openai" })
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(NamedError)
    expect(err.name).toBe("AuthError")
    expect(err.data.message).toBe("auth failed")
    expect(err.data.provider).toBe("openai")
  })

  test("toObject serialization", () => {
    const err = new AuthError({ message: "denied", provider: "anthropic" })
    expect(err.toObject()).toEqual({
      name: "AuthError",
      data: { message: "denied", provider: "anthropic" },
    })
  })

  test("isInstance type guard", () => {
    const err = new AuthError({ message: "test", provider: "openai" })
    expect(AuthError.isInstance(err)).toBe(true)
    expect(AuthError.isInstance(new ProviderError({ message: "x", provider: "y" }))).toBe(false)
  })

  test("schema is defined", () => {
    expect(AuthError.Schema).toBeDefined()
  })
})

describe("ProviderError", () => {
  test("construction and properties", () => {
    const err = new ProviderError({ message: "unknown provider", provider: "gemini" })
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(NamedError)
    expect(err.name).toBe("ProviderError")
    expect(err.data.message).toBe("unknown provider")
    expect(err.data.provider).toBe("gemini")
  })

  test("isInstance type guard", () => {
    const err = new ProviderError({ message: "test", provider: "x" })
    expect(ProviderError.isInstance(err)).toBe(true)
    expect(ProviderError.isInstance(new AuthError({ message: "x", provider: "y" }))).toBe(false)
  })
})

describe("TokenRefreshError", () => {
  test("construction and properties", () => {
    const err = new TokenRefreshError({ message: "refresh failed", status: 401 })
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(NamedError)
    expect(err.name).toBe("TokenRefreshError")
    expect(err.data.message).toBe("refresh failed")
    expect(err.data.status).toBe(401)
  })

  test("toObject serialization", () => {
    const err = new TokenRefreshError({ message: "expired", status: 403 })
    expect(err.toObject()).toEqual({
      name: "TokenRefreshError",
      data: { message: "expired", status: 403 },
    })
  })

  test("isInstance type guard", () => {
    const err = new TokenRefreshError({ message: "test", status: 500 })
    expect(TokenRefreshError.isInstance(err)).toBe(true)
    expect(TokenRefreshError.isInstance(new AuthError({ message: "x", provider: "y" }))).toBe(false)
  })

  test("can be caught and inspected", () => {
    try {
      throw new TokenRefreshError({ message: "Token refresh failed: 401", status: 401 })
    } catch (e) {
      expect(TokenRefreshError.isInstance(e)).toBe(true)
      if (TokenRefreshError.isInstance(e)) {
        expect(e.data.status).toBe(401)
      }
    }
  })
})
