import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { assertWsExposure, loadConfig } from "../src/config";
import { startOpenOmni } from "../src/index";

const ENV_KEYS = [
  "OPENOMNI_DB_PATH",
  "OPENOMNI_WS_HOST",
  "OPENOMNI_WS_PORT",
  "OPENOMNI_WS_TOKEN",
  "OPENOMNI_MODEL_PROVIDER",
  "OPENOMNI_MODEL_ID",
  "OPENOMNI_MODEL_API_KEY",
  "OPENOMNI_MODEL_BASE_URL",
  "OPENOMNI_MODEL_HEADERS",
  "OPENOMNI_MODEL_FALLBACKS",
  "OPENOMNI_SOCIAL_BUDGETS",
  "OPENOMNI_MACHINES_ENROLLED",
  "OPENOMNI_MACHINES_SOCKET",
  "OPENOMNI_VERIFIER_EXECUTABLES",
  "OPENOMNI_CHANNEL_ALLOWED_SENDERS",
] as const;

let saved: Record<string, string | undefined>;

/** Runs `act`, returning its thrown value and failing if it returns. */
function thrownBy(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  throw new Error("expected an enrollment refusal, got a value");
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.OPENOMNI_MODEL_PROVIDER = "fake";
  process.env.OPENOMNI_MODEL_ID = "resident-test";
  process.env.OPENOMNI_MODEL_API_KEY = "test-key";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("ws exposure enforcement", () => {
  it("refuses a non-loopback host without an upgrade token", () => {
    expect(() => assertWsExposure({ host: "0.0.0.0" })).toThrow(
      "OPENOMNI_WS_TOKEN is required when OPENOMNI_WS_HOST is not loopback",
    );
    expect(() => assertWsExposure({ host: "0.0.0.0", wsToken: "" })).toThrow(
      "OPENOMNI_WS_TOKEN is required when OPENOMNI_WS_HOST is not loopback",
    );
  });

  it("refuses injected non-loopback config before binding", async () => {
    // `/dev/null/...` cannot be opened: if the refusal ever stopped preceding
    // the ledger and the bind, this would fail on that path instead.
    await expect(
      startOpenOmni({
        config: {
          dbPath: "/dev/null/never-created.db",
          memoryPath: "/dev/null/never-created.memory.json",
          host: "0.0.0.0",
          wsPort: 0,
          model: { provider: "fake", id: "resident-test", apiKey: "test-key" },
        },
      }),
    ).rejects.toThrow("OPENOMNI_WS_TOKEN is required when OPENOMNI_WS_HOST is not loopback");
  });

  it("accepts a non-loopback host once a token is set", () => {
    process.env.OPENOMNI_WS_HOST = "0.0.0.0";
    process.env.OPENOMNI_WS_TOKEN = "shared-secret";
    const config = loadConfig();
    expect(config.host).toBe("0.0.0.0");
    expect(config.wsToken).toBe("shared-secret");
  });

  it("allows loopback without a token and omits the field", () => {
    const config = loadConfig();
    expect(config.host).toBe("127.0.0.1");
    expect("wsToken" in config).toBe(false);
  });

  it("refuses a missing required model value", () => {
    delete process.env.OPENOMNI_MODEL_API_KEY;
    expect(() => loadConfig()).toThrow();
  });

  it("leaves the model transport overrides absent when unset", () => {
    const config = loadConfig();
    expect("baseUrl" in config.model).toBe(false);
    expect("headers" in config.model).toBe(false);
  });

  it("reads the operator's model base URL and headers", () => {
    process.env.OPENOMNI_MODEL_BASE_URL = "https://gateway.internal/v1";
    process.env.OPENOMNI_MODEL_HEADERS = JSON.stringify({
      "x-tenant": "acme",
      "user-agent": "acme-fleet/2",
    });

    const config = loadConfig();

    expect(config.model.baseUrl).toBe("https://gateway.internal/v1");
    expect(config.model.headers).toEqual({ "x-tenant": "acme", "user-agent": "acme-fleet/2" });
  });

  it("fails closed on malformed OPENOMNI_MODEL_HEADERS JSON", () => {
    process.env.OPENOMNI_MODEL_HEADERS = "{not json";

    expect(() => loadConfig()).toThrow("OPENOMNI_MODEL_HEADERS is invalid JSON");
  });

  it.each([
    { name: "a JSON array", value: JSON.stringify(["x-tenant", "acme"]) },
    { name: "a bare string", value: JSON.stringify("x-tenant: acme") },
    { name: "non-string header values", value: JSON.stringify({ "x-retries": 3 }) },
    { name: "an empty header name", value: JSON.stringify({ "": "acme" }) },
    {
      name: "a header name containing a CR/LF",
      value: JSON.stringify({ "x-bad\r\ninjected": "acme" }),
    },
    {
      name: "a header value containing a CR/LF",
      value: JSON.stringify({ "x-tenant": "acme\r\ninjected" }),
    },
  ])("fails closed on $name", ({ value }) => {
    process.env.OPENOMNI_MODEL_HEADERS = value;

    expect(() => loadConfig()).toThrow("OPENOMNI_MODEL_HEADERS is invalid");
  });

  it("leaves the fallback chain absent when unset", () => {
    expect(loadConfig().model.fallbacks).toBeUndefined();
  });

  it("reads a comma-separated provider/model fallback chain in order", () => {
    process.env.OPENOMNI_MODEL_FALLBACKS = "openai/gpt-5, anthropic/claude-x";

    expect(loadConfig().model.fallbacks).toEqual([
      { provider: "openai", id: "gpt-5" },
      { provider: "anthropic", id: "claude-x" },
    ]);
  });

  it("keeps a model id containing slashes intact — only the first slash splits", () => {
    process.env.OPENOMNI_MODEL_FALLBACKS = "openai/meta-llama/llama-4";

    expect(loadConfig().model.fallbacks).toEqual([
      { provider: "openai", id: "meta-llama/llama-4" },
    ]);
  });

  it.each([
    { name: "an entry with no provider separator", value: "gpt-5" },
    { name: "an empty provider segment", value: "/gpt-5" },
    { name: "an empty model segment", value: "openai/" },
    { name: "a blank entry between two valid ones", value: "openai/gpt-5,,anthropic/claude-x" },
    { name: "whitespace inside a segment", value: "open ai/gpt-5" },
    {
      name: "a provider absent from the bundled catalog",
      value: "definitely-unknown-provider/model",
    },
  ])("fails closed on $name", ({ value }) => {
    process.env.OPENOMNI_MODEL_FALLBACKS = value;

    expect(() => loadConfig()).toThrow("OPENOMNI_MODEL_FALLBACKS is invalid");
  });

  it("treats a whitespace-only value as unset rather than as an empty chain", () => {
    process.env.OPENOMNI_MODEL_FALLBACKS = "   ";

    expect(loadConfig().model.fallbacks).toBeUndefined();
  });

  it("reads the Owner's export allowlist off the enrollment", () => {
    process.env.OPENOMNI_MACHINES_SOCKET = "/tmp/machines-config-test.sock";
    process.env.OPENOMNI_MACHINES_ENROLLED = JSON.stringify([
      {
        machineId: "alpha",
        name: "the laptop",
        allowedCapabilities: ["fs.read"],
        allowedExports: ["notes", "src"],
        enrolledAt: 0,
      },
    ]);

    expect(loadConfig().machines?.enrolled[0]?.allowedExports).toEqual(["notes", "src"]);
  });

  it("leaves the allowlist absent when the Owner named no export — no config, no reach", () => {
    process.env.OPENOMNI_MACHINES_ENROLLED = JSON.stringify([
      { machineId: "alpha", name: "the laptop", allowedCapabilities: ["fs.read"], enrolledAt: 0 },
    ]);

    expect(loadConfig().machines?.enrolled[0]?.allowedExports).toBeUndefined();
  });

  it("refuses an enrollment whose export names collide or break the grammar", () => {
    process.env.OPENOMNI_MACHINES_ENROLLED = JSON.stringify([
      {
        machineId: "alpha",
        name: "the laptop",
        allowedCapabilities: ["fs.read"],
        allowedExports: ["notes", "notes"],
        enrolledAt: 0,
      },
    ]);
    const duplicate = thrownBy(loadConfig);
    expect(duplicate).toBeInstanceOf(Error);
    expect((duplicate as Error).message).toBe(
      "OPENOMNI_MACHINES_ENROLLED is invalid: export names must be unique",
    );

    process.env.OPENOMNI_MACHINES_ENROLLED = JSON.stringify([
      {
        machineId: "alpha",
        name: "the laptop",
        allowedCapabilities: ["fs.read"],
        allowedExports: ["../escape"],
        enrolledAt: 0,
      },
    ]);
    const invalidName = thrownBy(loadConfig);
    expect(invalidName).toBeInstanceOf(Error);
    expect((invalidName as Error).message).toBe(
      "OPENOMNI_MACHINES_ENROLLED is invalid: export name must be lowercase alphanumeric with - or _ (e.g. notes)",
    );
  });

  it("reads registered verifier executable ids as absolute paths", () => {
    process.env.OPENOMNI_VERIFIER_EXECUTABLES = JSON.stringify({
      build: "/usr/bin/true",
      "test.unit": "/usr/bin/false",
    });

    const config = loadConfig();

    expect(config.verifiers?.executables).toEqual(
      new Map([
        ["build", "/usr/bin/true"],
        ["test.unit", "/usr/bin/false"],
      ]),
    );
  });

  it("leaves command verification unwired when no executable registry is configured", () => {
    expect(loadConfig().verifiers).toBeUndefined();
  });

  it.each([
    { name: "a non-object registry", value: JSON.stringify(["/usr/bin/true"]) },
    { name: "an invalid executable id", value: JSON.stringify({ "Build Now": "/usr/bin/true" }) },
    { name: "a relative executable path", value: JSON.stringify({ build: "bin/true" }) },
  ])("fails closed on $name", ({ value }) => {
    process.env.OPENOMNI_VERIFIER_EXECUTABLES = value;

    expect(() => loadConfig()).toThrow("OPENOMNI_VERIFIER_EXECUTABLES is invalid");
  });

  it("reads explicit social budgets while keeping the default absent", () => {
    expect(loadConfig().socialBudgets).toBeUndefined();
    process.env.OPENOMNI_SOCIAL_BUDGETS = JSON.stringify([
      {
        id: "budget:alice",
        targetActorId: "alice",
        maxPerWindow: 2,
        windowMs: 60_000,
        cooldownMs: 0,
      },
    ]);
    expect(loadConfig().socialBudgets).toEqual([
      {
        id: "budget:alice",
        targetActorId: "alice",
        maxPerWindow: 2,
        windowMs: 60_000,
        cooldownMs: 0,
      },
    ]);
  });

  it("reads per-surface sender allowlists, absent by default", () => {
    expect(loadConfig().channelAllowedSenders).toBeUndefined();
    process.env.OPENOMNI_CHANNEL_ALLOWED_SENDERS = JSON.stringify({ telegram: ["111"] });
    expect(loadConfig().channelAllowedSenders).toEqual({ telegram: ["111"] });
    process.env.OPENOMNI_CHANNEL_ALLOWED_SENDERS = "not-json";
    expect(() => loadConfig()).toThrow("OPENOMNI_CHANNEL_ALLOWED_SENDERS is invalid JSON");
  });
});
