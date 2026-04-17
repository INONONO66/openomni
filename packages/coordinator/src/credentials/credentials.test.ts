import { describe, it, expect } from "bun:test";
import { getCredentialsForProvider } from "./store";

describe("getCredentialsForProvider", () => {
  it("returns only ANTHROPIC_* keys for anthropic provider", () => {
    const creds = {
      ANTHROPIC_API_KEY: "key1",
      OPENAI_API_KEY: "key2",
      ANTHROPIC_ORG_ID: "org1",
    };

    const result = getCredentialsForProvider(creds, "anthropic");

    expect(result).toEqual({
      ANTHROPIC_API_KEY: "key1",
      ANTHROPIC_ORG_ID: "org1",
    });
    expect(result.OPENAI_API_KEY).toBeUndefined();
  });

  it("returns only OPENAI_* keys for openai provider", () => {
    const creds = {
      ANTHROPIC_API_KEY: "key1",
      OPENAI_API_KEY: "key2",
      OPENAI_ORG_ID: "org2",
    };

    const result = getCredentialsForProvider(creds, "openai");

    expect(result).toEqual({
      OPENAI_API_KEY: "key2",
      OPENAI_ORG_ID: "org2",
    });
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("returns empty object for empty credentials", () => {
    const creds = {};

    const result = getCredentialsForProvider(creds, "anthropic");

    expect(result).toEqual({});
  });

  it("handles provider names with hyphens by converting to underscores", () => {
    const creds = {
      OPENAI_COMPATIBLE_API_KEY: "key1",
      OPENAI_COMPATIBLE_BASE_URL: "https://example.com",
      ANTHROPIC_API_KEY: "key2",
    };

    const result = getCredentialsForProvider(creds, "openai-compatible");

    expect(result).toEqual({
      OPENAI_COMPATIBLE_API_KEY: "key1",
      OPENAI_COMPATIBLE_BASE_URL: "https://example.com",
    });
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
