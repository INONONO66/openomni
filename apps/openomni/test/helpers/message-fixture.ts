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
import { createSendMessageTool } from "../../src/tools/send_message";
import { dispatchOutboundMessage } from "../../src/composition/terminal-message";

export function messageFixture(
  role: LedgerSession.Role = "resident",
  messaging?: OutboundMessaging,
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
          tools: [],
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
        const payload = Gateway.SendMessage.parse(
          JSON.parse(input.messages.at(-1)?.text ?? "null"),
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
        const dispatcher = createDispatcher([eraseTool(createSendMessageTool(gateway))], {
          executor,
        });
        result = await dispatcher.execute(
          { id: crypto.randomUUID(), tool: "sendMessage", input: payload },
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
