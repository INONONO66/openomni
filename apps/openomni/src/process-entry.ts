import type { Readable } from "node:stream";
import {
  Bus, BundleDefinitions, GenerationLayers,
  closeSessions,
  createSessionRequests,
  currentExecutor,
  ForeignFailure,
  wakeSession,
  type SessionRuntime,
} from "@openomni/agent";
import { createGatewayRouter, decodeChannelFailure } from "@openomni/channels";
import { SessionHandleStore } from "@openomni/ledger";
import { Effect, FiberRef } from "effect";
import { acquireAppResource, channelRequests, channelTransaction, gatewayRuntime, toolPorts } from "./gateway";
import type { AppRuntime } from "./runtime";
import { Model, type SessionTransition } from "@openomni/protocol";
import { z } from "zod";
import { createCompletionPort } from "./composition/completion";
import { configureAuthority } from "./composition/generation-layers";
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

export function serveProcessSession(
  request: ProcessSessionRequest,
  committed: (ids: readonly string[]) => void,
  answer: ((input: SessionTransition.Answer) => Promise<SessionTransition.Resolution>) | undefined,
  appRuntime: AppRuntime,
) {
  return Effect.gen(function* () {
  const bundles = yield* BundleDefinitions;
  const generations = yield* GenerationLayers;
  seedKernelPolicyRows(bundles.select(bundles.names).rows);
  const runtime: SessionRuntime = {
    onInboxCommitted: committed,
    dispatchOutbound: dispatchOutboundMessage((...args) => gateway.ingest(...args), Date.now),
    authorizeConfigure: configureAuthority(generations),
  };
  const messages = {
    ingest: (...args: Parameters<ReturnType<typeof createGatewayRouter>["ingest"]>) =>
      gateway.ingest(...args),
  };
  // The process's one sub-model seam: the configured model's credential and transport, real I/O.
  const llm = createCompletionPort(
    {
      ...request.model,
      apiKey: request.apiKey,
      ...(request.transport === undefined ? {} : { transport: request.transport }),
    },
  );
  const resident = createResident({
    bundles: bundles.names,
    model: request.model,
    apiKey: request.apiKey,
    ...(request.transport === undefined ? {} : { transport: request.transport }),
    sessionRuntime: runtime,
    tools: toolPorts(appRuntime, { messages, completion: llm }),
  });
  yield* generations.initialize(resident.definitions);
  const requests = yield* createSessionRequests(runtime);
  const gateway = createGatewayRouter({
    sink: Bus.publish,
    transaction: channelTransaction,
    inbox: { commit: (input) => commitMessageInbox(input).pipe(Effect.mapError(decodeChannelFailure("message.commit"))) },
    prepare: prepareMessage(resident.materialize),
    run: (sender, execution, body) => Effect.gen(function* () {
      const outbound = yield* FiberRef.get(outboundMessage);
      const result = yield* (outbound?.executor ?? currentExecutor()).run(
        execution,
        (intent) => body(intent).pipe(Effect.mapError((error) => new ForeignFailure({ operation: "message.body", cause: String(error) }))),
      );
      if (sender.kind !== "session") throw new Error("process gateway requires a session sender");
      return { ...result, matchedRuleIds: messageDecisionRules(sender.id, execution) };
    }).pipe(Effect.mapError(decodeChannelFailure("message.run"))),
    requests: { ...channelRequests(requests), ...(answer === undefined ? {} : { answer: (input: SessionTransition.Answer) => Effect.tryPromise({ try: () => answer(input), catch: decodeChannelFailure("process.answer") }) }) },
    committed: (row) => committed([row.sessionId]),
  });
  yield* wakeSession(
    request.sessionId,
    resident.runnerFor(SessionHandleStore.row(request.sessionId)),
    runtime,
  ).pipe(Effect.ensuring(closeSessions(runtime).pipe(Effect.orDie)));
  });
}

export async function runProcessEntry(io: {
  stdin: Readable;
  log: (line: string) => void;
  exit: (code: number) => never;
  gatewayRuntime?: typeof gatewayRuntime;
}): Promise<void> {
  const replies = createProcessReplyChannel(io.stdin, io.log);
  try {
    const line = await replies.first;
    if (line === undefined) io.exit(PROCESS_SESSION_NO_REQUEST_EXIT);
    const request = ProcessSessionRequest.parse(JSON.parse(line));
    const runtime = (io.gatewayRuntime ?? gatewayRuntime)({ dbPath: request.dbPath });
    try {
      await acquireAppResource(runtime, serveProcessSession(
        request,
        (sessionIds) => io.log(JSON.stringify({ sessionIds })),
        replies.answer,
        runtime,
      ));
    } finally {
      await runtime.dispose();
    }
  } finally {
    replies.close();
  }
}

if (import.meta.main) {
  await runProcessEntry({ stdin: process.stdin, log: console.log, exit: process.exit });
}
