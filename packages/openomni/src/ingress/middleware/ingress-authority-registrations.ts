import type { PolicyRegistration } from "@openomni/agent";
import { Ingress, PolicyDecision } from "@openomni/protocol";
import type { AuthorityProjectionQueryPort } from "../actor-resolver";
import { authoritySourceFacts } from "../actor-resolver";
import { resolveTarget } from "../target";
import { getActor, targetRequiresCoordinator } from "./ingress-authority-actor";
import {
  applyChannelGrantTreatment,
  channelGrantReason,
  resolveInboundTreatment,
} from "./ingress-authority-channel-grant";
import { abortDecision, allowDecision, requireParsedEvent } from "./ingress-authority-decisions";
import { IngressAuthorityDefinitions } from "./ingress-authority-definitions";
import { evaluateIngressAuthority } from "./ingress-authority-evaluation";
import type { PreRunState } from "./ingress-authority-types";

export function registrations(
  state: PreRunState,
  queries: AuthorityProjectionQueryPort,
): PolicyRegistration[] {
  return [
    createSchemaValidation(state),
    createBlacklistCheck(state, queries),
    createChannelGrantCheck(state, queries),
    createCoordinatorPresence(state),
    createAuthorityCheck(state),
    createModeDispatch(state),
  ];
}

export function routedRegistrations(state: PreRunState): PolicyRegistration[] {
  return [
    createSchemaValidation(state),
    createCoordinatorPresence(state),
    createAuthorityCheck(state),
    createModeDispatch(state),
  ];
}

function createBlacklistCheck(
  state: PreRunState,
  queries: AuthorityProjectionQueryPort,
): PolicyRegistration {
  return {
    ...IngressAuthorityDefinitions.BlacklistCheck,
    failPolicy: "fail-closed",
    fn: async () => {
      const event = requireParsedEvent(state);
      const actor = getActor(event);
      const result = await queries.query({
        kind: "authority.blacklist_match",
        ...(typeof actor?.actorId === "string" ? { actorId: actor.actorId } : {}),
        ...(typeof actor?.endpointId === "string" ? { endpointId: actor.endpointId } : {}),
        channel: event.surface,
        candidates: [
          event.surface,
          ...(event.channel ? [event.channel] : []),
          `${event.surface}:${event.workspace ?? ""}:${event.channel ?? ""}`,
        ],
      });
      if (result.kind !== "authority.blacklist_match") {
        throw new TypeError("authority blacklist query returned the wrong projection kind");
      }
      const factsUsed = authoritySourceFacts(result);
      if (result.entry === null) {
        return PolicyDecision.allow({
          policyId: "ingress.blacklist",
          reasonCodes: ["blacklist.clear"],
          factsUsed,
        });
      }
      const reason = blacklistReason(result.entry.kind, result.entry.value, result.entry.reason);
      return PolicyDecision.deny({
        policyId: "ingress.blacklist",
        reasonCodes: [reason],
        factsUsed,
        effects: [{ type: "run.abort", reason }],
      });
    },
  };
}

function createChannelGrantCheck(
  state: PreRunState,
  queries: AuthorityProjectionQueryPort,
): PolicyRegistration {
  return {
    ...IngressAuthorityDefinitions.ChannelGrantCheck,
    failPolicy: "fail-closed",
    fn: async () => {
      const event = requireParsedEvent(state);
      const result = await queries.query({
        kind: "authority.channel_grant",
        surface: event.surface,
        ...(event.workspace === undefined ? {} : { workspace: event.workspace }),
        ...(event.channel === undefined ? {} : { channel: event.channel }),
      });
      if (result.kind !== "authority.channel_grant") {
        throw new TypeError("authority channel query returned the wrong projection kind");
      }
      const sourceFacts = authoritySourceFacts(result);
      if (result.grant === null) {
        const reason = channelGrantReason(undefined, undefined);
        return PolicyDecision.deny({
          policyId: "ingress.channel_grant",
          reasonCodes: [reason],
          factsUsed: sourceFacts,
          effects: [{ type: "run.abort", reason }],
        });
      }
      const inboundTreatment = resolveInboundTreatment(result.grant);
      if (inboundTreatment === "drop") {
        const reason = channelGrantReason(result.grant, inboundTreatment);
        return PolicyDecision.deny({
          policyId: "ingress.channel_grant",
          reasonCodes: [reason],
          factsUsed: sourceFacts,
          effects: [{ type: "run.abort", reason }],
        });
      }

      state.parsedEvent = applyChannelGrantTreatment(event, result.grant, inboundTreatment);
      return PolicyDecision.allow({
        policyId: "ingress.channel_grant",
        reasonCodes: [channelGrantReason(result.grant, inboundTreatment)],
        factsUsed: [
          `channel_grant.${result.grant.kind}`,
          `inbound.${inboundTreatment}`,
          ...sourceFacts,
        ],
      });
    },
  };
}

function createCoordinatorPresence(state: PreRunState): PolicyRegistration {
  return {
    ...IngressAuthorityDefinitions.CoordinatorPresence,
    failPolicy: "fail-closed",
    fn: () => {
      const event = requireParsedEvent(state);
      const target = resolveTarget(event);
      state.target = target;

      if (!targetRequiresCoordinator(target)) {
        return allowDecision("ingress.coordinator", "coordinator not required for resident target");
      }
      if (state.coordinator === undefined) {
        return abortDecision(
          "ingress.coordinator",
          `coordinator is required for ${target.kind} target`,
        );
      }
      return allowDecision(
        "ingress.coordinator",
        `coordinator available for ${target.kind} target`,
      );
    },
  };
}

function createSchemaValidation(state: PreRunState): PolicyRegistration {
  return {
    ...IngressAuthorityDefinitions.SchemaValidation,
    failPolicy: "fail-closed",
    fn: () => {
      const parsed = Ingress.DirectEventSchema.safeParse(state.input);
      if (!parsed.success) {
        state.schemaError = parsed.error;
        return abortDecision("ingress.schema", "invalid ingress event");
      }

      state.parsedEvent = parsed.data;
      return allowDecision("ingress.schema", "ingress event schema valid");
    },
  };
}

function createAuthorityCheck(state: PreRunState): PolicyRegistration {
  return {
    ...IngressAuthorityDefinitions.AuthorityCheck,
    failPolicy: "fail-closed",
    fn: () => {
      const event = requireParsedEvent(state);

      return evaluateIngressAuthority(event);
    },
  };
}

function createModeDispatch(state: PreRunState): PolicyRegistration {
  return {
    ...IngressAuthorityDefinitions.ModeDispatch,
    failPolicy: "fail-closed",
    fn: () => {
      const event = requireParsedEvent(state);
      if (event.mode !== "direct") {
        const unknownMode: unknown = event.mode;
        return abortDecision("ingress.mode", `unknown ingress mode: ${unknownMode}`);
      }

      state.mode = event.mode;
      return allowDecision("ingress.mode", `dispatch mode ${event.mode}`);
    },
  };
}

// merged from ingress-authority-blacklist.ts (#453 hygiene: sub-30-LOC single-importer)
export function blacklistReason(kind: string, value: string, reason: string | undefined): string {
  return reason ?? `blacklist.${kind}.${value}`;
}
