import type { Tool } from "@openomni/protocol";

/**
 * Tool specs for the provisioning administration surface — the LLM-facing
 * declarations only; the executors and their guards live in ./provision.
 */

const TRUST_TIERS = [
  "assigned_worker",
  "observer",
  "collaborator",
  "manager",
  "co_owner",
  "owner",
] as const;

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

