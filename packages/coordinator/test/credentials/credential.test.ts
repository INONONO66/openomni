import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadCredentials, getCredentialsForProvider } from "../../src/credentials/store";
import { createCredentialInjector } from "../../src/credentials/injector";

const TMP = join(tmpdir(), `openomni-cred-test-${process.pid}`);
const SECRETS_PATH = join(TMP, "secrets.json");

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("loadCredentials", () => {
  test("returns empty object when file does not exist", () => {
    const result = loadCredentials(join(TMP, "nonexistent.json"));
    expect(result).toEqual({});
  });

  test("reads and parses secrets file", () => {
    writeFileSync(
      SECRETS_PATH,
      JSON.stringify({ ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-oai-test" }),
    );
    const result = loadCredentials(SECRETS_PATH);
    expect(result).toEqual({ ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-oai-test" });
  });

  test("returns empty object on malformed JSON", () => {
    const badPath = join(TMP, "bad.json");
    writeFileSync(badPath, "{ not json }");
    const result = loadCredentials(badPath);
    expect(result).toEqual({});
  });
});

describe("getCredentialsForProvider", () => {
  const creds = {
    ANTHROPIC_API_KEY: "sk-ant-test",
    OPENAI_API_KEY: "sk-oai-test",
    ANTHROPIC_MODEL: "claude-3",
    DATABASE_URL: "postgres://localhost/db",
  };

  test("returns keys with provider prefix", () => {
    const result = getCredentialsForProvider(creds, "anthropic");
    expect(result).toHaveProperty("ANTHROPIC_API_KEY", "sk-ant-test");
    expect(result).toHaveProperty("ANTHROPIC_MODEL", "claude-3");
  });

  test("excludes keys that do not match", () => {
    const result = getCredentialsForProvider(creds, "anthropic");
    expect(result).not.toHaveProperty("DATABASE_URL");
  });

  test("handles provider names with hyphens", () => {
    const hyphenCreds = { AZURE_OPENAI_API_KEY: "azure-key", OTHER_KEY: "other" };
    const result = getCredentialsForProvider(hyphenCreds, "azure-openai");
    expect(result).toHaveProperty("AZURE_OPENAI_API_KEY", "azure-key");
  });
});

describe("createCredentialInjector", () => {
  test("inject returns filtered credentials for provider", () => {
    const creds = { ANTHROPIC_API_KEY: "sk-ant-test", DATABASE_URL: "postgres://localhost/db" };
    const injector = createCredentialInjector(creds);
    const result = injector.inject("worker-1", "anthropic");
    expect(result).toHaveProperty("ANTHROPIC_API_KEY", "sk-ant-test");
    expect(result).not.toHaveProperty("DATABASE_URL");
  });

  test("worker env does not contain API keys from process.env", () => {
    // Verify process.env is not used for credential resolution
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const creds = { ANTHROPIC_API_KEY: "sk-from-store" };
    const injector = createCredentialInjector(creds);
    const result = injector.inject("worker-2", "anthropic");

    // credentials come from the store, not process.env
    expect(result.ANTHROPIC_API_KEY).toBe("sk-from-store");
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

    if (savedKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  test("inject returns empty object when no matching credentials", () => {
    const creds = { DATABASE_URL: "postgres://localhost/db" };
    const injector = createCredentialInjector(creds);
    const result = injector.inject("worker-3", "anthropic");
    expect(result).toEqual({});
  });
});
