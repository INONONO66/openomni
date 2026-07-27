import {
  type Ingress,
  IngressEvent,
  Operational,
  type TraceContext as TraceContextProtocol,
} from "@openomni/protocol";
import { Bus, TraceContext } from "@openomni/session";
import { z } from "zod";
import { resolveTarget, targetKey } from "./target";

interface ResolvableEvent {
  surface: string;
  workspace?: string;
  channel?: string;
  target?: Ingress.Target;
  runtime?: { durableSessionId?: string };
  meta?: Ingress.Meta;
}

const ModelConfigSchema = z
  .object({
    providerID: z.string().min(1),
    modelID: z.string().min(1),
  })
  .strict();
export type IngressModelConfig = z.infer<typeof ModelConfigSchema>;

export interface MessagingSessionInfo {
  readonly id: string;
  readonly parentID?: string;
  readonly title: string;
  readonly model: IngressModelConfig;
  readonly time: { readonly created: number; readonly updated: number };
  readonly workerMeta?: Readonly<Record<string, unknown>>;
}

export type ResidentEffectOutcome =
  | { readonly status: "confirmed"; readonly result: Ingress.IngressResult }
  | { readonly status: "definite_failed" | "unknown"; readonly error: string };

export interface ResidentIngressReceipt {
  readonly requestId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly partId: string;
  readonly effectId: string;
  readonly isNewSession: boolean;
  readonly outcome?: ResidentEffectOutcome;
}

export type MessagingLedgerTransition =
  | {
      readonly kind: "SS-01";
      readonly sessionId: string;
      readonly title: string;
      readonly model: IngressModelConfig;
      readonly openedAt: number;
    }
  | {
      readonly kind: "SS-02";
      readonly sessionId: string;
      readonly parentSessionId: string;
      readonly title: string;
      readonly model: IngressModelConfig;
      readonly workerMeta: Readonly<Record<string, unknown>>;
      readonly openedAt: number;
    }
  | {
      readonly kind: "SF-01";
      readonly surfaceKey: string;
      readonly sessionId: string;
      readonly title: string;
      readonly model: IngressModelConfig;
      readonly openedAt: number;
    }
  | {
      readonly kind: "MS-01";
      readonly sessionId: string;
      readonly event: Ingress.ResolvedInboundEvent;
      readonly messageId: string;
      readonly partId: string;
      readonly text: string;
      readonly model: IngressModelConfig;
      readonly recordedAt: number;
    }
  | {
      readonly kind: "RT-11" | "RT-12";
      readonly requestId: string;
      readonly surfaceKey: string;
      readonly sessionId: string;
      readonly event: Ingress.ResolvedInboundEvent;
      readonly messageId: string;
      readonly partId: string;
      readonly effectId: string;
      readonly text: string;
      readonly title: string;
      readonly model: IngressModelConfig;
      readonly recordedAt: number;
    }
  | {
      readonly kind: "EF-01" | "EF-02" | "EF-03";
      readonly requestId: string;
      readonly sessionId: string;
      readonly effectId: string;
      readonly sourceRef: string;
      readonly outcome: ResidentEffectOutcome;
      readonly settledAt: number;
    }
  | {
      readonly kind: "MS-06";
      readonly sessionId: string;
      readonly messageId: string;
      readonly partId: string;
      readonly role: "assistant";
      readonly text: string;
      readonly model: { readonly provider: string; readonly id: string };
      readonly agent: string;
      readonly recordedAt: number;
    };

export type MessagingLedgerTransitionResult =
  | {
      readonly status: "committed";
      readonly session?: MessagingSessionInfo;
      readonly isNew?: boolean;
      readonly residentReceipt?: ResidentIngressReceipt;
    }
  | {
      readonly status: "rejected";
      readonly code:
        | "head_conflict"
        | "idempotency_mismatch"
        | "not_found"
        | "transition_forbidden";
    };

export type MessagingLedgerQuery =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "surface"; readonly surfaceKey: string }
  | { readonly kind: "transcript"; readonly sessionId: string };

export type MessagingLedgerQueryResult =
  | {
      readonly kind: "session";
      readonly session: MessagingSessionInfo | null;
    }
  | {
      readonly kind: "surface";
      readonly sessionId: string | null;
    }
  | {
      readonly kind: "transcript";
      readonly messages: readonly {
        readonly role: "user" | "assistant";
        readonly parts: readonly { readonly type: string; readonly text?: string }[];
      }[];
    };

/** Product-facing kernel service. Its implementation alone translates these exact SS/SF/MS/RT/EF calls. */
export interface MessagingLedgerService {
  execute(command: MessagingLedgerTransition): Promise<MessagingLedgerTransitionResult>;
  query(request: MessagingLedgerQuery): Promise<MessagingLedgerQueryResult>;
}

let messagingLedgerService: MessagingLedgerService | undefined;

export function configureMessagingLedgerService(service: MessagingLedgerService | undefined): void {
  messagingLedgerService = service;
}

export function requireMessagingLedgerService(): MessagingLedgerService {
  if (messagingLedgerService === undefined) {
    throw new MessagingLedgerServiceError("messaging_kernel_unavailable");
  }
  return messagingLedgerService;
}

export type MessagingLedgerServiceErrorCode =
  | "messaging_kernel_unavailable"
  | "messaging_kernel_rejected"
  | "messaging_projection_invalid"
  | "messaging_session_not_found";

export class MessagingLedgerServiceError extends Error {
  readonly code: MessagingLedgerServiceErrorCode;
  readonly detail?: string;

  constructor(code: MessagingLedgerServiceErrorCode, detail?: string) {
    super(code);
    this.name = "MessagingLedgerServiceError";
    this.code = code;
    this.detail = detail;
  }
}

export function requireCommittedMessagingTransition(
  result: MessagingLedgerTransitionResult,
): Extract<MessagingLedgerTransitionResult, { status: "committed" }> {
  if (result.status === "rejected") {
    throw new MessagingLedgerServiceError("messaging_kernel_rejected", result.code);
  }
  return result;
}

export type IngressModelConfigurationErrorCode = "ingress_model_missing" | "ingress_model_invalid";

export class IngressModelConfigurationError extends Error {
  readonly code: IngressModelConfigurationErrorCode;

  constructor(code: IngressModelConfigurationErrorCode) {
    super(code);
    this.name = "IngressModelConfigurationError";
    this.code = code;
  }
}

export type IngressSessionResolutionErrorCode = "ingress_parent_session_not_found";
export type IngressParentSessionSource = "target" | "actor";

export class IngressSessionResolutionError extends Error {
  readonly code: IngressSessionResolutionErrorCode;
  readonly parentSessionId: string;
  readonly source: IngressParentSessionSource;

  constructor(parentSessionId: string, source: IngressParentSessionSource) {
    super("ingress_parent_session_not_found");
    this.name = "IngressSessionResolutionError";
    this.code = "ingress_parent_session_not_found";
    this.parentSessionId = parentSessionId;
    this.source = source;
  }
}

export function requireIngressModel(
  model: IngressModelConfig | undefined,
  traceContext?: TraceContextProtocol.Type,
): IngressModelConfig {
  const parsed = ModelConfigSchema.safeParse(model);
  if (parsed.success) return parsed.data;

  const code: IngressModelConfigurationErrorCode =
    model === undefined ? "ingress_model_missing" : "ingress_model_invalid";
  Bus.publish(Operational.Error, {
    traceId: traceContext?.traceId ?? crypto.randomUUID(),
    time: Date.now(),
    component: "ingress.session-resolver",
    msg: code,
    error: code,
  });
  throw new IngressModelConfigurationError(code);
}

interface ResolveResult {
  session: MessagingSessionInfo;
  isNew: boolean;
  trace?: TraceContextProtocol.Type;
}

async function querySession(
  service: MessagingLedgerService,
  sessionId: string,
): Promise<MessagingSessionInfo | null> {
  const result = await service.query({ kind: "session", sessionId });
  if (result.kind !== "session") {
    throw new MessagingLedgerServiceError("messaging_projection_invalid");
  }
  return result.session;
}

async function requireSession(
  service: MessagingLedgerService,
  sessionId: string,
): Promise<MessagingSessionInfo> {
  const session = await querySession(service, sessionId);
  if (session === null) {
    throw new MessagingLedgerServiceError("messaging_session_not_found", sessionId);
  }
  return session;
}
export namespace IngressSessionResolver {
  // Explicit non-Resident targets are part of the semantic surface key.
  export function extractSurfaceKey(event: ResolvableEvent): string {
    const parts = [event.surface, event.workspace ?? "", event.channel ?? ""];
    const target = event.target || event.meta?.target ? resolveTarget(event) : undefined;
    if (target && target.kind !== "resident") parts.push("target", targetKey(target));
    if (parts[0]?.length === 0) throw new TypeError("surface key requires a surface");
    return parts.join(":");
  }

  export async function resolve(
    event: ResolvableEvent,
    modelConfig: IngressModelConfig,
    traceContext?: TraceContextProtocol.Type,
  ): Promise<ResolveResult> {
    requireIngressModel(modelConfig, traceContext);
    const service = requireMessagingLedgerService();
    const target = resolveTarget(event);
    let resolved: ResolveResult;

    if (target.kind === "worker") {
      const durableSessionId = event.runtime?.durableSessionId ?? target.sessionId;
      if (!durableSessionId) {
        throw new MessagingLedgerServiceError(
          "messaging_session_not_found",
          "worker ingress requires an authoritative durable session binding",
        );
      }
      resolved = { session: await requireSession(service, durableSessionId), isNew: false };
    } else {
      const durableSessionId = event.runtime?.durableSessionId;
      const surfaceKey = extractSurfaceKey(event);
      const surface = await service.query({ kind: "surface", surfaceKey });
      if (surface.kind !== "surface") {
        throw new MessagingLedgerServiceError("messaging_projection_invalid");
      }
      if (durableSessionId) {
        resolved = { session: await requireSession(service, durableSessionId), isNew: false };
      } else if (surface.sessionId) {
        resolved = { session: await requireSession(service, surface.sessionId), isNew: false };
      } else {
        throw new MessagingLedgerServiceError(
          "messaging_session_not_found",
          "new Resident ingress must be opened by RT-12",
        );
      }
    }

    if (traceContext) {
      Bus.publish(IngressEvent.SessionResolved, {
        traceId: traceContext.traceId,
        sessionId: resolved.session.id,
        isNew: resolved.isNew,
        target: target.kind,
        time: Date.now(),
      });
      return {
        ...resolved,
        trace: TraceContext.child(traceContext, { sessionId: resolved.session.id }),
      };
    }
    return resolved;
  }
}
