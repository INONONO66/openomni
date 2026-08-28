import { Actor } from "@openomni/protocol";
import { Storage } from "../storage/storage";
import { requireSubAdapter, withStoreTimestamps } from "../storage/timestamped-store";

interface ChannelGrantMatchInput {
  readonly surface: string;
  readonly workspace?: string;
  readonly channel?: string;
}

interface ChannelGrantResolution {
  readonly grant: Actor.ChannelGrant;
  readonly inboundTreatment: Actor.InboundTreatment;
}

function requireAdapter(): NonNullable<Storage.Adapter["channelGrant"]> {
  return requireSubAdapter(
    Storage.get().channelGrant,
    "Storage adapter does not implement channel grants",
  );
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

const treatmentRestriction: Record<Actor.InboundTreatment, number> = {
  drop: 0,
  evidence_only: 1,
  full_access: 2,
};

const defaultTierRestriction: Record<Actor.TrustTier, number> = {
  assigned_worker: 1,
  observer: 2,
  collaborator: 3,
  manager: 4,
  co_owner: 5,
  owner: 6,
};

const kindRestriction: Record<Actor.ChannelGrantKind, number> = {
  blocked_channel: 0,
  broadcast_channel: 1,
  trusted_channel: 2,
};

function effectiveTreatment(grant: Actor.ChannelGrant): Actor.InboundTreatment {
  const treatment = grant.inboundTreatment ?? defaultTreatment(grant.kind);
  if (grant.kind === "blocked_channel" || treatment === "drop") return "drop";
  if (grant.kind === "broadcast_channel") return "evidence_only";
  return treatment;
}

function compareStableText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Resolution keeps the existing specificity lattice, then orders equal-score
 * grants fail-closed: effective treatment (drop → evidence → full), absent or
 * lower-authority default tier, intrinsically restrictive kind, then grant ID
 * by code-unit order. IDs are unique stable identities, so the final key makes
 * this a backend- and insertion-independent total order.
 */
function compareResolutionOrder(a: Actor.ChannelGrant, b: Actor.ChannelGrant): number {
  const specificityOrder = specificity(b) - specificity(a);
  if (specificityOrder !== 0) return specificityOrder;

  const treatmentOrder =
    treatmentRestriction[effectiveTreatment(a)] - treatmentRestriction[effectiveTreatment(b)];
  if (treatmentOrder !== 0) return treatmentOrder;

  const defaultTierOrder =
    (a.defaultTier === undefined ? 0 : defaultTierRestriction[a.defaultTier]) -
    (b.defaultTier === undefined ? 0 : defaultTierRestriction[b.defaultTier]);
  if (defaultTierOrder !== 0) return defaultTierOrder;

  const kindOrder = kindRestriction[a.kind] - kindRestriction[b.kind];
  if (kindOrder !== 0) return kindOrder;

  return compareStableText(a.id, b.id);
}

export namespace ChannelGrantStore {
  export type Grant = Actor.ChannelGrant;

  export function put(input: Grant): Grant {
    const store = requireAdapter();
    const grant = Actor.ChannelGrant.parse(withStoreTimestamps(input, store.get(input.id)));
    store.set(grant);
    return grant;
  }

  export function remove(id: string): boolean {
    return requireAdapter().remove(id);
  }

  export function resolve(input: ChannelGrantMatchInput): ChannelGrantResolution | undefined {
    // Absent adapter previously read as "no grant" (deny — benign), but reads
    // and writes follow ONE rule here: the adapter is required (like put()).
    const grants = requireAdapter()
      .list()
      .filter((grant) => matches(grant, input))
      .sort(compareResolutionOrder);
    const grant = grants[0];
    if (!grant) return undefined;
    return {
      grant,
      inboundTreatment: grant.inboundTreatment ?? defaultTreatment(grant.kind),
    };
  }
}
