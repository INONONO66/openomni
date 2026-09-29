import type { Readable } from "node:stream";
import {
  Bus, BundleDefinitions, Clock, Entropy, GenerationLayers, ObservationSink,
  closeSessions,
  createSessionRequests,
  createSessionEntityRunTurn,
  currentExecutor,
  decideSessionAdmission,
  ForeignFailure,
  adoptSessionAuthority,
  receivedMessageAction,
  type SessionEntryServices,
  type SessionRuntime,
} from "@openomni/agent";
import { createChannelStores, createGatewayRouter, decodeChannelFailure } from "@openomni/channels";
import { Effect } from "effect";
import {
  acquireAppResource,
  channelRequests,
  channelStoreSource,
  channelTransaction,
  gatewayRuntime,
  toolPorts,
} from "./gateway";
import { AppScope, type AppRuntime } from "./runtime";
import { type Inbox, Model, type SessionTransition } from "@openomni/protocol";
import { z } from "zod";
import { AppLedger, type AppLedgerPlane } from "./composition/cluster-runtime";
import { createCompletionPort } from "./composition/completion";
import { configureAuthority } from "./composition/generation-layers";
import { GATEWAY_INGRESS_SESSION } from "./composition/ingress-executor";
import { createResident } from "./resident";
import { materializeInboxTarget, pendingInboxRow, prepareMessage } from "./composition/message-session";
import { messageDecisionRules } from "./composition/message-decision";
import { seedKernelPolicyRows } from "./policy-seed";
import { dispatchOutboundMessage, outboundMessage } from "./composition/terminal-message";
import { createProcessReplyChannel } from "./composition/process-replies";

export const ProcessSessionRequest = z
  .object({
    sessionId: z.string().min(1),
    catalogPath: z.string().min(1),
    sessionsDir: z.string().min(1),
    entityIdleMs: z.number().int().positive(),
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

/**
 * Direct chain commit of one received message (child-side delivery). The
 * child has no cluster client; an idle destination gets a fence takeover and
 * relies on the parent's `committed` doorbell (stdout) for any further wake
 * (the parent's entity re-adopts on its next activation — the same takeover
 * the fence CAS exists for). A RUNNING destination's live authority is
 * borrowed instead (W5.2 S4, same rule as `requestAuthorityKernel`):
 * stealing a live turn's fence would refuse that turn's own commits
 * mid-flight, and with the delivering RPC acking at the durable boundary
 * there is no redelivery to absorb that refusal — the row lands between the
 * turn's awaits and the turn's continuation drain consumes it.
 */
export function localInboxCommit(plane: AppLedgerPlane, owner: string, clock: () => number) {
  return (input: Inbox.Commit): Effect.Effect<Inbox.Row, ForeignFailure> =>
    Effect.gen(function* () {
      yield* materializeInboxTarget(plane, input, clock);
      const kernel = plane.openKernel(input.sessionId);
      const existing = kernel.actionById(input.id);
      if (existing !== undefined) return pendingInboxRow(input, existing.ordinal);
      const refuse = (error: { readonly _tag: string }) =>
        new ForeignFailure({ operation: "message.commit", cause: error._tag });
      const live = kernel.row(input.sessionId);
      const authority =
        live.state === "running" && live.leaseOwner !== null
          ? { owner: live.leaseOwner, fence: live.leaseFence }
          : {
              owner,
              fence: yield* adoptSessionAuthority(kernel, input.sessionId, owner).pipe(
                Effect.mapError(refuse),
              ),
            };
      const row = kernel.row(input.sessionId);
      const action = receivedMessageAction({ ...input, at: input.createdAt });
      const committed = yield* kernel
        .commit({
          sessionId: input.sessionId,
          owner: authority.owner,
          fence: authority.fence,
          now: clock(),
          expectedRevision: row.revision,
          actions: [action],
          state: row.state,
        })
        .pipe(Effect.mapError(refuse));
      const receipt = committed.receipts[0];
      if (receipt === undefined)
        return yield* new ForeignFailure({ operation: "message.commit", cause: "no receipt" });
      return pendingInboxRow(input, receipt.action.ordinal);
    });
}

export function serveProcessSession(
  request: ProcessSessionRequest,
  committed: (ids: readonly string[]) => void,
  answer: ((input: SessionTransition.Answer) => Promise<SessionTransition.Resolution>) | undefined,
  appRuntime: AppRuntime,
) {
  return Effect.gen(function* () {
  const bundles = yield* BundleDefinitions;
  const generations = yield* GenerationLayers;
  const plane = yield* AppLedger;
  const scope = yield* AppScope;
  const owner = `process:${process.pid}`;
  seedKernelPolicyRows(plane.catalog.policies, bundles.select(bundles.names).rows);
  const runtime: SessionRuntime = {
    openKernel: plane.openKernel,
    listSessions: plane.listSessions,
    processId: owner,
    onInboxCommitted: committed,
    dispatchOutbound: dispatchOutboundMessage(
      (...args) => gateway.ingest(...args),
      Date.now,
      plane.openKernel,
    ),
    authorizeConfigure: configureAuthority(generations, plane.openKernel),
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
    policyGeneration: () =>
      plane.openKernel(GATEWAY_INGRESS_SESSION).currentPolicyGeneration(),
  });
  yield* generations.initialize(resident.definitions);
  const requests = yield* createSessionRequests(runtime);
  const commitInbox = localInboxCommit(plane, owner, Date.now);
  const gateway = createGatewayRouter({
    sink: Bus.publish,
    stores: createChannelStores(channelStoreSource(plane)),
    transaction: channelTransaction(plane.sessionStore(GATEWAY_INGRESS_SESSION).transaction),
    inbox: { commit: (input) => commitInbox(input).pipe(Effect.mapError(decodeChannelFailure("message.commit"))) },
    prepare: prepareMessage(plane, resident.materialize),
    run: (sender, execution, body) => Effect.gen(function* () {
      const outbound = yield* outboundMessage;
      const result = yield* (outbound?.executor ?? currentExecutor()).run(
        execution,
        (intent) => body(intent).pipe(Effect.mapError((error) => new ForeignFailure({ operation: "message.body", cause: String(error) }))),
      );
      if (sender.kind !== "session") throw new Error("process gateway requires a session sender");
      return {
        ...result,
        matchedRuleIds: messageDecisionRules(plane.openKernel(sender.id), sender.id, execution),
      };
    }).pipe(Effect.mapError(decodeChannelFailure("message.run"))),
    requests: { ...channelRequests(requests), ...(answer === undefined ? {} : { answer: (input: SessionTransition.Answer) => Effect.tryPromise({ try: () => answer(input), catch: decodeChannelFailure("process.answer") }) }) },
    committed: (row) => committed([row.sessionId]),
  });
  // The child's one-shot drain (the entity's backlog loop, minus the mailbox):
  // adopt the fence once, then run admitted decisions until the chain says stop.
  const resolved: Parameters<typeof createSessionEntityRunTurn>[1] = {
    ...runtime,
    clock: (yield* Clock).now,
    entropy: (yield* Entropy).next,
    observations: yield* ObservationSink,
    generations,
    services: yield* Effect.context<SessionEntryServices>(),
  };
  const kernel = plane.openKernel(request.sessionId);
  const runTurn = createSessionEntityRunTurn(
    resident.runnerFor(kernel.row(request.sessionId)),
    resolved,
    scope,
  );
  const drain = Effect.gen(function* () {
    const fence = yield* adoptSessionAuthority(kernel, request.sessionId, owner).pipe(
      Effect.mapError((error) => new ForeignFailure({ operation: "process.adopt", cause: error._tag })),
    );
    const authority = { sessionId: request.sessionId, owner, fence };
    for (;;) {
      const row = kernel.row(request.sessionId);
      const open = kernel.latestOpenTurn(request.sessionId);
      const terminal = kernel.latestTurnTerminal(request.sessionId);
      const snapshot = {
        row,
        pending: kernel.pendingMessages(request.sessionId),
        ...(open === undefined ? {} : { open }),
        ...(terminal === undefined ? {} : { terminal }),
      };
      const decision = decideSessionAdmission(snapshot);
      switch (decision.kind) {
        case "stop":
        case "refused":
          return;
        case "consume":
          // The consume fold (`<id>:delivery` records) is entity-owned; a child
          // hitting it hands the backlog back to the parent's next activation.
          console.error(`process drain deferred consume: ${request.sessionId}`);
          return;
        case "start":
          // Inline detach: this drain owns the whole turn's lifetime itself.
          yield* runTurn({ authority, kernel, decision: { kind: "start" }, snapshot, detach: (body) => body });
          continue;
        default:
          yield* runTurn({ authority, kernel, decision, snapshot, detach: (body) => body });
          continue;
      }
    }
  });
  yield* drain.pipe(Effect.ensuring(closeSessions(runtime).pipe(Effect.orDie)));
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
    const runtime = (io.gatewayRuntime ?? gatewayRuntime)({
      catalogPath: request.catalogPath,
      sessionsDir: request.sessionsDir,
      // Never the shared catalog: the parent's SingleRunner owns its cluster_* tables.
      clusterStoragePath: ":memory:",
    });
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
