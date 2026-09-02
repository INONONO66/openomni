import { createHash } from "node:crypto";
import { ChannelProviders } from "@openomni/channels";
import type {
  ApprovalStore,
  ChannelInstanceStore,
  PersonStore,
  SecretStore,
} from "@openomni/ledger";
import { Vault } from "@openomni/ledger";
import type { Actor, Approval, Provisioning } from "@openomni/protocol";
import { newTraceId } from "@openomni/telemetry";
import { z } from "zod";
import { defineTool, ToolRefused } from "../core/define";
import {
  isRegisteredProvider,
  validateProviderCredential,
  validateProviderSettings,
} from "../../channels";
import type { ChannelRuntimeStatus, ChannelSupervisor } from "../../provisioning/supervisor";
import type { KekResolution } from "../../provisioning/vault-key";

/**
 * Resident-gated provisioning administration
 * (docs/provisioning-and-providers.md §5): each tool is a recorded act on the
 * durable declarations, and every mutation ends in the SAME reconcile the
 * boot runs — declarations change, affected stages bounce. Guard placement:
 * the sole-owner invariant lives in PersonStore (§8.8, one enforcement
 * layer); THIS layer owns the approval-lane guards — tier raises above
 * collaborator and any mutation of the owner Person consume an approved,
 * digest-matched `person_mutation` approval (§8.5, §8.6).
 */

export interface ProvisionPort {
  readonly persons: Pick<typeof PersonStore, "put" | "get" | "list" | "remove">;
  readonly instances: Pick<typeof ChannelInstanceStore, "put" | "get" | "list">;
  readonly secrets: Pick<typeof SecretStore, "put" | "get">;
  /** Boot's KEK resolution: sealing refuses while the vault is locked. */
  readonly kek: KekResolution;
  readonly supervisor: Pick<ChannelSupervisor, "reconcile" | "resume" | "status" | "source">;
  readonly approvals: {
    readonly request: typeof ApprovalStore.request;
    readonly get: (id: string) => Approval.Record | undefined;
    readonly decision: (id: string, at: number) => Approval.State;
  };
  /** Replays Person manifests into actor identity/endpoint facts (boot's materializer). */
  readonly materialize: () => void;
  readonly removeIdentity: (id: string) => boolean;
}

const TIER_ORDER: readonly Actor.TrustTier[] = [
  "assigned_worker",
  "observer",
  "collaborator",
  "manager",
  "co_owner",
  "owner",
];

const tierRank = (tier: Actor.TrustTier): number => TIER_ORDER.indexOf(tier);

const MANIFEST_INPUT = z
  .object({
    id: z.string().min(1).describe("Person id, person:<slug>."),
    displayName: z.string().min(1).optional(),
    kind: z.enum(["human", "ai_agent", "service"]).describe("What this Person is."),
    trustTier: z
      .enum(["owner", "co_owner", "manager", "collaborator", "observer", "assigned_worker"])
      .describe("Standing trust tier for every bound endpoint."),
    endpoints: z
      .array(
        z
          .object({
            channel: z.string().min(1),
            externalId: z.string().min(1),
            workspace: z.string().min(1).optional(),
          })
          .strict(),
      )
      .describe("Platform identities this Person speaks through."),
  })
  .strict();

const PERSON_DECLARE_INPUT = z
  .object({
    manifest: MANIFEST_INPUT,
    approvalId: z
      .string()
      .min(1)
      .optional()
      .describe("Approved person_mutation approval, when the guard requires one."),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Answer window for a guard-opened approval request (default 24h)."),
  })
  .strict();

const PERSON_REMOVE_INPUT = z.object({ personId: z.string().min(1) }).strict();

const CHANNEL_DECLARE_INPUT = z
  .object({
    id: z.string().min(1).describe("Instance id, channel:<provider>:<slug>."),
    provider: z.string().min(1),
    enabled: z.boolean().default(true),
    settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    credential: z
      .record(z.string(), z.string())
      .optional()
      .describe("Plaintext credential payload; sealed into the vault, never stored bare."),
  })
  .strict();

const INSTANCE_INPUT = z.object({ instanceId: z.string().min(1) }).strict();

const SECRET_ROTATE_INPUT = z
  .object({
    secretId: z.string().min(1),
    credential: z.record(z.string(), z.string()).describe("Replacement plaintext payload."),
  })
  .strict();

const EMPTY_INPUT = z.object({}).strict();

type ManifestInput = z.infer<typeof MANIFEST_INPUT>;

type PersonManifest = Omit<ManifestInput, "displayName"> & { readonly displayName: string };

/** Canonical manifest digest: the exact content the Owner approves (§8.6, anti-TOCTOU). */
export function personManifestDigest(input: PersonManifest): string {
  const canonical = JSON.stringify({
    id: input.id,
    displayName: input.displayName,
    kind: input.kind,
    trustTier: input.trustTier,
    endpoints: input.endpoints.map((endpoint) => ({
      channel: endpoint.channel,
      externalId: endpoint.externalId,
      workspace: endpoint.workspace ?? null,
    })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The approval guard (§5): a raise above collaborator — measured against the
 * Person's current tier, so lateral and downward edits stay direct — and ANY
 * mutation touching the reigning owner Person route through the lane.
 */
function approvalRequirement(
  existing: Provisioning.Person | undefined,
  next: PersonManifest,
): string | undefined {
  if (existing?.trustTier === "owner") {
    return "any mutation of the owner Person requires Owner approval (§8.6)";
  }
  const from = existing === undefined ? tierRank("observer") : tierRank(existing.trustTier);
  if (tierRank(next.trustTier) > from && tierRank(next.trustTier) > tierRank("collaborator")) {
    return `raising ${next.id} to ${next.trustTier} requires Owner approval (§8.5)`;
  }
  return undefined;
}

/**
 * §8.13 anti-fatigue bound shared with the approval lane: a guard-opened
 * request storm refuses instead of burying the Owner.
 */
const REQUEST_BOUND = { windowMs: 3_600_000, maxPending: 8 } as const;

const DEFAULT_APPROVAL_TIMEOUT_MS = 86_400_000;

/**
 * The guard opens its own approval request (§5): the digest is computed from
 * the exact manifest being declared, so the Owner approves THIS content —
 * re-running with an edited manifest is a digest-mismatch refusal, never a
 * silent swap (anti-TOCTOU, §8.6).
 */
function openMutationApproval(
  port: ProvisionPort,
  requirement: string,
  manifest: PersonManifest,
  digest: string,
  timeoutMs: number,
  at: number,
): { kind: "pending"; requirement: string; approvalId: string; digest: string; deadline: number } {
  try {
    const record = port.approvals.request(
      {
        id: `approval:${crypto.randomUUID()}`,
        subject: { kind: "person_mutation", personId: manifest.id, manifestDigest: digest },
        deadline: at + timeoutMs,
      },
      REQUEST_BOUND,
      newTraceId(),
      at,
    );
    return {
      kind: "pending",
      requirement,
      approvalId: record.id,
      digest,
      deadline: record.deadline,
    };
  } catch (error) {
    return refusal("person_declare", error instanceof Error ? error.message : String(error));
  }
}

function consumeApproval(
  port: ProvisionPort,
  approvalId: string,
  personId: string,
  digest: string,
  at: number,
): string | undefined {
  const record = port.approvals.get(approvalId);
  if (record === undefined) return `approval ${approvalId} does not exist`;
  if (port.approvals.decision(approvalId, at) !== "approved") {
    return `approval ${approvalId} is not approved — unanswered reads as refused`;
  }
  if (record.subject.kind !== "person_mutation") {
    return `approval ${approvalId} approves a ${record.subject.kind}, not a person_mutation`;
  }
  if (record.subject.personId !== personId) {
    return `approval ${approvalId} names ${record.subject.personId}, not ${personId}`;
  }
  if (record.subject.manifestDigest !== digest) {
    return `approval ${approvalId} approved a different manifest (digest mismatch)`;
  }
  return undefined;
}

function refusal(tool: string, reason: string): never {
  throw new ToolRefused(tool, reason);
}

async function reconcile(port: ProvisionPort): Promise<ChannelRuntimeStatus[]> {
  return port.supervisor.reconcile();
}

function executePersonDeclare(port: ProvisionPort, now: () => number = Date.now) {
  return async (input: z.output<typeof PERSON_DECLARE_INPUT>) => {
    const { approvalId, timeoutMs } = input;
    const { displayName, ...rest } = input.manifest;
    const manifest: PersonManifest = { ...rest, displayName: displayName ?? rest.id };
    const existing = port.persons.get(manifest.id);
    const digest = personManifestDigest(manifest);
    const requirement = approvalRequirement(existing, manifest);
    if (requirement !== undefined) {
      if (approvalId === undefined) {
        return openMutationApproval(
          port,
          requirement,
          manifest,
          digest,
          timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
          now(),
        );
      }
      const rejection = consumeApproval(port, approvalId, manifest.id, digest, now());
      if (rejection !== undefined) return refusal("person_declare", rejection);
    }
    try {
      const person = port.persons.put({
        ...manifest,
        revision: (existing?.revision ?? -1) + 1,
        createdBy: "resident",
        updatedAt: now(),
      });
      port.materialize();
      return {
        kind: "declared" as const,
        id: person.id,
        trustTier: person.trustTier,
        revision: person.revision,
      };
    } catch (error) {
      // §8.8: a second owner surfaces the store's typed owner_exists refusal.
      return refusal("person_declare", error instanceof Error ? error.message : String(error));
    }
  };
}

function executePersonRemove(port: ProvisionPort) {
  return async (input: z.output<typeof PERSON_REMOVE_INPUT>) => {
    const existing = port.persons.get(input.personId);
    if (existing === undefined) {
      return refusal("person_remove", `person ${input.personId} does not exist`);
    }
    if (existing.trustTier === "owner") {
      return refusal("person_remove", "the sole owner Person cannot be removed");
    }
    port.persons.remove(existing.id);
    port.removeIdentity(existing.id);
    return { id: existing.id };
  };
}

function sealCredential(
  port: ProvisionPort,
  secretId: string,
  credential: Record<string, string>,
  existing: Provisioning.Secret | undefined,
  at: number,
): Provisioning.Secret | string {
  if (port.kek.kind === "locked") {
    return `vault is locked (${port.kek.reason}) — cannot seal a credential`;
  }
  const envelope = Vault.seal(new TextEncoder().encode(JSON.stringify(credential)), port.kek.kek);
  return {
    id: secretId,
    ciphertext: envelope.ciphertext,
    wrappedDek: envelope.wrappedDek,
    kekId: envelope.kekId,
    purpose: existing?.purpose ?? "channel_credential",
    createdAt: existing?.createdAt ?? at,
    ...(existing === undefined ? {} : { rotatedAt: at }),
  };
}

function executeChannelDeclare(port: ProvisionPort, now: () => number = Date.now) {
  return async (input: z.output<typeof CHANNEL_DECLARE_INPUT>) => {
    // §4: knobs must parse under the provider's settings declaration before the row lands.
    const badSettings = validateProviderSettings(input.provider, input.settings);
    if (badSettings !== undefined) return refusal("channel_declare", badSettings);
    const existing = port.instances.get(input.id);
    let credentialRef = existing?.credentialRef;
    if (input.credential !== undefined) {
      // §5: the provider schema gates BEFORE any row lands.
      const invalid = validateProviderCredential(input.provider, input.credential);
      if (invalid !== undefined) return refusal("channel_declare", invalid);
      const secretId = credentialRef ?? `secret:${input.id.replaceAll(":", "-")}`;
      const sealed = sealCredential(
        port,
        secretId,
        input.credential,
        port.secrets.get(secretId),
        now(),
      );
      if (typeof sealed === "string") return refusal("channel_declare", sealed);
      port.secrets.put(sealed);
      credentialRef = secretId;
    }
    try {
      port.instances.put({
        id: input.id,
        provider: input.provider,
        enabled: input.enabled,
        settings: input.settings,
        ...(credentialRef === undefined ? {} : { credentialRef }),
        revision: (existing?.revision ?? -1) + 1,
        createdBy: "resident",
        updatedAt: now(),
      });
    } catch (error) {
      return refusal("channel_declare", error instanceof Error ? error.message : String(error));
    }
    return { id: input.id, action: "declared" as const, statuses: await reconcile(port) };
  };
}

function channelToggleExecutor(port: ProvisionPort, enabled: boolean, now: () => number) {
  const tool = enabled ? "channel_enable" : "channel_disable";
  return async (input: z.output<typeof INSTANCE_INPUT>) => {
    const existing = port.instances.get(input.instanceId);
    if (existing === undefined) {
      return refusal(tool, `channel ${input.instanceId} is not declared`);
    }
    if (enabled) {
      // Manual breaker re-arm (§5): enabling is the operator saying "try again".
      port.supervisor.resume(existing.id);
    }
    port.instances.put({ ...existing, enabled, revision: existing.revision + 1, updatedAt: now() });
    return {
      id: existing.id,
      action: enabled ? ("enabled" as const) : ("disabled" as const),
      statuses: await reconcile(port),
    };
  };
}

function executeChannelEnable(port: ProvisionPort, now: () => number = Date.now) {
  return channelToggleExecutor(port, true, now);
}

function executeChannelDisable(port: ProvisionPort, now: () => number = Date.now) {
  return channelToggleExecutor(port, false, now);
}

function executeSecretRotate(port: ProvisionPort, now: () => number = Date.now) {
  return async (input: z.output<typeof SECRET_ROTATE_INPUT>) => {
    const existing = port.secrets.get(input.secretId);
    if (existing === undefined) {
      return refusal("secret_rotate", `secret ${input.secretId} does not exist`);
    }
    // The rotated payload must still satisfy every consumer's provider schema.
    for (const instance of port.instances.list()) {
      if (instance.credentialRef !== existing.id) continue;
      const invalid = validateProviderCredential(instance.provider, input.credential);
      if (invalid !== undefined) {
        return refusal("secret_rotate", `${instance.id}: ${invalid}`);
      }
    }
    const sealed = sealCredential(port, existing.id, input.credential, existing, now());
    if (typeof sealed === "string") return refusal("secret_rotate", sealed);
    port.secrets.put(sealed);
    return { id: existing.id, kekId: sealed.kekId, statuses: await reconcile(port) };
  };
}

function executeProvisionStatus(port: ProvisionPort) {
  return async (_input: z.output<typeof EMPTY_INPUT>) => {
    const statuses = port.supervisor.status();
    const preconditions = [...new Set(statuses.map((status) => status.surface))]
      .filter(isRegisteredProvider)
      .flatMap((surface) =>
        ChannelProviders[surface].preconditions.map((text) => ({ surface, text })),
      );
    return {
      source: port.supervisor.source(),
      vault:
        port.kek.kind === "locked"
          ? { kind: "locked" as const, reason: port.kek.reason }
          : { kind: "open" as const },
      statuses,
      preconditions,
    };
  };
}

const Statuses = z.array(
  z.custom<ChannelRuntimeStatus>((value) => typeof value === "object" && value !== null),
);
export const ProvisionStatusOutput = z
  .object({
    source: z.enum(["declared", "env"]),
    vault: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("open") }).strict(),
      z.object({ kind: z.literal("locked"), reason: z.string() }).strict(),
    ]),
    statuses: Statuses,
    preconditions: z.array(z.object({ surface: z.string(), text: z.string() }).strict()),
  })
  .strict();
function renderProvisionStatus(value: z.output<typeof ProvisionStatusOutput>): string {
  const lines = value.statuses.map(
    (status) =>
      `${status.id} [${status.surface}] → ${status.state}${status.detail === undefined ? "" : ` (${status.detail})`}`,
  );
  return [
    `channel source: ${value.source}`,
    value.vault.kind === "locked" ? `vault_locked (${value.vault.reason})` : "vault open",
    ...(lines.length === 0 ? ["no channels declared or configured"] : lines),
    ...value.preconditions.map(({ surface, text }) => `${surface} precondition: ${text}`),
  ].join("\n");
}
const ProvisionInput = z
  .object({
    op: z.union([
      z.literal("person_declare"),
      z.literal("person_remove"),
      z.literal("channel_declare"),
      z.literal("channel_enable"),
      z.literal("channel_disable"),
      z.literal("secret_rotate"),
      z.literal("status"),
    ]),
    args: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((value, ctx) => {
    const schemas = {
      person_declare: PERSON_DECLARE_INPUT,
      person_remove: PERSON_REMOVE_INPUT,
      channel_declare: CHANNEL_DECLARE_INPUT,
      channel_enable: INSTANCE_INPUT,
      channel_disable: INSTANCE_INPUT,
      secret_rotate: SECRET_ROTATE_INPUT,
      status: EMPTY_INPUT,
    } as const;
    const parsed = schemas[value.op].safeParse(value.args);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({ ...issue, path: ["args", ...issue.path] });
  });
const ProvisionOutput = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null,
);
function statusLines(statuses: readonly ChannelRuntimeStatus[]): string {
  return statuses.length === 0
    ? "no channels declared or configured"
    : statuses
        .map(
          (status) =>
            `${status.id} → ${status.state}${status.detail === undefined ? "" : ` (${status.detail})`}`,
        )
        .join("\n");
}

export function createProvisionTool(port: ProvisionPort) {
  const executors = {
    person_declare: executePersonDeclare(port),
    person_remove: executePersonRemove(port),
    channel_declare: executeChannelDeclare(port),
    channel_enable: executeChannelEnable(port),
    channel_disable: executeChannelDisable(port),
    secret_rotate: executeSecretRotate(port),
    status: executeProvisionStatus(port),
  };
  return defineTool({
    name: "provision",
    category: "mutation",
    description:
      "Administer people, channels, credentials, and provisioning status. Use op=person_declare|person_remove|channel_declare|channel_enable|channel_disable|secret_rotate|status.",
    input: ProvisionInput,
    output: ProvisionOutput,
    visibility: { model: ["resident"], cell: ["resident"] },
    execute: async (input) => {
      switch (input.op) {
        case "person_declare":
          return executors.person_declare(PERSON_DECLARE_INPUT.parse(input.args));
        case "person_remove":
          return executors.person_remove(PERSON_REMOVE_INPUT.parse(input.args));
        case "channel_declare":
          return executors.channel_declare(CHANNEL_DECLARE_INPUT.parse(input.args));
        case "channel_enable":
          return executors.channel_enable(INSTANCE_INPUT.parse(input.args));
        case "channel_disable":
          return executors.channel_disable(INSTANCE_INPUT.parse(input.args));
        case "secret_rotate":
          return executors.secret_rotate(SECRET_ROTATE_INPUT.parse(input.args));
        case "status":
          return executors.status({});
      }
    },
    render: (args, value) => {
      if ("source" in value)
        return renderProvisionStatus(value as z.output<typeof ProvisionStatusOutput>);
      if (args.op === "person_declare" && value.kind === "pending")
        return `person_declare pending: ${String(value.requirement)} — approval ${String(value.approvalId)} opened (digest ${String(value.digest)}); unanswered after ${String(value.deadline)} reads as refused.`;
      if (args.op === "person_declare")
        return `person ${String(value.id)} declared (tier ${String(value.trustTier)}, revision ${String(value.revision)})`;
      if (args.op === "person_remove") return `person ${String(value.id)} removed`;
      if (
        args.op === "channel_declare" ||
        args.op === "channel_enable" ||
        args.op === "channel_disable"
      )
        return `channel ${String(value.id)} ${String(value.action)}\n${statusLines(value.statuses as readonly ChannelRuntimeStatus[])}`;
      if (args.op === "secret_rotate")
        return `secret ${String(value.id)} rotated (kek ${String(value.kekId)})\n${statusLines(value.statuses as readonly ChannelRuntimeStatus[])}`;
      return JSON.stringify(value, null, 2);
    },
  });
}
