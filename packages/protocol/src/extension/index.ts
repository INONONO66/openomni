import { z } from "zod";
import { AgentProfile } from "../agent/index.js";
import { Tool } from "../tool/index.js";
import { Skill } from "../skill/index.js";
import { McpConfig } from "../mcp/index.js";
import { Policy } from "../policy/index.js";
import { BusEvent } from "../bus/index.js";
import { AppConnector } from "../app-connector/index.js";

export namespace Extension {
  export const LifecycleState = z.enum([
    "proposed",
    "approved",
    "staged",
    "installed",
    "enabled",
    "disabled",
    "rolled_back",
    "uninstalled",
    "failed",
  ]);
  export type LifecycleState = z.infer<typeof LifecycleState>;

  export const SurfaceBinding = z.object({
    surfaceId: z.string(),
    adapterType: z.string().optional(),
  });
  export type SurfaceBinding = z.infer<typeof SurfaceBinding>;

  export const Contributes = z.object({
    agents: z.array(AgentProfile.Definition).optional(),
    tools: z.array(Tool.Spec).optional(),
    skills: z.array(Skill.Definition).optional(),
    mcpServers: z.array(McpConfig.ServerConfig).optional(),
    middlewares: z.array(Policy.Definition).optional(),
    surfaces: z.array(SurfaceBinding).optional(),
    appConnectors: z.array(AppConnector.Definition).optional(),
  });
  export type Contributes = z.infer<typeof Contributes>;

  export const Manifest = z.object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    description: z.string(),
    author: z.string().optional(),
    homepage: z.string().optional(),
    contributes: Contributes.optional(),
    permissions: z.array(Policy.Permission).optional(),
    provenance: z
      .object({
        manifestHash: z.string(),
        packageHash: z.string().optional(),
        signedBy: z.string().optional(),
        createdByRunId: z.string().optional(),
        sourceSessionId: z.string().optional(),
      })
      .optional(),
    compatibility: z
      .object({
        openomni: z.string(),
      })
      .optional(),
  });
  export type Manifest = z.infer<typeof Manifest>;

  export const InstallRequest = z.object({
    manifest: Manifest,
    requestedBy: z.string(),
    requestedAt: z.number(),
    reason: z.string().optional(),
  });
  export type InstallRequest = z.infer<typeof InstallRequest>;

  const EventBase = z.object({
    extensionId: z.string(),
    version: z.string(),
    actor: z.string(),
    time: z.number(),
    reason: z.string().optional(),
  });

  export namespace Events {
    export const Proposed = BusEvent.define("extension.proposed", EventBase, {
      visibility: "llm_reason",
    });
    export const Approved = BusEvent.define("extension.approved", EventBase, {
      visibility: "llm_reason",
    });
    export const Staged = BusEvent.define("extension.staged", EventBase, {
      visibility: "internal",
    });
    export const Installed = BusEvent.define("extension.installed", EventBase, {
      visibility: "llm_reason",
    });
    export const Enabled = BusEvent.define("extension.enabled", EventBase, {
      visibility: "llm_reason",
    });
    export const Disabled = BusEvent.define("extension.disabled", EventBase, {
      visibility: "llm_reason",
    });
    export const RolledBack = BusEvent.define(
      "extension.rolled_back",
      EventBase.extend({ fromVersion: z.string() }),
      { visibility: "llm_reason" },
    );
    export const Uninstalled = BusEvent.define("extension.uninstalled", EventBase, {
      visibility: "llm_reason",
    });
    export const Failed = BusEvent.define(
      "extension.failed",
      EventBase.extend({ error: z.string() }),
      { visibility: "llm_reason" },
    );
  }
}
