import { Actor, resolveTarget, type Gateway } from "@openomni/protocol";

export type ActorRecord = Record<string, unknown>;

const workerControlActions = ["spawn", "send", "cancel", "resume", "schedule"] as const;
export type WorkerControlAction = (typeof workerControlActions)[number];

const topLevelTrustTiers = new Set<Actor.TrustTier>(["owner", "co_owner", "manager"]);
const evidenceOnlyTrustTiers = new Set<Actor.TrustTier>(["collaborator", "observer"]);

export const actionLabels: Record<WorkerControlAction, `action.${WorkerControlAction}`> = {
  spawn: "action.spawn",
  send: "action.send",
  cancel: "action.cancel",
  resume: "action.resume",
  schedule: "action.schedule",
};

export function getActor(event: Gateway.DeliveredEvent): ActorRecord | undefined {
  const actor = event.meta?.actor;
  return isRecord(actor) ? actor : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function actorRole(actor: ActorRecord | undefined): string {
  return String(actor?.role ?? actor?.kind ?? actor?.type ?? "").toLowerCase();
}

export function actorTrustTier(actor: ActorRecord | undefined): Actor.TrustTier | undefined {
  const parsed = Actor.TrustTier.safeParse(actor?.trustTier);
  return parsed.success ? parsed.data : undefined;
}

export function getEventAction(event: Gateway.DeliveredEvent): WorkerControlAction | undefined {
  const meta = asRecord(event.meta);
  return (
    normalizeControlAction(meta?.action) ??
    inputAction(meta?.input) ??
    inputAction(event.payload) ??
    inputAction(asRecord(event.payload)?.input)
  );
}

export function isAuthorizedTopLevelActor(event: Gateway.DeliveredEvent): boolean {
  const actor = getActor(event);
  if (!actor) return false;

  const target = resolveTarget(event);
  const role = actorRole(actor);

  const trustTier = actorTrustTier(actor);
  if (trustTier) {
    if (topLevelTrustTiers.has(trustTier)) return true;
    return (
      target.kind === "resident" &&
      event.meta?.inboundTreatment === "evidence_only" &&
      evidenceOnlyTrustTiers.has(trustTier)
    );
  }

  if (role === "resident") return true;
  if (role === "user") return true;
  if (role === "manager") return isTrustedManager(actor);
  if (role === "worker" && target.kind === "resident") return isTrustedManager(actor);

  return false;
}

function normalizeControlAction(value: unknown): WorkerControlAction | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.toLowerCase()) {
    case "spawn":
      return "spawn";
    case "send":
      return "send";
    case "cancel":
      return "cancel";
    case "resume":
      return "resume";
    case "schedule":
      return "schedule";
    default:
      return undefined;
  }
}

function inputAction(input: unknown): WorkerControlAction | undefined {
  const record = asRecord(input);
  return normalizeControlAction(record?.action);
}

function isTrustedManager(actor: ActorRecord): boolean {
  const trustTier = actorTrustTier(actor);
  return trustTier !== undefined && topLevelTrustTiers.has(trustTier);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
