import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  type ChannelDeliveryRoute,
  type ProviderDeliveryRoute,
  resolveChannelGrant,
} from "@openomni/channels";
import { LeaseStore, Storage } from "@openomni/ledger";
import type { Sink } from "@openomni/llm";
import type { Channel } from "@openomni/protocol";
import type { BuiltChannel, ChannelComponent } from "../src/channels";
import { createComposer } from "../src/composition/composer";
import { MOUNTED_CHANNEL_DEFAULT_TIER, registerTrustedChannelGrant } from "../src/gateway";
import { createLeaseLinkage, createMachinesPort, replyText } from "../src/index";
import {
  type ChannelSupervisor,
  createChannelSupervisor,
  type DesiredChannelRow,
  type DesiredChannels,
} from "../src/provisioning/supervisor";
import { assistantMessage } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextMessage, openSocket } from "./helpers/ws";

const suite = residentSuite();

describe("boot catalog", () => {
  test("boots without memory configuration or a memory tool", async () => {
    let offered: readonly string[] = [];
    const config = suite.config("openomni-no-memory-", { wsToken: "boot-memory-absence" });
    const app = await suite.boot({
      config,
      llm: {
        resolveProviderModel: fakeProviderModel,
        run: async (input, sink: Sink) => {
          offered = (input.tools ?? []).map((tool) => tool.name);
          sink.onMessage(assistantMessage(input, { text: "ready" }));
          return { type: "stop" };
        },
      },
    });

    const ws = await openSocket(`ws://127.0.0.1:${app.port}/ws?token=boot-memory-absence`);
    const result = nextMessage(ws);
    ws.send(JSON.stringify({ type: "message", text: "report readiness" }));
    const frame = JSON.parse(String((await result).data)) as { text: string; type: string };
    ws.close();

    expect(frame).toEqual({ type: "response", text: "ready" });
    expect("memoryPath" in config).toBe(false);
    expect(offered).not.toContain("memory");
  });
});

describe("replyText", () => {
  test("hands a string payload back verbatim and serializes anything else", () => {
    expect(replyText("done")).toBe("done");
    expect(replyText({ status: "done", count: 2 })).toBe('{"status":"done","count":2}');
  });
});

describe("createLeaseLinkage", () => {
  test("projects the live store row onto admission's narrow lease facts", () => {
    const list = spyOn(LeaseStore, "listLiveByHolder").mockReturnValue([
      {
        id: "lease-1",
        conversationId: "conversation-1",
        holderDelegationId: "delegation-1",
        contactId: "actor-1",
      } as never,
    ]);
    try {
      expect(createLeaseLinkage().listLiveByHolder("delegation-1", 1)).toEqual([
        {
          id: "lease-1",
          conversationId: "conversation-1",
          holderDelegationId: "delegation-1",
          contactId: "actor-1",
        },
      ]);
    } finally {
      list.mockRestore();
    }
  });
});

describe("createMachinesPort", () => {
  const enrolled = [
    { name: "a", machineId: "machine:a", allowedCapabilities: ["shell"], enrolledAt: 1 },
    { name: "b", machineId: "machine:b", allowedCapabilities: ["shell"], enrolledAt: 1 },
  ];
  const machines = { socketPath: "/tmp/unused.sock", enrolled };

  test("is absent without a host or enrollment", () => {
    expect(createMachinesPort(undefined, machines)).toBeUndefined();
    expect(
      createMachinesPort(
        { attached: () => undefined, attachedExports: () => undefined },
        undefined,
      ),
    ).toBeUndefined();
  });

  test("folds enrollment against live attachment per read", () => {
    const port = createMachinesPort(
      {
        attached: (machineId) => (machineId === "machine:a" ? ["shell"] : undefined),
        attachedExports: () => [],
      },
      machines,
    );
    if (port === undefined) throw new Error("expected a machines port");

    expect(port()).toEqual([
      { machineId: "machine:a", attached: true, capabilities: ["shell"], effectiveExports: [] },
      { machineId: "machine:b", attached: false, capabilities: [], effectiveExports: [] },
    ]);
  });

  test("reports the live effective export set, not the enrollment's wish", () => {
    const port = createMachinesPort(
      {
        attached: (machineId) => (machineId === "machine:a" ? ["fs.read"] : undefined),
        // The host answers with enrollment∩offer, so an export the Owner
        // allowed but the daemon never offered is simply not here.
        attachedExports: (machineId) => (machineId === "machine:a" ? ["notes"] : undefined),
      },
      {
        socketPath: "/tmp/unused.sock",
        enrolled: [
          {
            name: "a",
            machineId: "machine:a",
            allowedCapabilities: ["fs.read"],
            allowedExports: ["notes", "src"],
            enrolledAt: 1,
          },
        ],
      },
    );
    if (port === undefined) throw new Error("expected a machines port");

    expect(port()).toEqual([
      {
        machineId: "machine:a",
        attached: true,
        capabilities: ["fs.read"],
        effectiveExports: ["notes"],
      },
    ]);
  });
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
            config: { triggers: [] },
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
      build: (component) => component.build(async () => null),
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
    const route: ProviderDeliveryRoute = async () => ({});
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
