// This file owns actor identity, access-control, and connector installation storage contracts.
import type { Actor } from "../actor/index.js";
import type { AppConnector } from "../app-connector/index.js";

export type { Storage } from "./namespace.js";

declare module "./namespace.js" {
  namespace Storage {
    export interface ActorRegistrySubAdapter {
      getIdentity(id: string): Actor.Identity | undefined;
      setIdentity(identity: Actor.Identity): void;
      listIdentities(): Actor.Identity[];
      removeIdentity(id: string): boolean;
      getEndpoint(id: string): Actor.Endpoint | undefined;
      setEndpoint(endpoint: Actor.Endpoint): void;
      findEndpoint(
        channel: string,
        externalId: string,
        workspace: string | undefined,
      ): Actor.Endpoint | undefined;
      listEndpoints(actorId?: string, workspace?: string): Actor.Endpoint[];
      removeEndpoint(id: string): boolean;
    }

    export interface BlacklistSubAdapter {
      get(id: string): Actor.BlacklistEntry | undefined;
      set(entry: Actor.BlacklistEntry): void;
      list(): Actor.BlacklistEntry[];
      remove(id: string): boolean;
    }

    export interface ChannelGrantSubAdapter {
      get(id: string): Actor.ChannelGrant | undefined;
      set(grant: Actor.ChannelGrant): void;
      list(): Actor.ChannelGrant[];
      remove(id: string): boolean;
    }

    export interface AppConnectorInstallationSubAdapter {
      get(id: string): AppConnector.Installation | undefined;
      set(installation: AppConnector.Installation): void;
      list(): AppConnector.Installation[];
      remove(id: string): boolean;
    }
  }
}
