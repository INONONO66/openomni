import { runEffect } from "./helpers/effect";
import { decodeChannelFailure } from "@openomni/channels";
import { Effect, Either } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Bus } from "@openomni/agent";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import type { SessionTransition } from "@openomni/protocol";
import { runnerTestLayer } from "../../../packages/agent/test/helpers/service-layers";
import { commitMessageInbox } from "../src/composition/message-session";
import { dispatchOutboundMessage } from "../src/composition/terminal-message";
import { seedKernelPolicyRows } from "../src/policy-seed";

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  seedKernelPolicyRows();
  Bus.reset();
});
afterEach(() => {
  Storage.reset();
  Bus.reset();
});

function materialize(id: string) {
  Either.getOrThrowWith(
    Effect.runSync(
      Effect.either(
        SessionHandleStore.materialize({
          id,
          parentId: null,
          role: "resident",
          tools: [],
          system: { preset: "", blocks: [] },
          policyGeneration: SessionHandleStore.currentPolicyGeneration(),
          actionId: `${id}:config`,
          at: 100,
        }),
      ),
    ),
    (error) => error,
  );
}

const message: SessionTransition.OutboundMessage = {
  messageId: "letter",
  sourceSessionId: "child",
  sourceActionId: "terminal",
  destinationSessionId: "parent",
  requestId: "request",
  replyTo: "request",
  terminal: "completed",
  content: "CHILD_RESULT",
  digest: "digest",
};

test("the receiving consumer may only commit the exact outbound letter", async () => {
  materialize("child");
  materialize("parent");
  const dispatch = dispatchOutboundMessage(
    () =>
      Effect.gen(function* () {
        yield* commitMessageInbox({
          id: "different-letter",
          sessionId: message.destinationSessionId,
          kind: "prompt",
          content: message.content,
          origin: { encodingVersion: 1, value: message },
          createdAt: 100,
          parentActionId: null,
        });
        return {
          status: "executed" as const,
          handle: { messageId: "different-letter", target: "parent" },
          delivery: { kind: "session" as const },
        };
      }).pipe(Effect.mapError(decodeChannelFailure("test.inbox"))),
    () => 100,
  );
  const failure = await runEffect(
    Effect.scoped(Effect.flip(
      dispatch({ message, authority: { owner: "runner", fence: 1 } }),
    ).pipe(Effect.provide(runnerTestLayer))),
  );
  expect(failure).toMatchObject({ _tag: "ForeignFailure", operation: "message.outbound" });
  expect(SessionHandleStore.inboxRows("parent")).toEqual([]);
});
