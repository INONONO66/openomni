import {
  type ChannelDeliveryRoute,
  createGatewayRouter,
  type GatewayRouter,
} from "@openomni/channels";
import { ChannelGrantStore, LedgerWrites, type LedgerError } from "@openomni/ledger";
import type { Actor, Gateway } from "@openomni/protocol";
import { Bus, createSessionRequests, currentExecutor, scopeObservation } from "@openomni/agent";
import { Gateway as GatewayProtocol } from "@openomni/protocol";
import { messageDecisionRules } from "./composition/message-decision";
import { createIngressExecutor } from "./composition/ingress-executor";
import { outboundMessage } from "./composition/terminal-message";
import { Cause, Effect, Either, Exit, Option } from "effect";
import { MonitorRefused, type MonitorPorts } from "./tools/monitor";
import {
  AppClock,
  AppEntropy,
  AppLifecycleFailure,
  AppLive,
  createAppRuntime,
  type AppRuntime,
  type AppRuntimeOptions,
  type AppServices,
} from "./runtime";

let processRuntime: AppRuntime | undefined;

export function gatewayRuntime(options: AppRuntimeOptions): AppRuntime {
  if (processRuntime !== undefined) return processRuntime;
  const runtime = createAppRuntime(AppLive(options));
  const dispose = runtime.dispose.bind(runtime);
  let disposal: Promise<void> | undefined;
  Object.assign(runtime, {
    dispose: () => {
      disposal ??= dispose().finally(() => {
        if (processRuntime === runtime) processRuntime = undefined;
      });
      return disposal;
    },
  });
  processRuntime = runtime;
  return runtime;
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

export async function createMonitorPorts(runtime: AppRuntime): Promise<MonitorPorts> {
  const { alarms, clock, entropy } = await runAppBoot(
    runtime,
    Effect.gen(function* () {
      return {
        alarms: (yield* LedgerWrites).alarms,
        clock: yield* AppClock,
        entropy: yield* AppEntropy,
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

export function createResidentGateway(
  ports: Omit<
    Parameters<typeof createGatewayRouter>[0],
    "sink" | "run" | "messaging" | "requests"
  > & {
    readonly requests?: Parameters<typeof createGatewayRouter>[0]["requests"];
  },
  messaging?: OutboundMessaging,
): GatewayRouter {
  registerTrustedChannelGrant({ surface: "ws", defaultTier: LOOPBACK_BOOTSTRAP_TIER });
  const externalRun = createIngressExecutor(ports.clock ?? Date.now);
  return createGatewayRouter({
    ...ports,
    requests: ports.requests ?? createSessionRequests({ observations: Bus, clock: ports.clock }),
    sink: scopeObservation(Bus, { sessionId: "gateway-ingress" }).publish,
    run: async (sender, request, body) => {
      if (sender.kind === "external") return externalRun(sender, request, body);
      const result = await (outboundMessage.getStore()?.executor ?? currentExecutor()).run(
        request,
        body,
      );
      return { ...result, matchedRuleIds: messageDecisionRules(sender.id, request) };
    },
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
}
