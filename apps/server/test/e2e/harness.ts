import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGatewayRouter,
  type ChannelDeliveryRoute,
  type GatewayRouter,
} from "@openomni/channels";
import {
  createBrainEngine,
  createEngagementTools,
  createMessageSendTool,
  createToolExecutor,
  ResidentRuntime,
  type NativeTool,
} from "@openomni/openomni";
import { EngagementStore } from "@openomni/ledger";
import type { Gateway, Ingress, Tool } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import type { SeamModel } from "./model-seam";

/**
 * The E2E harness: the REAL gateway router + REAL brain deliver consumer +
 * REAL tool executor (the production `toolExecutorFactory` = `createToolExecutor`),
 * composed exactly as `apps/server/src/bootstrap` wires them. The ONLY fakes
 * are the two legitimate ones the existing composed-pipeline E2E tests use:
 *
 *   1. the OUTBOUND platform delivery route (capturing, no real Telegram/Discord);
 *   2. the model, behind the swappable `SeamModel` seam (stub now, proxy later).
 *
 * Everything authority-bearing — perimeter admission/treatment, session
 * materialization, engagement hydration, the S6 deny-all gate, the send
 * kernel, wait correlation — is the production code path.
 */

const PERSONA = "actor-persona";
const WORKSPACE_ROOT = "/tmp/openomni-e2e-workspace";
const SYSTEM_PROMPT = "You are the resident assistant (E2E harness).";

/**
 * A deterministic, side-effect-free native tool. Read-only tier 0 so it is
 * allowed under a normal (full_access) run and denied fail-closed under an
 * evidence_only run — the S6 gate is the only thing that changes the verdict.
 */
export function probeTool(output: Record<string, unknown> = { probe: "ok" }): NativeTool {
  return {
    spec: {
      name: "probe",
      description: "Deterministic read-only probe used by the E2E harness.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    riskTier: 0,
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    category: "custom",
    async execute(call: Tool.Call): Promise<Tool.Result> {
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        toolName: call.tool,
        output: JSON.stringify(output),
        isError: false,
      };
    },
  };
}

export interface ComposeConfig {
  readonly model: SeamModel;
  /** Send grants for the as-me `message.send` tool (case 4). */
  readonly grants?: readonly Gateway.SenderTargetGrant[];
  /** Fixed tool clock; defaults to a real-future constant. */
  readonly now?: () => number;
  /** Extra native tools to register alongside the bootstrap-shaped set. */
  readonly extraTools?: readonly NativeTool[];
}

export interface Harness {
  readonly router: GatewayRouter;
  /** Captured outbound platform sends (the legitimate delivery fake). */
  readonly outbound: Array<{ externalId: string; body: string }>;
  /** Every `Gateway.Deliver` the router handed the brain, in order. */
  readonly deliveries: Gateway.Deliver[];
  /** Per-run implicit-input context the production factory received. */
  readonly factoryContexts: Array<{ engagementId?: string; actorTrustTier?: string }>;
  readonly personaActorId: string;
}

// A fixed injected clock, safely in the future of the wall clock the wait fold
// reads (expiry is evaluated against Date.now() at reply time).
const DEFAULT_NOW = 5_000_000_000_000;

/**
 * Live-mode wiring: when the proxy model carries a baseURL but no auth file is
 * configured, materialize a proxy auth file and point `OPENOMNI_AUTH_FILE` at
 * it so the real `@openomni/llm` path resolves a proxy credential. A no-op for
 * the stub model, and a no-op when the operator already set an auth file.
 */
function ensureLiveAuth(model: SeamModel): void {
  if (model.kind !== "proxy") return;
  if (process.env.OPENOMNI_AUTH_FILE) return;
  const baseURL = process.env.OPENOMNI_E2E_PROXY_URL;
  if (!baseURL) return;
  const dir = mkdtempSync(join(tmpdir(), "openomni-e2e-auth-"));
  const file = join(dir, "auth.json");
  const apiKey = process.env.OPENOMNI_E2E_PROXY_KEY;
  writeFileSync(
    file,
    JSON.stringify({
      [model.model.provider]: {
        type: "proxy",
        baseURL,
        ...(apiKey === undefined ? {} : { apiKey }),
      },
    }),
    { mode: 0o600 },
  );
  process.env.OPENOMNI_AUTH_FILE = file;
}

/**
 * Composes the production seams around a swappable model. The caller drives it
 * with `router.ingest(...)` and asserts on the capture surfaces.
 */
export function composeHarness(config: ComposeConfig): Harness {
  ensureLiveAuth(config.model);

  const outbound: Array<{ externalId: string; body: string }> = [];
  const deliveries: Gateway.Deliver[] = [];
  const factoryContexts: Array<{ engagementId?: string; actorTrustTier?: string }> = [];
  const now = config.now ?? (() => DEFAULT_NOW);

  // Late-bound so the send tool can reach the router's messaging seam, exactly
  // as bootstrap defers the send port until the router composes.
  let router: GatewayRouter;

  const buildTools = (): NativeTool[] => [
    probeTool(),
    createMessageSendTool({
      send: (input) => router.messaging.send(input),
      personaActorId: PERSONA,
      now,
      activeEngagementId: (sessionId) => {
        const active = EngagementStore.list({
          ownerSessionId: sessionId,
          states: [...EngagementStore.activeStates],
        });
        const [sole, ...rest] = active;
        return rest.length === 0 ? sole?.id : undefined;
      },
    }),
    ...createEngagementTools({ engagements: EngagementStore, now }),
    ...(config.extraTools ?? []),
  ];

  // The production AgentDef shape (mirrors bootstrap's buildResidentAgentDef →
  // buildAgentDefFromEntries): the authority-bearing seam is `toolExecutorFactory`
  // = `createToolExecutor({ tools, config })`, and `permissions` allow-by-default
  // (the execution runtime fails closed on an absent permission). The S6 gate
  // overrides this to deny-all for an evidence_only delivery.
  const agentDef: Ingress.AgentDef = {
    model: config.model.model,
    systemPrompt: SYSTEM_PROMPT,
    tools: buildTools().map((tool) => tool.spec),
    permissions: { action: "tool.call" },
    toolConfig: { workspaceRoot: WORKSPACE_ROOT },
    toolExecutorFactory: (ctx) => {
      factoryContexts.push({
        ...(ctx.engagementId === undefined ? {} : { engagementId: ctx.engagementId }),
        ...(ctx.actorTrustTier === undefined ? {} : { actorTrustTier: ctx.actorTrustTier }),
      });
      return createToolExecutor({ tools: buildTools(), config: { runtime: ctx } });
    },
  };

  const brain = createBrainEngine({
    residentRuntime: ResidentRuntime.create(config.model.residentOptions()),
    externalAgentResolver: async () => agentDef,
  });

  const deliveryRoutes = new Map<string, ChannelDeliveryRoute>([
    [
      "telegram",
      async (externalId, body) => {
        outbound.push({ externalId, body });
        return { externalMessageId: `platform:${outbound.length}` };
      },
    ],
  ]);

  router = createGatewayRouter({
    sink: Bus.publish,
    deliver: async (delivery) => {
      deliveries.push(delivery);
      return brain.deliver(delivery);
    },
    messaging: {
      deliveryRoutes,
      grants: () => config.grants ?? [],
    },
  });

  return { router, outbound, deliveries, factoryContexts, personaActorId: PERSONA };
}
