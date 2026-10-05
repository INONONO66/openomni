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
import { type ChannelError, createChannelStores, decodeChannelFailure, type ChannelStoreSource } from "@openomni/channels";
import { Core, type Bundle, Inspect } from "@openomni/agent";
import type { ChannelGrantStore } from "@openomni/channels";
import type { Actor, Gateway, LedgerAction } from "@openomni/protocol";
const Entropy = Core.Entropy;
const GenerationLayers = Core.GenerationLayers;
const ObservationSink = Core.ObservationSink;
const currentInvocation = Core.currentInvocation;
type SessionEntryServices = Core.SessionEntryServices;
const createSessionRequests = Core.createSessionRequests;
const currentExecutor = Core.currentExecutor;
const AgentFailure = Core.AgentFailure;
const scopeObservation = Core.scopeObservation;
const attemptUsage = Inspect.attemptUsage;
const toolWallMs = Inspect.toolWallMs;
import { Gateway as GatewayProtocol, L0Observation, SessionGeneration, type SessionFork, SessionRead } from "@openomni/protocol";
import { configureAuthority } from "./composition/generation-layers";
import { messageDecisionRules } from "./composition/message-decision";
import { createIngressExecutor, GATEWAY_INGRESS_SESSION } from "./composition/ingress-executor";
import { outboundMessage } from "./composition/terminal-message";
import { type Context, Effect, Result, Exit, ManagedRuntime, Scope } from "effect";
import { AppLedger, type AppLedgerPlane } from "./composition/cluster-runtime";
import type { ComposedGeneration } from "./composition/composed";
import { captureNow } from "./composition/platform";
import { createAlarmMonitorPorts } from "./composition/alarm-plane";
import { MonitorRefused, type MonitorPorts } from "./tools/core/watch";
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
  return runtime.runPromise(Effect.result(effect), { signal }).then((result) => {
    if (Result.isFailure(result)) throw result.failure;
    return result.success;
  });
}

export function acquireAppResource<A, E>(
  runtime: AppRuntime,
  effect: Effect.Effect<A, E, Scope.Scope | AppServices>,
): Promise<A> {
  return runAppEffect(
    runtime,
    Effect.flatMap(AppScope, (scope) => Scope.provide(effect, scope)),
  );
}

export async function runAppBoot<A, E>(
  runtime: AppRuntime,
  effect: Effect.Effect<A, E, AppServices>,
): Promise<A> {
  const exit = await runtime.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Core.fromCause(
    exit.cause,
    (cause) => new AppLifecycleFailure({ operation: "app.boot", cause }),
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
    readonly machines?: { readonly host: MachineHost; readonly defaultMachine: string };
    readonly cells?: ComposedCodemode;
    readonly completion: ReturnType<typeof createCompletionPort>;
    readonly messages: GatewayRouter;
    /** Injected clock + id entropy (#1245): required, no ambient Date/crypto. */
    readonly now: () => number;
    readonly id: () => string;
  },
): ToolPorts {
  const cells = ports.cells;
  const machines = ports.machines;
  return {
    alarms: undefined,
    provisioning: undefined,
    clock: ports.now,
    id: ports.id,
    machines:
      machines === undefined
        ? undefined
        : {
            defaultMachine: machines.defaultMachine,
            get: (id) => {
              const handle = machines.host.get(id);
              return {
                fs: {
                  read: (path, window) => runAppEffect(runtime, handle.fs.read(path, window)),
                  write: (path, data) => runAppEffect(runtime, handle.fs.write(path, data)),
                  list: (path) => runAppEffect(runtime, handle.fs.list(path)),
                  stat: (path) => runAppEffect(runtime, handle.fs.stat(path)),
                },
                exec: (cmd, cwd) => runAppEffect(runtime, handle.exec(cmd, cwd)),
                pty: {
                  open: (name, cwd) => runAppEffect(runtime, handle.pty.open(name, cwd)),
                  write: (name, data) => runAppEffect(runtime, handle.pty.write(name, data)),
                  read: (name, options) => runAppEffect(runtime, handle.pty.read(name, options)),
                },
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

/** Phase inputs captured from the kernel BEFORE the final consistency check. */
interface PhaseSources {
  readonly terminal: ReturnType<Core.SessionHandleStore.SessionKernel["latestTurnTerminal"]>;
  readonly latest: ReturnType<Core.SessionHandleStore.SessionKernel["latestAction"]>;
  readonly openTurnIntent: ReturnType<Core.SessionHandleStore.SessionKernel["actionById"]>;
  readonly genesis: ReturnType<Core.SessionHandleStore.SessionKernel["latestAction"]>;
}

/**
 * The emitted phase and when it began. phaseSince is the durable transition
 * that ESTABLISHED the phase: the current open turn's intent for running, the
 * terminal that recorded the interruption or sealed the turn for
 * terminal-derived phases, and genesis for a bare idle session. Never the
 * latest activity or a previous turn's terminal, which would move within one
 * phase or predate the current turn (review r1 finding 6). Pure over facts
 * captured before the final fence/revision consistency check: a fresh kernel
 * read here could pair an old page with a NEWER turn's phase timestamp
 * (review r2 finding 7), so this function reads no kernel at all.
 */
function phaseFacts(
  state: SessionRead.Page["state"],
  sources: PhaseSources,
): { phase: SessionRead.Page["phase"]; phaseSince: number } {
  if (state === "running")
    return { phase: state, phaseSince: sources.openTurnIntent?.ts ?? sources.latest?.ts ?? 0 };
  if (state === "interrupted") {
    const terminal = sources.terminal;
    const sealed = terminal?.effect.kind === "interrupted" ? terminal.action.ts : undefined;
    return { phase: state, phaseSince: sealed ?? sources.latest?.ts ?? 0 };
  }
  if (sources.terminal !== undefined) {
    const phase = sources.terminal.effect.kind === "result" ? "completed"
      : sources.terminal.effect.kind === "error" ? "failed"
      : sources.terminal.effect.kind === "waiting" ? "waiting_input" : "idle";
    return { phase, phaseSince: sources.terminal.action.ts };
  }
  return { phase: "idle", phaseSince: sources.genesis?.ts ?? 0 };
}

/**
 * The history page is one transactional revision snapshot. Session action rows
 * are retained from genesis, so a valid old cursor is always repairable by
 * paging; an epoch change or a cursor ahead of the durable head is a typed gap.
 */
export function readSessionCursor(
  kernel: Core.SessionHandleStore.SessionKernel,
  input: SessionRead.Request,
): SessionRead.Response {
  const frame = SessionRead.Request.parse(input);
  const before = kernel.row(frame.sessionId);
  const afterRevision = frame.cursor?.revision ?? 0;
  if (frame.cursor !== undefined &&
      (frame.cursor.epoch !== before.fence || afterRevision > before.revision)) {
    return {
      type: "session_gap" as const,
      sessionId: frame.sessionId,
      epoch: before.fence,
      headRevision: before.revision,
      oldestRevision: 0,
    };
  }
  const page = kernel.historyPage(frame.sessionId, { afterRevision, limit: frame.limit });
  const terminal = kernel.latestTurnTerminal(frame.sessionId);
  const latest = kernel.latestAction(frame.sessionId);
  // Review r2 finding 7: capture every phase fact BEFORE the final
  // consistency check below. A commit that lands during these reads moves the
  // after-row revision and surfaces as the typed gap; a commit that lands
  // after the check can no longer leak a newer turn's timestamp into this page.
  const openTurn = kernel.latestOpenTurn(frame.sessionId);
  const openTurnIntent = openTurn === undefined ? undefined : kernel.actionById(openTurn.turnId);
  const genesis = kernel.latestAction(frame.sessionId, 1);
  const after = kernel.row(frame.sessionId);
  if (before.fence !== after.fence || before.revision !== page.headRevision ||
      after.revision !== page.headRevision ||
      (page.actions[0] !== undefined && page.actions[0].ordinal !== afterRevision + 1)) {
    return {
      type: "session_gap" as const,
      sessionId: frame.sessionId,
      epoch: after.fence,
      headRevision: after.revision,
      oldestRevision: 0,
    };
  }
  const { phase, phaseSince } = phaseFacts(after.state, { terminal, latest, openTurnIntent, genesis });
  return SessionRead.Page.parse({
    type: frame.cursor === undefined ? "session_snapshot" as const : "session_page" as const,
    sessionId: frame.sessionId,
    state: after.state,
    phase,
    phaseSince,
    epoch: after.fence,
    afterRevision,
    headRevision: page.headRevision,
    nextRevision: page.nextRevision,
    actions: page.actions.map((action) => ({
      revision: action.ordinal,
      actionId: action.id,
      kind: action.kind,
      at: action.ts,
    })),
    usage: attemptUsage(page.actions),
    // Fork ancestry projection (#1257): read off the genesis configure this
    // page already captured; inspect surface only, never model context.
    ancestry: sessionAncestry(after.parentId, genesis),
    toolWallMs: toolWallMs(page.actions.flatMap((action) => {
      if (action.kind !== "tool" || action.parentId === null) return [];
      const effect = action.effect.value;
      if (effect === null || typeof effect !== "object" || Array.isArray(effect) ||
          effect.phase !== "result") return [];
      const intent = kernel.actionById(action.parentId);
      return intent?.kind === "tool" ? [{ start: intent.ts, end: action.ts }] : [];
    })),
  });
}

/** Fork ancestry projection for one page (#1257): genesis pin plus aside text. */
function sessionAncestry(
  parentId: string | null,
  genesis: LedgerAction.Node | undefined,
): NonNullable<SessionRead.Page["ancestry"]> {
  const value = genesis?.kind === "session.configure" ? genesis.intent.value : undefined;
  const holder = value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  const parsed = SessionGeneration.ForkAncestry.safeParse(holder?.forkedFrom);
  const forkedFrom = parsed.success ? parsed.data : null;
  return { parentId, forkedFrom, aside: forkedFrom === null ? null : Inspect.forkAside(forkedFrom) };
}

export function webSocketCallbacks(
  runtime: AppRuntime,
  handler: WebSocketHandler,
  sink: Context.Service.Shape<typeof ObservationSink>,
  openSession?: (sessionId: string) => Core.SessionHandleStore.SessionKernel | undefined,
  fork?: (request: SessionFork.Request) => Effect.Effect<SessionFork.Response>,
) {
  const inflight = new Set<Promise<void>>();
  const readers = new Map<WsConnection, Map<string, () => void>>();
  function read(ws: WsConnection, request: SessionRead.Request): void {
    const subscriptions = readers.get(ws) ?? new Map<string, () => void>();
    readers.set(ws, subscriptions);
    subscriptions.get(request.sessionId)?.();
    let cursor = request.cursor;
    let sentRevision = cursor?.revision ?? 0;
    const send = () => {
      try {
        const kernel = openSession?.(request.sessionId);
        if (kernel === undefined) {
          ws.send(JSON.stringify({ type: "error", reason: "session_not_found", sessionId: request.sessionId }));
          return;
        }
        const response = readSessionCursor(kernel, { ...request, cursor });
        if (response.type !== "session_gap") {
          sentRevision = response.actions.at(-1)?.revision ?? response.afterRevision;
          cursor = { revision: sentRevision, epoch: response.epoch };
        }
        ws.send(JSON.stringify(response));
      } catch {
        ws.send(JSON.stringify({ type: "error", reason: "session_read_failed", sessionId: request.sessionId }));
      }
    };
    // Register before capture; notifications only hint at authoritative reads.
    subscriptions.set(request.sessionId, sink.subscribe(L0Observation.ActionCommittedEvent, (event) => {
      if (event.revision > sentRevision) send();
    }, { match: { sessionId: request.sessionId } }));
    send();
  }
  return {
    callbacks: {
      ...handler.ws,
      close(ws: WsConnection): void {
        for (const stop of readers.get(ws)?.values() ?? []) stop();
        readers.delete(ws);
        handler.ws.close(ws);
      },
      message(ws: WsConnection, data: string | Buffer): Promise<void> {
        const settled = runtime.runPromise(
          handler.handleFrame(ws.data, data).pipe(
            Effect.matchEffect({
              onSuccess: (outcome) => {
                // #1257: the fork program runs on this edge's app runtime (W5.3
                // effect boundary); unavailability is a typed refusal.
                if (!("admitted" in outcome) && outcome.type === "session_fork") {
                  const response =
                    fork?.(outcome) ??
                    Effect.succeed<SessionFork.Response>({
                      type: "session_fork_refused",
                      sessionId: outcome.sessionId,
                      reason: "storage",
                      detail: "fork is not available on this gateway",
                    } satisfies SessionFork.Refused);
                  return Effect.map(response, (frame) => void ws.send(JSON.stringify(frame)));
                }
                return Effect.sync(() => {
                  // A keyless frame is a perimeter refusal (#1245) — report it verbatim.
                  if ("admitted" in outcome) ws.send(JSON.stringify(outcome));
                  else if (outcome.type === "session_read") read(ws, outcome);
                  else ws.send(JSON.stringify(outcome));
                });
              },
              onFailure: (error) =>
                Effect.sync(() => void ws.send(JSON.stringify({ type: "error", reason: error._tag }))),
            }),
          ),
        );
        const tracked: Promise<void> = settled
          .catch(() => undefined)
          .finally(() => void inflight.delete(tracked));
        inflight.add(tracked);
        return settled;
      },
    },
    /**
     * Shutdown join (W5.2): an accepted frame's ingest captures the
     * gateway-ingress generation for the whole ingest, so the generation
     * drain must not start before every in-flight frame has unwound.
     */
    settled(): Promise<void> {
      return Promise.all([...inflight]).then(() => undefined);
    },
  };
}

/** The alarm plane's tool ports: capability verbs over chain facts (#1254). */
export async function createMonitorPorts(
  runtime: AppRuntime,
  capability: Bundle.AlarmCapabilityDefinition,
): Promise<MonitorPorts> {
  const { plane, clock, entropy } = await runAppBoot(
    runtime,
    Effect.gen(function* () {
      return {
        plane: yield* AppLedger,
        clock: yield* captureNow,
        entropy: yield* Entropy,
      };
    }),
  );
  return createAlarmMonitorPorts({
    capability,
    openKernel: plane.openKernel,
    clock,
    entropy: entropy.id,
    run: <A>(effect: Effect.Effect<A, Error>, signal: AbortSignal): Promise<A> =>
      runtime.runPromise(Effect.result(effect), { signal }).then((result) => {
        if (Result.isFailure(result)) throw new MonitorRefused(result.failure);
        return result.success;
      }),
  });
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
export function registerTrustedChannelGrant(
  grants: ChannelGrantStore,
  grant: TrustedChannelGrant,
): () => void {
  const id = `openomni-resident-${grant.surface}`;
  grants.put({
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
    grants.remove(id);
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
  grants: ChannelGrantStore,
  allowedSendersBySurface: Readonly<Record<string, readonly string[]>> | undefined,
): (surfaceId: string, defaultTier: Actor.TrustTier) => () => void {
  return (surfaceId, defaultTier) => {
    const allowedSenders = allowedSendersBySurface?.[surfaceId];
    return registerTrustedChannelGrant(grants, {
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

/** One synchronous ledger unit on the ingress session file (decision facts live there). */
export function channelTransaction(
  run: <T>(operation: () => T) => T,
): <A>(operation: Effect.Effect<A, ChannelError>) => Effect.Effect<A, ChannelError> {
  return (operation) =>
    Effect.try({
      try: () =>
        run(() =>
          Result.getOrThrowWith(Effect.runSync(Effect.result(operation)), (error) => error),
        ),
      catch: decodeChannelFailure("message.transaction"),
    });
}

/** The perimeter's store source over the app plane: catalog adapters plus the ingress session's decision facts. */
export function channelStoreSource(plane: AppLedgerPlane, now: () => number): ChannelStoreSource {
  const ingress = plane.sessionStore(GATEWAY_INGRESS_SESSION);
  return {
    now,
    actorRegistry: plane.catalog.actorRegistry,
    blacklist: plane.catalog.blacklist,
    channelGrant: plane.catalog.channelGrant,
    replyGrant: plane.catalog.replyGrant,
    egressBudget: plane.catalog.egressBudget,
    surfaceKey: plane.catalog.surfaceKey,
    decisionFacts: ingress.decisionFacts,
    transaction: ingress.transaction,
  };
}

export function channelRequests(
  requests: Effect.Success<ReturnType<typeof createSessionRequests>>,
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
): Effect.Effect<GatewayRouter, Core.ExecutionError, SessionEntryServices | ComposedGeneration | AppLedger> {
  return Effect.gen(function* () {
    const plane = yield* AppLedger;
    const observations = yield* ObservationSink;
    const stamp = { now: ports.now, id: ports.id };
    registerTrustedChannelGrant(plane.stores.channelGrants, {
      surface: "ws",
      defaultTier: LOOPBACK_BOOTSTRAP_TIER,
    });
    const externalRun = yield* createIngressExecutor(plane);
    const requests = ports.requests ?? channelRequests(yield* createSessionRequests({ authorizeConfigure: configureAuthority(yield* GenerationLayers, plane.openKernel), openKernel: plane.openKernel, listSessions: plane.listSessions }));
    return createGatewayRouter({
      ...ports,
      stores: ports.stores ?? createChannelStores(channelStoreSource(plane, ports.now)),
      transaction: channelTransaction(plane.sessionStore(GATEWAY_INGRESS_SESSION).transaction),
      requests,
      sink: scopeObservation(observations, { sessionId: "gateway-ingress" }, stamp).publish,
      run: (sender, request, body) =>
        Effect.gen(function* () {
          const execute = (intent: Parameters<typeof body>[0]) =>
            body(intent).pipe(
              Effect.mapError(
                (error) => new AgentFailure({ operation: "message.body", cause: String(error) }),
              ),
            );
          if (sender.kind === "external") return yield* externalRun(sender, request, execute);
          const outbound = yield* outboundMessage;
          const result = yield* (outbound?.executor ?? currentExecutor()).run(request, execute);
          return {
            ...result,
            matchedRuleIds: messageDecisionRules(plane.openKernel(sender.id), sender.id, request),
          };
        }).pipe(Effect.mapError(decodeChannelFailure("message.run"))),
      observe: (sender, observation) =>
        scopeObservation(observations, {
          sessionId: sender.kind === "session" ? sender.id : "gateway-ingress",
        }, stamp).publish(GatewayProtocol.MessageObserved, observation),
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
