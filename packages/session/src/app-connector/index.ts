import { Actor, AppConnector } from "@openomni/protocol";
import { createHash } from "node:crypto";
import { Storage } from "../storage/storage";
import { requireSubAdapter } from "../storage/timestamped-store";
import { assertConsentMatchesRequirements } from "./consent-validation";

type InstallationInput = Omit<AppConnector.Installation, "createdAt" | "updatedAt" | "endpointId"> &
  Partial<Pick<AppConnector.Installation, "createdAt" | "endpointId">>;
type ConsentInput = Omit<AppConnector.Consent, "grantedAt"> &
  Partial<Pick<AppConnector.Consent, "grantedAt">>;
type SmokeVerifiedInput = Pick<AppConnector.Installation, "detectedVersion">;
type SmokeVerificationFailedInput = Partial<Pick<AppConnector.Installation, "detectedVersion">>;

function requireAdapter(): NonNullable<Storage.Adapter["appConnectorInstallation"]> {
  return requireSubAdapter(
    Storage.get().appConnectorInstallation,
    "Storage adapter does not implement app connector installations",
  );
}

function withTimestamps(
  installation: InstallationInput,
  existing?: AppConnector.Installation,
): AppConnector.Installation {
  const now = Date.now();
  return AppConnector.Installation.parse({
    ...installation,
    endpointId: installation.endpointId ?? existing?.endpointId ?? endpointIdFor(installation.id),
    createdAt: existing?.createdAt ?? installation.createdAt ?? now,
    updatedAt: now,
  });
}

function requireInstallation(id: string): AppConnector.Installation {
  const installation = requireAdapter().get(id);
  if (!installation) {
    throw new Error(`AppConnector installation not found: ${id}`);
  }
  return installation;
}

function removeInstallation(id: string): boolean {
  return requireAdapter().remove(id);
}

function consentRecord(input: ConsentInput): AppConnector.Consent {
  return AppConnector.Consent.parse({
    ...input,
    grantedAt: input.grantedAt ?? Date.now(),
  });
}

function endpointIdFor(installationId: string): string {
  return `endpoint:${installationId}`;
}

function actorIdFor(installationId: string): string {
  return `actor:${installationId}`;
}

function hashPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

function workspaceHash(installation: AppConnector.Installation): string | undefined {
  const worktreePath = installation.workspace?.worktreePath;
  return worktreePath === undefined ? undefined : hashPath(worktreePath);
}

function connectorActorIdentity(installation: AppConnector.Installation): Actor.Identity {
  return Actor.Identity.parse({
    id: actorIdFor(installation.id),
    kind: "ai_agent",
    trustTier: "assigned_worker",
    relationship: "external_agent",
    displayName: installation.definition.name,
    metadata: {
      connectorId: installation.connectorId,
      installationId: installation.id,
    },
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt,
  });
}

function connectorActorEndpoint(installation: AppConnector.Installation): Actor.Endpoint {
  const workspace = workspaceHash(installation);
  return Actor.Endpoint.parse({
    id: installation.endpointId,
    actorId: actorIdFor(installation.id),
    channel: "app_connector",
    externalId: installation.id,
    ...(workspace === undefined ? {} : { workspace }),
    displayName: installation.definition.name,
    metadata: {
      connectorId: installation.connectorId,
      installationId: installation.id,
      provider: installation.definition.driver.provider,
      ...(installation.workspace === undefined
        ? {}
        : {
            repoPathHash: installation.workspace.repoPathHash,
            worktreePathHash: installation.workspace.worktreePathHash,
          }),
    },
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt,
  });
}

function upsertActorEndpoint(installation: AppConnector.Installation): void {
  // Fail closed: an installation row without its actor identity/endpoint is a
  // half-registered connector (routing would silently miss it). A missing
  // actorRegistry sub-adapter is a wiring defect, never a skip.
  const actorRegistry = requireSubAdapter(
    Storage.get().actorRegistry,
    "Storage adapter does not implement actorRegistry — app connector installs fail closed",
  );
  actorRegistry.setIdentity(connectorActorIdentity(installation));
  actorRegistry.setEndpoint(connectorActorEndpoint(installation));
}

export namespace AppConnectorInstallationStore {
  export function set(input: InstallationInput): AppConnector.Installation {
    const storage = Storage.get();
    const adapter = requireAdapter();
    const installation = withTimestamps(input, adapter.get(input.id));
    // One unit: the installation row and its actor identity/endpoint commit
    // or roll back together — a crash between them must not leave a
    // connector that exists for consent but not for routing.
    storage.transaction(() => {
      adapter.set(installation);
      upsertActorEndpoint(installation);
    });
    return installation;
  }

  export function get(id: string): AppConnector.Installation | undefined {
    return requireAdapter().get(id);
  }

  export function list(): AppConnector.Installation[] {
    return requireAdapter().list();
  }

  export function requestConsent(id: string): AppConnector.Installation {
    const installation = requireInstallation(id);
    if (installation.status !== "registered") {
      throw new Error(`Cannot request consent for ${installation.status} installation: ${id}`);
    }
    return set({ ...installation, status: "pending_consent" });
  }

  export function grantConsent(id: string, input: ConsentInput): AppConnector.Installation {
    const installation = requireInstallation(id);
    if (installation.status !== "pending_consent") {
      throw new Error(`Cannot grant consent for ${installation.status} installation: ${id}`);
    }

    assertConsentMatchesRequirements(input, installation.definition);

    return set({
      ...installation,
      status: "consented",
      consent: consentRecord(input),
    });
  }

  export function markSmokeVerified(
    id: string,
    input: SmokeVerifiedInput,
  ): AppConnector.Installation {
    const installation = requireInstallation(id);
    if (installation.status !== "consented") {
      throw new Error(`Cannot smoke verify ${installation.status} installation: ${id}`);
    }

    return set({
      ...installation,
      status: "enabled",
      detectedVersion: input.detectedVersion,
    });
  }

  export function markSmokeVerificationFailed(
    id: string,
    input: SmokeVerificationFailedInput = {},
  ): AppConnector.Installation {
    const installation = requireInstallation(id);
    if (installation.status !== "consented") {
      throw new Error(`Cannot smoke verify ${installation.status} installation: ${id}`);
    }

    return set({
      ...installation,
      status: "verification_failed",
      ...(input.detectedVersion !== undefined ? { detectedVersion: input.detectedVersion } : {}),
    });
  }

  export function disable(id: string): AppConnector.Installation {
    const installation = requireInstallation(id);
    if (installation.status === "disabled") {
      return installation;
    }
    return set({ ...installation, status: "disabled" });
  }

  export function uninstall(id: string): boolean {
    requireInstallation(id);
    return removeInstallation(id);
  }
}
