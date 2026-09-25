import { describe, expect, test } from "bun:test";
import { fakeProviders } from "./helpers/channel-providers";
import type { Channel, Provisioning } from "@openomni/protocol";
import { declaredChannelProfile } from "../src/channels";

const handler: Channel.MessageHandler = () => Promise.resolve();
const credentials = {
  telegram: { token: "tg-token" },
  github: { secret: "gh-secret", token: "gh-api", botUsername: "omni-bot" },
  discord: { token: "dc-token" },
};
const instances: Provisioning.ChannelInstance[] = Object.keys(credentials).map((provider) => ({
  id: `channel:${provider}:main`, provider, enabled: true, settings: {},
  credentialRef: provider, revision: 0, createdBy: "owner", updatedAt: 0,
}));

function profile(rows = instances) {
  const fakes = fakeProviders();
  const payloads = new Map(Object.entries(credentials).map(([key, value]) => [key, JSON.stringify(value)]));
  const selected = declaredChannelProfile(rows, (ref) => {
    const value = payloads.get(ref);
    return value === undefined
      ? { kind: "locked", reason: "missing" }
      : { kind: "ok", plaintext: new TextEncoder().encode(value) };
  }, fakes.providers);
  return { fakes, ...selected };
}

describe("declared channel composition", () => {
  test("no declarations produce no rows", () => {
    expect(profile([]).rows).toEqual([]);
  });

  test("one row per declaration preserves credentials and binds the handler", async () => {
    const { fakes, rows, statuses } = profile();
    expect(rows.map((row) => row.component.id)).toEqual(["telegram", "github", "discord"]);
    expect(statuses.every((status) => status.state === "ready")).toBe(true);
    const built = rows.map((row) => row.component.build(handler));
    expect(fakes.surfaces.map((surface) => surface.handler)).toEqual([handler, handler, handler]);
    expect(fakes.surfaces.map((surface) => surface.credentials)).toEqual(Object.values(credentials));
    expect(fakes.surfaces.map((surface) => surface.config)).toEqual([{}, {}, {}]);
    const [telegram, github, discord] = built;
    expect(telegram?.deliveryRoute).toBeDefined();
    expect(telegram?.webhookHandler).toBeUndefined();
    expect(discord?.deliveryRoute).toBeDefined();
    expect(discord?.webhookHandler).toBeUndefined();
    expect(github?.deliveryRoute).toBeUndefined();
    expect(github?.webhookHandler).toBeDefined();
    await telegram?.deliveryRoute?.("actor-1", "hello", "key-1");
    expect(fakes.delivered).toEqual([{ externalId: "actor-1", body: "hello" }]);
    expect((await github?.webhookHandler?.(new Request("https://x.test/webhook")))?.status).toBe(200);
    expect(fakes.webhookCalls).toHaveLength(1);
  });
});
