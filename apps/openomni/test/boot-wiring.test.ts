import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveChannelGrant, type ChannelDeliveryRoute } from "@openomni/channels";
import { Storage } from "@openomni/ledger";
import type { Channel } from "@openomni/protocol";
import type { BuiltChannel } from "../src/channels";
import { createComposer } from "../src/composition/composer";
import { createMachinesPort, mountChannelStages, replyText } from "../src/index";

describe("replyText", () => {
  test("hands a string payload back verbatim and serializes anything else", () => {
    expect(replyText("done")).toBe("done");
    expect(replyText({ status: "done", count: 2 })).toBe('{"status":"done","count":2}');
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
    expect(createMachinesPort({ attached: () => undefined }, undefined)).toBeUndefined();
  });

  test("folds enrollment against live attachment per read", () => {
    const port = createMachinesPort(
      { attached: (machineId) => (machineId === "machine:a" ? ["shell"] : undefined) },
      machines,
    );
    if (port === undefined) throw new Error("expected a machines port");

    expect(port()).toEqual([
      { machineId: "machine:a", attached: true, capabilities: ["shell"] },
      { machineId: "machine:b", attached: false, capabilities: [] },
    ]);
  });
});

describe("mountChannelStages", () => {
  beforeEach(() => {
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    Storage.reset();
  });

  function fakeChannel(id: string, deliveryRoute?: ChannelDeliveryRoute) {
    const calls: string[] = [];
    const surface: Channel.Surface = {
      id,
      config: { triggers: [] },
      async start() {
        calls.push("start");
      },
      async stop() {
        calls.push("stop");
      },
      onMessage() {
        // The handler was bound at build time; the stage never rebinds it.
      },
    };
    const built: BuiltChannel = {
      surface,
      ...(deliveryRoute === undefined ? {} : { deliveryRoute }),
    };
    return { built, calls };
  }

  test("a stage owns its grant, route, and surface; dispose revokes all three", async () => {
    const composer = createComposer();
    const deliveryRoutes = new Map<string, ChannelDeliveryRoute>();
    const route: ChannelDeliveryRoute = async () => ({});
    const routed = fakeChannel("telegram", route);
    const ingressOnly = fakeChannel("github");

    await mountChannelStages(
      composer,
      [routed.built, ingressOnly.built],
      deliveryRoutes,
      "00-11111111111111111111111111111111-2222222222222222-01",
    );

    expect(routed.calls).toEqual(["start"]);
    expect(deliveryRoutes.get("telegram")).toBe(route);
    // Ingress-only channels register no outbound route.
    expect(deliveryRoutes.has("github")).toBe(false);
    expect(resolveChannelGrant({ surface: "telegram" })?.grant.kind).toBe("trusted_channel");
    expect(resolveChannelGrant({ surface: "github" })?.grant.kind).toBe("trusted_channel");

    await composer.dispose();

    expect(routed.calls).toEqual(["start", "stop"]);
    expect(ingressOnly.calls).toEqual(["start", "stop"]);
    expect(deliveryRoutes.has("telegram")).toBe(false);
    expect(resolveChannelGrant({ surface: "telegram" })).toBeUndefined();
    expect(resolveChannelGrant({ surface: "github" })).toBeUndefined();
  });
});
