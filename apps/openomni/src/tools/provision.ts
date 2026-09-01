import { createHash } from "node:crypto";
import { ChannelProviders } from "@openomni/channels";
import type {
  ApprovalStore,
  ChannelInstanceStore,
  PersonStore,
  SecretStore,
} from "@openomni/ledger";
import { Vault } from "@openomni/ledger";
import type { Actor, Approval, Provisioning, Tool } from "@openomni/protocol";
import { newTraceId } from "@openomni/telemetry";
import { z } from "zod";
import {
  isRegisteredProvider,
  validateProviderCredential,
  validateProviderSettings,
} from "../channels";
import type { ChannelSupervisor } from "../provisioning/supervisor";
import type { KekResolution } from "../provisioning/vault-key";

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

const TRUST_TIERS = TIER_ORDER as readonly string[];

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
    settings: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
    credential: z
      .record(z.string())
      .optional()
      .describe("Plaintext credential payload; sealed into the vault, never stored bare."),
  })
  .strict();

const INSTANCE_INPUT = z.object({ instanceId: z.string().min(1) }).strict();

const SECRET_ROTATE_INPUT = z
  .object({
    secretId: z.string().min(1),
    credential: z.record(z.string()).describe("Replacement plaintext payload."),
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
): string {
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
    return `person_declare pending: ${requirement} — approval ${record.id} opened (digest ${digest}); the Owner answers with approval_decide, then re-run person_declare with approvalId=${record.id}. Unanswered after ${record.deadline} reads as refused.`;
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

function jsonSchema(shape: Record<string, unknown>, required: readonly string[]): Record<string, unknown> {
  return { type: "object", additionalProperties: false, required, properties: shape };
}

export function personDeclareToolSpec(): Tool.Spec {
  return {
    name: "person_declare",
    description:
      "Upsert a Person manifest (identity + platform endpoint bindings). Tier raises above collaborator and any change to the owner Person open a person_mutation approval pinned to this exact manifest's digest; re-run with the approved approvalId to land it.",
    inputSchema: jsonSchema(
      {
        manifest: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind", "trustTier", "endpoints"],
          properties: {
            id: { type: "string", minLength: 1 },
            displayName: { type: "string", minLength: 1 },
            kind: { type: "string", enum: ["human", "ai_agent", "service"] },
            trustTier: { type: "string", enum: [...TRUST_TIERS] },
            endpoints: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["channel", "externalId"],
                properties: {
                  channel: { type: "string", minLength: 1 },
                  externalId: { type: "string", minLength: 1 },
                  workspace: { type: "string", minLength: 1 },
                },
              },
            },
          },
        },
        approvalId: { type: "string", minLength: 1 },
        timeoutMs: { type: "integer", exclusiveMinimum: 0 },
      },
      ["manifest"],
    ),
    safe: false,
    placement: "host",
  };
}

export function personRemoveToolSpec(): Tool.Spec {
  return {
    name: "person_remove",
    description:
      "Remove a Person manifest and its derived identity. Refuses to remove the sole owner.",
    inputSchema: jsonSchema({ personId: { type: "string", minLength: 1 } }, ["personId"]),
    safe: false,
    placement: "host",
  };
}

export function channelDeclareToolSpec(): Tool.Spec {
  return {
    name: "channel_declare",
    description:
      "Upsert a ChannelInstance declaration. A supplied credential is validated against the provider's schema, sealed into the vault, and referenced — invalid credentials refuse before anything lands. Affected stages bounce immediately.",
    inputSchema: jsonSchema(
      {
        id: { type: "string", minLength: 1 },
        provider: { type: "string", minLength: 1 },
        enabled: { type: "boolean" },
        settings: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
        credential: { type: "object", additionalProperties: { type: "string" } },
      },
      ["id", "provider"],
    ),
    safe: false,
    placement: "host",
  };
}

export function channelEnableToolSpec(): Tool.Spec {
  return {
    name: "channel_enable",
    description:
      "Enable a declared channel and bounce its stage. Also re-arms a breaker-paused instance (the manual resume).",
    inputSchema: jsonSchema({ instanceId: { type: "string", minLength: 1 } }, ["instanceId"]),
    safe: false,
    placement: "host",
  };
}

export function channelDisableToolSpec(): Tool.Spec {
  return {
    name: "channel_disable",
    description: "Disable a declared channel and stop its stage.",
    inputSchema: jsonSchema({ instanceId: { type: "string", minLength: 1 } }, ["instanceId"]),
    safe: false,
    placement: "host",
  };
}

export function secretRotateToolSpec(): Tool.Spec {
  return {
    name: "secret_rotate",
    description:
      "Seal a new credential revision over an existing vault row and bounce every stage referencing it (stop → swap → start).",
    inputSchema: jsonSchema(
      {
        secretId: { type: "string", minLength: 1 },
        credential: { type: "object", additionalProperties: { type: "string" } },
      },
      ["secretId", "credential"],
    ),
    safe: false,
    placement: "host",
  };
}

export function provisionStatusToolSpec(): Tool.Spec {
  return {
    name: "provision_status",
    description:
      "Read-only: where channel truth comes from (declared store vs env), per-instance mount state including vault_locked and paused_by_breaker, and vault lock state.",
    inputSchema: jsonSchema({}, []),
    safe: true,
    placement: "host",
  };
}

function refusal(tool: string, reason: string): string {
  return `${tool} refused: ${reason}`;
}

async function reconcileReport(port: ProvisionPort, act: string): Promise<string> {
  const statuses = await port.supervisor.reconcile();
  const lines = statuses.map((status) => `${status.id} → ${status.state}${status.detail === undefined ? "" : ` (${status.detail})`}`);
  return `${act}\n${lines.length === 0 ? "no channels declared or configured" : lines.join("\n")}`;
}

export function personDeclareToolExecutor(port: ProvisionPort, now: () => number = Date.now) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = PERSON_DECLARE_INPUT.safeParse(rawInput);
    if (!parsed.success) {
      return refusal("person_declare", parsed.error.issues[0]?.message ?? "invalid input");
    }
    const { approvalId, timeoutMs } = parsed.data;
    const { displayName, ...rest } = parsed.data.manifest;
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
      return `person ${person.id} declared (tier ${person.trustTier}, revision ${person.revision})`;
    } catch (error) {
      // §8.8: a second owner surfaces the store's typed owner_exists refusal.
      return refusal("person_declare", error instanceof Error ? error.message : String(error));
    }
  };
}

export function personRemoveToolExecutor(port: ProvisionPort) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = PERSON_REMOVE_INPUT.safeParse(rawInput);
    if (!parsed.success) {
      return refusal("person_remove", parsed.error.issues[0]?.message ?? "invalid input");
    }
    const existing = port.persons.get(parsed.data.personId);
    if (existing === undefined) {
      return refusal("person_remove", `person ${parsed.data.personId} does not exist`);
    }
    if (existing.trustTier === "owner") {
      return refusal("person_remove", "the sole owner Person cannot be removed");
    }
    port.persons.remove(existing.id);
    port.removeIdentity(existing.id);
    return `person ${existing.id} removed`;
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

export function channelDeclareToolExecutor(port: ProvisionPort, now: () => number = Date.now) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = CHANNEL_DECLARE_INPUT.safeParse(rawInput);
    if (!parsed.success) {
      return refusal("channel_declare", parsed.error.issues[0]?.message ?? "invalid input");
    }
    const input = parsed.data;
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
    return reconcileReport(port, `channel ${input.id} declared`);
  };
}

function channelToggleExecutor(port: ProvisionPort, enabled: boolean, now: () => number) {
  const tool = enabled ? "channel_enable" : "channel_disable";
  return async (rawInput: unknown): Promise<string> => {
    const parsed = INSTANCE_INPUT.safeParse(rawInput);
    if (!parsed.success) {
      return refusal(tool, parsed.error.issues[0]?.message ?? "invalid input");
    }
    const existing = port.instances.get(parsed.data.instanceId);
    if (existing === undefined) {
      return refusal(tool, `channel ${parsed.data.instanceId} is not declared`);
    }
    if (enabled) {
      // Manual breaker re-arm (§5): enabling is the operator saying "try again".
      port.supervisor.resume(existing.id);
    }
    port.instances.put({ ...existing, enabled, revision: existing.revision + 1, updatedAt: now() });
    return reconcileReport(port, `channel ${existing.id} ${enabled ? "enabled" : "disabled"}`);
  };
}

export function channelEnableToolExecutor(port: ProvisionPort, now: () => number = Date.now) {
  return channelToggleExecutor(port, true, now);
}

export function channelDisableToolExecutor(port: ProvisionPort, now: () => number = Date.now) {
  return channelToggleExecutor(port, false, now);
}

export function secretRotateToolExecutor(port: ProvisionPort, now: () => number = Date.now) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = SECRET_ROTATE_INPUT.safeParse(rawInput);
    if (!parsed.success) {
      return refusal("secret_rotate", parsed.error.issues[0]?.message ?? "invalid input");
    }
    const existing = port.secrets.get(parsed.data.secretId);
    if (existing === undefined) {
      return refusal("secret_rotate", `secret ${parsed.data.secretId} does not exist`);
    }
    // The rotated payload must still satisfy every consumer's provider schema.
    for (const instance of port.instances.list()) {
      if (instance.credentialRef !== existing.id) continue;
      const invalid = validateProviderCredential(instance.provider, parsed.data.credential);
      if (invalid !== undefined) {
        return refusal("secret_rotate", `${instance.id}: ${invalid}`);
      }
    }
    const sealed = sealCredential(port, existing.id, parsed.data.credential, existing, now());
    if (typeof sealed === "string") return refusal("secret_rotate", sealed);
    port.secrets.put(sealed);
    return reconcileReport(port, `secret ${existing.id} rotated (kek ${sealed.kekId})`);
  };
}

export function provisionStatusToolExecutor(port: ProvisionPort) {
  return async (rawInput: unknown): Promise<string> => {
    const parsed = EMPTY_INPUT.safeParse(rawInput ?? {});
    if (!parsed.success) {
      return refusal("provision_status", "provision_status takes no arguments");
    }
    const vault = port.kek.kind === "locked" ? `vault_locked (${port.kek.reason})` : "vault open";
    const statuses = port.supervisor.status();
    const lines = statuses.map(
      (status) =>
        `${status.id} [${status.surface}] → ${status.state}${status.detail === undefined ? "" : ` (${status.detail})`}`,
    );
    // §4: portal-side switches the credential cannot carry — reported verbatim, never verified here.
    const preconditionLines = [...new Set(statuses.map((status) => status.surface))]
      .filter(isRegisteredProvider)
      .flatMap((surface) =>
        ChannelProviders[surface].preconditions.map(
          (precondition) => `${surface} precondition: ${precondition}`,
        ),
      );
    return [
      `channel source: ${port.supervisor.source()}`,
      vault,
      ...(lines.length === 0 ? ["no channels declared or configured"] : lines),
      ...preconditionLines,
    ].join("\n");
  };
}
