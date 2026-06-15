import type { PolicyRegistration } from "@openomni/agent";
import { Ingress, PolicyDecision } from "@openomni/protocol";
import { BlacklistStore, ChannelGrantStore } from "@openomni/session";
import { resolveTarget } from "../target";
import { getActor, targetRequiresCoordinator } from "./ingress-authority-actor";
import { blacklistReason } from "./ingress-authority-blacklist";
import { applyChannelGrantTreatment, channelGrantReason } from "./ingress-authority-channel-grant";
import { abortDecision, allowDecision, requireParsedEvent } from "./ingress-authority-decisions";
import { IngressAuthorityDefinitions } from "./ingress-authority-definitions";
import { evaluateIngressAuthority } from "./ingress-authority-evaluation";
import type { PreRunState } from "./ingress-authority-types";

export function registrations(state: PreRunState): PolicyRegistration[] {
  return [
    createSchemaValidation(state),
    createBlacklistCheck(state),
    createChannelGrantCheck(state),
    createCoordinatorPresence(state),
    createAuthorityCheck(state),
    createModeDispatch(state),
  ];
}

function createBlacklistCheck(state: PreRunState): PolicyRegistration {
  return {
    ...IngressAuthorityDefinitions.BlacklistCheck,
    failPolicy: "fail-closed",
    fn: () => {
      const event = requireParsedEvent(state);
      const actor = getActor(event);
      const entry = BlacklistStore.match({
        actorId: typeof actor?.actorId === "string" ? actor.actorId : undefined,
        endpointId: typeof actor?.endpointId === "string" ? actor.endpointId : undefined,
        channel: event.surface,
        candidates: [
          event.surface,
          ...(event.channel ? [event.channel] : []),
          `${event.surface}:${event.workspace ?? ""}:${event.channel ?? ""}`,
        ],
      });
      if (!entry) return allowDecision("ingress.blacklist", "blacklist.clear");
      return abortDecision(
        "ingress.blacklist",
        blacklistReason(entry.kind, entry.value, entry.reason),
      );
    },
  };
}

function createChannelGrantCheck(state: PreRunState): PolicyRegistration {
  return {
    ...IngressAuthorityDefinitions.ChannelGrantCheck,
    failPolicy: "fail-closed",
    fn: () => {
      const event = requireParsedEvent(state);
      const resolution = ChannelGrantStore.resolve({
        surface: event.surface,
        workspace: event.workspace,
        channel: event.channel,
      });

      if (!resolution) {
        return abortDecision("ingress.channel_grant", channelGrantReason(undefined, undefined));
      }
      if (resolution.inboundTreatment === "drop") {
        return abortDecision(
          "ingress.channel_grant",
          channelGrantReason(resolution.grant, resolution.inboundTreatment),
        );
      }

      state.parsedEvent = applyChannelGrantTreatment(
        event,
        resolution.grant,
        resolution.inboundTreatment,
      );

      return PolicyDecision.allow({
        policyId: "ingress.channel_grant",
        reasonCodes: [channelGrantReason(resolution.grant, resolution.inboundTreatment)],
        factsUsed: [
          `channel_grant.${resolution.grant.kind}`,
          `inbound.${resolution.inboundTreatment}`,
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
