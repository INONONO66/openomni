import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOnboardFlags, runOnboard, type OnboardIO } from "../../src/cli/onboard";
import { renderSystemdUnit } from "../../src/cli/systemd";

function createStubIO(): OnboardIO & { logs: string[]; warns: string[] } {
  const logs: string[] = [];
  const warns: string[] = [];
  return {
    logs,
    warns,
    ask: (_question, defaultValue) => Promise.resolve(defaultValue),
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
    close: () => undefined,
  };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (typeof value !== "object" || value === null) return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.push(key);
    collectKeys(child, keys);
  }
  return keys;
}

describe("onboard", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "openomni-onboard-test-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("creates a bootable config with strong tokens from empty state", async () => {
    await runOnboard({ baseDir, io: createStubIO() });

    const configPath = join(baseDir, "config.json");
    const config = readJson(configPath);
    const server = config.server as Record<string, unknown>;
    expect(server.port).toBe(3000);
    expect(server.host).toBe("127.0.0.1");
    expect(typeof server.wsToken).toBe("string");
    expect((server.wsToken as string).length).toBeGreaterThanOrEqual(40);
    expect(typeof server.adminToken).toBe("string");
    expect((server.adminToken as string).length).toBeGreaterThanOrEqual(40);
    expect(server.adminToken).not.toBe(server.wsToken);
    expect((config.workspace as Record<string, unknown>).root).toBe(join(baseDir, "workspace"));
    expect(existsSync(join(baseDir, "workspace"))).toBe(true);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(config.model).toBeUndefined();
    expect(existsSync(join(baseDir, "auth.json"))).toBe(false);
  });

  it("is idempotent: rerun preserves both tokens, --force rotates them", async () => {
    await runOnboard({ baseDir, io: createStubIO() });
    const first = readJson(join(baseDir, "config.json")).server as Record<string, unknown>;
    await runOnboard({ baseDir, io: createStubIO() });
    const second = readJson(join(baseDir, "config.json")).server as Record<string, unknown>;
    expect(second.wsToken).toBe(first.wsToken as string);
    expect(second.adminToken).toBe(first.adminToken as string);

    await runOnboard({ baseDir, io: createStubIO(), flags: { force: true } });
    const third = readJson(join(baseDir, "config.json")).server as Record<string, unknown>;
    expect(third.wsToken).not.toBe(first.wsToken as string);
    expect(third.adminToken).not.toBe(first.adminToken as string);
  });

  it("preserves keys it does not own", async () => {
    const configPath = join(baseDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        telegram: { token: "bot-token", allowedUsers: ["u1"] },
        custom: { nested: { flag: true } },
        server: { port: 4100 },
      }),
    );

    await runOnboard({ baseDir, io: createStubIO() });

    const config = readJson(configPath);
    expect(config.telegram).toEqual({ token: "bot-token", allowedUsers: ["u1"] });
    expect(config.custom).toEqual({ nested: { flag: true } });
    expect((config.server as Record<string, unknown>).port).toBe(4100);
  });

  it("writes proxy auth to auth.json only — config.json never carries api keys", async () => {
    const hub = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const hubUrl = `http://127.0.0.1:${hub.port}`;
    try {
      await runOnboard({
        baseDir,
        io: createStubIO(),
        flags: {
          tokenHubUrl: hubUrl,
          apiKey: "hub-secret-key",
          model: "claude-test-1",
        },
      });
    } finally {
      hub.stop(true);
    }

    const authPath = join(baseDir, "auth.json");
    const auth = readJson(authPath);
    expect(auth.anthropic).toEqual({
      type: "proxy",
      baseURL: hubUrl,
      apiKey: "hub-secret-key",
    });
    expect(statSync(authPath).mode & 0o777).toBe(0o600);

    const config = readJson(join(baseDir, "config.json"));
    expect(config.model).toEqual({ provider: "anthropic", id: "claude-test-1" });
    const keys = collectKeys(config);
    expect(keys).not.toContain("apiKey");
    expect(keys).not.toContain("key");
    expect(JSON.stringify(config)).not.toContain("hub-secret-key");
  });

  it("treats an unreachable token hub as a warning, not a failure", async () => {
    const io = createStubIO();
    await runOnboard({
      baseDir,
      io,
      flags: { tokenHubUrl: "http://127.0.0.1:9", model: "claude-test-1" },
    });
    expect(io.warns.some((line) => line.includes("not reachable"))).toBe(true);
    expect(existsSync(join(baseDir, "auth.json"))).toBe(true);
  });

  it("keeps an existing model choice on rerun", async () => {
    writeFileSync(
      join(baseDir, "config.json"),
      JSON.stringify({
        model: { provider: "anthropic", id: "claude-pinned-1", providerOptions: { a: 1 } },
      }),
    );
    await runOnboard({ baseDir, io: createStubIO() });
    const config = readJson(join(baseDir, "config.json"));
    expect(config.model).toEqual({
      provider: "anthropic",
      id: "claude-pinned-1",
      providerOptions: { a: 1 },
    });
  });

  it("--model alone never flips a user-edited provider or drops providerOptions", async () => {
    writeFileSync(
      join(baseDir, "config.json"),
      JSON.stringify({
        model: { provider: "openai", id: "gpt-old", providerOptions: { reasoningEffort: "high" } },
      }),
    );
    await runOnboard({ baseDir, io: createStubIO(), flags: { model: "gpt-new" } });
    const config = readJson(join(baseDir, "config.json"));
    expect(config.model).toEqual({
      provider: "openai",
      id: "gpt-new",
      providerOptions: { reasoningEffort: "high" },
    });
  });

  it("fails closed on a string-typed port in existing config instead of rewriting it", async () => {
    writeFileSync(join(baseDir, "config.json"), JSON.stringify({ server: { port: "4100" } }));
    await expect(runOnboard({ baseDir, io: createStubIO() })).rejects.toThrow(
      /invalid server\.port/,
    );
    expect(readJson(join(baseDir, "config.json"))).toEqual({ server: { port: "4100" } });
  });

  it("fails closed on a corrupt existing config", async () => {
    writeFileSync(join(baseDir, "config.json"), "{not json");
    await expect(runOnboard({ baseDir, io: createStubIO() })).rejects.toThrow(/not valid JSON/);
  });

  it("rejects an invalid token hub URL", async () => {
    await expect(
      runOnboard({ baseDir, io: createStubIO(), flags: { tokenHubUrl: "not a url" } }),
    ).rejects.toThrow(/invalid token hub URL/);
  });
});

describe("parseOnboardFlags", () => {
  it("parses the documented flags", () => {
    const flags = parseOnboardFlags([
      "--token-hub-url",
      "https://hub.example",
      "--provider",
      "anthropic",
      "--model",
      "claude-test-1",
      "--port",
      "4200",
      "--workspace",
      "/tmp/ws",
      "--force",
      "--install-daemon",
    ]);
    expect(flags).toEqual({
      tokenHubUrl: "https://hub.example",
      provider: "anthropic",
      model: "claude-test-1",
      apiKey: undefined,
      port: 4200,
      host: undefined,
      workspace: "/tmp/ws",
      force: true,
      installDaemon: true,
    });
  });

  it("rejects invalid ports and unknown flags", () => {
    expect(() => parseOnboardFlags(["--port", "70000"])).toThrow(/invalid port/);
    expect(() => parseOnboardFlags(["--port", "abc"])).toThrow(/invalid port/);
    expect(() => parseOnboardFlags(["--bogus"])).toThrow(/bogus/);
  });
});

describe("renderSystemdUnit", () => {
  it("renders a unit that can find bun and restarts on failure", () => {
    const unit = renderSystemdUnit({
      execPath: "/home/op/.bun/bin/bun",
      scriptPath: "/home/op/.bun/install/global/node_modules/openomni/dist/bin/cli.js",
      scope: "user",
    });
    expect(unit).toContain(
      'ExecStart="/home/op/.bun/bin/bun" "/home/op/.bun/install/global/node_modules/openomni/dist/bin/cli.js" serve',
    );
    expect(unit).toContain('Environment="PATH=/home/op/.bun/bin:');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
    expect(
      renderSystemdUnit({ execPath: "/usr/bin/bun", scriptPath: "/x", scope: "system" }),
    ).toContain("WantedBy=multi-user.target");
  });

  it("escapes systemd % specifiers and $ variables in install paths", () => {
    const unit = renderSystemdUnit({
      execPath: "/opt/100%/bin/bun",
      scriptPath: "/opt/$HOME-like/cli.js",
      scope: "user",
    });
    expect(unit).toContain('ExecStart="/opt/100%%/bin/bun" "/opt/$$HOME-like/cli.js" serve');
    expect(unit).toContain('Environment="PATH=/opt/100%%/bin:');
  });

  it("quotes paths containing spaces", () => {
    const unit = renderSystemdUnit({
      execPath: "/home/o p/.bun/bin/bun",
      scriptPath: "/home/o p/pkg/dist/bin/cli.js",
      scope: "user",
    });
    expect(unit).toContain(
      'ExecStart="/home/o p/.bun/bin/bun" "/home/o p/pkg/dist/bin/cli.js" serve',
    );
  });
});
