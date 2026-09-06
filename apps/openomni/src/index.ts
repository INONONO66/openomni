import { AsyncResource } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";
import { configuredCompaction } from "./compaction/strategy";
import { seedKernelPolicyRows } from "./policy-seed";
import {
  type ChatAgentConfig,
  closeSessions,
  type SessionRuntime,
  getSessionHandle,
  ExecutionApprovalError,
  sweepSessions,
	wakeSession,
} from "@openomni/agent";
import {
  type ChannelDeliveryRoute,
  type GatewayRouter,
  WaitService,
  WebSocketHandler,
} from "@openomni/channels";
import { homedir } from "node:os";
import {
  ActorRegistry,
  ApprovalStore,
  ChannelInstanceStore,
  initialize,
  PersonStore,
  SecretStore,
	SessionHandleStore,
  Storage,
} from "@openomni/ledger";

import { createMachineHost, type MachineHost } from "@openomni/machines";
import type { Placement } from "@openomni/placement";
import type { Channel } from "@openomni/protocol";
import { Bus, newTraceId } from "@openomni/agent";
import { desiredChannels, materializePersons } from "./provisioning/declared";
import { type ChannelSupervisor, createChannelSupervisor } from "./provisioning/supervisor";
import { resolveKek } from "./provisioning/vault-key";
import type { ProvisionPort } from "./tools/mutation/provision";
import {
  assertWsExposure,
  loadConfig,
  modelTransport,
  type OpenOmniConfig,
  type RegisteredActor,
} from "./config";
import { createLlmToolPort } from "./tools/execution/llm";
import { processEntryPath } from "./process-entry-path";
import { createProcessSessionTransport } from "./composition/process-session";
import { commitMessageInbox, prepareMessage } from "./composition/message-session";
import { commitTerminalMessage } from "./composition/terminal-message";
import { createMountedChannelGrantRegistrar, createResidentGateway } from "./gateway";
import { createComposer, rollbackToCause } from "./composition/composer";
import { createResident } from "./resident";
import { HOST_TARGET } from "@openomni/agent";
import { composeCodemode } from "./composition/codemode";

interface StartOptions {
  readonly sessionRuntime?: Pick<
    SessionRuntime,
    "clock" | "approvalTimeoutMs" | "scheduleApprovalTimeout" | "waitRetry" | "openIntent"
  >;
  readonly config?: OpenOmniConfig;
  readonly llm?: ChatAgentConfig["llm"];
  readonly toolDefinitions?: readonly import("@openomni/protocol").AnyToolDefinition[];
}

/**
 * The targets a turn may place tools on: the brain, plus every enrolled
 * machine that is attached right now, each reduced to what it may actually
 * do. Reading attachment per turn is what makes a machine that connects
 * between two messages offerable on the second one.
 */
function attachedTargets(
  host: MachineHost | undefined,
): readonly Placement.ToolTarget[] {
  if (host === undefined) return [HOST_TARGET];
  const machines = host.list().map((entry): Placement.ToolTarget => ({ kind: "machine", id: entry.machineId, capabilities: entry.capabilities }));
  return [HOST_TARGET, ...machines];
}

/**
 * Owner-admitted delegation targets, recorded as durable identity facts.
 * Registration is an upsert, so a restart re-asserting the same actors is a
 * no-op — which is also why this is not a composer effect: durable facts are
 * history, not runtime handles.
 */
function registerActors(actors: readonly RegisteredActor[]): void {
  for (const actor of actors) {
    ActorRegistry.registerIdentity({
      id: actor.actorId,
      kind: actor.kind,
      trustTier: actor.trustTier,
      ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
    });
    const channel = actor.channel ?? "ws";
    ActorRegistry.registerEndpoint({
      id: `${channel}:${actor.externalId}`,
      actorId: actor.actorId,
      channel,
      externalId: actor.externalId,
    });
  }
}

/**
 * The app's HTTP surface: the ws upgrade seam, unauthenticated liveness (no
 * clock, no version, no state), and — only when a GitHub channel is composed —
 * its webhook ingress. Everything else is 404. The webhook handler is read
 * live from the supervisor's table so a channel_declare landing a GitHub
 * instance mid-run is reachable without rebinding the server.
 */
function createHttpRoutes(
  wsHandler: WebSocketHandler,
  githubWebhookHandler: () => ((request: Request) => Promise<Response>) | undefined,
) {
  return (
    request: Request,
    bunServer: Parameters<WebSocketHandler["handleUpgrade"]>[1],
  ): Response | Promise<Response> | undefined => {
    const url = new URL(request.url);
    if (request.headers.get("upgrade") === "websocket" && url.pathname === "/ws") {
      // undefined = the upgrade succeeded; a Response = the upgrade was denied.
      return wsHandler.handleUpgrade(request, bunServer);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/github/webhook") {
      const handler = githubWebhookHandler();
      if (handler !== undefined) return handler(request);
    }
    return new Response("Not found", { status: 404 });
  };
}

export async function startOpenOmni(options: StartOptions = {}) {
  const config = options.config ?? loadConfig();
  assertWsExposure(config);
  // One resolution of the operator's endpoint and headers, shared by every
  // model caller this composition builds.
  const transport = modelTransport(config.model);
  // Every stage whose teardown matters is mounted on the composer: boot
  // rollback and shutdown are the same reverse-order release, owned by the
  // stage that acquired the thing rather than restated by hand in two places.
  const composer = createComposer();
	const doorbell = new AsyncResource("session-inbox");
  try {
    await composer.mount("journal", (ctx) => {
      initialize({ dbPath: config.dbPath, observationSink: Bus });
      seedKernelPolicyRows();
      ctx.effect(() => Storage.reset());
    });

    const sessionRuntime: SessionRuntime = {
      ...options.sessionRuntime,
			commitTerminal: commitTerminalMessage((...args) => messages.ingest(...args), options.sessionRuntime?.clock ?? Date.now),
      observations: Bus,
			onInboxCommitted: (ids) => { for (const id of ids) doorbell.runInAsyncScope(() => { void wake(id); }); },
      async authorizeApproval(credential, request) {
        const expected = Buffer.from(config.wsToken ?? "");
        const presented = Buffer.from(credential);
        if (
          expected.length === 0 ||
          presented.length !== expected.length ||
          !timingSafeEqual(presented, expected)
        ) {
          throw new ExecutionApprovalError("unauthenticated");
        }
        return { kind: "owner", principalId: "owner", evidenceId: `ws-owner:${request.id}` };
      },
    };
    await composer.mount("session.handles", (ctx) => {
      ctx.effect(() => closeSessions(sessionRuntime));
    });
    const actors: readonly RegisteredActor[] = config.actors ?? [];
    registerActors(actors);
    // Declared Person manifests materialize alongside env actors — both are
    // idempotent identity upserts; the provisioning store is the durable one.
    materializePersons();

    let gateway: GatewayRouter | undefined;
		const messages = {
			ingest: (...args: Parameters<GatewayRouter["ingest"]>) => {
				if (gateway === undefined) throw new Error("gateway is not composed");
				return gateway.ingest(...args);
      },
    };
    // The catalog's approval lane (§6): Owner-consent requests plus the two
    // acts they authorize — promotion and cross-channel endpoint merge.
    // Provisioning administration port: the supervisor is created after the
    // Resident (it needs the routing handler), so the port reaches it through
    // a late binding — tools cannot run before composition finishes anyway.
    let channelSupervisor: ChannelSupervisor | undefined;
    const liveSupervisor = (): ChannelSupervisor => {
      if (channelSupervisor === undefined)
        throw new Error("provisioning used before composition finished");
      return channelSupervisor;
    };
    const provisioningPort: ProvisionPort = {
      persons: PersonStore,
      instances: ChannelInstanceStore,
      secrets: SecretStore,
      kek: resolveKek(process.env, homedir()),
      supervisor: {
        reconcile: () => liveSupervisor().reconcile(),
        resume: (instanceId) => liveSupervisor().resume(instanceId),
        status: () => liveSupervisor().status(),
        source: () => liveSupervisor().source(),
      },
      approvals: {
        request: ApprovalStore.request,
        get: ApprovalStore.get,
        decision: ApprovalStore.decision,
      },
      materialize: materializePersons,
      removeIdentity: ActorRegistry.removeIdentity,
    };
    const approvalPort = {
      request: ApprovalStore.request,
      get: ApprovalStore.get,
      decide: ApprovalStore.decide,
      decision: ApprovalStore.decision,
      getIdentity: ActorRegistry.getIdentity,
      getEndpoint: ActorRegistry.getEndpoint,
      promote: ActorRegistry.promote,
      mergeEndpoint: ActorRegistry.mergeEndpoint,
    };
    // The cell door is bound per cell rather than globally, so a cell serves
    // exactly the tools its own dispatcher holds.
    let cells: ReturnType<typeof composeCodemode> | undefined;
    const machines = config.machines;
    const host: MachineHost | undefined =
      machines === undefined
        ? undefined
        : await createMachineHost({
            socketPath: machines.socketPath,
            enrollment: (machineId) => machines.enrolled.find((e) => e.machineId === machineId),
            events: Bus,
            now: () => Date.now(),
            callTool: (call) => cells === undefined ? Promise.resolve({ status: "failed", error: "codemode is not composed" }) : cells.callTool(call),
          });
    if (host !== undefined) {
      const attachedHost = host;
      await composer.mount("machines", (ctx) => ctx.effect(() => attachedHost.close()));
    }

    // Self-referential: a cell's catalog is the same one that dispatches cells,
    // and placement subtracts what a cell cannot reach.
    const llmPort = createLlmToolPort(
      { ...config.model, ...(transport === undefined ? {} : { transport }) },
      options.llm ?? {},
    );
    if (host !== undefined) {
      cells = composeCodemode(host);
      const composed = cells;
      await composer.mount("codemode", (ctx) => ctx.effect(() => composed.close()));
    }

		const resident = createResident({
      toolDefinitions: options.toolDefinitions,
      model: config.model,
      ...(config.model.fallbacks === undefined ? {} : { modelFallbacks: config.model.fallbacks }),
      apiKey: config.model.apiKey,
      ...(transport === undefined ? {} : { transport }),
      compaction: configuredCompaction(config, options.llm ?? {}),
      tools: {
				messages,
        ...(cells === undefined ? {} : { cells }),
        llm: llmPort,
        approvals: approvalPort,
        provisioning: provisioningPort,
      },
      targets: () => attachedTargets(host),
      sessionRuntime,
      ...(options.llm === undefined ? {} : { llm: options.llm }),
    });

		const routingHandler: Channel.MessageHandler = async ({ sender, facts }) => {
			await messages.ingest(sender, facts);
    };
    let wsHandler: WebSocketHandler | undefined;
		const wsRoute = async (externalId: string, body: string, idempotencyKey: string) => {
      if (wsHandler === undefined) throw new Error("ws delivery used before composition finished");
			return wsHandler.push(externalId, body, idempotencyKey);
    };
    // Live table: channel components register and revoke their own outbound
    // routes while the gateway keeps reading it per delivery.
    const deliveryRoutes = new Map<string, ChannelDeliveryRoute>();
    deliveryRoutes.set("ws", wsRoute);
    // One runtime owner for external channels (provisioning §5): boot
    // reconcile and every tool-driven mutation run the SAME diff — any
    // declared ChannelInstance shadows env channel config entirely (§8.1).
    const webhookHandlers = new Map<string, (request: Request) => Promise<Response>>();
    const supervisor = createChannelSupervisor({
      desired: () => desiredChannels(config),
      build: (component) => component.build(routingHandler),
      // The tier is the row's, never this call site's: mounting a named
      // surface materializes no owner authority (#931).
      grant: createMountedChannelGrantRegistrar(config.channelAllowedSenders),
      deliveryRoutes,
      webhookHandlers,
      traceId: newTraceId,
    });
    channelSupervisor = supervisor;
		const processSessions = createProcessSessionTransport({
			command: [process.execPath, processEntryPath(import.meta.url)],
			worker: {
				dbPath: config.dbPath, model: config.model, apiKey: config.model.apiKey,
				...(transport === undefined ? {} : { transport })
          },
			committed: (ids) => { for (const id of ids) doorbell.runInAsyncScope(() => { void wake(id); }); },
		});
		await composer.mount("session.processes", (ctx) => ctx.effect(() => processSessions.close()));
		const wake = (id: string) => {
			const row = SessionHandleStore.row(id);
			const runner = SessionHandleStore.latestGeneration(SessionHandleStore.tree(id))
				.systemBlocks.find((block) => block.id === "runner" && block.source === "app:runner")?.content;
			return runner === "process" ? processSessions.wake(id)
				: wakeSession(id, resident.runnerFor(row), sessionRuntime);
		};
		gateway = createResidentGateway({
			inbox: { commit: commitMessageInbox },
			prepare: prepareMessage(resident.materialize),
			armDeadline: SessionHandleStore.armMessageDeadline,
			committed: (row) => { doorbell.runInAsyncScope(() => { void wake(row.sessionId); }); },
			clock: sessionRuntime.clock,
		}, {
			deliveryRoutes,
			grants: () => SessionHandleStore.listRows().filter((row) => row.role === "resident")
				.flatMap((row) => actors.map((actor) => ({
					id: `${row.id}->${actor.actorId}`, senderId: row.id,
					targetActorId: actor.actorId, operations: ["awaited" as const, "fire_and_forget" as const],
				}))),
			budgets: () => config.socialBudgets ?? [],
			replyGrantRules: () => SessionHandleStore.listRows().filter((row) => row.role === "resident")
				.flatMap((row) => [...deliveryRoutes.keys()].map((surface) => ({
					id: `reply:${row.id}:${surface}`, senderId: row.id, surface,
					operations: ["fire_and_forget" as const, "awaited" as const],
					instanceTtlMs: 86_400_000, maxLiveInstances: 64, createdBy: "resident",
				}))),
		});
		WaitService.sweepExpired(newTraceId(), Bus.publish);
		for (const id of SessionHandleStore.expireMessageDeadlines((sessionRuntime.clock ?? Date.now)())) await wake(id);
		await sweepSessions(resident.runnerFor, sessionRuntime);

    await composer.mount("channels", async (ctx) => {
      ctx.effect(() => supervisor.stopAll());
      await supervisor.reconcile();
    });

    wsHandler = new WebSocketHandler(
      routingHandler,
      Bus.publish,
      config.wsToken === undefined ? {} : { token: config.wsToken },
    );

    const server = Bun.serve({
      hostname: config.host,
      port: config.wsPort,
      websocket: wsHandler.ws,
      fetch: createHttpRoutes(wsHandler, () => webhookHandlers.get("github")),
    });

    if (server.port === undefined) throw new Error("OpenOmni ws server did not bind a TCP port");
    const boundServer = server;
    const boundPort: number = server.port;
    await composer.mount("ws.server", (ctx) => {
      // Initiate the graceful stop without awaiting it: Bun resolves this
      // promise only after every open client connection closes, and shutdown
      // must not wait on clients (the pre-composer stop never did).
      ctx.effect(() => {
        void boundServer.stop();
      });
    });
    return {
      port: boundPort,
			gateway,
      sessions: { get: (id: string) => getSessionHandle(id, sessionRuntime) },
      // The boot's honest channel record: where config came from and why each
      // declared row did or did not mount (provision_status reads this later).
      channels: { source: liveSupervisor().source(), statuses: liveSupervisor().status() },
      // Shutdown is the same reverse-order release boot rollback uses: the
      // composer owns the sequence, so a new stage cannot leak by forgetting
      // a line here.
      stop: () => composer.dispose(),
    };
  } catch (error) {
    // Fail-closed boot rollback leaves no armed kernel timer or configured
    // storage behind, so a later boot starts clean.
    return rollbackToCause(composer, error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Entry-point shutdown wiring, extracted behind seams so tests can drive it
 * deterministically. The handler awaits the full async stop before any exit.
 */
export function installShutdownHandlers(deps: {
  readonly stop: () => Promise<void>;
  readonly exit: (code: number) => void;
  readonly on: (signal: "SIGINT" | "SIGTERM", handler: () => void) => void;
}): void {
  const handler = () => {
    void deps.stop().then(
      () => deps.exit(0),
      () => deps.exit(1),
    );
  };
  deps.on("SIGINT", handler);
  deps.on("SIGTERM", handler);
}
