import { expect, spyOn, test } from "bun:test";
import { ChannelProviders } from "@openomni/channels";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import type { PlainObject, SessionGeneration } from "@openomni/protocol";
import { fakeProviders } from "./helpers/channel-providers";
import { eventSignal } from "./helpers/event-signal";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextFrame } from "./helpers/ws";
import { declareChannel } from "./helpers/declared-channel";

const suite = residentSuite();

test("a mounted driver receives a rejected promise when message policy refuses admission", async () => {
  const providers = fakeProviders();
  const telegram = spyOn(ChannelProviders.telegram, "create").mockImplementation(providers.providers.telegram.create);
  try {
    const config = suite.config("driver-refusal-");
    suite.defer(declareChannel(config.dbPath, "telegram", { token: "fixture" }));
    const app = await suite.boot({
      config,
      llm: { resolveModel: fakeProviderModel },
    });
    const policies = Storage.get().policies;
    if (policies === undefined) throw new Error("missing policy fixture");
    policies.append({
      name: "fixture-message-denial", kind: "message", phase: "pre", priority: 10000,
      generation: SessionHandleStore.currentPolicyGeneration(),
      match: { encodingVersion: 1, value: {} },
      verdict: { encodingVersion: 1, value: { type: "deny", reason: "fixture_refusal" } },
    });
    const surface = providers.surfaces[0];
    if (surface?.handler === null || surface?.handler === undefined) throw new Error("missing driver handler");
    await expect(surface.handler({
      sender: { kind: "external", surface: "telegram", externalId: "sender" },
      facts: {
        eventId: "frame", surface: "telegram", channelId: "conversation", dm: true,
        addressees: [], render: "hello", payload: {},
      },
    })).rejects.toThrow("message admission refused:");
    expect(SessionHandleStore.listRows().map((row: ReturnType<typeof SessionHandleStore.row>) => row.id)).toEqual(["gateway-ingress"]);
    expect((await fetch(`http://127.0.0.1:${app.port}/health`)).status).toBe(200);
  } finally {
    telegram.mockRestore();
  }
});

test("an admitted WebSocket message reports a failed wake without taking down ingress", async () => {
  const app = await suite.boot({
    config: suite.config("wake-failure-", { wsToken: "fixture-token" }),
    llm: { resolveModel: fakeProviderModel },
  });
  const ws = await suite.openSocket(`ws://127.0.0.1:${app.port}/ws`, ["auth", "fixture-token"]);
  const reported = eventSignal<string>("failed wake");
  const readGeneration = SessionHandleStore.latestGenerationFor;
  const failure = new Error("fixture_generation_unavailable");
  const generation = spyOn(SessionHandleStore, "latestGenerationFor").mockImplementation((id: string): SessionGeneration.Snapshot => {
    if (id !== "gateway-ingress") throw failure;
    return readGeneration(id);
  });
  const incident = spyOn(console, "error").mockImplementation((_message: string, detail: string): void => reported.resolve(detail));
  try {
    const receipt = nextFrame(ws, (frame: PlainObject): boolean => frame.type === "receipt");
    ws.send(JSON.stringify({ type: "message", text: "wake" }));
    expect(await receipt).toMatchObject({ status: "accepted" });
    expect(await reported.promise).toContain(failure.message);
    expect(incident.mock.calls).toHaveLength(1);
    expect((await fetch(`http://127.0.0.1:${app.port}/health`)).status).toBe(200);
  } finally {
    generation.mockRestore();
    incident.mockRestore();
  }
});
