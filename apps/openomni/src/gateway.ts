import type { MachineHost } from "@openomni/machines";
import type { ComposedCodemode } from "./composition/codemode";
import type { ToolPorts } from "./tools/core/catalog";
import type { createCompletionPort } from "./composition/completion";
import {
  type ChannelDeliveryRoute,
  createGatewayRouter,
  type GatewayRouter,
  type WebSocketHandler,
  type WsConnection,
} from "@openomni/channels";
import { type ChannelError, decodeChannelFailure } from "@openomni/channels";
import { ChannelGrantStore, DecisionFacts, LedgerWrites, type LedgerError } from "@openomni/ledger";
import type { Actor, Gateway } from "@openomni/protocol";
import {
  Bus,
  Clock, Entropy, GenerationLayers, currentInvocation,
  type SessionEntryServices, type BundleDefinitions,
  createSessionRequests,
  currentExecutor,
  ForeignFailure,
  scopeObservation,
} from "@openomni/agent";
import { Gateway as GatewayProtocol } from "@openomni/protocol";
import { configureAuthority } from "./composition/generation-layers";
import { messageDecisionRules } from "./composition/message-decision";
import { createIngressExecutor } from "./composition/ingress-executor";
import { outboundMessage } from "./composition/terminal-message";
import { Cause, Effect, Either, Exit, FiberRef, ManagedRuntime, Option, Scope } from "effect";
import { MonitorRefused, type MonitorPorts } from "./tools/core/monitor-ports";
import {
  AppLifecycleFailure,
  AppLive,
  AppScope,
  type AppRuntime,
  type AppRuntimeOptions,
  type AppServices,
} from "./runtime";

let processRuntime: AppRuntime | undefined;

export function gatewayRuntime(options: AppRuntimeOptions): AppRuntime {
  if (processRuntime !== undefined) return processRuntime;
  const runtime = ManagedRuntime.make(AppLive(options));
  const dispose = runtime.dispose.bind(runtime);
  const disposeEffect = runtime.disposeEffect;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  Object.assign(runtime, {
    disposeEffect: disposeEffect.pipe(Effect.ensuring(Effect.sync(() => {
      disposed = true;
      if (processRuntime === runtime) processRuntime = undefined;
    }))),
    dispose: () => {
      if (disposed) {
        disposal ??= dispose();
        return disposal;
      }
      disposal ??= runAppEffect(runtime, Effect.flatMap(GenerationLayers, (generations) => generations.drain).pipe(
        Effect.mapError((error) => new AppLifecycleFailure({ operation: "shutdown.raw_unsettled", cause: String(error) })),
      )).catch((error: Error) => { disposal = undefined; throw error; }).then(() => dispose().finally(() => {
        if (processRuntime === runtime) processRuntime = undefined;
      }));
      return disposal;
    },
  });
  processRuntime = runtime;
  return runtime;
}

export function runAppEffect<A, E>(
  runtime: AppRuntime,
  effect: Effect.Effect<A, E, AppServices>,
  signal?: AbortSignal,
): Promise<A> {
  return runtime.runPromise(Effect.either(effect), { signal }).then((result) => {
    if (Either.isLeft(result)) throw result.left;
    return result.right;
  });
}

export function acquireAppResource<A, E>(
  runtime: AppRuntime,
  effect: Effect.Effect<A, E, Scope.Scope | AppServices>,
): Promise<A> {
  return runAppEffect(
    runtime,
    Effect.flatMap(AppScope, (scope) => Scope.extend(effect, scope)),
  );
}

export async function runAppBoot<A, E>(
  runtime: AppRuntime,
  effect: Effect.Effect<A, E, AppServices>,
): Promise<A> {
  const exit = await runtime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Option.getOrElse(
    Cause.failureOption(exit.cause),
    () => new AppLifecycleFailure({ operation: "app.boot", cause: Cause.pretty(exit.cause) }),
  );
  console.error("app boot incident", failure);
  await runtime.dispose().catch((disposal: Error) => {
    throw new AggregateError([failure, disposal], "app boot and disposal failed");
  });
  throw failure;
}

export function toolPorts(
  runtime: AppRuntime,
  ports: {
    readonly machines?: MachineHost;
    readonly cells?: ComposedCodemode;
    readonly completion: ReturnType<typeof createCompletionPort>;
    readonly messages: GatewayRouter;
  },
): ToolPorts {
  const cells = ports.cells;
  const machines = ports.machines;
  return {
    alarms: undefined,
    provisioning: undefined,
    clock: Date.now,
    machines:
      machines === undefined
        ? undefined
        : {
            get: (id) => {
              const handle = machines.get(id);
              return {
                fs: {
                  read: (path, window) => runAppEffect(runtime, handle.fs.read(path, window)),
                  write: (path, data) => runAppEffect(runtime, handle.fs.write(path, data)),
                  list: (path) => runAppEffect(runtime, handle.fs.list(path)),
                  stat: (path) => runAppEffect(runtime, handle.fs.stat(path)),
                },
                exec: (cmd, cwd) => runAppEffect(runtime, handle.exec(cmd, cwd)),
              };
            },
          },
    cells:
      cells === undefined
        ? undefined
        : {
            cell: {
              run: (code, tenant, options) =>
                runAppEffect(runtime, cells.cell.run(code, tenant, options), options.signal),
              peek: (id, tenant) => runAppEffect(runtime, cells.cell.peek(id, tenant)),
              stop: (id, tenant) => runAppEffect(runtime, cells.cell.stop(id, tenant)),
            },
          },
    llm: (call) => runAppEffect(runtime, currentInvocation().generation.provide(ports.completion(call))),
    messages: { ingest: (...args) => runAppEffect(runtime, ports.messages.ingest(...args)) },
  };
}

export function webSocketCallbacks(runtime: AppRuntime, handler: WebSocketHandler) {
  return {
    ...handler.ws,
    message(ws: WsConnection, data: string | Buffer): Promise<void> {
      return runtime.runPromise(
        handler.handleFrame(ws.data, data).pipe(
          Effect.match({
            onSuccess: (outcome) => ws.send(JSON.stringify(outcome)),
            onFailure: (error) => ws.send(JSON.stringify({ type: "error", reason: error._tag })),
          }),
        ),
      );
    },
  };
}

export async function createMonitorPorts(runtime: AppRuntime): Promise<MonitorPorts> {
  const { alarms, clock, entropy } = await runAppBoot(
    runtime,
    Effect.gen(function* () {
      return {
        alarms: (yield* LedgerWrites).alarms,
        clock: yield* Clock,
        entropy: yield* Entropy,
      };
    }),
  );
  const execute = <A>(effect: Effect.Effect<A, LedgerError>, signal: AbortSignal): Promise<A> =>
    runtime.runPromise(Effect.either(effect), { signal }).then((result) => {
      if (Either.isLeft(result)) throw new MonitorRefused(result.left);
      return result.right;
    });
  return {
    arm: (input, signal) => execute(alarms.arm(input), signal),
    cancel: (id, sessionId, at, signal) => execute(alarms.cancel(id, sessionId, at), signal),
    rearm: (id, sessionId, at, signal) => execute(alarms.rearm(id, sessionId, at), signal),
    clock: clock.now,
    entropy: entropy.next,
  };
}

/**
 * The tier a named channel surface mounts with when no Owner decision
 * declares one (#931): the least authority the protocol tier vocabulary
 * carries. Mounting is not an authority decision — a surface that merely
 * exists grants the weakest standing there is, and every raise above it is
 * an explicit declaration (`ChannelInstance.grant.defaultTier`).
 */
export const MOUNTED_CHANNEL_DEFAULT_TIER: Actor.TrustTier = "assigned_worker";

/**
 * The one owner-tier decision this app makes (#931): the loopback `ws`
 * bootstrap surface (docs/provisioning-and-providers.md §6), token-gated off
 * loopback by `assertWsExposure`. It is named here so the single call site
 * that holds it is greppable and no other caller can inherit it.
 */
const LOOPBACK_BOOTSTRAP_TIER: Actor.TrustTier = "owner";

/** The authority one surface's trusted-channel grant materializes. */
export interface TrustedChannelGrant {
  readonly surface: string;
  /**
   * The tier senders on this surface resolve to when they carry no registered
   * identity. Always explicit: owner authority exists only where a call site
   * names it (the loopback `ws` bootstrap).
   */
  readonly defaultTier: Actor.TrustTier;
  readonly allowedSenders?: readonly string[];
}

/**
 * Registers the Resident's trusted-channel authority for one surface and
 * returns the revoker. A channel component holds this while mounted: the
 * grant exists exactly as long as the component serves the surface, so an
 * unmounted channel's inbound traffic loses `trusted_channel` treatment and
 * the perimeter refuses it fail-closed. Grants are current authority, not
 * history — revoking one erases no recorded fact.
 */
export function registerTrustedChannelGrant(grant: TrustedChannelGrant): () => void {
  const id = `openomni-resident-${grant.surface}`;
  ChannelGrantStore.put({
    id,
    surface: grant.surface,
    kind: "trusted_channel",
    defaultTier: grant.defaultTier,
    // An allowlisted grant materializes this tier for the listed senders
    // alone — everyone else on the surface finds no grant and is blocked.
    ...(grant.allowedSenders === undefined ? {} : { allowedSenders: [...grant.allowedSenders] }),
    createdBy: "local-owner",
  });
  return () => {
    ChannelGrantStore.remove(id);
  };
}

/**
 * THE grant seam the composition root hands the channel supervisor (#931):
 * the surface's tier is whatever its desired row declared, and the configured
 * allowlist pins the grant to its listed senders (an unlisted surface keeps
 * the open posture). Owner authority cannot enter here — this function names
 * no tier of its own, so no mounted named surface can acquire one.
 */
export function createMountedChannelGrantRegistrar(
  allowedSendersBySurface: Readonly<Record<string, readonly string[]>> | undefined,
): (surfaceId: string, defaultTier: Actor.TrustTier) => () => void {
  return (surfaceId, defaultTier) => {
    const allowedSenders = allowedSendersBySurface?.[surfaceId];
    return registerTrustedChannelGrant({
      surface: surfaceId,
      defaultTier,
      ...(allowedSenders === undefined ? {} : { allowedSenders }),
    });
  };
}

export interface OutboundMessaging {
  readonly deliveryRoutes: ReadonlyMap<string, ChannelDeliveryRoute>;
  readonly grants: () => readonly Gateway.SenderTargetGrant[];
  readonly budgets?: () => readonly Gateway.SocialBudget[];
  readonly replyGrantRules?: () => readonly Gateway.ReplyGrantRule[];
}

export function channelTransaction<A>(
  operation: Effect.Effect<A, ChannelError>,
): Effect.Effect<A, ChannelError> {
  return Effect.try({
    try: () =>
      DecisionFacts.transaction(() =>
        Either.getOrThrowWith(Effect.runSync(Effect.either(operation)), (error) => error),
      ),
    catch: decodeChannelFailure("message.transaction"),
  });
}

export function channelRequests(
  requests: Effect.Effect.Success<ReturnType<typeof createSessionRequests>>,
): Parameters<typeof createGatewayRouter>[0]["requests"] {
  return {
    list: requests.list,
    open: (input) =>
      requests.open(input).pipe(Effect.mapError(decodeChannelFailure("request.open"))),
    answer: (input) =>
      requests.answer(input).pipe(Effect.mapError(decodeChannelFailure("request.answer"))),
    receipt: (input) =>
      requests.receipt(input).pipe(Effect.mapError(decodeChannelFailure("request.receipt"))),
  };
}

export function createResidentGateway(
  ports: Omit<
    Parameters<typeof createGatewayRouter>[0],
    "sink" | "run" | "messaging" | "requests" | "transaction"
  > & {
    readonly requests?: Parameters<typeof createGatewayRouter>[0]["requests"];
  },
  messaging?: OutboundMessaging,
): Effect.Effect<GatewayRouter, import("@openomni/agent").ExecutionError, SessionEntryServices | BundleDefinitions> {
  return Effect.gen(function* () {
    registerTrustedChannelGrant({ surface: "ws", defaultTier: LOOPBACK_BOOTSTRAP_TIER });
    const externalRun = yield* createIngressExecutor();
    const requests = ports.requests ?? channelRequests(yield* createSessionRequests({ authorizeConfigure: configureAuthority(yield* GenerationLayers) }));
    return createGatewayRouter({
      ...ports,
      transaction: channelTransaction,
      requests,
      sink: scopeObservation(Bus, { sessionId: "gateway-ingress" }).publish,
      run: (sender, request, body) =>
        Effect.gen(function* () {
          const execute = (intent: Parameters<typeof body>[0]) =>
            body(intent).pipe(
              Effect.mapError(
                (error) => new ForeignFailure({ operation: "message.body", cause: String(error) }),
              ),
            );
          if (sender.kind === "external") return yield* externalRun(sender, request, execute);
          const outbound = yield* FiberRef.get(outboundMessage);
          const result = yield* (outbound?.executor ?? currentExecutor()).run(request, execute);
          return { ...result, matchedRuleIds: messageDecisionRules(sender.id, request) };
        }).pipe(Effect.mapError(decodeChannelFailure("message.run"))),
      observe: (sender, observation) =>
        scopeObservation(Bus, {
          sessionId: sender.kind === "session" ? sender.id : "gateway-ingress",
        }).publish(GatewayProtocol.MessageObserved, observation),
      ...(messaging === undefined
        ? {}
        : {
            messaging: {
              ...messaging,
              budgets: messaging.budgets ?? (() => []),
            },
          }),
    });
  });
}
