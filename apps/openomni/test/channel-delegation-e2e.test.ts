import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunInput, Sink } from "@openomni/llm";
import { Storage } from "@openomni/ledger";
import type { Message } from "@openomni/protocol";
import { startOpenOmni } from "../src/index";

const WS_TOKEN = "channel-delegation-e2e-token";

const directories: string[] = [];
let stopApp: (() => void) | undefined;

afterEach(() => {
  stopApp?.();
  stopApp = undefined;
  Storage.reset();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function message(input: RunInput, text: string): Message.WithParts {
  const id = `fake-${input.trace.sessionId}-${input.messages.length}`;
  const sessionID = input.trace.sessionId;
  const part = { type: "text", text } as never;
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
      tokens: { input: 4, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      { ...(part as object), id: `${id}-text`, sessionID, messageID: id } as never,
      {
        id: `${id}-finish`,
        sessionID,
        messageID: id,
        type: "step-finish",
        reason: "stop",
        cost: 0,
        tokens: { input: 4, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ],
  };
}

async function openSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("socket failed to open")), { once: true });
  });
  return ws;
}

function nextFrame(
  ws: WebSocket,
  accept: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no frame arrived")), 10_000);
    const listener = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (!accept(frame)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", listener);
      resolve(frame);
    };
    ws.addEventListener("message", listener);
  });
}

test("the Resident delegates to an external actor over the channel and reports the reply", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openomni-channel-delegation-"));
  directories.push(directory);
  const residentTexts: string[] = [];

  const app = await startOpenOmni({
    config: {
      dbPath: join(directory, "chat.db"),
      memoryPath: join(directory, "memory.json"),
      host: "127.0.0.1",
      wsPort: 0,
      wsToken: WS_TOKEN,
      model: { provider: "fake", id: "channel-delegation-test", apiKey: "test-key" },
      actors: [{ actorId: "alice", externalId: "alice", trustTier: "collaborator", kind: "human" }],
    },
    llm: {
      resolveProviderModel: async (model) => ({
        id: model.id,
        name: model.id,
        providerID: model.provider,
      }),
      run: async (input: RunInput, sink: Sink) => {
        const lastUser = [...input.messages].reverse().find((entry) => entry.info.role === "user");
        const asked = (lastUser?.parts ?? [])
          .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
          .join("");
        residentTexts.push(asked);

        if (asked.includes("please ask alice")) {
          const executed = await input.toolExecutor?.({
            id: "call-1",
            tool: "delegate",
            input: {
              instruction: "review the quarterly report",
              mode: "assign",
              acceptanceCriteria: ["every section read"],
              actorId: "alice",
              timeoutMs: 10_000,
            },
          });
          sink.onMessage(message(input, `alice reports: ${executed?.output ?? "nothing"}`));
          return { type: "stop" };
        }

        sink.onMessage(message(input, "noted"));
        return { type: "stop" };
      },
    },
  });
  stopApp = app.stop;

  const base = `ws://127.0.0.1:${app.port}/ws?token=${WS_TOKEN}`;
  const owner = await openSocket(base);
  const alice = await openSocket(`${base}&actor=alice`);
  const bob = await openSocket(`${base}&actor=bob`);

  const instruction = nextFrame(alice, (frame) => frame.type === "message");
  const ownerAnswer = nextFrame(owner, (frame) => frame.type === "response");
  owner.send(JSON.stringify({ type: "message", text: "please ask alice to review the report" }));

  const delivered = await instruction;
  // The actor reads the same rendered contract text an inline worker reads.
  expect(delivered.text).toBe(
    "review the quarterly report\n\nIt is done when all of these hold:\n- every section read",
  );
  expect(typeof delivered.messageId).toBe("string");

  // A responder the Wait does not expect cannot settle the delegation: bob's
  // reply is delivered as an ordinary message and answered by the Resident.
  const bobAnswer = nextFrame(bob, (frame) => frame.type === "response");
  bob.send(
    JSON.stringify({ type: "message", text: "bob butting in", replyToId: delivered.messageId }),
  );
  expect(((await bobAnswer) as { text: string }).text).toBe("noted");

  const aliceAck = nextFrame(alice, (frame) => frame.type === "response");
  alice.send(
    JSON.stringify({
      type: "message",
      text: "every section read, numbers check out",
      replyToId: delivered.messageId,
    }),
  );

  // The actor's reply settles the waiting delegation instead of opening a turn.
  expect(((await aliceAck) as { text: string }).text).toContain("Reply received");
  expect(((await ownerAnswer) as { text: string }).text).toBe(
    "alice reports: every section read, numbers check out",
  );

  // Exactly two Resident turns spoke: the owner's ask and bob's stray message.
  // Alice's reply resumed the delegation without becoming a turn of its own.
  expect(residentTexts.filter((text) => text.includes("please ask alice"))).toHaveLength(1);
  expect(residentTexts.filter((text) => text.includes("bob butting in"))).toHaveLength(1);
  expect(residentTexts.filter((text) => text.includes("numbers check out"))).toHaveLength(0);

  owner.close();
  alice.close();
  bob.close();
});
