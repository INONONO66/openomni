import { AppConnector } from "@openomni/protocol";
import { Storage } from "../storage/storage";
import { assertConsentMatchesRequirements } from "./consent-validation";

type InstallationInput = Omit<AppConnector.Installation, "createdAt" | "updatedAt"> &
  Partial<Pick<AppConnector.Installation, "createdAt">>;
type ConsentInput = Omit<AppConnector.Consent, "grantedAt"> &
  Partial<Pick<AppConnector.Consent, "grantedAt">>;

function requireAdapter(): NonNullable<Storage.Adapter["appConnectorInstallation"]> {
  const adapter = Storage.get().appConnectorInstallation;
  if (!adapter) {
    throw new Error("Storage adapter does not implement app connector installations");
  }
  return adapter;
}

function withTimestamps(
  installation: InstallationInput,
  existing?: AppConnector.Installation,
): AppConnector.Installation {
  const now = Date.now();
  return AppConnector.Installation.parse({
    ...installation,
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

function consentRecord(input: ConsentInput): AppConnector.Consent {
  return AppConnector.Consent.parse({
    ...input,
    grantedAt: input.grantedAt ?? Date.now(),
  });
}

export namespace AppConnectorInstallationStore {
  export function set(input: InstallationInput): AppConnector.Installation {
    const adapter = requireAdapter();
    const installation = withTimestamps(input, adapter.get(input.id));
    adapter.set(installation);
    return installation;
  }

  export function get(id: string): AppConnector.Installation | undefined {
    return requireAdapter().get(id);
  }

  export function list(): AppConnector.Installation[] {
    return requireAdapter().list();
  }

  export function remove(id: string): boolean {
    return requireAdapter().remove(id);
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

  export function disable(id: string): AppConnector.Installation {
    const installation = requireInstallation(id);
    if (installation.status === "disabled") {
      return installation;
    }
    return set({ ...installation, status: "disabled" });
  }

  export function uninstall(id: string): boolean {
    requireInstallation(id);
    return remove(id);
  }
}
