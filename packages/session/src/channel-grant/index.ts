import { Actor } from "@openomni/protocol";
import { Storage } from "../storage/storage";

export interface ChannelGrantMatchInput {
  readonly surface: string;
  readonly workspace?: string;
  readonly channel?: string;
}

export interface ChannelGrantResolution {
  readonly grant: Actor.ChannelGrant;
  readonly inboundTreatment: Actor.InboundTreatment;
}

function adapter(): Storage.Adapter["channelGrant"] {
  return Storage.get().channelGrant;
}

function requireAdapter(): NonNullable<Storage.Adapter["channelGrant"]> {
  const current = adapter();
  if (!current) throw new Error("Storage adapter does not implement channel grants");
  return current;
}

function withTimestamps(grant: Actor.ChannelGrant, existing?: Actor.ChannelGrant) {
  const now = Date.now();
  return {
    ...grant,
    createdAt: grant.createdAt ?? existing?.createdAt ?? now,
    updatedAt: existing ? now : (grant.updatedAt ?? now),
  };
}

function defaultTreatment(kind: Actor.ChannelGrantKind): Actor.InboundTreatment {
  if (kind === "trusted_channel") return "full_access";
  if (kind === "broadcast_channel") return "evidence_only";
  return "drop";
}

function matches(grant: Actor.ChannelGrant, input: ChannelGrantMatchInput): boolean {
  if (grant.surface !== input.surface) return false;
  if (grant.workspace !== undefined && grant.workspace !== input.workspace) return false;
  if (grant.channel !== undefined && grant.channel !== input.channel) return false;
  return true;
}

function specificity(grant: Actor.ChannelGrant): number {
  return (grant.workspace === undefined ? 0 : 1) + (grant.channel === undefined ? 0 : 1);
}

export namespace ChannelGrantStore {
  export type Grant = Actor.ChannelGrant;

  export function put(input: Grant): Grant {
    const store = requireAdapter();
    const grant = Actor.ChannelGrant.parse(withTimestamps(input, store.get(input.id)));
    store.set(grant);
    return grant;
  }

  export function get(id: string): Grant | undefined {
    return requireAdapter().get(id);
  }

  export function list(): Grant[] {
    return requireAdapter().list();
  }

  export function remove(id: string): boolean {
    return requireAdapter().remove(id);
  }

  export function resolve(input: ChannelGrantMatchInput): ChannelGrantResolution | undefined {
    const store = adapter();
    if (!store) return undefined;
    const grants = store
      .list()
      .filter((grant) => matches(grant, input))
      .sort((a, b) => specificity(b) - specificity(a));
    const grant = grants[0];
    if (!grant) return undefined;
    return {
      grant,
      inboundTreatment: grant.inboundTreatment ?? defaultTreatment(grant.kind),
    };
  }
}
