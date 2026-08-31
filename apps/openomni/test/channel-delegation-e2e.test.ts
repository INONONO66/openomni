import { expect, test } from "bun:test";
import type { RunInput, Sink } from "@openomni/llm";
import { Session } from "@openomni/ledger";
import { assistantMessage } from "./helpers/assistant-message";
import { fakeProviderModel, residentSuite } from "./helpers/resident-suite";
import { nextFrame, openSocket } from "./helpers/ws";

const WS_TOKEN = "channel-delegation-e2e-token";
const suite = residentSuite();

test("the Resident delegates to an external actor over the channel and reports the reply", async () => {
  const residentTexts: string[] = [];
  let ownerSessionId: string | undefined;
  let wake!: () => void;
  const wakeSeen = new Promise<void>((resolve) => {
    wake = resolve;
  });

  const app = await suite.boot({
    config: suite.config("openomni-channel-delegation-", {
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
    }),
    llm: {
      resolveProviderModel: fakeProviderModel,
      run: async (input: RunInput, sink: Sink) => {
        const lastUser = [...input.messages].reverse().find((entry) => entry.info.role === "user");
        const asked = (lastUser?.parts ?? [])
          .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
          .join("");
        residentTexts.push(asked);
        if (ownerSessionId === undefined && !input.trace.sessionId.startsWith("delegation-")) {
          ownerSessionId = input.trace.sessionId;
        }

        if (asked.includes("please ask alice")) {
          const executed = await input.toolExecutor?.({
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
  expect(((await ownerAnswer) as { text: string }).text).toContain("settlement will arrive as a message");

  // Settlement wakes exactly one Resident turn in the origin session. The
  // wake is internal, so it is observed through the provider and transcript,
  // not as a second channel response to the actor's reply.
  await wakeSeen;
  expect(residentTexts.filter((text) => text.includes("please ask alice"))).toHaveLength(1);
  expect(residentTexts.filter((text) => text.includes("bob butting in"))).toHaveLength(1);
  expect(residentTexts.filter((text) => text.includes("delegation ") && text.includes(" settled:"))).toHaveLength(1);
  if (ownerSessionId === undefined) throw new Error("owner session was not materialized");
  expect(Session.getMessages(ownerSessionId).some((entry) => entry.role === "user" && entry.agent === "system")).toBe(true);

  owner.close();
  alice.close();
  bob.close();
});
