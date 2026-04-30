import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import yargs from "yargs";

const selectMock = mock();
const passwordMock = mock();
const textMock = mock();
const confirmMock = mock();

mock.module("@clack/prompts", () => ({
  intro: () => undefined,
  outro: () => undefined,
  cancel: () => undefined,
  isCancel: () => false,
  select: selectMock,
  password: passwordMock,
  text: textMock,
  confirm: confirmMock,
  log: {
    info: () => undefined,
    message: () => undefined,
    error: () => undefined,
    success: () => undefined,
    warn: () => undefined,
  },
  spinner: () => ({
    start: () => undefined,
    stop: () => undefined,
    message: () => undefined,
  }),
}));

const authSetMock = mock();
const methodRunMock = mock();

mock.module("@openomni/llm", () => ({
  Auth: {
    set: authSetMock,
    get: mock(async () => undefined),
    all: mock(async () => ({})),
    remove: mock(async () => undefined),
  },
  getAuthProviders: () => [
    {
      id: "test-provider",
      name: "Test Provider",
      hint: "test hint",
      methods: [
        {
          id: "api-key",
          label: "API Key",
          hint: "Enter key",
          run: methodRunMock,
        },
      ],
    },
  ],
}));

const { ConfigCommand } = await import("../src/cmd/config");
const { AuthCommand } = await import("../src/cmd/auth");
const { Config } = await import("../src/config/index");

const testBase = join(process.env.TMPDIR ?? "/tmp", `openomni-cmd-test-${process.pid}`);
const configDir = join(testBase, ".openomni");
const configFile = join(configDir, "config.json");
const savedConfigPath = process.env.OPENOMNI_CONFIG_PATH;

function restoreEnv() {
  if (savedConfigPath !== undefined) {
    process.env.OPENOMNI_CONFIG_PATH = savedConfigPath;
  } else {
    delete process.env.OPENOMNI_CONFIG_PATH;
  }
}

describe("AuthCommand structure", () => {
  it("exports correct command and description", () => {
    expect(AuthCommand.command).toBe("auth");
    expect(AuthCommand.describe).toBe("Manage credentials");
    expect(typeof AuthCommand.builder).toBe("function");
    expect(typeof AuthCommand.handler).toBe("function");
  });

  it("builder registers subcommands", () => {
    if (typeof AuthCommand.builder !== "function") throw new Error("expected function");
    expect(AuthCommand.builder(yargs([]))).toBeDefined();
  });
});

describe("ConfigCommand structure", () => {
  it("exports correct command and description", () => {
    expect(ConfigCommand.command).toBe("config");
    expect(ConfigCommand.describe).toBe("Manage adapter configurations");
    expect(typeof ConfigCommand.builder).toBe("function");
    expect(typeof ConfigCommand.handler).toBe("function");
  });

  it("builder registers subcommands", () => {
    if (typeof ConfigCommand.builder !== "function") throw new Error("expected function");
    expect(ConfigCommand.builder(yargs([]))).toBeDefined();
  });
});

describe("config add handler", () => {
  beforeEach(() => {
    process.env.OPENOMNI_CONFIG_PATH = configFile;
    if (existsSync(testBase)) rmSync(testBase, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    selectMock.mockReset();
    passwordMock.mockReset();
    textMock.mockReset();
    confirmMock.mockReset();
  });

  afterEach(() => {
    if (existsSync(testBase)) rmSync(testBase, { recursive: true });
    restoreEnv();
  });

  it("writes telegram adapter to config file", async () => {
    selectMock.mockResolvedValue("telegram");
    passwordMock.mockResolvedValue("test-tg-token");
    textMock.mockResolvedValue("");

    await yargs(["config", "add"]).command(ConfigCommand).exitProcess(false).parseAsync();

    const loaded = Config.load();
    expect(loaded.telegram?.token).toBe("test-tg-token");
  });

  it("writes discord adapter to config file", async () => {
    selectMock.mockResolvedValue("discord");
    passwordMock.mockResolvedValue("test-dc-token");
    textMock.mockResolvedValue("");

    await yargs(["config", "add"]).command(ConfigCommand).exitProcess(false).parseAsync();

    const loaded = Config.load();
    expect(loaded.discord?.token).toBe("test-dc-token");
  });

  it("includes allowedUsers when provided", async () => {
    selectMock.mockResolvedValue("telegram");
    passwordMock.mockResolvedValue("tg-token");
    textMock.mockResolvedValue("user1, user2");

    await yargs(["config", "add"]).command(ConfigCommand).exitProcess(false).parseAsync();

    const loaded = Config.load();
    expect(loaded.telegram?.token).toBe("tg-token");
    expect(loaded.telegram?.allowedUsers).toEqual(["user1", "user2"]);
  });

  it("writes github adapter with secret and optional token", async () => {
    selectMock.mockResolvedValue("github");
    let pwdCall = 0;
    passwordMock.mockImplementation(async () => {
      pwdCall++;
      return pwdCall === 1 ? "gh-secret" : "gh-token";
    });
    confirmMock.mockResolvedValue(true);
    textMock.mockResolvedValue("");

    await yargs(["config", "add"]).command(ConfigCommand).exitProcess(false).parseAsync();

    const loaded = Config.load();
    expect(loaded.github?.secret).toBe("gh-secret");
    expect(loaded.github?.token).toBe("gh-token");
  });
});

describe("auth login handler", () => {
  beforeEach(() => {
    selectMock.mockReset();
    passwordMock.mockReset();
    textMock.mockReset();
    authSetMock.mockReset();
    methodRunMock.mockReset();
  });

  it("stores API key for custom 'other' provider", async () => {
    selectMock.mockResolvedValue("other");
    textMock.mockResolvedValue("custom-provider");
    passwordMock.mockResolvedValue("sk-test-key");
    authSetMock.mockResolvedValue(undefined);

    await yargs(["auth", "login"]).command(AuthCommand).exitProcess(false).parseAsync();

    expect(authSetMock).toHaveBeenCalledWith("custom-provider", {
      type: "api",
      key: "sk-test-key",
    });
  });

  it("invokes provider login method for known provider", async () => {
    selectMock.mockResolvedValue("test-provider");
    methodRunMock.mockResolvedValue(undefined);

    await yargs(["auth", "login"]).command(AuthCommand).exitProcess(false).parseAsync();

    expect(methodRunMock).toHaveBeenCalledTimes(1);
    const callbacks = methodRunMock.mock.calls[0]?.[0];
    expect(callbacks).toBeDefined();
    expect(typeof callbacks.showUrl).toBe("function");
    expect(typeof callbacks.getInput).toBe("function");
    expect(typeof callbacks.showMessage).toBe("function");
  });
});
