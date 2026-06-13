import { type AppConnector, Policy } from "@openomni/protocol";
import { AppConnectorInstallationStore } from "@openomni/session";
import { z } from "zod";
import type { DiscoveryCandidate } from "./discovery.js";

export interface AppConnectorRegistrationOptions {
  readonly registeredBy: string;
}

export const AppConnectorConsentOptions = z
  .object({
    grantedBy: z.string().min(1),
    credentials: z.array(z.string().min(1)).optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    permissions: z.array(Policy.Permission).optional(),
  })
  .strict();
export type AppConnectorConsentOptions = z.infer<typeof AppConnectorConsentOptions>;

export namespace AppConnectorRegistry {
  export function register(
    candidate: DiscoveryCandidate,
    options: AppConnectorRegistrationOptions,
  ): AppConnector.Installation {
    if (candidate.status !== "available") {
      throw new Error(`Cannot register unavailable connector ${candidate.id}`);
    }

    return AppConnectorInstallationStore.set({
      id: installationId(candidate.id),
      connectorId: candidate.connector.id,
      connectorVersion: candidate.connector.version,
      definition: candidate.connector,
      ...(candidate.version !== undefined ? { detectedVersion: candidate.version } : {}),
      testedVersions: candidate.testedVersions,
      status: "registered",
      registeredBy: options.registeredBy,
    });
  }

  export function get(id: string): AppConnector.Installation | undefined {
    return AppConnectorInstallationStore.get(id);
  }

  export function list(): AppConnector.Installation[] {
    return AppConnectorInstallationStore.list();
  }

  export function remove(id: string): boolean {
    return AppConnectorInstallationStore.remove(id);
  }

  export function disable(id: string): AppConnector.Installation {
    return AppConnectorInstallationStore.disable(id);
  }

  export function uninstall(id: string): boolean {
    return AppConnectorInstallationStore.uninstall(id);
  }

  export function requestConsent(id: string): AppConnector.Installation {
    return AppConnectorInstallationStore.requestConsent(id);
  }

  export function grantConsent(
    id: string,
    options: AppConnectorConsentOptions,
  ): AppConnector.Installation {
    return AppConnectorInstallationStore.grantConsent(
      id,
      AppConnectorConsentOptions.parse(options),
    );
  }
}

function installationId(connectorId: string): string {
  return `install:${connectorId}`;
}
