import { expect, test } from "bun:test";
import type { RunInput, Sink } from "@openomni/llm";
import { SessionHandleStore } from "@openomni/ledger";
import { requestToolStep, assistantMessage } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextFrame } from "./helpers/ws";
import {
  createDispositionFixture,
  seedRetiredWait,
} from "../../../packages/ledger/test/helpers/disposition-967";
import {
  archiveAndVerify,
  disposeCli,
} from "../../../packages/ledger/test/helpers/disposition-967-cli";

const WS_TOKEN = "channel-delegation-e2e-token";
const suite = residentSuite();

test("the Resident delegates to an external actor over the channel and reports the reply", async () => {
  const fixture = createDispositionFixture();
  await using _resources = {
    async [Symbol.asyncDispose]() {
      try {
        await suite.cleanup();
      } finally {
        fixture[Symbol.dispose]();
      }
    },
  };
  seedRetiredWait(fixture.db);
  archiveAndVerify(fixture);
  expect(disposeCli(fixture).exitCode).toBe(0);
  const residentTexts: string[] = [];
  const seenTurns = new Set<string>();
  let ownerSessionId: string | undefined;
  let wake!: () => void;
  const wakeSeen = new Promise<void>((resolve) => {
    wake = resolve;
  });

  const app = await suite.boot({
    config: {
      dbPath: fixture.path,
      host: "127.0.0.1",
      wsPort: 0,
      wsToken: WS_TOKEN,
      model: { provider: "fake", id: "channel-delegation-test", apiKey: "test-key" },
      actors: [{ actorId: "alice", externalId: "alice", trustTier: "collaborator", kind: "human" }],
      socialBudgets: [
        {
          id: "budget:alice",
          targetActorId: "alice",
          maxPerWindow: 2,
          windowMs: 60_000,
          cooldownMs: 0,
        },
      ],
    },
    llm: {
      resolveProviderModel: fakeProviderModel,
      run: async (input: RunInput, sink: Sink) => {
        const lastUser = [...input.messages].reverse().find((entry) => entry.info.role === "user");
        const asked = (lastUser?.parts ?? [])
          .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
          .join("");
        if (!seenTurns.has(input.trace.runId)) {
          residentTexts.push(asked);
          seenTurns.add(input.trace.runId);
        }
        if (
          ownerSessionId === undefined &&
          SessionHandleStore.row(input.trace.sessionId).role === "resident"
        ) {
          ownerSessionId = input.trace.sessionId;
        }

        if (asked.includes("please ask alice")) {
          const executed = requestToolStep(input, sink, {
            id: "call-1",
            tool: "delegate",
            input: {
              instruction: "review the quarterly report",
              operation: "assign",
              acceptanceCriteria: ["every section read"],
              actorId: "alice",
              timeoutMs: 10_000,
            },
          });
          if (executed === undefined) return { type: "stop" };
          sink.onMessage(
            assistantMessage(input, {
              text: `delegation started: ${executed?.output ?? "nothing"}`,
            }),
          );
          return { type: "stop" };
        }
        if (asked.startsWith("delegation ") && asked.includes(" settled:")) {
          wake();
          sink.onMessage(assistantMessage(input, { text: `wake observed: ${asked}` }));
          return { type: "stop" };
        }

        sink.onMessage(assistantMessage(input, { text: "noted" }));
        return { type: "stop" };
      },
    },
  });

  const base = `ws://127.0.0.1:${app.port}/ws`;
  const protocols = ["auth", WS_TOKEN];
  const owner = await suite.openSocket(base, protocols);
  const alice = await suite.openSocket(`${base}?actor=alice`, protocols);
  const bob = await suite.openSocket(`${base}?actor=bob`, protocols);
  expect([owner.protocol, alice.protocol, bob.protocol]).toEqual(["auth", "auth", "auth"]);

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
  expect(((await ownerAnswer) as { text: string }).text).toContain(
    "settlement will arrive as a message",
  );

  // Settlement wakes exactly one Resident turn in the origin session. The
  // wake is internal, so it is observed through the provider and transcript,
  // not as a second channel response to the actor's reply.
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      wakeSeen,
      new Promise<never>((_resolve, reject) => {
        wakeTimer = setTimeout(() => reject(new Error("settlement wake deadline")), 10000);
      }),
    ]);
  } finally {
    clearTimeout(wakeTimer);
  }
  expect(residentTexts.filter((text) => text.includes("please ask alice"))).toHaveLength(1);
  expect(residentTexts.filter((text) => text.includes("bob butting in"))).toHaveLength(1);
  expect(
    residentTexts.filter((text) => text.includes("delegation ") && text.includes(" settled:")),
  ).toHaveLength(1);
  if (ownerSessionId === undefined) throw new Error("owner session was not materialized");
  const wakeDeliveries = SessionHandleStore.tree(ownerSessionId)
    .map(SessionHandleStore.delivery)
    .filter((entry) => entry?.kind === "prompt" && entry.content.includes(" settled:"));
  expect(wakeDeliveries).toHaveLength(1);
  expect(wakeDeliveries[0]?.origin.value).toMatchObject({ systemKind: "delegation.settled" });
  console.log(
    "967-U1 actor correlation",
    JSON.stringify({
      messageId: delivered.messageId,
      ownerSessionId,
      wakeDeliveries,
      ownerProtocol: owner.protocol,
      aliceProtocol: alice.protocol,
      bobProtocol: bob.protocol,
    }),
  );
});
