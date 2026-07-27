import { z } from "zod";
import { AgentProfile } from "../agent/index.js";
import { Ledger } from "../ledger/index.js";
import { Model } from "../model/index.js";
import { Policy } from "../policy/index.js";
import { Token } from "../token/index.js";
import { Tool } from "../tool/index.js";
import { Wait } from "../wait/index.js";
import { Actor } from "../actor/index.js";
import { AppConnector } from "../app-connector/index.js";

const NonEmpty = z.string().min(1);
const Digest = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase SHA-256 digest");
const WorkspaceId = z.string().regex(/^w1:[0-9a-f]{64}$/);
const nativeCommandGroups = {
  SS: [
    "messaging.session.open.v1",
    "messaging.session.open_child.v1",
    "messaging.session.revise_metadata.v1",
    "messaging.session.close.v1",
    "messaging.session.expire.v1",
  ],
  SF: ["messaging.surface.bind.v1", "messaging.surface.rebind.v1", "messaging.surface.unbind.v1"],
  MS: [
    "messaging.message.record_inbound.v1",
    "messaging.message.start_assistant.v1",
    "messaging.message.append_part.v1",
    "messaging.message.revise_part.v1",
    "messaging.message.change_status.v1",
    "messaging.message.finish_assistant.v1",
    "messaging.message.recover.v1",
  ],
  RT: [
    "kernel.route.blacklist_deny.v1",
    "kernel.route.stage_wait_ambiguity.v1",
    "kernel.route.accept_report_result.v1",
    "kernel.route.accept_clarification.v1",
    "kernel.route.accept_wait_response.v1",
    "kernel.route.unsupported_action.v1",
    "kernel.route.missing_system_identity.v1",
    "kernel.route.missing_channel_grant.v1",
    "kernel.route.missing_actor.v1",
    "kernel.route.missing_default_authority.v1",
    "kernel.route.existing_resident.v1",
    "kernel.route.new_resident.v1",
    "kernel.route.active_worker.v1",
    "kernel.route.new_foreground_worker.v1",
    "kernel.route.new_background_worker.v1",
    "kernel.route.stop_or_cancel.v1",
    "kernel.route.schedule_fire.v1",
  ],
  DP: [
    "kernel.dispatch.deny.v1",
    "kernel.dispatch.pending.v1",
    "kernel.dispatch.unsupported_actor_message.v1",
    "kernel.dispatch.unknown_action.v1",
    "kernel.dispatch.spawn_worker.v1",
    "kernel.dispatch.connector_submit.v1",
    "kernel.dispatch.submit_completion.v1",
    "kernel.dispatch.submit_completion_readback.v1",
    "kernel.dispatch.cancel_work.v1",
    "kernel.dispatch.fail_work.v1",
    "kernel.dispatch.interrupt_attempt.v1",
    "kernel.dispatch.message_worker.v1",
    "kernel.dispatch.resume_wait.v1",
    "kernel.dispatch.ensure_cancel.v1",
    "kernel.dispatch.ask_resident.v1",
    "kernel.dispatch.accept_response.v1",
    "kernel.dispatch.actor_fire_and_forget.v1",
    "kernel.dispatch.actor_awaited.v1",
    "kernel.dispatch.external_submit.v1",
    "kernel.dispatch.a2a_submit.v1",
    "kernel.dispatch.api_submit.v1",
    "kernel.dispatch.device_submit.v1",
    "kernel.dispatch.schedule_create.v1",
    "kernel.dispatch.schedule_cancel.v1",
  ],
  WI: [
    "kernel.work.create.v1",
    "kernel.work.revise_metadata.v1",
    "kernel.work.revise_criteria.v1",
    "kernel.work.replace_dependencies.v1",
    "kernel.work.start.v1",
    "kernel.work.record_evidence.v1",
    "kernel.work.record_readback.v1",
    "kernel.work.add_blocker.v1",
    "kernel.work.resolve_blocker.v1",
    "kernel.work.fail.v1",
    "kernel.work.cancel.v1",
    "kernel.work.retry.v1",
    "kernel.work.exhaust_retry.v1",
    "kernel.work.record_outcome.v1",
    "kernel.work.archive.v1",
    "kernel.work.assign.v1",
    "kernel.work.set_deadline.v1",
  ],
  CP: [
    "kernel.completion.submit_candidate.v1",
    "kernel.completion.record_verdict.v1",
    "kernel.completion.evaluate.v1",
    "kernel.completion.admit.v1",
  ],
  AT: [
    "kernel.attempt.allocate.v1",
    "kernel.attempt.request_start.v1",
    "kernel.attempt.confirm_running.v1",
    "kernel.attempt.start_failed.v1",
    "kernel.attempt.confirm_cancel.v1",
    "kernel.attempt.interrupt_starting.v1",
    "kernel.attempt.wait.v1",
    "kernel.attempt.succeed.v1",
    "kernel.attempt.fail.v1",
    "kernel.attempt.cancel_running.v1",
    "kernel.attempt.interrupt_running.v1",
    "kernel.attempt.resume.v1",
    "kernel.attempt.fail_waiting.v1",
    "kernel.attempt.cancel_waiting.v1",
    "kernel.attempt.interrupt_waiting.v1",
  ],
  WT: [
    "kernel.wait.open.v1",
    "kernel.wait.record_below_quorum.v1",
    "kernel.wait.resolve_threshold.v1",
    "kernel.wait.record_duplicate.v1",
    "kernel.wait.stage_ambiguity.v1",
    "kernel.wait.select_ambiguity.v1",
    "kernel.wait.record_follow_up.v1",
    "kernel.wait.cancel.v1",
    "kernel.wait.expire.v1",
    "kernel.wait.resolve_partial.v1",
    "kernel.wait.reject_late.v1",
    "kernel.wait.remind.v1",
    "kernel.wait.resume.v1",
    "kernel.wait.close_followups_empty.v1",
    "kernel.wait.close_followups_present.v1",
  ],
  GR: [
    "kernel.grant.create.v1",
    "kernel.grant.revoke.v1",
    "kernel.grant.expire.v1",
    "kernel.grant.revise.v1",
  ],
  SC: ["kernel.schedule.initialize_or_advance.v1", "kernel.schedule.settle_and_advance.v1"],
  XD: [
    "kernel.cross_owner.deliver_pending.v1",
    "kernel.cross_owner.settle_delivered.v1",
    "kernel.cross_owner.settle_definite_failed.v1",
  ],
  EF: [
    "kernel.effect.confirm.v1",
    "kernel.effect.fail_definite.v1",
    "kernel.effect.mark_unknown.v1",
    "kernel.effect.resolve_unknown.v1",
  ],
} as const;

const configurationOperationGroups = {
  AF: ["artifact.put_and_reference.v1"],
  AI: [
    "kernel.actor.register_identity.v1",
    "kernel.actor.revise_identity.v1",
    "kernel.actor.retire_identity.v1",
  ],
  AE: [
    "kernel.actor.bind_endpoint.v1",
    "kernel.actor.rebind_endpoint.v1",
    "kernel.actor.unbind_endpoint.v1",
  ],
  BL: [
    "kernel.authority.create_blacklist.v1",
    "kernel.authority.revise_blacklist.v1",
    "kernel.authority.revoke_blacklist.v1",
    "kernel.authority.expire_blacklist.v1",
  ],
  CG: [
    "kernel.authority.create_channel_grant.v1",
    "kernel.authority.revise_channel_grant.v1",
    "kernel.authority.revoke_channel_grant.v1",
  ],
  CI: [
    "kernel.connector.register_installation.v1",
    "kernel.connector.revise_definition.v1",
    "kernel.connector.request_consent.v1",
    "kernel.connector.grant_consent.v1",
    "kernel.connector.request_verification.v1",
    "kernel.connector.record_verified.v1",
    "kernel.connector.record_verification_failed.v1",
    "kernel.connector.disable.v1",
    "kernel.connector.uninstall.v1",
  ],
} as const;

const NativeTransitionPairsV1 = Object.entries(nativeCommandGroups).flatMap(([family, commands]) =>
  commands.map(
    (command, index) => [`${family}-${String(index + 1).padStart(2, "0")}`, command] as const,
  ),
);
const NativeTransitionIdsV1 = NativeTransitionPairsV1.map(([id]) => id);
const NativeCommandNamesV1 = NativeTransitionPairsV1.map(([, command]) => command);
const NativeTransitionIdSetV1 = new Set<string>(NativeTransitionIdsV1);
const NativeCommandNameSetV1 = new Set<string>(NativeCommandNamesV1);
const ConfigurationOperationPairsV1 = Object.entries(configurationOperationGroups).flatMap(
  ([family, commands]) =>
    commands.map(
      (command, index) => [`${family}-${String(index + 1).padStart(2, "0")}`, command] as const,
    ),
);
const ClosedOperationPairsV1 = [...NativeTransitionPairsV1, ...ConfigurationOperationPairsV1];
const ClosedOperationIdSetV1 = new Set<string>(ClosedOperationPairsV1.map(([id]) => id));
const ClosedCommandNameSetV1 = new Set<string>(
  ClosedOperationPairsV1.map(([, command]) => command),
);

type PadTransitionOrdinalV1<Ordinal extends number> =
  `${Ordinal}` extends `${infer First}${infer Rest}`
    ? Rest extends ""
      ? `0${First}`
      : `${Ordinal}`
    : never;
type EnumerateTransitionIdsV1<
  Family extends string,
  Commands extends readonly unknown[],
  Ordinal extends readonly unknown[] = readonly [unknown],
> = Commands extends readonly [unknown, ...infer RemainingCommands]
  ?
      | `${Family}-${PadTransitionOrdinalV1<Ordinal["length"]>}`
      | EnumerateTransitionIdsV1<Family, RemainingCommands, readonly [...Ordinal, unknown]>
  : never;
type NativeTransitionIdTypeV1 = {
  [Family in keyof typeof nativeCommandGroups]: EnumerateTransitionIdsV1<
    Family,
    (typeof nativeCommandGroups)[Family]
  >;
}[keyof typeof nativeCommandGroups];
type NativeCommandNameTypeV1 =
  (typeof nativeCommandGroups)[keyof typeof nativeCommandGroups][number];

const requestSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  mode: z.literal("direct"),
  prompt: z.string(),
  model: Model.Ref,
  systemPrompt: z.string().optional(),
  tools: z.array(Tool.Spec).optional(),
  toolConfig: Tool.Config.optional(),
  permissions: Policy.Permission.optional(),
  credentials: z.record(z.string()).optional(),
  budget: AgentProfile.AgentBudget.optional(),
  skills: z.array(z.string()).optional(),
  agentName: z.string().optional(),
  workspaceRoot: z.string().optional(),
  middleware: z.array(z.string()).optional(),
  policyPlan: Policy.PolicyPlan.optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
  traceId: z.string().optional(),
});

const connectorLogEventSchema = z.object({
  kind: z.literal("connector_log_event"),
  artifactId: z.string(),
  message: z.string(),
  timestamp: z.string().optional(),
  sequence: z.number().int().nonnegative(),
  data: z.record(z.string(), z.unknown()),
  usage: Token.ExecutionUsage.optional(),
  toolCall: z
    .object({
      id: z.string().min(1).optional(),
      tool: z.string().min(1),
      status: z.enum(["pending", "running", "completed", "failed", "error"]).optional(),
      input: z.record(z.string(), z.unknown()).optional(),
      output: z.unknown().optional(),
    })
    .optional(),
});

const resultSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  status: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
  output: z.string().optional(),
  finishReason: z.string().optional(),
  usage: Token.ExecutionUsage.optional(),
  error: z.string().optional(),
  artifacts: z
    .array(
      z.object({
        kind: z.literal("connector_log"),
        artifactId: z.string(),
        title: z.string(),
        mimeType: z.string(),
      }),
    )
    .optional(),
  logEvents: z.array(connectorLogEventSchema).optional(),
});

export namespace Execution {
  export const WorkspaceRefV1 = z
    .object({
      canonicalizerVersion: z.literal("workspace-v1"),
      workspaceId: WorkspaceId,
      canonicalBytesDigest: Digest,
    })
    .strict();
  export type WorkspaceRefV1 = z.infer<typeof WorkspaceRefV1>;

  const WorkspaceWildcardResourceV1 = z
    .object({
      version: z.literal("resource-scope-v1"),
      kind: z.literal("workspace"),
      target: z.literal("**"),
    })
    .strict();
  const WorkspacePathResourceV1 = z
    .object({
      version: z.literal("resource-scope-v1"),
      kind: z.literal("workspace_path"),
      targetDigest: Digest,
    })
    .strict();
  const EndpointResourceV1 = z
    .object({
      version: z.literal("resource-scope-v1"),
      kind: z.literal("endpoint"),
      targetDigest: Digest,
    })
    .strict();
  const ConnectorResourceV1 = z
    .object({
      version: z.literal("resource-scope-v1"),
      kind: z.literal("connector"),
      installationId: NonEmpty,
      definitionVersion: NonEmpty,
    })
    .strict();
  const DeviceResourceV1 = z
    .object({
      version: z.literal("resource-scope-v1"),
      kind: z.literal("device"),
      driver: NonEmpty,
      target: NonEmpty,
    })
    .strict();
  const RegisteredResourceV1 = z
    .object({
      version: z.literal("resource-scope-v1"),
      kind: z.literal("registered"),
      variant: z.string().regex(/^[a-z][a-z0-9_-]*\.v1$/),
      targetDigest: Digest,
    })
    .strict();

  export const ResourceScopeV1 = z.discriminatedUnion("kind", [
    WorkspaceWildcardResourceV1,
    WorkspacePathResourceV1,
    EndpointResourceV1,
    ConnectorResourceV1,
    DeviceResourceV1,
    RegisteredResourceV1,
  ]);
  export type ResourceScopeV1 = z.infer<typeof ResourceScopeV1>;

  function resourceKey(resource: ResourceScopeV1): string {
    switch (resource.kind) {
      case "workspace":
        return "workspace:**";
      case "workspace_path":
        return `workspace:path:${resource.targetDigest}`;
      case "endpoint":
        return `endpoint:${resource.targetDigest}`;
      case "connector":
        return `connector:${resource.installationId}:${resource.definitionVersion}`;
      case "device":
        return `device:${resource.driver}:${resource.target}`;
      case "registered":
        return `${resource.variant}:${resource.targetDigest}`;
    }
  }

  export const EffectScopeV1 = z
    .object({
      version: z.literal("effect-scope-v1"),
      workspace: WorkspaceRefV1,
      resources: z.array(ResourceScopeV1).min(1),
      resolver: z
        .object({
          id: NonEmpty,
          version: NonEmpty,
          inputDigest: Digest,
        })
        .strict(),
      containment: z.enum(["filesystem-canonicalized", "connector-declared", "none"]),
      mutationClass: z.enum(["mutating", "unknown"]),
    })
    .strict()
    .superRefine((scope, ctx) => {
      const keys = scope.resources.map(resourceKey);
      if (new Set(keys).size !== keys.length) {
        ctx.addIssue({
          code: "custom",
          message: "effect resources must be unique",
          path: ["resources"],
        });
      }
      const sorted = [...keys].sort();
      if (keys.some((key, index) => key !== sorted[index])) {
        ctx.addIssue({
          code: "custom",
          message: "effect resources must be canonically sorted",
          path: ["resources"],
        });
      }
    });
  export type EffectScopeV1 = z.infer<typeof EffectScopeV1>;

  export const CredentialSourceRefV1 = z
    .object({
      version: z.literal("credential-source-ref-v1"),
      providerId: NonEmpty,
      authType: z.enum(["api", "proxy"]),
      credentialId: NonEmpty,
      rotationId: NonEmpty,
      account: NonEmpty.optional(),
      sourceKind: z.enum(["default_file", "override_file", "injected_runtime"]),
      sourcePathDigest: Digest,
      endpointRef: NonEmpty.optional(),
      credentialDigest: Digest,
    })
    .strict();
  export type CredentialSourceRefV1 = z.infer<typeof CredentialSourceRefV1>;

  export const LLMEndpointRefV1 = z
    .object({
      version: z.literal("llm-endpoint-ref-v1"),
      kind: z.enum(["default", "proxy", "custom"]),
      valueRef: NonEmpty,
      endpointDigest: Digest,
    })
    .strict();
  export type LLMEndpointRefV1 = z.infer<typeof LLMEndpointRefV1>;

  export const LLMEnvironmentV1 = z
    .object({
      version: z.literal("llm-environment-v1"),
      catalogSchemaVersion: z.number().int().positive(),
      catalogSource: z.enum(["bundled", "remote"]),
      catalogSourceVersion: NonEmpty,
      catalogDigest: Digest,
      modelDigest: Digest,
      endpoint: LLMEndpointRefV1,
      credential: CredentialSourceRefV1,
      sdkPackage: NonEmpty,
      adapterVersion: NonEmpty,
      environmentDigest: Digest,
    })
    .strict();
  export type LLMEnvironmentV1 = z.infer<typeof LLMEnvironmentV1>;

  export const CredentialProvisioningRequestV1 = z
    .object({
      version: z.literal("credential-provisioning-request-v1"),
      runtimeId: NonEmpty,
      workerId: NonEmpty,
      generation: z.number().int().nonnegative(),
      principalId: NonEmpty,
      attempt: Ledger.AttemptRefV1,
      providerIds: z.array(NonEmpty).min(1),
      nonceRef: Digest,
      expiresAt: z.number().int().nonnegative(),
      credentialRefs: z.array(CredentialSourceRefV1).min(1),
    })
    .strict()
    .superRefine((request, ctx) => {
      if (new Set(request.providerIds).size !== request.providerIds.length) {
        ctx.addIssue({
          code: "custom",
          message: "provider IDs must be unique",
          path: ["providerIds"],
        });
      }
      if (
        new Set(request.credentialRefs.map((ref) => ref.providerId)).size !==
        request.credentialRefs.length
      ) {
        ctx.addIssue({
          code: "custom",
          message: "credential providers must be unique",
          path: ["credentialRefs"],
        });
      }
      const providers = [...request.providerIds].sort();
      const refs = request.credentialRefs.map((ref) => ref.providerId).sort();
      if (
        providers.length !== refs.length ||
        providers.some((provider, index) => provider !== refs[index])
      ) {
        ctx.addIssue({
          code: "custom",
          message: "credential refs must exactly match requested providers",
          path: ["credentialRefs"],
        });
      }
    });
  export type CredentialProvisioningRequestV1 = z.infer<typeof CredentialProvisioningRequestV1>;

  export const CredentialProvisioningReceiptV1 = z
    .object({
      version: z.literal("credential-provisioning-receipt-v1"),
      runtimeId: NonEmpty,
      workerId: NonEmpty,
      generation: z.number().int().nonnegative(),
      principalId: NonEmpty,
      attempt: Ledger.AttemptRefV1,
      nonceRef: Digest,
      acceptedCredentialDigests: z.array(Digest).min(1),
      acceptedAtDbMs: z.number().int().nonnegative(),
    })
    .strict()
    .refine(
      (receipt) =>
        new Set(receipt.acceptedCredentialDigests).size ===
        receipt.acceptedCredentialDigests.length,
      {
        message: "accepted credential digests must be unique",
        path: ["acceptedCredentialDigests"],
      },
    );
  export type CredentialProvisioningReceiptV1 = z.infer<typeof CredentialProvisioningReceiptV1>;

  export const RedactedCredentialRefV1 = CredentialSourceRefV1.brand<"RedactedCredentialRefV1">();
  export type RedactedCredentialRefV1 = z.infer<typeof RedactedCredentialRefV1>;
  export const RedactedEnvironmentRefV1 = LLMEnvironmentV1.brand<"RedactedEnvironmentRefV1">();
  export type RedactedEnvironmentRefV1 = z.infer<typeof RedactedEnvironmentRefV1>;

  export const AuthenticatedWorkerIdentityV1 = z
    .object({
      version: z.literal("authenticated-worker-identity-v1"),
      runtimeId: NonEmpty,
      workerId: NonEmpty,
      generation: z.number().int().nonnegative(),
      principalId: NonEmpty,
      sessionId: NonEmpty,
      runId: NonEmpty,
      attemptId: NonEmpty,
    })
    .strict();
  export type AuthenticatedWorkerIdentityV1 = z.infer<typeof AuthenticatedWorkerIdentityV1>;

  export const NativeTransitionIdV1 = z.custom<NativeTransitionIdTypeV1>(
    (candidate) => typeof candidate === "string" && NativeTransitionIdSetV1.has(candidate),
    "unknown native transition ID",
  );
  export type NativeTransitionIdV1 = z.infer<typeof NativeTransitionIdV1>;
  export const NativeCommandNameV1 = z.custom<NativeCommandNameTypeV1>(
    (candidate) => typeof candidate === "string" && NativeCommandNameSetV1.has(candidate),
    "unknown native command name",
  );
  export type NativeCommandNameV1 = z.infer<typeof NativeCommandNameV1>;
  export const ClosedOperationIdV1 = z.custom<string>(
    (candidate) => typeof candidate === "string" && ClosedOperationIdSetV1.has(candidate),
    "unknown closed operation ID",
  );
  export const ClosedCommandNameV1 = z.custom<string>(
    (candidate) => typeof candidate === "string" && ClosedCommandNameSetV1.has(candidate),
    "unknown closed command name",
  );

  export const ContentBlobRefV1 = z
    .object({
      version: z.literal("content-blob-ref-v1"),
      digest: Digest,
      byteLength: z.number().int().nonnegative(),
      mediaType: NonEmpty,
    })
    .strict();
  export type ContentBlobRefV1 = z.infer<typeof ContentBlobRefV1>;

  const RunBindingV1 = z
    .object({
      version: z.literal("run-binding-v1"),
      workItemId: NonEmpty,
      attemptId: NonEmpty,
      sessionId: NonEmpty,
      runId: NonEmpty,
    })
    .strict();

  const NativeFactBaseV1 = z
    .object({
      subjectId: NonEmpty,
      occurredAtDbMs: z.number().int().nonnegative(),
    })
    .strict();
  const familyPayloadSchemas = {
    SS: NativeFactBaseV1.extend({
      sessionId: NonEmpty,
      parentSessionId: NonEmpty.nullable(),
      model: Model.Ref.strict(),
      sessionSnapshotRef: ContentBlobRefV1,
    }).strict(),
    SF: NativeFactBaseV1.extend({
      sessionId: NonEmpty,
      surfaceId: NonEmpty,
      surfaceKind: NonEmpty,
      endpointId: NonEmpty,
      surfaceSnapshotRef: ContentBlobRefV1,
    }).strict(),
    MS: NativeFactBaseV1.extend({
      sessionId: NonEmpty,
      surfaceId: NonEmpty,
      messageId: NonEmpty,
      partId: NonEmpty.nullable(),
      role: z.enum(["user", "assistant", "system", "tool"]),
      status: NonEmpty,
      model: Model.Ref.strict().nullable(),
      messageSnapshotRef: ContentBlobRefV1,
      partSnapshotRef: ContentBlobRefV1.nullable(),
    }).strict(),
    RT: NativeFactBaseV1.extend({
      sessionId: NonEmpty,
      surfaceId: NonEmpty,
      messageId: NonEmpty,
      routeId: NonEmpty,
      routeDecision: NonEmpty,
      authoritySnapshotRef: ContentBlobRefV1,
      routeSnapshotRef: ContentBlobRefV1,
    }).strict(),
    DP: NativeFactBaseV1.extend({
      dispatchId: NonEmpty,
      routeId: NonEmpty,
      sourceSessionId: NonEmpty,
      sourceOwner: Ledger.OwnerV1,
      destinationOwner: Ledger.OwnerV1,
      dispatchDecision: NonEmpty,
      settlement: z.enum(["pending", "delivered", "definite_failed"]),
      dispatchSnapshotRef: ContentBlobRefV1,
      destinationReceiptRef: ContentBlobRefV1.nullable(),
      definiteFailureProofRef: ContentBlobRefV1.nullable(),
    }).strict(),
    WI: NativeFactBaseV1.extend({
      workItemId: NonEmpty,
      sessionId: NonEmpty,
      workSnapshotRef: ContentBlobRefV1,
    }).strict(),
    CP: NativeFactBaseV1.extend({
      workItemId: NonEmpty,
      candidateId: NonEmpty,
      runBinding: RunBindingV1,
      runBindingRef: ContentBlobRefV1,
      completionSnapshotRef: ContentBlobRefV1,
      candidateArtifactRef: ContentBlobRefV1,
      verdictArtifactRef: ContentBlobRefV1.nullable(),
      admissionDecisionArtifactRef: ContentBlobRefV1.nullable(),
      verdictArtifactRefs: z.array(ContentBlobRefV1),
    }).strict(),
    AT: NativeFactBaseV1.extend({
      attempt: Ledger.AttemptRefV1,
      runBinding: RunBindingV1,
      model: Model.Ref.strict(),
      environmentRef: RedactedEnvironmentRefV1,
      environmentSnapshotRef: ContentBlobRefV1,
      attemptSnapshotRef: ContentBlobRefV1,
    }).strict(),
    WT: NativeFactBaseV1.extend({
      waitEvent: Wait.LifecycleEventV1,
      waitSnapshotRef: ContentBlobRefV1,
    }).strict(),
    GR: NativeFactBaseV1.extend({
      grantId: NonEmpty,
      attempt: Ledger.AttemptRefV1,
      granteeId: NonEmpty,
      grantScopeRef: ContentBlobRefV1,
      grantSnapshotRef: ContentBlobRefV1,
    }).strict(),
    SC: NativeFactBaseV1.extend({
      scheduleId: NonEmpty,
      generation: z.number().int().nonnegative(),
      nextFireRef: Digest.nullable(),
      settlementRef: Digest.nullable(),
      scheduleSnapshotRef: ContentBlobRefV1,
    }).strict(),
    EF: NativeFactBaseV1.extend({
      effect: Ledger.EffectRefV1,
      attempt: Ledger.AttemptRefV1,
      effectScope: EffectScopeV1,
      effectScopeRef: ContentBlobRefV1,
      settlement: z.enum([
        "pending",
        "confirmed",
        "definite_failed",
        "unknown",
        "manually_resolved",
      ]),
      effectSettlementRef: ContentBlobRefV1,
    }).strict(),
  } as const;

  const mixedTransitionFactFamilies: Readonly<
    Record<string, readonly (keyof typeof familyPayloadSchemas)[]>
  > = {
    "SF-01": ["SS", "SF"],
    "MS-01": ["RT", "MS", "EF"],
    "RT-02": ["RT", "WT"],
    "RT-03": ["RT", "WT", "DP", "AT", "CP"],
    "RT-04": ["RT", "WT", "DP", "EF"],
    "RT-05": ["RT", "WT", "EF"],
    "RT-11": ["RT", "MS", "EF"],
    "RT-12": ["SS", "SF", "RT", "MS", "EF"],
    "RT-13": ["RT", "MS", "DP", "EF"],
    "RT-14": ["RT", "MS", "DP", "WI", "AT", "EF"],
    "RT-15": ["RT", "MS", "DP", "WI", "AT", "EF"],
    "RT-16": ["RT", "DP", "EF"],
    "RT-17": ["SC", "DP", "RT", "EF"],
    "DP-05": ["DP", "WI", "AT", "EF"],
    "DP-06": ["DP", "EF"],
    "DP-07": ["DP", "AT", "CP"],
    "DP-08": ["DP", "AT", "CP", "EF"],
    "DP-09": ["DP", "WI"],
    "DP-10": ["DP", "WI"],
    "DP-11": ["DP", "AT"],
    "DP-12": ["DP", "EF"],
    "DP-13": ["DP", "WT", "EF"],
    "DP-14": ["DP", "EF"],
    "DP-15": ["WT", "DP", "AT"],
    "DP-16": ["DP", "WT", "EF"],
    "DP-17": ["DP", "EF"],
    "DP-18": ["DP", "WT", "EF"],
    "DP-19": ["DP", "EF"],
    "DP-20": ["DP", "EF"],
    "DP-21": ["DP", "EF"],
    "DP-22": ["DP", "EF"],
    "DP-23": ["DP", "SC"],
    "DP-24": ["DP", "SC"],
    "WI-12": ["AT", "WI"],
    "CP-04": ["CP", "WI"],
    "AT-02": ["AT", "EF"],
    "AT-03": ["EF", "AT"],
    "AT-04": ["EF", "AT"],
    "AT-05": ["EF", "AT"],
    "AT-07": ["AT", "WT"],
    "AT-12": ["WT", "EF"],
    "AT-14": ["WT", "AT"],
    "WT-03": ["WT", "DP"],
    "WT-12": ["WT", "EF"],
    "WT-13": ["WT", "EF"],
    "XD-01": ["DP", "EF"],
    "XD-02": ["DP"],
    "XD-03": ["DP"],
  };
  export const NativeTransitionFactFamiliesV1 = Object.freeze(
    Object.fromEntries(
      NativeTransitionPairsV1.map(([transitionId]) => [
        transitionId,
        Object.freeze(
          mixedTransitionFactFamilies[transitionId] ??
            ([transitionId.slice(0, 2)] as readonly (keyof typeof familyPayloadSchemas)[]),
        ),
      ]),
    ) as Readonly<Record<NativeTransitionIdTypeV1, readonly (keyof typeof familyPayloadSchemas)[]>>,
  );
  const factBundleSchema = (factFamilies: readonly (keyof typeof familyPayloadSchemas)[]) =>
    z
      .object(
        Object.fromEntries(
          factFamilies.map((family) => [family, familyPayloadSchemas[family]]),
        ) as Record<string, z.ZodTypeAny>,
      )
      .strict();
  const nativePayloadSchemas: Readonly<Record<string, z.ZodTypeAny>> = Object.fromEntries(
    NativeTransitionPairsV1.map(([transitionId, command]) => {
      const factFamilies = NativeTransitionFactFamiliesV1[transitionId as NativeTransitionIdTypeV1];
      const facts =
        transitionId === "DP-15"
          ? z.union([factBundleSchema(factFamilies), factBundleSchema(["WT", "DP"])])
          : factBundleSchema(factFamilies);
      return [
        transitionId,
        z
          .object({
            version: z.literal("native-transition-payload-v1"),
            transitionId: z.literal(transitionId),
            command: z.literal(command),
            owner: Ledger.OwnerV1,
            facts,
          })
          .strict()
          .transform((payload) => ({
            ...payload,
            ...(payload.facts[
              transitionId.startsWith("XD-") ? "DP" : transitionId.slice(0, 2)
            ] as Readonly<Record<string, unknown>>),
          })),
      ];
    }),
  );
  export const NativeTransitionPayloadV1 = z.union(
    Object.values(nativePayloadSchemas) as unknown as readonly [
      z.ZodTypeAny,
      z.ZodTypeAny,
      ...z.ZodTypeAny[],
    ],
  );
  export type NativeTransitionPayloadV1 = {
    readonly version: "native-transition-payload-v1";
    readonly transitionId: NativeTransitionIdTypeV1;
    readonly command: NativeCommandNameTypeV1;
    readonly owner: Ledger.OwnerV1;
    readonly facts: Readonly<
      Partial<{
        [K in keyof typeof familyPayloadSchemas]: z.infer<(typeof familyPayloadSchemas)[K]>;
      }>
    >;
    /** @deprecated Runtime schemas reject flat facts; retained only for source compatibility while callers migrate. */
    readonly subjectId: string;
    readonly occurredAtDbMs: number;
    readonly sessionId: string;
    readonly surfaceId: string;
    readonly messageId: string;
    readonly routeId: string;
    readonly dispatchId: string;
    readonly workItemId: string;
    readonly candidateId: string;
    readonly grantId: string;
    readonly scheduleId: string;
    readonly attempt: Ledger.AttemptRefV1;
    readonly waitEvent: Wait.LifecycleEventV1;
    readonly runBinding?: {
      readonly version: "run-binding-v1";
      readonly workItemId: string;
      readonly attemptId: string;
      readonly sessionId: string;
      readonly runId: string;
    };
  };
  export const NativeTransitionPayloadSchemasV1 = Object.freeze(nativePayloadSchemas);

  const ConfigurationRecordVersionV1 = z.number().int().positive();
  const ConfigurationTombstonePayloadV1 = z
    .object({
      version: z.literal("configuration-operation-payload-v1"),
      operationId: ClosedOperationIdV1,
      command: ClosedCommandNameV1,
      owner: Ledger.OwnerV1,
      subjectId: NonEmpty,
      recordVersion: ConfigurationRecordVersionV1,
      occurredAtDbMs: z.number().int().nonnegative(),
      configurationSnapshotRef: ContentBlobRefV1,
    })
    .strict();
  const ArtifactReferencePayloadV1 = ConfigurationTombstonePayloadV1.extend({
    artifactId: NonEmpty,
    contentRef: ContentBlobRefV1,
    title: NonEmpty,
  }).strict();
  const ActorIdentityPayloadV1 = ConfigurationTombstonePayloadV1.extend({
    identity: Actor.Identity.strict(),
  }).strict();
  const ActorEndpointPayloadV1 = ConfigurationTombstonePayloadV1.extend({
    endpoint: Actor.Endpoint.strict(),
  }).strict();
  const BlacklistPayloadV1 = ConfigurationTombstonePayloadV1.extend({
    entry: Actor.BlacklistEntry.strict(),
  }).strict();
  const ChannelGrantPayloadV1 = ConfigurationTombstonePayloadV1.extend({
    grant: Actor.ChannelGrant.strict(),
  }).strict();
  const ConnectorInstallationPayloadV1 = ConfigurationTombstonePayloadV1.extend({
    installation: AppConnector.Installation,
    effect: Ledger.EffectRefV1.optional(),
  }).strict();

  function configurationPayloadSchema(operationId: string): z.ZodTypeAny {
    if (operationId === "AF-01") return ArtifactReferencePayloadV1;
    if (operationId === "AI-01" || operationId === "AI-02") return ActorIdentityPayloadV1;
    if (operationId === "AE-01" || operationId === "AE-02") return ActorEndpointPayloadV1;
    if (operationId === "BL-01" || operationId === "BL-02") return BlacklistPayloadV1;
    if (operationId === "CG-01" || operationId === "CG-02") return ChannelGrantPayloadV1;
    if (operationId.startsWith("CI-") && operationId !== "CI-09") {
      return ConnectorInstallationPayloadV1;
    }
    return ConfigurationTombstonePayloadV1;
  }

  function commandSchema(
    operationId: string,
    command: string,
    payload: z.ZodTypeAny,
  ): z.ZodTypeAny {
    return z
      .object({
        version: z.literal("kernel-transition-command-v1"),
        transitionId: z.literal(operationId),
        command: z.literal(command),
        requestId: NonEmpty,
        requestHash: Digest,
        identity: AuthenticatedWorkerIdentityV1,
        expectedHead: Ledger.HeadV1,
        payload,
      })
      .strict()
      .superRefine((request, ctx) => {
        const payloadOwner = (request.payload as { owner?: Ledger.OwnerV1 }).owner;
        if (!payloadOwner || payloadOwner.ownerKey !== request.expectedHead.owner.ownerKey) {
          ctx.addIssue({
            code: "custom",
            message: "transition payload and expected head owner must match",
            path: ["payload", "owner"],
          });
        }
        const operationPayload = request.payload as { operationId?: string; command?: string };
        if (
          operationPayload.operationId !== undefined &&
          (operationPayload.operationId !== operationId || operationPayload.command !== command)
        ) {
          ctx.addIssue({
            code: "custom",
            message: "operation ID, command, and payload schema must match",
            path: ["payload", "operationId"],
          });
        }
      });
  }
  export type ConfigurationOperationPayloadV1 =
    | z.infer<typeof ArtifactReferencePayloadV1>
    | z.infer<typeof ActorIdentityPayloadV1>
    | z.infer<typeof ActorEndpointPayloadV1>
    | z.infer<typeof BlacklistPayloadV1>
    | z.infer<typeof ChannelGrantPayloadV1>
    | z.infer<typeof ConnectorInstallationPayloadV1>
    | z.infer<typeof ConfigurationTombstonePayloadV1>;

  const nativeCommandSchemas = Object.fromEntries(
    NativeTransitionPairsV1.map(([transitionId, command]) => [
      transitionId,
      commandSchema(transitionId, command, required(nativePayloadSchemas[transitionId])),
    ]),
  );
  const configurationCommandSchemas = Object.fromEntries(
    ConfigurationOperationPairsV1.map(([operationId, command]) => [
      operationId,
      commandSchema(operationId, command, configurationPayloadSchema(operationId)),
    ]),
  );
  const closedCommandSchemas = [
    ...Object.values(nativeCommandSchemas),
    ...Object.values(configurationCommandSchemas),
  ];

  export const KernelTransitionCommandV1 = z.union(
    closedCommandSchemas as unknown as readonly [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
  );
  export type KernelTransitionCommandV1 = {
    readonly version: "kernel-transition-command-v1";
    readonly transitionId: string;
    readonly command: string;
    readonly requestId: string;
    readonly requestHash: string;
    readonly identity: AuthenticatedWorkerIdentityV1;
    readonly expectedHead: Ledger.HeadV1;
    readonly payload: NativeTransitionPayloadV1 | ConfigurationOperationPayloadV1;
  };
  export const NativeTransitionCommandSchemasV1 = Object.freeze(nativeCommandSchemas);
  export const ConfigurationOperationCommandSchemasV1 = Object.freeze(configurationCommandSchemas);
  export const ClosedOperationCommandSchemasV1 = Object.freeze({
    ...nativeCommandSchemas,
    ...configurationCommandSchemas,
  });
  export const ConfigurationOperationCatalogV1 = Object.freeze(
    ConfigurationOperationPairsV1.map(([id, command]) => Object.freeze({ id, command })),
  );
  export const ClosedOperationCatalogV1 = Object.freeze(
    ClosedOperationPairsV1.map(([id, command]) => Object.freeze({ id, command })),
  );

  export const KernelTransitionResultV1 = z.discriminatedUnion("status", [
    z
      .object({
        version: z.literal("kernel-transition-result-v1"),
        status: z.literal("committed"),
        receipt: Ledger.AppendReceiptV1,
      })
      .strict(),
    z
      .object({
        version: z.literal("kernel-transition-result-v1"),
        status: z.literal("rejected"),
        code: z.enum([
          "transition_forbidden",
          "identity_mismatch",
          "head_conflict",
          "idempotency_mismatch",
        ]),
        definiteFailureClass: z
          .literal("destination_append_definite_no_materialization")
          .optional(),
      })
      .strict(),
  ]);
  export type KernelTransitionResultV1 = z.infer<typeof KernelTransitionResultV1>;

  export const KernelQueryV1 = z.discriminatedUnion("kind", [
    z
      .object({
        version: z.literal("kernel-query-v1"),
        kind: z.literal("authenticated_transcript"),
        identity: AuthenticatedWorkerIdentityV1,
        sessionId: NonEmpty,
        afterOwnerSeq: z.number().int().nonnegative().optional(),
      })
      .strict(),
    z
      .object({
        version: z.literal("kernel-query-v1"),
        kind: z.literal("authenticated_attempt"),
        identity: AuthenticatedWorkerIdentityV1,
        attempt: Ledger.AttemptRefV1,
      })
      .strict(),
    z
      .object({
        version: z.literal("kernel-query-v1"),
        kind: z.literal("authenticated_wait"),
        identity: AuthenticatedWorkerIdentityV1,
        waitId: NonEmpty,
      })
      .strict(),
  ]);
  export type KernelQueryV1 = z.infer<typeof KernelQueryV1>;

  export const KernelQueryResultV1 = z.discriminatedUnion("kind", [
    z
      .object({
        version: z.literal("kernel-query-result-v1"),
        kind: z.literal("authenticated_transcript"),
        messages: z.array(
          z
            .object({
              role: z.enum(["user", "assistant"]),
              content: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
    z
      .object({
        version: z.literal("kernel-query-result-v1"),
        kind: z.literal("authenticated_attempt"),
        attempt: Ledger.AttemptRefV1,
        events: z.array(Ledger.EnvelopeV1),
        environment: RedactedEnvironmentRefV1.optional(),
      })
      .strict(),
    z
      .object({
        version: z.literal("kernel-query-result-v1"),
        kind: z.literal("authenticated_wait"),
        wait: Wait.LifecycleEventV1,
      })
      .strict(),
  ]);
  export type KernelQueryResultV1 = z.infer<typeof KernelQueryResultV1>;
  export const LogEvent = connectorLogEventSchema;
  export type LogEvent = z.infer<typeof LogEvent>;

  export const Request = requestSchema;
  export type Request = z.infer<typeof requestSchema>;

  export const Result = resultSchema;
  export type Result = z.infer<typeof resultSchema>;

  /**
   * Command face of an executor driver (#462 §6). `deliver` is the one verb
   * every executor implements; `send` and `cancel` are capability-declared —
   * the presence of the method is the declaration, and dispatch rejects a
   * `send` to a non-capable executor at the gate instead of faking it.
   * A driver receives tasks already authorized and policy-stamped by
   * dispatch (ring 4) and enforces process-level physics only — it is never
   * a gate. Type-only: internals differ per executor; what the gate holds
   * must be identical.
   */
  export interface Driver {
    deliver(runId: string, task: { sessionId: string } & Record<string, unknown>): Promise<unknown>;
    cancel?(runId: string): Promise<unknown>;
    send?(sessionId: string, message: string, runId?: string): Promise<unknown>;
  }
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("required protocol invariant is missing");
  return value;
}
