import type { AppConnector } from "@openomni/protocol";
import { AppConnectorInstallationStore } from "@openomni/session";
import type { DiscoveryCandidate } from "./discovery.js";

export interface AppConnectorRegistrationOptions {
  readonly registeredBy: string;
}

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
}

function installationId(connectorId: string): string {
  return `install:${connectorId}`;
}
