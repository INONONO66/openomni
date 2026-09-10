import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Bus,
  createDispatcher,
  createExecutor,
  createSessionRequests,
  eraseTool,
  session,
  type SessionRuntime,
} from "@openomni/agent";
import { initialize } from "@openomni/ledger";
import { Gateway, type LedgerSession, type Tool } from "@openomni/protocol";
import { createResidentGateway, type OutboundMessaging } from "../../src/gateway";
import {
  commitMessageInbox,
  messageMaterialization,
  prepareMessage,
} from "../../src/composition/message-session";
import { seedKernelPolicyRows } from "../../src/policy-seed";
import { createSendMessageTool } from "../../src/tools/send-message";
import { dispatchOutboundMessage } from "../../src/composition/terminal-message";
import type { z } from "zod";

/** The model-facing vocabulary is read off the sealed tool, not re-exported for tests. */
type SendMessageInput = z.output<ReturnType<typeof createSendMessageTool>["input"]>;

export function messageFixture(
  role: LedgerSession.Role = "resident",
  messaging?: OutboundMessaging,
  tools: Parameters<typeof messageMaterialization>[0]["tools"] = [],
) {
  const directory = mkdtempSync(join(tmpdir(), "message-policy-"));
  const dbPath = join(directory, "test.sqlite");
  initialize({ dbPath, observationSink: Bus });
  seedKernelPolicyRows();
  const sessionId = "sender";
  const runtime: SessionRuntime = {
    observations: Bus,
    clock: () => 100,
    dispatchOutbound: dispatchOutboundMessage(
      (...args) => gateway.ingest(...args),
      () => 100,
    ),
  };
  const requests = createSessionRequests(runtime);
  const gateway = createResidentGateway(
    {
      clock: runtime.clock,
      requests,
      inbox: { commit: commitMessageInbox },
      prepare: prepareMessage((id, parentId, childRole, runner) =>
        messageMaterialization({
          id,
          parentId,
          role: childRole,
          runner,
          tools,
          preset: "",
          at: 100,
        }),
      ),
    },
    messaging,
  );
  let result: Tool.Result | undefined;
  const handle = session(
    {
      id: sessionId,
      role,
      runner: async (input) => {
        const payload = toolInput(
          Gateway.SendMessage.parse(JSON.parse(input.messages.at(-1)?.text ?? "null")),
        );
        const executor = createExecutor({
          identity: {
            sessionId,
            role,
            parentActionId: input.turnId,
            turnId: input.turnId,
            toolsHash: input.toolsHash,
            toolsGeneration: input.toolsGeneration,
          },
          ledger: input.ledger,
          policy: input.policy,
          observations: Bus,
          clock: () => 100,
          entropy: () => crypto.randomUUID(),
        });
        const dispatcher = createDispatcher(
          [eraseTool(createSendMessageTool(gateway, runtime.clock))],
          { executor },
        );
        result = await dispatcher.execute(
          { id: crypto.randomUUID(), tool: "send_message", input: payload },
          { sessionId, turnId: input.turnId },
        );
        return { kind: "result", text: result.output ?? "" };
      },
    },
    runtime,
  );
  return {
    directory,
    dbPath,
    gateway,
    sessionId,
    requests,
    async send(input: Gateway.SendMessage): Promise<Tool.Result> {
      result = undefined;
      await handle.prompt(JSON.stringify(input));
      if (result === undefined) throw new Error("fixture tool did not execute");
      return result;
    },
  };
}

/**
 * Fixtures speak the gateway contract; the tool speaks the model vocabulary
 * (§3.5). Deadlines are absolute against the fixture clock of 100.
 */
function toolInput(send: Gateway.SendMessage): SendMessageInput {
  return {
    to: send.to.kind === "actor" ? { kind: "contact", id: send.to.actorId } : send.to,
    message: send.content,
    kind: send.type === "message" ? "prompt" : send.type,
    ...(send.replyTo === undefined ? {} : { reply_to: send.replyTo }),
    ...(send.deadline === undefined ? {} : { deadline_ms: send.deadline - 100 }),
  };
}
