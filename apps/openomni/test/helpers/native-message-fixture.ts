import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus, closeSessions, createDispatcher, createExecutor, createSessionRequests, eraseTool, session, type SessionRuntime } from "@openomni/agent";
import { decodeChannelFailure } from "@openomni/channels";
import { initialize } from "@openomni/ledger";
import { Gateway, type LedgerSession, type Tool } from "@openomni/protocol";
import { Effect, Exit, Scope } from "effect";
import { channelRequests, createResidentGateway, type OutboundMessaging } from "../../src/gateway";
import { commitMessageInbox, messageMaterialization, prepareMessage } from "../../src/composition/message-session";
import { dispatchOutboundMessage } from "../../src/composition/terminal-message";
import { seedKernelPolicyRows } from "../../src/policy-seed";
import { createSendMessageTool } from "../../src/tools/send-message";
import { runEffect } from "./effect";

/** Owns the native session scope while the test drives durable message deadlines. */
export async function nativeMessageFixture(role: LedgerSession.Role, messaging: OutboundMessaging) {
  const directory = mkdtempSync(join(tmpdir(), "message-policy-"));
  const dbPath = join(directory, "test.sqlite");
  initialize({ dbPath, observationSink: Bus });
  seedKernelPolicyRows();
  const scope = await runEffect(Scope.make());
  const sessionId = "sender";
  const runtime: SessionRuntime = {
    observations: Bus,
    clock: () => 100,
    dispatchOutbound: dispatchOutboundMessage((...args) => gateway.ingest(...args), () => 100),
  };
  const requests = createSessionRequests(runtime);
  const gateway = await runEffect(createResidentGateway({
    clock: runtime.clock,
    requests: channelRequests(requests),
    inbox: { commit: (input) => commitMessageInbox(input).pipe(Effect.mapError(decodeChannelFailure("inbox.commit"))) },
    prepare: prepareMessage((id, parentId, childRole, runner) => messageMaterialization({ id, parentId, role: childRole, runner, tools: [], preset: "", at: 100 })),
  }, messaging));
  let result: Tool.Result | undefined;
  const handle = await runEffect(Scope.extend(session({
    id: sessionId,
    role,
    runner: (input) => Effect.gen(function* () {
      const send = Gateway.SendMessage.parse(JSON.parse(input.messages.at(-1)?.text ?? "null"));
      const executor = createExecutor({
        identity: { sessionId, role, parentActionId: input.turnId, turnId: input.turnId, toolsHash: input.toolsHash, toolsGeneration: input.toolsGeneration },
        ledger: input.ledger,
        policy: input.policy,
        observations: Bus,
        clock: () => 100,
        entropy: () => crypto.randomUUID(),
      });
      const dispatcher = createDispatcher([eraseTool(createSendMessageTool({ ingest: (...args) => runEffect(gateway.ingest(...args)) }, runtime.clock))], { executor });
      result = yield* dispatcher.execute({ id: crypto.randomUUID(), tool: "send_message", input: {
        to: send.to.kind === "actor" ? { kind: "contact", id: send.to.actorId } : send.to,
        message: send.content,
        kind: send.type === "message" ? "prompt" : send.type,
        ...(send.replyTo === undefined ? {} : { reply_to: send.replyTo }),
        ...(send.deadline === undefined ? {} : { deadline_ms: send.deadline - 100 }),
      } }, { sessionId, turnId: input.turnId });
      return { kind: "result" as const, text: result.output ?? "" };
    }),
  }, runtime), scope));
  return {
    directory, dbPath,
    async send(input: Gateway.SendMessage): Promise<Tool.Result> {
      result = undefined;
      await runEffect(handle.prompt(JSON.stringify(input)));
      if (result === undefined) throw new Error("fixture tool did not execute");
      return result;
    },
    async close() {
      await runEffect(closeSessions(runtime));
      await runEffect(Scope.close(scope, Exit.void));
    },
  };
}
