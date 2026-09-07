import {
  Bus,
  closeSessions,
  createSessionRequests,
  currentExecutor,
  wakeSession,
  type SessionRuntime,
} from "@openomni/agent";
import { createGatewayRouter } from "@openomni/channels";
import { initialize, SessionHandleStore, Storage } from "@openomni/ledger";
import { Model, type SessionTransition } from "@openomni/protocol";
import { z } from "zod";
import { createLlmToolPort } from "./tools/execution/llm";
import { createResident } from "./resident";
import { commitMessageInbox, prepareMessage } from "./composition/message-session";
import { messageDecisionRules } from "./composition/message-decision";
import { seedKernelPolicyRows } from "./policy-seed";
import { dispatchOutboundMessage, outboundMessage } from "./composition/terminal-message";
import { createProcessReplyChannel } from "./composition/process-replies";

export const ProcessSessionRequest = z
  .object({
    sessionId: z.string().min(1),
    dbPath: z.string().min(1),
    model: Model.Ref,
    apiKey: z.string().min(1),
    transport: z
      .object({
        baseUrl: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ProcessSessionRequest = z.infer<typeof ProcessSessionRequest>;
export const PROCESS_SESSION_NO_REQUEST_EXIT = 78;

export async function serveProcessSession(
  request: ProcessSessionRequest,
  committed: (ids: readonly string[]) => void,
  answer?: (input: SessionTransition.Answer) => Promise<SessionTransition.Resolution>,
): Promise<void> {
  initialize({ dbPath: request.dbPath, observationSink: Bus });
  seedKernelPolicyRows();
  const runtime: SessionRuntime = {
    observations: Bus,
    onInboxCommitted: committed,
    dispatchOutbound: dispatchOutboundMessage((...args) => gateway.ingest(...args), Date.now),
  };
  const messages = {
    ingest: (...args: Parameters<ReturnType<typeof createGatewayRouter>["ingest"]>) =>
      gateway.ingest(...args),
  };
  const resident = createResident({
    model: request.model,
    apiKey: request.apiKey,
    ...(request.transport === undefined ? {} : { transport: request.transport }),
    sessionRuntime: runtime,
    tools: {
      messages,
      llm: createLlmToolPort(
        {
          ...request.model,
          apiKey: request.apiKey,
          ...(request.transport === undefined ? {} : { transport: request.transport }),
        },
        {},
      ),
    },
  });
  const gateway = createGatewayRouter({
    sink: Bus.publish,
    inbox: { commit: commitMessageInbox },
    prepare: prepareMessage(resident.materialize),
    run: async (sender, execution, body) => {
      const result = await (outboundMessage.getStore()?.executor ?? currentExecutor()).run(
        execution,
        body,
      );
      if (sender.kind !== "session") throw new Error("process gateway requires a session sender");
      return { ...result, matchedRuleIds: messageDecisionRules(sender.id, execution) };
    },
    requests: { ...createSessionRequests(runtime), ...(answer === undefined ? {} : { answer }) },
    committed: (row) => committed([row.sessionId]),
  });
  try {
    await wakeSession(
      request.sessionId,
      resident.runnerFor(SessionHandleStore.row(request.sessionId)),
      runtime,
    );
  } finally {
    await closeSessions(runtime);
    Storage.reset();
  }
}

if (import.meta.main) {
  const replies = createProcessReplyChannel(process.stdin, (line) => console.log(line));
  try {
    const line = await replies.first;
    if (line === undefined) process.exit(PROCESS_SESSION_NO_REQUEST_EXIT);
    await serveProcessSession(ProcessSessionRequest.parse(JSON.parse(line)), (sessionIds) =>
      console.log(JSON.stringify({ sessionIds })), replies.answer,
    );
  } finally { replies.close(); }
}
