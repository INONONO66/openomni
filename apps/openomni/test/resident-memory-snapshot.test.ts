import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunInput, Sink } from "@openomni/llm";
import { initialize, Session, Storage } from "@openomni/ledger";
import type { Gateway, Message } from "@openomni/protocol";
import type { CuratedMemory } from "../src/memory/store";
import { createResident } from "../src/resident";

const directories: string[] = [];

afterEach(() => {
  Storage.reset();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function stopMessage(input: RunInput, call: number): Message.WithParts {
  const id = `assistant-${call}`;
  const sessionID = input.trace.sessionId;
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "",
      modelID: input.model.id,
      providerID: input.model.providerID,
      agent: "resident",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      { id: `${id}-text`, sessionID, messageID: id, type: "text", text: `reply ${call}` },
      {
        id: `${id}-finish`,
        sessionID,
        messageID: id,
        type: "step-finish",
        reason: "stop",
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ],
  };
}

let inbound = 0;

function delivery(sessionId: string): Gateway.Deliver {
  inbound += 1;
  const id = `inbound-${inbound}`;
  return {
    sessionId,
    event: {
      id,
      traceId: `trace-${id}`,
      surface: "internal",
      userId: "owner",
      payload: "resident question",
      target: { kind: "resident" },
      mode: "direct",
    },
    decision: {
      traceId: `trace-${id}`,
      time: Date.now(),
      inboundId: id,
      surface: "internal",
      mode: "direct",
      stage: "surface_default",
      outcome: "route",
      reason: "test",
      factsUsed: [],
      target: "resident",
      sessionId,
    },
  };
}

function createSession(): string {
  return Session.create({
    traceId: "trace-session",
    title: "memory snapshot session",
    model: { providerID: "fake", modelID: "resident-test" },
  }).id;
}

describe("Resident memory snapshot lifecycle", () => {
  it("freezes per session and re-freezes to current memory after cap eviction", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openomni-resident-snapshot-"));
    directories.push(directory);
    initialize({ dbPath: join(directory, "chat.db") });

    let rendered = "memory v1";
    const memory: CuratedMemory = {
      add: () => "id",
      replace: () => undefined,
      remove: () => undefined,
      render: () => rendered,
    };
    const systems: string[] = [];
    const resident = createResident({
      model: { provider: "fake", id: "resident-test" },
      apiKey: "test-key",
      tools: { memory },
      targets: () => [],
      llm: {
        resolveProviderModel: async (model) => ({
          id: model.id,
          name: model.id,
          providerID: model.provider,
          limit: { context: 1_000_000 },
        }),
        run: async (input, sink: Sink) => {
          systems.push(input.system ?? "");
          sink.onMessage(stopMessage(input, systems.length));
          return { type: "stop" };
        },
      },
    });

    const first = createSession();
    await resident(delivery(first));
    expect(systems.at(-1)).toEndWith("\n\nmemory v1");

    // A mid-session memory write must not leak into the frozen session.
    rendered = "memory v2";
    await resident(delivery(first));
    expect(systems.at(-1)).toEndWith("\n\nmemory v1");

    // Fill the snapshot map past SNAPSHOT_CAP (64) so the first session evicts.
    for (let index = 0; index < 64; index += 1) {
      await resident(delivery(createSession()));
    }
    expect(systems.at(-1)).toEndWith("\n\nmemory v2");

    // The evicted session re-freezes to CURRENT memory on its next turn.
    rendered = "memory v3";
    await resident(delivery(first));
    expect(systems.at(-1)).toEndWith("\n\nmemory v3");
  });
});
