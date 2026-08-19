import { Actor } from "@openomni/protocol";
import { Storage } from "../storage/storage";
import { requireSubAdapter, withStoreTimestamps } from "../storage/timestamped-store";

function requireAdapter(): NonNullable<Storage.Adapter["actorRegistry"]> {
  return requireSubAdapter(
    Storage.get().actorRegistry,
    "Storage adapter does not implement actorRegistry",
  );
}

export namespace ActorRegistry {
  /**
   * Presence probe (#707 S8 review fix): the gateway router's actor
   * resolver keeps its legacy pass-through when no registry sub-adapter is
   * configured (test fakes) — probed through THIS surface instead of the
   * master Storage entry, so the router never names Storage at all.
   */
  export function isConfigured(): boolean {
    return Storage.get().actorRegistry !== undefined;
  }

  export function registerIdentity(input: Actor.Identity): Actor.Identity {
    const adapter = requireAdapter();
    const identity = Actor.Identity.parse(
      withStoreTimestamps(input, adapter.getIdentity(input.id)),
    );
    adapter.setIdentity(identity);
    return identity;
  }

  export function getIdentity(id: string): Actor.Identity | undefined {
    return requireAdapter().getIdentity(id);
  }

  export function removeIdentity(id: string): boolean {
    return requireAdapter().removeIdentity(id);
  }

  export function registerEndpoint(input: Actor.Endpoint): Actor.Endpoint {
    const adapter = requireAdapter();
    const endpoint = Actor.Endpoint.parse(
      withStoreTimestamps(input, adapter.getEndpoint(input.id)),
    );
    if (!adapter.getIdentity(endpoint.actorId)) {
      throw new Error(`Actor identity not found: ${endpoint.actorId}`);
    }
    const existingForAddress = adapter.findEndpoint(
      endpoint.channel,
      endpoint.externalId,
      endpoint.workspace,
    );
    if (existingForAddress && existingForAddress.id !== endpoint.id) {
      throw new Error(
        `Actor endpoint already registered for ${endpoint.channel}:${endpoint.workspace ?? ""}:${endpoint.externalId}`,
      );
    }
    adapter.setEndpoint(endpoint);
    return endpoint;
  }

  export function getEndpoint(id: string): Actor.Endpoint | undefined {
    return requireAdapter().getEndpoint(id);
  }

  export function listEndpoints(actorId?: string, workspace?: string): Actor.Endpoint[] {
    return requireAdapter().listEndpoints(actorId, workspace);
  }

  export function resolveEndpoint(
    channel: string,
    externalId: string,
    workspace?: string,
  ): Actor.ResolvedEndpoint | undefined {
    const adapter = requireAdapter();
    const endpoint = adapter.findEndpoint(channel, externalId, workspace);
    if (!endpoint) return undefined;
    const identity = adapter.getIdentity(endpoint.actorId);
    if (!identity) return undefined;
    return { identity, endpoint };
  }
}
