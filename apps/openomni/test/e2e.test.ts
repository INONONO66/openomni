import { Effect } from "effect";
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { AssertionError } from "node:assert/strict";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import type { Sink } from "@openomni/llm";
import { SessionHandleStore, SurfaceKey } from "@openomni/ledger";
import { ConfigurationError, loadConfig, type OpenOmniConfig } from "../src/config";
import { assistantMessage } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextResidentTurn } from "./helpers/resident-turn";
import { declareChannel } from "./helpers/declared-channel";
import { expectAbsentWebhook } from "./helpers/http";

const REPLY = "A deterministic Resident reply.";
const WS_TOKEN = "e2e-upgrade-token";
const suite = residentSuite();

/** A valid raw upgrade that exposes 101 as well as refusal, without fetch's 101 restriction. */
async function upgradeResponse(port: number, path: string) {
  const socket = connect({ host: "127.0.0.1", port });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<{ status: number; raw: string }>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("HTTP upgrade response timed out")), 2000);
      let raw = "";
      socket.setEncoding("utf8");
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        raw += chunk;
        const end = raw.indexOf("\r\n\r\n");
        if (end < 0) return;
        const status = Number(raw.split(" ")[1]);
        const length = Number(/content-length: (\d+)/i.exec(raw)?.[1] ?? 0);
        if (raw.length < end + 4 + length) return;
        resolve({ status, raw });
      });
      socket.once("connect", () =>
        socket.write(
          [
            `GET ${path} HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "",
            "",
          ].join("\r\n"),
        ),
      );
    });
  } finally {
    clearTimeout(timer);
    socket.destroy();
    await closed;
  }
}

async function bootWithConfig(config: OpenOmniConfig): Promise<{ port: number }> {
  const app = await suite.boot({
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: (input, sink: Sink) => Effect.sync(() => {
        sink.onMessage(assistantMessage(input, { id: "fake-assistant-message", text: REPLY }));
        return { type: "stop" };
      }),
    },
  });
  return { port: app.port };
}

function bootApp(): Promise<{ port: number }> {
  return bootWithConfig(suite.config("openomni-resident-", { wsToken: WS_TOKEN }));
}

/**
 * Runs `fn` with the config env reduced to exactly `env`, restoring every
 * variable afterwards so the parity tests are deterministic in any shell.
 */
async function withConfigEnv(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const name of CONFIG_ENV) saved.set(name, process.env[name]);
  try {
    for (const name of CONFIG_ENV) delete process.env[name];
    Object.assign(process.env, env);
    await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function configEnvFor(directory: string): Record<string, string> {
  return {
    OPENOMNI_DB_PATH: join(directory, "chat.db"),
    OPENOMNI_WS_PORT: "0",
    OPENOMNI_WS_TOKEN: WS_TOKEN,
    OPENOMNI_MODEL_PROVIDER: "fake",
    OPENOMNI_MODEL_ID: "resident-test",
    OPENOMNI_MODEL_API_KEY: "test-key",
  };
}

// Every variable loadConfig() reads, so the env-path parity test below is
// deterministic regardless of the shell it runs in.
const CONFIG_ENV = [
  "DISCORD_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_TOKEN",
  "GITHUB_BOT_USERNAME",
  "OPENOMNI_DB_PATH",
  "OPENOMNI_WS_HOST",
  "OPENOMNI_WS_PORT",
  "OPENOMNI_WS_TOKEN",
  "OPENOMNI_MODEL_PROVIDER",
  "OPENOMNI_MODEL_ID",
  "OPENOMNI_MODEL_API_KEY",
  "OPENOMNI_COMPACTION_SUMMARIZER",
  "OPENOMNI_ACTORS",
  "OPENOMNI_SOCIAL_BUDGETS",
  "OPENOMNI_MACHINES_ENROLLED",
  "OPENOMNI_MACHINES_SOCKET",
] as const;

describe("OpenOmni Resident WebSocket", () => {
  it("967-U1 real upgrade rejects query-only before admission and accepts canonical auth", async () => {
    let providerCalls = 0;
    const config = suite.config("openomni-967-u1-", { wsToken: WS_TOKEN });
    const app = await suite.boot({
      config,
      llm: {
        resolveModel: fakeProviderModel,
        run: (input, sink: Sink) => Effect.sync(() => {
          providerCalls += 1;
          sink.onMessage(assistantMessage(input, { text: REPLY }));
          return { type: "stop" };
        }),
      },
    });
    const db = new Database(config.dbPath, { readonly: true });
    try {
      const refusal = await upgradeResponse(app.port, `/ws?token=${WS_TOKEN}`);
      const before = db
        .query("SELECT COUNT(*) AS count FROM session WHERE id != 'gateway-ingress'")
        .get();
      console.log(
        "967-U1 HTTP",
        JSON.stringify({
          port: app.port,
          dbPath: config.dbPath,
          ...refusal,
          providerCalls,
          sessions: before,
        }),
      );
      expect(refusal.status).toBe(401);
      expect(providerCalls).toBe(0);
      expect(before).toEqual({ count: 0 });
      expect(
        db
          .query("SELECT COUNT(*) AS count FROM action WHERE session_id != 'gateway-ingress'")
          .get(),
      ).toEqual({ count: 0 });

      const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", WS_TOKEN]);
      expect(ws.protocol).toBe("auth");
      const response = nextResidentTurn();
      ws.send(JSON.stringify({ type: "message", text: "967-U1 input" }));
      const reply = await response;
      expect(reply).toMatchObject({ text: REPLY });
      expect(providerCalls).toBe(1);
      expect(
        SessionHandleStore.listRows().filter((row) => row.id !== "gateway-ingress"),
      ).toHaveLength(1);
      const session = SessionHandleStore.listRows().filter(
        (row) => row.id !== "gateway-ingress",
      )[0];
      if (session === undefined) throw new Error("resident session was not persisted");
      const snapshot = SessionHandleStore.getSnapshot(session.id);
      expect(snapshot).toMatchObject({ role: "resident", state: "idle" });
      expect(snapshot.turns.at(-1)?.messages).toEqual([
        { role: "user", text: "967-U1 input" },
        { role: "assistant", text: REPLY },
      ]);
      const sessions = db
        .query("SELECT id, role, state, revision FROM session WHERE id != 'gateway-ingress'")
        .all();
      const actions = db
        .query("SELECT session_id, kind, ordinal FROM action ORDER BY ordinal")
        .all();
      expect(sessions).toHaveLength(1);
      expect(actions.length).toBeGreaterThan(0);
      console.log(
        "967-U1 WS SQLite",
        JSON.stringify({
          protocol: ws.protocol,
          reply,
          providerCalls,
          sessions,
          actions,
          turns: snapshot.turns,
        }),
      );
    } finally {
      db.close();
      await suite.cleanup();
      expect(existsSync(dirname(config.dbPath))).toBe(false);
      console.log(
        "967-U1 cleanup",
        JSON.stringify({
          port: app.port,
          dbPath: config.dbPath,
          directoryExists: existsSync(dirname(config.dbPath)),
        }),
      );
    }
  });

  it("967-U1 closes owned sockets and removes SQLite after an assertion failure", async () => {
    const config = suite.config("openomni-967-failure-", { wsToken: WS_TOKEN });
    const app = await bootWithConfig(config);
    const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", WS_TOKEN]);
    const failure = new AssertionError({
      actual: ws.protocol,
      expected: "intentional-assertion-failure",
      operator: "strictEqual",
    });
    try {
      throw failure;
    } catch (error) {
      expect(error).toBe(failure);
    } finally {
      // Outside any rejection matcher: a cleanup rejection must fail this test.
      await suite.cleanup();
    }
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    expect(existsSync(dirname(config.dbPath))).toBe(false);
    console.log(
      "967-U1 failure cleanup",
      JSON.stringify({
        state: ws.readyState,
        directoryExists: existsSync(dirname(config.dbPath)),
        port: app.port,
      }),
    );
  });

  it("boots WebSocket-only when no channel credentials are configured", async () => {
    const app = await bootApp();

    await expectAbsentWebhook(app.port);

    const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", WS_TOKEN]);
    expect(ws.protocol).toBe("auth");
    const reply = nextResidentTurn();
    ws.send(JSON.stringify({ type: "message", text: "Help me judge this." }));

    expect(await reply).toMatchObject({ text: REPLY });

    const sessions = SessionHandleStore.listRows().filter((row) => row.id !== "gateway-ingress");
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    if (session === undefined) throw new Error("Expected one persisted session");
    const snapshot = SessionHandleStore.getSnapshot(session.id);
    expect(snapshot).toMatchObject({ role: "resident", state: "idle" });
    expect(snapshot.turns.at(-1)?.messages).toEqual([
      { role: "user", text: "Help me judge this." },
      { role: "assistant", text: REPLY },
    ]);

    const surfaceKeys = SurfaceKey.listBySession(session.id);
    expect(surfaceKeys).toHaveLength(1);
    expect(surfaceKeys[0]).toStartWith("ws:");
  });

  it("boots WebSocket-only through loadConfig when channel env vars are unset", async () => {
    await withConfigEnv(configEnvFor(suite.tempDir("openomni-resident-")), async () => {
      // Without declared instances, only the built-in WebSocket surface mounts.
      const config = loadConfig();

      const app = await bootWithConfig(config);
      await expectAbsentWebhook(app.port);
    });
  });

  it("refuses boot configuration with a legacy channel credential", async () => {
    const env = {
      ...configEnvFor(suite.tempDir("openomni-resident-")),
      GITHUB_WEBHOOK_SECRET: "github-webhook-secret",
    };
    await withConfigEnv(env, async () => {
      try {
        loadConfig();
        throw new Error("legacy channel credential accepted");
      } catch (error) {
        if (!ConfigurationError.isInstance(error)) throw error;
        expect(error.data.code).toBe("legacy_channel_credentials");
        expect(error.data.replacement).toEqual({ tool: "provision", op: "channel_add" });
      }
    });
  });

  it("mounts a declared GitHub driver on the existing HTTP server", async () => {
    const config = suite.config("declared-github-", { wsToken: WS_TOKEN });
    suite.defer(declareChannel(config.dbPath, "github", { secret: "github-webhook-secret" }));
    const app = await bootWithConfig(config);

    const response = await fetch(`http://127.0.0.1:${app.port}/github/webhook`, {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Missing signature");
  });

  it("rejects an upgrade carrying the wrong subprotocol token", async () => {
    const app = await bootApp();

    await expect(
      suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "wrong-token"]),
    ).rejects.toThrow("WebSocket failed before opening");
    expect(
      SessionHandleStore.listRows().filter((row) => row.id !== "gateway-ingress"),
    ).toHaveLength(0);
  });

  it("rolls a failed boot back and leaves the next boot clean", async () => {
    // Occupy the port so Bun.serve fails AFTER the journal and kernel stages
    // mounted — the composer must unwind them and rethrow the original cause.
    const occupant = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("occupied"),
    });
    const config = suite.config("openomni-resident-", {
      wsPort: occupant.port ?? 0,
      wsToken: WS_TOKEN,
    });
    try {
      await expect(bootWithConfig(config)).rejects.toThrow(
        /in use|EADDRINUSE|Failed to (listen|start server)/i,
      );

      // The rollback released storage: the same config boots cleanly once the
      // port frees up.
      await occupant.stop(true);
      const app = await bootWithConfig(config);
      const health = await fetch(`http://127.0.0.1:${app.port}/health`);
      expect(await health.json()).toEqual({ ok: true });
    } finally {
      await occupant.stop(true);
    }
  });
});
