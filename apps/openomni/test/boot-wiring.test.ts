import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type ChannelDeliveryRoute,
  type ProviderDeliveryRoute,
  resolveChannelGrant,
} from "@openomni/channels";
import { SessionHandleStore, SqliteStorageAdapter, Storage } from "@openomni/ledger";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { RunInput, Sink } from "@openomni/llm";
import type { Channel } from "@openomni/protocol";
import type { BuiltChannel, ChannelComponent } from "../src/channels";
import { createComposer } from "../src/composition/composer";
import { MOUNTED_CHANNEL_DEFAULT_TIER, registerTrustedChannelGrant } from "../src/gateway";
import {
  type ChannelSupervisor,
  createChannelSupervisor,
  type DesiredChannelRow,
  type DesiredChannels,
} from "../src/provisioning/supervisor";
import { assistantMessage } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextFrame, nextMessage } from "./helpers/ws";

const suite = residentSuite();

describe("boot tool catalog", () => {
  test("boots ready without legacy work tools in the Resident catalog", async () => {
    let resolveToolNames!: (names: readonly string[]) => void;
    const toolNames = new Promise<readonly string[]>((resolve) => {
      resolveToolNames = resolve;
    });
    const app = await suite.boot({
      config: suite.config("openomni-boot-catalog-", { wsToken: "boot-catalog-token" }),
      llm: {
        resolveModel: fakeProviderModel,
        run: async (input: RunInput, sink: Sink) => {
          resolveToolNames(input.tools.map((tool) => tool.name));
          sink.onMessage(assistantMessage(input, { id: "boot-catalog-reply", text: "ready" }));
          return { type: "stop" };
        },
      },
    });

		const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws?actor=owner`, [
      "auth",
      "boot-catalog-token",
    ]);
		const reply = nextFrame(ws, (frame) => frame.type === "message");
    ws.send(JSON.stringify({ type: "message", text: "catalog" }));

		expect(await reply).toMatchObject({ type: "message", text: "ready" });
    expect(await toolNames).not.toContain("work_items");
    expect(await toolNames).not.toContain("complete_work");
  });
});

test("967 boot preserves promoted expired session", async () => {
  const config = suite.config("openomni-967-history-", { wsToken: "history-token" });
  let calls = 0;
  const options = {
    config,
    llm: {
      resolveModel: fakeProviderModel,
      run: async (input: RunInput, sink: Sink) => {
        calls += 1;
        sink.onMessage(assistantMessage(input, { text: "recovered" }));
        return { type: "stop" as const };
      },
    },
  };
  // Capture the real app's catalog, not a dummy runner or a parallel declaration.
  const first = await suite.boot(options);
  const ws = await suite.openSocket(`ws://127.0.0.1:${first.port}/ws`, ["auth", "history-token"]);
  const response = nextMessage(ws);
  ws.send(JSON.stringify({ type: "message", text: "catalog seed" }));
  await response;
	const template = SessionHandleStore.listRows().find((row) => row.id !== "gateway-ingress");
  if (template === undefined) throw new Error("missing app session");
  const generation = SessionHandleStore.latestGeneration(SessionHandleStore.tree(template.id));
  await first.stop();

  const seed = new SqliteStorageAdapter(config.dbPath);
  Storage.configure(seed);
  const raw = new Database(config.dbPath);
  const id = "promoted-expired";
  const legacy = JSON.stringify({
    id,
    title: "historical",
    model: { providerID: "old", modelID: "old" },
    time: { created: 1, updated: 1 },
    spawnDepth: 0,
    expiresAt: 2,
  });
  try {
    raw
      .query("INSERT INTO session (id, data, time_created, time_updated) VALUES (?, ?, 1, 1)")
      .run(id, legacy);
    expect(
      SessionHandleStore.materialize({
        id,
        parentId: null,
        role: "resident",
        tools: generation.tools,
        system: { preset: generation.systemPreset, blocks: generation.systemBlocks },
        policyGeneration: generation.policyGeneration,
        actionId: "historical-configure",
        at: 3,
      }).created,
    ).toBe(true);
    expect(
      seed.actions.append(
        {
          id: "historical-completed",
          sessionId: id,
          parentId: "historical-configure",
          kind: "tool",
          intent: { encodingVersion: 1, value: { tool: "archived-read" } },
          effect: { encodingVersion: 1, value: { result: "completed" } },
          irreversible: true,
          ts: 4,
        },
        1,
      ),
    ).toBeDefined();
    SessionHandleStore.commitInbox({
      id: "historical-pending",
      sessionId: id,
      kind: "prompt",
      content: "recover this",
      origin: { encodingVersion: 1, value: { source: "967-fixture" } },
      createdAt: 5,
      parentActionId: "historical-completed",
    });
    expect(
      seed.alarms.arm({ id: "historical-alarm", sessionId: id, kind: "at", fireAt: 100 }),
    ).toBeDefined();
    const before = {
      session: raw.query("SELECT * FROM session WHERE id = ?").get(id),
      actions: raw.query("SELECT * FROM action WHERE session_id = ? ORDER BY ordinal").all(id),
      inbox: raw.query("SELECT * FROM inbox WHERE session_id = ?").all(id),
      alarms: raw.query("SELECT * FROM alarm WHERE session_id = ?").all(id),
    };
    console.log("967 SQLite before boot", JSON.stringify(before));
    Storage.reset();
    calls = 0;

    const app = await suite.boot(options);
    const after = {
      session: raw.query("SELECT * FROM session WHERE id = ?").get(id),
      actions: raw.query("SELECT * FROM action WHERE session_id = ? ORDER BY ordinal").all(id),
      inbox: raw.query("SELECT * FROM inbox WHERE session_id = ?").all(id),
      alarms: raw.query("SELECT * FROM alarm WHERE session_id = ?").all(id),
    };
    console.log("967 SQLite after boot", JSON.stringify({ ...after, calls }));
    expect(after.session).not.toBeNull();
    expect(after.actions.slice(0, before.actions.length)).toEqual(before.actions);
    expect(after.alarms).toEqual(before.alarms);
    expect(raw.query("SELECT data FROM session WHERE id = ?").get(id)).toEqual({ data: legacy });
    expect(SessionHandleStore.pendingInbox(id)).toEqual([]);
    expect(SessionHandleStore.inboxRows(id)).toMatchObject([
      { id: "historical-pending", status: "consumed" },
    ]);
    expect(SessionHandleStore.getSnapshot(id).turns.at(-1)?.messages).toEqual([
      { role: "user", text: "recover this" },
      { role: "assistant", text: "recovered" },
    ]);
    expect(calls).toBe(1);
    await app.stop();
    const reopened = new SqliteStorageAdapter(config.dbPath);
    try {
      Storage.configure(reopened);
      expect(raw.query("SELECT * FROM session WHERE id = ?").get(id)).toEqual(after.session);
      expect(
        raw.query("SELECT * FROM action WHERE session_id = ? ORDER BY ordinal").all(id),
      ).toEqual(after.actions);
      expect(raw.query("SELECT * FROM inbox WHERE session_id = ?").all(id)).toEqual(after.inbox);
      expect(raw.query("SELECT * FROM alarm WHERE session_id = ?").all(id)).toEqual(after.alarms);
      expect(SessionHandleStore.getSnapshot(id).state).toBe("idle");
      expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
      console.log(
        "967 SQLite reopen",
        JSON.stringify({ id, actions: after.actions.length, state: "idle" }),
      );
    } finally {
      Storage.reset();
    }
  } finally {
    raw.close();
    seed.close();
    await suite.cleanup();
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    expect(existsSync(dirname(config.dbPath))).toBe(false);
    console.log(
      "967 cleanup",
      JSON.stringify({
        dbPath: config.dbPath,
        directoryExists: existsSync(dirname(config.dbPath)),
        socketState: ws.readyState,
      }),
    );
  }
});

describe("channel supervisor", () => {
  beforeEach(() => {
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    Storage.reset();
  });

  interface FakeChannel {
    readonly component: ChannelComponent;
    readonly calls: string[];
    failNextStarts: number;
  }

  function fakeChannel(
    id: ChannelComponent["id"],
    calls: string[],
    options: { deliveryRoute?: ProviderDeliveryRoute; webhook?: boolean } = {},
  ): FakeChannel {
    const channel: FakeChannel = {
      calls,
      failNextStarts: 0,
      component: {
        id,
        build: (): BuiltChannel => {
          const surface: Channel.Surface = {
            id,
						config: {},
            async start() {
              if (channel.failNextStarts > 0) {
                channel.failNextStarts -= 1;
                throw new Error(`${id} start refused`);
              }
              calls.push(`start:${id}`);
            },
            async stop() {
              calls.push(`stop:${id}`);
            },
            onMessage() {
              // The handler was bound at build time; the stage never rebinds it.
            },
          };
          return {
            surface,
            ...(options.deliveryRoute === undefined
              ? {}
              : { deliveryRoute: options.deliveryRoute }),
            ...(options.webhook === true ? { webhookHandler: async () => new Response("ok") } : {}),
          };
        },
      },
    };
    return channel;
  }

  function supervisorFor(desired: () => DesiredChannels): {
    supervisor: ChannelSupervisor;
    deliveryRoutes: Map<string, ChannelDeliveryRoute>;
    webhookHandlers: Map<string, (request: Request) => Promise<Response>>;
  } {
    const deliveryRoutes = new Map<string, ChannelDeliveryRoute>();
    const webhookHandlers = new Map<string, (request: Request) => Promise<Response>>();
    const supervisor = createChannelSupervisor({
      desired,
			build: (component) => component.build(async () => undefined),
      grant: (surface, defaultTier) => registerTrustedChannelGrant({ surface, defaultTier }),
      deliveryRoutes,
      webhookHandlers,
      traceId: () => "00-11111111111111111111111111111111-2222222222222222-01",
    });
    return { supervisor, deliveryRoutes, webhookHandlers };
  }

  const row = (channel: FakeChannel, key: string, instanceId?: string): DesiredChannelRow => ({
    instanceId: instanceId ?? `channel:${channel.component.id}:main`,
    key,
    component: channel.component,
    defaultTier: MOUNTED_CHANNEL_DEFAULT_TIER,
  });

  test("a stage owns its grant, route, and webhook; stopAll revokes all of them", async () => {
    const calls: string[] = [];
		const route: ProviderDeliveryRoute = async () => ({ value: "accepted" });
    const routed = fakeChannel("telegram", calls, { deliveryRoute: route });
    const ingressOnly = fakeChannel("github", calls, { webhook: true });
    const { supervisor, deliveryRoutes, webhookHandlers } = supervisorFor(() => ({
      source: "declared",
      rows: [row(routed, "0:0"), row(ingressOnly, "0:0")],
      statuses: [],
    }));

    const statuses = await supervisor.reconcile();

    expect(statuses.map((status) => status.state)).toEqual(["mounted", "mounted"]);
    expect(calls).toEqual(["start:telegram", "start:github"]);
    expect(deliveryRoutes.get("telegram")).toBe(route);
    // Ingress-only channels register no outbound route; webhook channels land
    // in the live webhook table the HTTP surface reads per request.
    expect(deliveryRoutes.has("github")).toBe(false);
    expect(webhookHandlers.has("github")).toBe(true);
    expect(resolveChannelGrant({ surface: "telegram" })?.grant.kind).toBe("trusted_channel");
    // #931: the mounted stage's grant carries the row's declared tier — a
    // named surface never materializes owner authority by mounting.
    expect(resolveChannelGrant({ surface: "telegram" })?.grant.defaultTier).toBe(
      MOUNTED_CHANNEL_DEFAULT_TIER,
    );
    expect(resolveChannelGrant({ surface: "github" })?.grant.defaultTier).toBe(
      MOUNTED_CHANNEL_DEFAULT_TIER,
    );
    expect(supervisor.source()).toBe("declared");

    await supervisor.stopAll();

    expect(calls).toEqual(["start:telegram", "start:github", "stop:github", "stop:telegram"]);
    expect(deliveryRoutes.has("telegram")).toBe(false);
    expect(webhookHandlers.has("github")).toBe(false);
    expect(resolveChannelGrant({ surface: "telegram" })).toBeUndefined();
    expect(resolveChannelGrant({ surface: "github" })).toBeUndefined();
  });

  // #931 done-means 5: the grant row is observable immediately after the
  // synchronous part of reconcile resolves, at the row's exact tier, and the
  // disposal path removes it.
  test("a row's declared tier is the mounted grant's tier and disposal removes the row", async () => {
    const calls: string[] = [];
    const declared = fakeChannel("discord", calls);
    const { supervisor } = supervisorFor(() => ({
      source: "declared",
      rows: [{ ...row(declared, "0:0"), defaultTier: "observer" }],
      statuses: [],
    }));

    await supervisor.reconcile();

    expect(resolveChannelGrant({ surface: "discord" })?.grant.defaultTier).toBe("observer");

    await supervisor.stopAll();

    expect(resolveChannelGrant({ surface: "discord" })).toBeUndefined();
  });

  test("§8.7 rotation bounces exactly the changed stage, stop before start", async () => {
    const calls: string[] = [];
    const rotated = fakeChannel("telegram", calls);
    const untouched = fakeChannel("discord", calls);
    let key = "1:100";
    const { supervisor } = supervisorFor(() => ({
      source: "declared",
      rows: [row(rotated, key), row(untouched, "1:0")],
      statuses: [],
    }));

    await supervisor.reconcile();
    calls.length = 0;
    key = "1:200"; // secret_rotate bumped the rotation epoch, same revision.
    const statuses = await supervisor.reconcile();

    // The old mount released everything BEFORE its replacement started, and
    // the untouched stage never restarted.
    expect(calls).toEqual(["stop:telegram", "start:telegram"]);
    expect(statuses).toEqual([
      { id: "channel:telegram:main", surface: "telegram", state: "mounted" },
      { id: "channel:discord:main", surface: "discord", state: "mounted" },
    ]);
  });

  test("a removed declaration unmounts and a failed start unwinds fail-closed", async () => {
    const calls: string[] = [];
    const flaky = fakeChannel("telegram", calls);
    let rows: DesiredChannelRow[] = [row(flaky, "0:0")];
    const { supervisor, deliveryRoutes } = supervisorFor(() => ({
      source: "declared",
      rows,
      statuses: [],
    }));

    flaky.failNextStarts = 1;
    const failed = await supervisor.reconcile();
    expect(failed[0]).toEqual({
      id: "channel:telegram:main",
      surface: "telegram",
      state: "start_failed",
      detail: "telegram start refused",
    });
    // Fail-closed: the stage that never started owns no grant and no route.
    expect(resolveChannelGrant({ surface: "telegram" })).toBeUndefined();
    expect(deliveryRoutes.has("telegram")).toBe(false);

    await supervisor.reconcile();
    expect(calls).toEqual(["start:telegram"]);
    rows = [];
    const removed = await supervisor.reconcile();
    expect(removed).toEqual([]);
    expect(calls).toEqual(["start:telegram", "stop:telegram"]);
    expect(resolveChannelGrant({ surface: "telegram" })).toBeUndefined();
  });

  test("three consecutive start failures trip the breaker; only resume re-arms it", async () => {
    const calls: string[] = [];
    const broken = fakeChannel("telegram", calls);
    broken.failNextStarts = 3;
    const { supervisor } = supervisorFor(() => ({
      source: "declared",
      rows: [row(broken, "0:0")],
      statuses: [],
    }));

    const first = await supervisor.reconcile();
    const second = await supervisor.reconcile();
    const third = await supervisor.reconcile();
    expect(first[0]?.state).toBe("start_failed");
    expect(second[0]?.state).toBe("start_failed");
    expect(third[0]?.state).toBe("paused_by_breaker");

    // Paused means paused: further reconciles never touch the surface again.
    const paused = await supervisor.reconcile();
    expect(paused[0]?.state).toBe("paused_by_breaker");
    expect(paused[0]?.detail).toBe("3 consecutive start failures; channel_enable re-arms it");
    expect(calls).toEqual([]);

    expect(supervisor.resume("channel:telegram:main")).toBe(true);
    expect(supervisor.resume("channel:telegram:main")).toBe(false);
    const resumed = await supervisor.reconcile();
    expect(resumed[0]?.state).toBe("mounted");
    expect(calls).toEqual(["start:telegram"]);
    expect(supervisor.status()).toEqual(resumed);
    await supervisor.stopAll();
  });

  test("composer stage disposal drives stopAll exactly like shutdown", async () => {
    const calls: string[] = [];
    const channel = fakeChannel("telegram", calls);
    const { supervisor } = supervisorFor(() => ({
      source: "env",
      rows: [row(channel, "env", "env:telegram")],
      statuses: [],
    }));
    const composer = createComposer();
    await composer.mount("channels", async (ctx) => {
      ctx.effect(() => supervisor.stopAll());
      await supervisor.reconcile();
    });

    expect(calls).toEqual(["start:telegram"]);
    expect(supervisor.source()).toBe("env");
    await composer.dispose();
    expect(calls).toEqual(["start:telegram", "stop:telegram"]);
    expect(supervisor.status()).toEqual([]);
  });
});

describe("supervisor status passthrough", () => {
  test("profile statuses surface verbatim in the reconcile verdict, detail included", async () => {
    const deliveryRoutes = new Map<string, ChannelDeliveryRoute>();
    const webhookHandlers = new Map<string, (request: Request) => Promise<Response>>();
    const supervisor = createChannelSupervisor({
      desired: () => ({
        source: "declared",
        rows: [],
        statuses: [
          {
            id: "channel:discord:main",
            provider: "discord",
            state: "vault_locked",
            detail: "no KEK",
          },
          { id: "channel:slack:main", provider: "slack", state: "disabled" },
        ],
      }),
      build: () => {
        throw new Error("nothing to build");
      },
      grant: (surface, defaultTier) => registerTrustedChannelGrant({ surface, defaultTier }),
      deliveryRoutes,
      webhookHandlers,
      traceId: () => "00-11111111111111111111111111111111-2222222222222222-01",
    });

    const statuses = await supervisor.reconcile();

    expect(statuses).toEqual([
      { id: "channel:discord:main", surface: "discord", state: "vault_locked", detail: "no KEK" },
      { id: "channel:slack:main", surface: "slack", state: "disabled" },
    ]);
  });
});
