import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus, closeSessions, createDispatcher, createExecutor, createSessionRequests, eraseTool, session, type SessionRuntime } from "@openomni/agent";
import { decodeChannelFailure } from "@openomni/channels";
import { createAppLedger } from "../../src/composition/cluster-runtime";
import { Gateway, type LedgerSession, type Tool } from "@openomni/protocol";
import { Effect, Exit, Scope } from "effect";
import { channelRequests, createResidentGateway, type OutboundMessaging } from "../../src/gateway";
import { messageMaterialization, prepareMessage } from "../../src/composition/message-session";
import { localInbox } from "./ledger";
import { dispatchOutboundMessage } from "../../src/composition/terminal-message";
import { allowConfigure, generationServices } from "./generation-services";
import { ToolCatalog } from "@openomni/agent";
import { seedKernelPolicyRows } from "../../src/policy-seed";
import { createSendMessageTool } from "../../src/tools/send-message";
import { runEffect, acquireSyncEffect, runSyncEffect } from "./effect";

/** Owns the native session scope while the test drives durable message deadlines. */
export async function nativeMessageFixture(role: LedgerSession.Role, messaging: OutboundMessaging) {
  const directory = mkdtempSync(join(tmpdir(), "message-policy-"));
  const catalogPath = join(directory, "catalog.sqlite");
  const sessionsDir = join(directory, "sessions");
  const plane = createAppLedger({ catalogPath, sessionsDir, observationSink: Bus });
  seedKernelPolicyRows(plane.catalog.policies);
  const scope = await runEffect(Scope.make());
  const sessionId = "sender";
  const runtime: SessionRuntime = {
    authorizeConfigure: allowConfigure,
    openKernel: plane.openKernel,
    listSessions: plane.listSessions,
    dispatchOutbound: dispatchOutboundMessage((...args) => gateway.ingest(...args), () => 100, plane.openKernel),
  };
  const context = acquireSyncEffect(generationServices({ clock: () => 100, plane }));
  const requests = runSyncEffect(createSessionRequests(runtime).pipe(Effect.provide(context)));
  const gateway = await runEffect(createResidentGateway({
    clock: () => 100,
    requests: channelRequests(requests),
    inbox: { commit: (input) => localInbox(plane, "message-fixture", () => 100)(input).pipe(Effect.mapError(decodeChannelFailure("inbox.commit"))) },
    prepare: prepareMessage(plane, (id, parentId, childRole, runner) => messageMaterialization(() => plane.openKernel(id).currentPolicyGeneration())({ id, parentId, role: childRole, runner, tools: [], preset: "", at: 100 })),
  }, messaging).pipe(Effect.provide(context)));
  let result: Tool.Result | undefined;
  const handle = await runEffect(Scope.provide(session({
    id: sessionId,
    role,
    runner: (input) => Effect.gen(function* () {
      const send = Gateway.SendMessage.parse(JSON.parse(input.messages.at(-1)?.text ?? "null"));
      const executor = yield* createExecutor({
        identity: { sessionId, role, parentActionId: input.turnId, turnId: input.turnId, toolsHash: input.toolsHash, toolsGeneration: input.toolsGeneration },
        ledger: input.ledger,
      });
      const dispatcher = yield* createDispatcher({ executor }).pipe(Effect.provideService(ToolCatalog, { definitions: [eraseTool(createSendMessageTool({ ingest: (...args) => runEffect(gateway.ingest(...args)) }, () => 100))] }));
      result = yield* dispatcher.execute({ id: crypto.randomUUID(), tool: "send_message", input: {
        to: send.to.kind === "actor" ? { kind: "contact", id: send.to.actorId } : send.to,
        message: send.content,
        kind: send.type === "message" ? "prompt" : send.type,
        ...(send.replyTo === undefined ? {} : { reply_to: send.replyTo }),
        ...(send.deadline === undefined ? {} : { deadline_ms: send.deadline - 100 }),
      } }, { sessionId, turnId: input.turnId });
      return { kind: "result" as const, text: result.output ?? "" };
    }),
  }, runtime).pipe(Effect.provide(context)), scope));
  return {
    directory, plane,
    async send(input: Gateway.SendMessage): Promise<Tool.Result> {
      result = undefined;
      await runEffect(handle.prompt(JSON.stringify(input)));
      if (result === undefined) throw new Error("fixture tool did not execute");
      return result;
    },
    async close() {
      await runEffect(closeSessions(runtime).pipe(Effect.provide(context)));
      await runEffect(Scope.close(scope, Exit.void));
    },
  };
}
