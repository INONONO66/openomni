import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sink } from "@openomni/llm";
import { initialize, Session, Storage } from "@openomni/ledger";
import type { Gateway } from "@openomni/protocol";
import { createResident } from "../src/resident";
import { assistantMessage } from "./helpers/assistant-message";

const directories: string[] = [];

afterEach(() => {
  Storage.reset();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function addStoredMessage(sessionId: string, index: number): void {
  const role = index % 2 === 0 ? "user" : "assistant";
  const messageId = `history-${index}`;
  Session.addMessage(
    sessionId,
    role === "user"
      ? {
          id: messageId,
          sessionID: sessionId,
          role,
          time: { created: index + 1 },
          agent: "resident",
          model: { providerID: "fake", modelID: "resident-test" },
        }
      : {
          id: messageId,
          sessionID: sessionId,
          role,
          time: { created: index + 1 },
          parentID: `history-${index - 1}`,
          modelID: "resident-test",
          providerID: "fake",
          agent: "resident",
          path: { cwd: "", root: "" },
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        },
  );
  Session.addPart(messageId, {
    id: `${messageId}-text`,
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text: `${role} history ${index} ${"filler ".repeat(30)}`,
  });
}

function delivery(sessionId: string): Gateway.Deliver {
  return {
    sessionId,
    event: {
      id: "inbound-compaction",
      traceId: "trace-resident-compaction",
      surface: "internal",
      userId: "owner",
      payload: "new resident question",
      target: { kind: "resident" },
      mode: "direct",
    },
    decision: {
      traceId: "trace-resident-compaction",
      time: Date.now(),
      inboundId: "inbound-compaction",
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

describe("Resident compaction", () => {
  it("replaces oversized hydrated history before continuing the Resident run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openomni-resident-compaction-"));
    directories.push(directory);
    initialize({ dbPath: join(directory, "chat.db") });
    const session = Session.create({
      traceId: "trace-session",
      title: "long Resident session",
      model: { providerID: "fake", modelID: "resident-test" },
    });
    for (let index = 0; index < 12; index += 1) addStoredMessage(session.id, index);

    const messageCounts: number[] = [];
    let calls = 0;
    const resident = createResident({
      model: { provider: "fake", id: "resident-test" },
      apiKey: "test-key",
      tools: {},
      targets: () => [],
      llm: {
        resolveProviderModel: async (model) => ({
          id: model.id,
          name: model.id,
          providerID: model.provider,
          limit: { context: 100 },
        }),
        run: async (input, sink: Sink) => {
          calls += 1;
          messageCounts.push(input.messages?.length ?? 0);
          sink.onMessage(
            assistantMessage(input, {
              call: calls,
              reason: calls === 1 ? "tool-calls" : "stop",
              tokens: { input: 90, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            }),
          );
          return { type: "stop" };
        },
      },
    });

    await resident(delivery(session.id));

    expect(calls).toBe(2);
    expect(messageCounts[1]).toBeLessThan(messageCounts[0] ?? 0);
  });
});
